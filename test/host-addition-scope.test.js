import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.js';
import { EventStore } from '../src/event-store.js';
import { EventManager } from '../src/events.js';
import { eventScope, rebindApprovedHostAddition } from '../src/event-scope.js';

function configs() {
  const before = configSchema.parse({ defaultHost: 'mini', events: { enabled: true, stateDirectory: '/tmp/synthetic-state' }, hosts: {
    mini: { coreId: 'core-mini', connection: { type: 'unix', socketPath: '/tmp/mini.sock' }, accessMode: 'trusted-core', sendMode: 'normal' },
    air: { coreId: 'core-air', connection: { type: 'unix', socketPath: '/tmp/air.sock' } },
    'dev-pith': { coreId: 'core-pith', connection: { type: 'unix', socketPath: '/tmp/pith.sock' } },
    'dev-huub': { coreId: 'core-huub', connection: { type: 'unix', socketPath: '/tmp/huub.sock' } }
  } });
  const approval = { host: 'bo-control', coreId: 'core-bo', includeUnfilteredEvents: true,
    connection: { type: 'ssh', destination: 'test@bo.example', hcPath: '/opt/hc', session: 'default', allowCoreAutoStart: true },
    grants: [{ address: 't1', created_ms: 123 }, { address: 't1s', created_ms: 456 }]
  };
  const after = configSchema.parse({ ...before, hosts: { ...before.hosts,
    'bo-control': { coreId: approval.coreId, connection: approval.connection, accessMode: 'restricted', sendMode: 'idle-only', sendAllowlist: approval.grants, profiles: {} }
  } });
  return { before, after, approval };
}
function fixture(t) {
  const c = configs(), dir = mkdtempSync(join(tmpdir(), 'approved-host-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir);
  const state = { version: 1, scope: eventScope(c.before), sequence: 7,
    subscriptions: [
      { id: 'all-hosts', owner: 'owner-a', eventName: 'terminal.status_changed', arguments: {}, delivery: { mode: 'webhook', url: 'https://synthetic.example/a', secret: 'synthetic-secret' }, expiresAt: 999999 },
      { id: 'narrow', owner: 'owner-b', eventName: 'terminal.status_changed', arguments: { host: 'mini', terminal: 't1', created_ms: 55 }, delivery: { mode: 'webhook', url: 'https://synthetic.example/b', secret: 'synthetic-other' }, expiresAt: 999999 }
    ],
    outbox: [{ subscriptionId: 'all-hosts', body: 'exact-pending-bytes', eventId: 'event-7', attempt: 2 }],
    history: [{ eventId: 'event-7', cursor: 'created:7' }], terminals: [{ host: 'mini', address: 't1', created_ms: 55 }],
    initializedHosts: ['mini', 'air', 'dev-pith', 'dev-huub'], created: ['marker'], custom_preserved: { a: 1 }
  };
  store.save(state);
  return { ...c, dir, store, state, bytes: readFileSync(store.path), key: readFileSync(join(dir, 'events.key')) };
}
test('approved exact four-to-five host migration preserves encrypted state, key, filters and principals', async t => {
  const f = fixture(t);
  const migrated = rebindApprovedHostAddition(f.state, f.before, f.after, f.approval);
  assert.deepEqual({ ...migrated, scope: f.state.scope }, f.state);
  assert.equal(f.state.scope, eventScope(f.before), 'input state is untouched');
  assert.equal(migrated.scope, eventScope(f.after));
  assert.deepEqual(readFileSync(f.store.path), f.bytes, 'planning is pure, no writes');
  f.store.save(migrated);
  assert.deepEqual(f.store.load(), migrated);
  assert.deepEqual(readFileSync(join(f.dir, 'events.key')), f.key);
  const manager = new EventManager(null, f.after, { store: f.store, now: () => 100, autoDispatch: false });
  t.after(() => manager.stopPolling());
  assert.equal(manager.getDiagnostics('owner-a').active_subscriptions, 1);
  assert.equal(manager.getDiagnostics('owner-b').active_subscriptions, 1);
  assert.equal(manager.getDiagnostics('new-owner').active_subscriptions, 0);
  assert.deepEqual(manager.getSubscriptions(), f.state.subscriptions);
  assert.deepEqual(manager.outbox, f.state.outbox);
  const boEvent = { host: 'bo-control', terminal: 't1s', created_ms: 456, previous_status: 'working', new_status: 'idle', timestamp_ms: 100 };
  assert.equal(manager.matchSubscription(f.state.subscriptions[0], boEvent), true);
  assert.equal(manager.matchSubscription(f.state.subscriptions[1], boEvent), false, 'old host filter remains narrow');
  assert.equal(manager.matchSubscription(f.state.subscriptions[1], { ...boEvent, host: 'mini', terminal: 't1', created_ms: 55 }), true);
  assert.equal(manager.matchSubscription(f.state.subscriptions[1], { ...boEvent, host: 'mini', terminal: 't1', created_ms: 56 }), false, 'reused lifetime stays excluded');
  manager.deliverEvent('terminal.status_changed', boEvent);
  assert.equal(manager.outbox.length, 2);
  assert.deepEqual(manager.outbox[0], f.state.outbox[0], 'pending original bytes/attempt preserved');
  assert.equal(manager.outbox[1].subscriptionId, 'all-hosts', 'only explicitly approved unfiltered event access widens');
  assert.deepEqual(JSON.parse(manager.outbox[1].body).data, boEvent);
  assert.throws(() => manager.deliverEvent('terminal.status_changed', { ...boEvent, text: 'private transcript' }), /Invalid event payload/);
  assert.equal(manager.outbox.length, 2);
});

for (const [name, mutate] of [
  ['existing core', c => c.hosts.mini.coreId = 'other'],
  ['existing access mode', c => c.hosts.mini.accessMode = 'restricted'],
  ['existing send mode', c => c.hosts.mini.sendMode = 'idle-only'],
  ['existing grant', c => c.hosts.air.sendAllowlist.push({ address: 't2', created_ms: 1 })],
  ['existing connection', c => c.hosts.air.connection.socketPath = '/tmp/other.sock'],
  ['existing host removed', c => delete c.hosts.air],
  ['extra host', c => c.hosts.other = structuredClone(c.hosts.air)],
  ['bo core', c => c.hosts['bo-control'].coreId = 'other'],
  ['bo destination', c => c.hosts['bo-control'].connection.destination = 'other@bo.example'],
  ['bo session', c => c.hosts['bo-control'].connection.session = 'other'],
  ['bo executable', c => c.hosts['bo-control'].connection.hcPath = '/other/hc'],
  ['bo trusted access', c => c.hosts['bo-control'].accessMode = 'trusted-core'],
  ['bo normal mode', c => c.hosts['bo-control'].sendMode = 'normal'],
  ['bo creation profiles', c => c.hosts['bo-control'].profiles = { pi: { agent: 'pi', executable: '/opt/pi', projects: { x: '/tmp/x' } } }],
  ['bo Escape policy', c => c.hosts['bo-control'].escape = { enabled: false, approvals: [] }],
  ['bo timeout', c => c.hosts['bo-control'].timeoutMs = 12345],
  ['wrong t1 lifetime', c => c.hosts['bo-control'].sendAllowlist[0].created_ms++],
  ['wrong communicator lifetime', c => c.hosts['bo-control'].sendAllowlist[1].created_ms++],
  ['wrong communicator address', c => c.hosts['bo-control'].sendAllowlist[1].address = 't2'],
  ['extra grant', c => c.hosts['bo-control'].sendAllowlist.push({ address: 't2', created_ms: 1 })],
  ['missing grant', c => c.hosts['bo-control'].sendAllowlist.pop()],
  ['reordered grants', c => c.hosts['bo-control'].sendAllowlist.reverse()],
  ['changed default', c => c.defaultHost = 'bo-control'],
  ['changed event directory', c => c.events.stateDirectory = '/tmp/other'],
  ['disabled events', c => c.events.enabled = false],
  ['transport', c => c.transport = 'http'],
  ['principal injection', c => c.principal = 'other']
]) test('approved migration rejects '+name+' without touching original encrypted files', t => {
  const f = fixture(t);
  mutate(f.after);
  assert.throws(() => rebindApprovedHostAddition(f.state, f.before, f.after, f.approval));
  assert.deepEqual(readFileSync(f.store.path), f.bytes);
  assert.deepEqual(readFileSync(join(f.dir, 'events.key')), f.key);
});
test('event visibility requires explicit approval, unique grants and exact old scope; startup still fails closed', t => {
  const f = fixture(t);
  for (const a of [
    { ...f.approval, includeUnfilteredEvents: false },
    { ...f.approval, includeUnfilteredEvents: undefined },
    { ...f.approval, grants: [f.approval.grants[0], f.approval.grants[0]] },
    { ...f.approval, grants: [f.approval.grants[0]] },
    { ...f.approval, wildcard: true }
  ]) assert.throws(() => rebindApprovedHostAddition(f.state, f.before, f.after, a));
  for (const state of [null, { ...f.state, scope: 'unknown' }, { ...f.state, version: 2 }, { ...f.state, outbox: null }]) {
    assert.throws(() => rebindApprovedHostAddition(state, f.before, f.after, f.approval));
  }
  assert.throws(() => rebindApprovedHostAddition(f.state, f.after, f.after, f.approval));
  assert.throws(() => new EventManager(null, f.after, { store: f.store, now: () => 100 }), /different core configuration/);
  assert.deepEqual(readFileSync(f.store.path), f.bytes);
});
test('atomic encrypted replacement failure preserves backup/key; exact encrypted rollback reopens old scope', t => {
  const f = fixture(t), backup = join(f.dir, 'backup.enc');
  copyFileSync(f.store.path, backup);
  const migrated = rebindApprovedHostAddition(f.state, f.before, f.after, f.approval);
  rmSync(f.store.path); mkdirSync(f.store.path);
  assert.throws(() => f.store.save(migrated));
  assert.deepEqual(readFileSync(backup), f.bytes);
  assert.deepEqual(readFileSync(join(f.dir, 'events.key')), f.key);
  assert.equal(readdirSync(f.dir).some(p => p.endsWith('.tmp')), false);
  rmSync(f.store.path, { recursive: true });
  const restore = join(f.dir, 'restore.enc'); copyFileSync(backup, restore); renameSync(restore, f.store.path);
  assert.deepEqual(readFileSync(f.store.path), f.bytes);
  assert.deepEqual(f.store.load(), f.state);
});
