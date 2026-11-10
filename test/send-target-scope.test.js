import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.js';
import { EventStore } from '../src/event-store.js';
import { EventManager } from '../src/events.js';
import { eventScope, rebindSendTargetExtension } from '../src/event-scope.js';

const target = { host: 'bo-control', address: 't1', created_ms: 123 };
const configuration = () => configSchema.parse({ defaultHost: 'bo-control', events: { enabled: true, stateDirectory: '/tmp/synthetic-state' }, hosts: {
  'bo-control': { coreId: 'synthetic-core', connection: { type: 'unix', socketPath: '/tmp/synthetic.sock' } }
} });
function setup(t) {
  const before = configuration(), after = structuredClone(before);
  after.hosts['bo-control'].sendAllowlist.push({ address: 't1', created_ms: 123 });
  const dir = mkdtempSync(join(tmpdir(), 'send-target-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir);
  const state = { version: 1, scope: eventScope(before), sequence: 7,
    subscriptions: [{ id: 'sub', owner: 'principal-a', secret: 'synthetic-secret', expiresAt: 999999 }],
    outbox: [{ subscriptionId: 'sub', eventId: 'event-7', attempt: 2 }], history: [{ cursor: 'created:7' }],
    terminals: [{ host: 'bo-control', address: 't1', created_ms: 123 }], initializedHosts: ['bo-control'], created: ['marker'] };
  store.save(state);
  return { before, after, dir, store, state };
}

test('explicit offline exact-lifetime extension preserves all state, encryption key and principal isolation', async t => {
  const { before, after, dir, store, state } = setup(t);
  const key = readFileSync(join(dir, 'events.key'));
  const initial = readFileSync(join(dir, 'events.enc'));
  const migrated = rebindSendTargetExtension(state, before, after, target);
  assert.deepEqual(state.scope, eventScope(before), 'input not mutated');
  assert.deepEqual({ ...migrated, scope: state.scope }, state);
  assert.notEqual(migrated.scope, state.scope);
  assert.deepEqual(readFileSync(join(dir, 'events.enc')), initial, 'pure plan writes nothing');
  const backup = join(dir, 'backup.enc'); copyFileSync(store.path, backup);
  store.save(migrated);
  assert.deepEqual(store.load(), migrated);
  assert.deepEqual(readFileSync(join(dir, 'events.key')), key);
  const manager = new EventManager(null, after, { store, now: () => 100, autoDispatch: false });
  t.after(() => manager.stopPolling());
  assert.equal(manager.getDiagnostics('principal-a').active_subscriptions, 1);
  assert.equal(manager.getDiagnostics('principal-b').active_subscriptions, 0, 'send grant cannot grant another principal event access');
  assert.throws(() => new EventManager(null, before, { store, now: () => 100 }), /different core configuration/);
  // Offline rollback restores the exact encrypted file atomically, not a newly
  // initialized store. Original key remains unchanged throughout.
  const rollback = join(dir, 'rollback.enc'); copyFileSync(backup, rollback); renameSync(rollback, store.path);
  assert.deepEqual(readFileSync(store.path), initial);
  assert.deepEqual(store.load(), state);
  assert.deepEqual(readFileSync(join(dir, 'events.key')), key);
});

for (const [name, mutate] of [
  ['core identity', c => c.hosts['bo-control'].coreId = 'other'],
  ['socket', c => c.hosts['bo-control'].connection.socketPath = '/tmp/other.sock'],
  ['access mode', c => c.hosts['bo-control'].accessMode = 'trusted-core'],
  ['send mode', c => c.hosts['bo-control'].sendMode = 'normal'],
  ['extra grant', c => c.hosts['bo-control'].sendAllowlist.push({ address: 't2', created_ms: 456 })],
  ['wrong lifetime', c => c.hosts['bo-control'].sendAllowlist[0].created_ms = 456],
  ['wrong address', c => c.hosts['bo-control'].sendAllowlist[0].address = 't2'],
  ['event store', c => c.events.stateDirectory = '/tmp/other'],
  ['event enablement', c => c.events.enabled = false],
  ['creation profiles', c => c.hosts['bo-control'].profiles = { x: { agent: 'pi', executable: '/opt/pi', projects: { x: '/tmp/x' } } }],
  ['principal/security configuration injection', c => c.principal = 'principal-b']
]) test(`exact extension rejects ${name} and does not modify protected files`, t => {
  const { before, after, dir, store, state } = setup(t);
  const initial = readFileSync(store.path), key = readFileSync(join(dir, 'events.key'));
  mutate(after);
  assert.throws(() => rebindSendTargetExtension(state, before, after, target));
  assert.deepEqual(readFileSync(store.path), initial);
  assert.deepEqual(readFileSync(join(dir, 'events.key')), key);
});

test('unknown prior scope, missing state, duplicate target and implicit startup migration fail closed', t => {
  const { before, after, store, state } = setup(t);
  assert.throws(() => rebindSendTargetExtension({ ...state, scope: 'unknown' }, before, after, target));
  assert.throws(() => rebindSendTargetExtension(null, before, after, target));
  assert.throws(() => rebindSendTargetExtension(state, after, after, target), /already has a grant/);
  assert.throws(() => new EventManager(null, after, { store, now: () => 100 }), /different core configuration/);
});

test('atomic state replacement failure leaves recoverable backup and key intact, no partial temp files', t => {
  const { before, after, dir, store, state } = setup(t);
  const initial = readFileSync(store.path), key = readFileSync(join(dir, 'events.key'));
  const backup = join(dir, 'backup.enc'); copyFileSync(store.path, backup);
  // Force rename to fail against a directory, after the encrypted temp is fsynced.
  rmSync(store.path); mkdirSync(store.path);
  assert.throws(() => store.save(rebindSendTargetExtension(state, before, after, target)));
  assert.deepEqual(readFileSync(backup), initial);
  assert.deepEqual(readFileSync(join(dir, 'events.key')), key);
  assert.equal(readdirSync(dir).some(p => p.endsWith('.tmp')), false);
  rmSync(store.path, { recursive: true }); copyFileSync(backup, store.path);
  assert.deepEqual(store.load(), state);
});
