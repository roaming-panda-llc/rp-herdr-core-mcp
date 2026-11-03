import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { EventManager } from '../src/events.js';
import { EventStore } from '../src/event-store.js';

const secret = 'whsec_' + Buffer.alloc(32, 1).toString('base64');
const replacement = 'whsec_' + Buffer.alloc(32, 2).toString('base64');
const request = (overrides = {}) => ({ name: 'terminal.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://callback.example/hook', secret }, ...overrides });
const payload = (n = 1) => ({ host: 'local', terminal: 't1', created_ms: n });
function setup(t, opts = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-events-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.now();
  const calls = [];
  const transport = async (_url, options) => {
    calls.push(options);
    const body = JSON.parse(options.body);
    if (body.type === 'verification') return { ok: true, status: 200, json: async () => ({ challenge: body.challenge }) };
    return { ok: true, status: 200 };
  };
  const config = { events: { stateDirectory: directory } };
  const manager = new EventManager(null, config, { now: () => now, transport, autoDispatch: false, ...opts });
  t.after(() => manager.stopPolling());
  return { manager, config, directory, calls, advance: ms => { now += ms; }, now: () => now, transport };
}

test('positive challenge uses subscription ID and signed exact bytes; refresh is canonical and extends TTL', async t => {
  const { manager, calls, advance } = setup(t);
  const sub = await manager.handleSubscribe('alice', request());
  assert.equal(calls[0].headers['X-MCP-Subscription-Id'], sub.id);
  assert.equal(new Webhook(secret).verify(calls[0].body, calls[0].headers).type, 'verification');
  advance(10000);
  const refresh = await manager.handleSubscribe('alice', request());
  assert.equal(refresh.id, sub.id);
  assert.ok(refresh.refreshBefore > sub.refreshBefore);
  assert.equal(calls.length, 1);
  await manager.deliverEvent('terminal.created', payload());
  await manager.processOutbox();
  const event = new Webhook(secret).verify(calls[1].body, calls[1].headers);
  assert.equal(event.eventId, calls[1].headers['webhook-id']);
  assert.equal(event.cursor, 'created:1');
  assert.deepEqual(event.data, payload());
});

test('wrong challenge is categorized without leaking callback contents and never activates', async t => {
  const { manager } = setup(t, { transport: async () => ({ ok: true, json: async () => ({ challenge: 'private response data' }) }) });
  await assert.rejects(manager.handleSubscribe('alice', request()), e => e.code === -32015 && e.data.reason === 'challenge_failed' && !e.message.includes('private'));
  assert.equal(manager.subscriptions.size, 0);
});

test('principal isolation, filters and idempotent unsubscribe cancel queued deliveries', async t => {
  const { manager, calls } = setup(t);
  const alice = await manager.handleSubscribe('alice', request({ arguments: { host: 'local' } }));
  const bob = await manager.handleSubscribe('bob', request({ arguments: { host: 'other' } }));
  assert.notEqual(alice.id, bob.id);
  await manager.deliverEvent('terminal.created', payload());
  assert.equal(manager.outbox.length, 1);
  await manager.handleUnsubscribe('bob', request({ arguments: { host: 'local' } }));
  assert.equal(manager.outbox.length, 1);
  await manager.handleUnsubscribe('alice', request({ arguments: { host: 'local' } }));
  await manager.handleUnsubscribe('alice', request({ arguments: { host: 'local' } }));
  await manager.processOutbox();
  assert.equal(manager.outbox.length, 0);
  assert.equal(calls.length, 2);
});

test('retry keeps event bytes and ID, refreshes timestamp and dual-signs rotated secrets', async t => {
  const { manager, calls, advance, now, transport } = setup(t);
  await manager.handleSubscribe('alice', request());
  manager.transport = async (url, options) => { await transport(url, options); return { ok: false, status: 503 }; };
  await manager.deliverEvent('terminal.created', payload());
  await manager.processOutbox();
  const first = calls[1];
  advance(2000);
  await manager.handleSubscribe('alice', request({ delivery: { mode: 'webhook', url: 'https://callback.example/hook', secret: replacement } }));
  manager.transport = transport;
  await manager.processOutbox();
  const second = calls[2];
  assert.equal(first.body, second.body);
  assert.equal(first.headers['webhook-id'], second.headers['webhook-id']);
  assert.notEqual(first.headers['webhook-timestamp'], second.headers['webhook-timestamp']);
  new Webhook(secret).verify(second.body, second.headers, new Date(now()));
  new Webhook(replacement).verify(second.body, second.headers, new Date(now()));
  assert.equal(manager.outbox.length, 0);
});

test('expiry and shutdown preserve cancellation boundaries', async t => {
  const { manager, calls, advance } = setup(t);
  await manager.handleSubscribe('alice', request({ ttlMs: 60000 }));
  await manager.deliverEvent('terminal.created', payload());
  advance(60000);
  await manager.processOutbox();
  assert.equal(manager.outbox.length, 0);
  assert.equal(manager.subscriptions.size, 0);
  assert.equal(calls.length, 1);
  await manager.stopPolling();
  await assert.rejects(manager.handleSubscribe('alice', request()), /stopping/);
});

test('in-flight delivery is aborted on unsubscribe and cannot requeue', async t => {
  const { manager } = setup(t);
  await manager.handleSubscribe('alice', request());
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  manager.transport = async (_url, { signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await manager.deliverEvent('terminal.created', payload());
  const delivery = manager.processOutbox();
  await ready;
  await manager.handleUnsubscribe('alice', request());
  await delivery;
  assert.equal(manager.outbox.length, 0);
});

test('encrypted durable outbox resumes after restart with same event ID and bytes', async t => {
  const { manager, config, directory, calls, transport } = setup(t);
  await manager.handleSubscribe('alice', request());
  await manager.deliverEvent('terminal.created', payload());
  const before = structuredClone(manager.outbox[0]);
  await manager.stopPolling();
  const encrypted = readFileSync(join(directory, 'events.enc'));
  assert.equal(encrypted.includes(Buffer.from(secret)), false);
  assert.equal(encrypted.includes(Buffer.from('callback.example')), false);
  assert.equal(statSync(join(directory, 'events.key')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'events.enc')).mode & 0o777, 0o600);
  const restarted = new EventManager(null, config, { transport, autoDispatch: false });
  t.after(() => restarted.stopPolling());
  await restarted.processOutbox();
  assert.equal(calls[1].body, before.body);
  assert.equal(calls[1].headers['webhook-id'], before.eventId);
  assert.equal(restarted.outbox.length, 0);
  assert.equal(new EventStore(directory).load().outbox.length, 0);
});

test('created replay resumes after acknowledged cursor without skipping queued events', async t => {
  const { manager, config, transport } = setup(t);
  const initial = await manager.handleSubscribe('alice', request());
  assert.equal(initial.cursor, 'created:0');
  await manager.deliverEvent('terminal.created', payload(1));
  await manager.deliverEvent('terminal.created', payload(2));
  assert.equal((await manager.handleSubscribe('alice', request())).cursor, 'created:0');
  await manager.processOutbox();
  await manager.handleUnsubscribe('alice', request());
  await manager.stopPolling();
  const restarted = new EventManager(null, config, { transport, autoDispatch: false });
  t.after(() => restarted.stopPolling());
  const replay = await restarted.handleSubscribe('alice', request({ cursor: 'created:1' }));
  assert.equal(replay.truncated, false);
  assert.equal(restarted.outbox.length, 1);
  assert.equal(JSON.parse(restarted.outbox[0].body).data.created_ms, 2);
});

test('per-subscription retries are bounded and do not block another subscriber', async t => {
  const { manager, advance } = setup(t);
  const alice = await manager.handleSubscribe('alice', request());
  const bob = await manager.handleSubscribe('bob', request());
  const attempts = [];
  manager.transport = async (_url, opts) => { attempts.push(opts.headers['X-MCP-Subscription-Id']); return { ok: opts.headers['X-MCP-Subscription-Id'] === bob.id, status: 503 }; };
  await manager.deliverEvent('terminal.created', payload());
  await manager.processOutbox();
  for (let i = 0; i < 10; i++) { advance(16000); await manager.processOutbox(); }
  assert.equal(attempts.filter(id => id === alice.id).length, 5);
  assert.equal(attempts.filter(id => id === bob.id).length, 1);
});

test('410 and 413 cancel the entire subscription queue', async t => {
  for (const status of [410, 413]) {
    const { manager } = setup(t);
    await manager.handleSubscribe('alice', request());
    await manager.deliverEvent('terminal.created', payload(1));
    await manager.deliverEvent('terminal.created', payload(2));
    let calls = 0;
    manager.transport = async () => { calls++; return { ok: false, status }; };
    await manager.processOutbox();
    assert.equal(calls, 1);
    assert.equal(manager.outbox.length, 0);
    assert.equal(manager.subscriptions.size, 0);
  }
});

test('terminal polling handles host isolation, reused addresses and finish/disappear deduplication', async t => {
  const { manager } = setup(t);
  let a = [{ address: 't1', created_ms: 1, state: 'live', pid: 10, status: { state: 'idle' } }];
  let b = structuredClone(a);
  manager.pollingHosts = [
    { hostId: 'a', core: { call: async () => ({ terminals: a }) } },
    { hostId: 'b', core: { call: async () => ({ terminals: b }) } }
  ];
  await manager.pollTerminals();
  const events = [];
  const deliver = manager.deliverEvent.bind(manager);
  manager.deliverEvent = (name, data) => { events.push({ name, data }); return deliver(name, data); };
  a = [{ ...a[0], state: 'exited', pid: null }];
  await manager.pollTerminals();
  a = [];
  await manager.pollTerminals();
  assert.equal(events.filter(e => e.name === 'terminal.finished').length, 1);
  b = [{ ...b[0], created_ms: 2 }];
  await manager.pollTerminals();
  assert.equal(events.filter(e => e.name === 'terminal.finished').length, 2);
  assert.equal(events.filter(e => e.name === 'terminal.created').length, 1);
  await manager.deliverEvent('terminal.created', { host: 'b', terminal: 't1', created_ms: 2 });
  assert.equal(manager.state.history.length, 1);
});

test('tampered durable state fails closed', t => {
  const { manager, directory } = setup(t);
  manager.persist();
  const path = join(directory, 'events.enc');
  const data = readFileSync(path); data[data.length - 1] ^= 1; writeFileSync(path, data);
  assert.throws(() => new EventStore(directory).load());
});

test('bounded history reports truncation, outbox rejects overflow without losing queued work', async t => {
  const store = { load: () => null, save: () => {} };
  const { manager } = setup(t, { store });
  for (let i = 1; i <= 1002; i++) manager.deliverEvent('terminal.created', payload(i));
  assert.equal(manager.state.history.length, 1000);
  const replay = await manager.handleSubscribe('alice', request({ cursor: 'created:0' }));
  assert.equal(replay.truncated, true);
  assert.equal(replay.cursor, 'created:2');
  assert.equal(manager.outbox.length, 1000);
  assert.throws(() => manager.deliverEvent('terminal.created', payload(1003)), /capacity/);
  assert.equal(manager.state.sequence, 1002);
  assert.equal(manager.outbox.length, 1000);
});

test('lifetime filters isolate reused terminal addresses and non-replay events return null cursors', async t => {
  const { manager } = setup(t);
  const sub = await manager.handleSubscribe('alice', request({ name: 'terminal.status_changed', arguments: { terminal: 't1', created_ms: 7 } }));
  assert.equal(sub.cursor, null);
  for (const created_ms of [6, 7]) manager.deliverEvent('terminal.status_changed', { host: 'local', terminal: 't1', created_ms, previous_status: 'idle', new_status: 'working', timestamp_ms: 100 });
  assert.equal(manager.outbox.length, 1);
  assert.equal(JSON.parse(manager.outbox[0].body).cursor, null);
  assert.equal(JSON.parse(manager.outbox[0].body).data.created_ms, 7);
});

test('unsubscribe racing verification removes the eventual subscription', async t => {
  let release, start;
  const started = new Promise(resolve => { start = resolve; });
  const { manager } = setup(t, { transport: async (_url, options) => {
    const { challenge } = JSON.parse(options.body);
    start();
    await new Promise(resolve => { release = resolve; });
    return { ok: true, status: 200, json: async () => ({ challenge }) };
  } });
  const subscribing = manager.handleSubscribe('alice', request());
  await started;
  const unsubscribing = manager.handleUnsubscribe('alice', request());
  release();
  await Promise.all([subscribing, unsubscribing]);
  assert.equal(manager.subscriptions.size, 0);
});

test('revoked principal is removed before durable queued work can resume', async t => {
  const { manager, config, transport } = setup(t);
  await manager.handleSubscribe('old-token', request());
  manager.deliverEvent('terminal.created', payload());
  await manager.stopPolling();
  const restarted = new EventManager(null, config, { transport, autoDispatch: false });
  t.after(() => restarted.stopPolling());
  restarted.restrictOwner('new-token');
  assert.equal(restarted.outbox.length, 0);
  assert.equal(restarted.subscriptions.size, 0);
});

test('storage failure stops delivery and does not acknowledge subscription activation', async t => {
  const { manager } = setup(t, { store: { load: () => null, save: () => { throw new Error('disk full'); } } });
  await assert.rejects(manager.handleSubscribe('alice', request()), /storage write failed/);
  assert.equal(manager.shuttingDown, true);
});
