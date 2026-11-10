import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configSchema } from '../src/config.js';
import { EventManager } from '../src/events.js';
import { makeServer } from '../src/server.js';
import { sessionProjection } from '../src/session-observation.js';

const policy = { coreId: 'core-a', accessMode: 'restricted', sendMode: 'idle-only', sendAllowlist: [{ address: 't1', created_ms: 123 }] };
const terminal = { address: 't1', created_ms: 123, pid: 42, state: 'live', status: { state: 'idle' }, status_ms: 999, secret: 'private' };

test('projection distinguishes authorization, preflight and delivery without claiming freshness', () => {
  const result = sessionProjection(terminal, policy, 456);
  assert.equal(result.send_enabled, true);
  assert.deepEqual(result.send_preflight, { eligible: true, reason: null, atomic_status_guard: 'idle', delivered: false });
  assert.deepEqual(result.observation, { adapter_observed_at_ms: 456, producer_last_reported_at_ms: null, reporting_capability: null });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(sessionProjection({ ...terminal, created_ms: 124 }, policy, 456).send_preflight.reason, 'lifetime_mismatch');
  assert.equal(sessionProjection(terminal, { ...policy, coreId: undefined }, 456).send_preflight.reason, 'not_authorized');
});

test('working, blocked, error and unknown never become ready; done requires normal mode', () => {
  for (const state of ['working', 'blocked', 'error', null, 'done']) {
    const t = { ...terminal, status: state ? { state } : null };
    assert.equal(sessionProjection(t, policy, 456).send_preflight.reason, 'status_not_ready');
    const normal = sessionProjection(t, { ...policy, sendMode: 'normal' }, 456);
    assert.equal(normal.send_preflight.eligible, state === 'done');
    assert.equal(normal.send_preflight.delivered, false);
    if (state === 'done') assert.equal(normal.send_preflight.atomic_status_guard, null);
  }
  assert.equal(sessionProjection({ ...terminal, state: 'finished' }, policy, 456).send_preflight.reason, 'not_live');
  assert.equal(sessionProjection({ ...terminal, pid: null }, { ...policy, accessMode: 'trusted-core' }, 456).send_preflight.reason, 'program_not_verified');
});

test('event diagnostics are owner scoped, secret free and strictly nonmutating', () => {
  const manager = new EventManager(null, {}, { now: () => 100, autoDispatch: false });
  manager.state.subscriptions = [
    { id: 'owned', owner: 'a', expiresAt: 200, secret: 'private-secret', callbackUrl: 'https://private.example' },
    { id: 'expired', owner: 'a', expiresAt: 50 },
    { id: 'foreign', owner: 'b', expiresAt: 200 }
  ];
  manager.state.outbox = [{ subscriptionId: 'owned' }, { subscriptionId: 'expired' }, { subscriptionId: 'foreign' }];
  manager.persist = () => assert.fail('diagnostics must never write');
  manager.cleanupExpired = () => assert.fail('diagnostics must never clean up');
  const before = structuredClone(manager.state);
  assert.deepEqual(manager.getDiagnostics('a'), { enabled: true, active_subscriptions: 1, expired_subscriptions: 1, queued_deliveries: 1, polling_started: false, delivery_stopped: false, live_receipt_verified: null });
  assert.deepEqual(manager.state, before);
  assert.equal(manager.getDiagnostics('other').active_subscriptions, 0);
  assert.ok(!/private|foreign|owned|expired"/.test(JSON.stringify(manager.getDiagnostics('a'))));
});

test('diagnostics tool uses existing manager, never a second state store or core call', async t => {
  const config = configSchema.parse({ socketPath: '/tmp/test.sock', events: { enabled: true } });
  const manager = new EventManager(null, config, { now: () => 100, autoDispatch: false });
  manager.state.subscriptions = [{ id: 'a', owner: 'caller', expiresAt: 200 }, { id: 'b', owner: 'other', expiresAt: 200 }];
  manager.startPolling = async () => {};
  manager.persist = () => assert.fail('read tool must not persist');
  const core = { call() { assert.fail('read tool must not call core'); } };
  const server = makeServer(core, config, manager, 'caller');
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const result = JSON.parse((await client.callTool({ name: 'events_diagnostics', arguments: {} })).content[0].text);
  assert.equal(result.active_subscriptions, 1);
  assert.equal(manager.state.subscriptions.length, 2);
});

test('duplicate address preflight mirrors actual first-match lifetime rejection without dispatch', async t => {
  const config = configSchema.parse({ socketPath: '/tmp/test.sock', ...policy, sendAllowlist: [
    { address: 't1', created_ms: 122 }, { address: 't1', created_ms: 123 }
  ] });
  const calls = [];
  const core = { async call(method) { calls.push(method); if (method === 'terminal.list') return { terminals: [terminal] }; assert.fail('No mutation permitted'); } };
  const server = makeServer(core, config);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = JSON.parse((await client.callTool({ name: 'list_sessions', arguments: {} })).content[0].text).sessions[0];
  assert.equal(listed.send_enabled, true, 'legacy policy projection retained');
  assert.equal(listed.send_preflight.eligible, false);
  assert.equal(listed.send_preflight.reason, 'lifetime_mismatch');
  const sent = await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'must not deliver' } });
  assert.equal(sent.isError, true);
  assert.match(sent.content[0].text, /identity is no longer live/);
  assert.deepEqual(calls, ['terminal.list', 'terminal.list']);
});

test('disabled diagnostics never initialize events and report unknown receipt', async t => {
  const config = configSchema.parse({ socketPath: '/tmp/test.sock' });
  const server = makeServer({}, config);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual(JSON.parse((await client.callTool({ name: 'events_diagnostics', arguments: {} })).content[0].text), { enabled: false, live_receipt_verified: null });
});
