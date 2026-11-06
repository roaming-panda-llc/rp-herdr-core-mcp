import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.js';
import { EventManager } from '../src/events.js';
import { EventStore } from '../src/event-store.js';

// Exact hash used by 190d723 and the first Escape release, independent of the
// new implementation. All state/keys below are synthetic in disposable paths.
const legacyScope = c => createHash('sha256').update(JSON.stringify({ hosts: c.hosts, coreId: c.coreId, socketPath: c.socketPath })).digest('hex');
const config = () => configSchema.parse({ defaultHost: 'mini', hosts: {
  mini: { coreId: 'synthetic-mini', connection: { type: 'unix', socketPath: '/tmp/synthetic.sock' } },
  remote: { coreId: 'synthetic-remote', connection: { type: 'ssh', destination: 'test@example.test', hcPath: '/opt/hc', session: 'test', allowCoreAutoStart: true } }
} });
const escape = { enabled: true, approvals: [{ action_id: 'test_action', terminal: 't1', created_ms: 123, pid: 456, action: 'dismiss-nonapproval-ui', status: 'idle', screen_sha256: '0'.repeat(64), expires_ms: 999999 }] };
function fixture(t, c) {
  const dir = mkdtempSync(join(tmpdir(), 'escape-event-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir);
  const state = { version: 1, scope: legacyScope(c), sequence: 7,
    subscriptions: [{ id: 'sub', owner: 'synthetic-owner', secret: 'synthetic-secret', expiresAt: 999999 }],
    outbox: [{ subscriptionId: 'sub', body: 'synthetic-payload', eventId: 'event-7', attempt: 2 }],
    history: [{ eventId: 'event-7', cursor: 'created:7' }], terminals: [{ host: 'mini', address: 't1', created_ms: 123 }],
    initializedHosts: ['mini'], created: ['synthetic-marker'] };
  store.save(state);
  return { dir, store, state, key: readFileSync(join(dir, 'events.key')), bytes: readFileSync(join(dir, 'events.enc')) };
}
function open(t, f, c) {
  const m = new EventManager(null, c, { store: f.store, now: () => 100, autoDispatch: false, transport: () => assert.fail('No callbacks during scope migration') });
  t.after(() => m.stopPolling());
  return m;
}
test('pre-Escape encrypted state survives adding, updating, disabling and removing host Escape policy', t => {
  const original = config(), f = fixture(t, original);
  for (const policy of [escape, { ...escape, approvals: [{ ...escape.approvals[0], pid: 789, expires_ms: 888888 }] }, { enabled: false, approvals: [] }, undefined]) {
    const next = config(); if (policy) next.hosts.mini.escape = policy;
    const before = readFileSync(join(f.dir, 'events.enc'));
    const m = open(t, f, next);
    assert.deepEqual(m.state, f.state);
    // No migration/write is needed for the deployment's pre-Escape scope.
    assert.deepEqual(readFileSync(join(f.dir, 'events.enc')), before);
    m.persist();
    assert.deepEqual(f.store.load(), f.state);
    assert.deepEqual(readFileSync(join(f.dir, 'events.key')), f.key);
  }
});
test('initial Escape full-host scope migrates only from exact config, preserving durable fields and key', t => {
  const current = config(); current.hosts.mini.escape = escape;
  const f = fixture(t, current), expected = { ...f.state, scope: legacyScope(config()) };
  assert.notEqual(expected.scope, f.state.scope);
  const m = open(t, f, current);
  assert.deepEqual(m.state, expected);
  assert.deepEqual(f.store.load(), expected, 'normalized scope persisted before return');
  assert.deepEqual(readFileSync(join(f.dir, 'events.key')), f.key);
  const changed = config(); changed.hosts.mini.escape = { enabled: false, approvals: [] };
  assert.deepEqual(open(t, f, changed).state, expected);
  assert.equal(f.store.load().scope, legacyScope(config()), 'old adapter can reopen with pre-Escape config');
});
for (const [name, mutate] of [
  ['core ID', c => c.hosts.mini.coreId = 'different'],
  ['socket', c => c.hosts.mini.connection.socketPath = '/tmp/other.sock'],
  ['SSH destination', c => c.hosts.remote.connection.destination = 'other@example.test'],
  ['SSH session', c => c.hosts.remote.connection.session = 'other'],
  ['SSH executable', c => c.hosts.remote.connection.hcPath = '/other/hc'],
  ['host rename', c => { c.hosts.renamed = c.hosts.mini; delete c.hosts.mini; }],
  ['host removal', c => delete c.hosts.remote],
  ['host addition', c => c.hosts.extra = structuredClone(c.hosts.remote)],
  ['creation profiles', c => c.hosts.mini.profiles = { pi: { executable: '/opt/pi' } }],
  ['existing non-Escape policy', c => c.hosts.mini.sendMode = 'normal']
]) test(`Escape cannot mask ${name} change, for old or normalized scopes`, t => {
  for (const legacyEscape of [false, true]) {
    const prior = config(); if (legacyEscape) prior.hosts.mini.escape = escape;
    const f = fixture(t, prior), changed = structuredClone(prior);
    changed.hosts.mini.escape = escape; mutate(changed);
    assert.throws(() => open(t, f, changed), /different core configuration/);
    assert.deepEqual(readFileSync(join(f.dir, 'events.enc')), f.bytes);
    assert.deepEqual(readFileSync(join(f.dir, 'events.key')), f.key);
  }
});
test('legacy full hash with a simultaneously changed Escape policy fails closed without rewriting state', t => {
  const prior = config(); prior.hosts.mini.escape = escape;
  const f = fixture(t, prior), changed = config(); changed.hosts.mini.escape = { enabled: false, approvals: [] };
  assert.throws(() => open(t, f, changed), /different core configuration/);
  assert.deepEqual(readFileSync(join(f.dir, 'events.enc')), f.bytes);
});
test('legacy local socket scope is unchanged by Escape and still binds core/socket', t => {
  const c = configSchema.parse({ coreId: 'synthetic-local', socketPath: '/tmp/local.sock' }), f = fixture(t, c);
  assert.deepEqual(open(t, f, { ...c, escape }).state, f.state);
  for (const change of [{ coreId: 'other' }, { socketPath: '/tmp/other.sock' }]) assert.throws(() => open(t, f, { ...c, ...change, escape }), /different core configuration/);
});
test('migration persistence failure aborts startup without delivering or replacing durable state', t => {
  const current = config(); current.hosts.mini.escape = escape;
  const f = fixture(t, current);
  const store = { load: () => structuredClone(f.state), save: () => { throw new Error('synthetic disk failure'); } };
  assert.throws(() => new EventManager(null, current, { store, now: () => 100, autoDispatch: false }), /write failed/);
  assert.deepEqual(readFileSync(join(f.dir, 'events.enc')), f.bytes);
});

test('parsed defaults/order preserve the pre-Escape 190d723 scope fingerprint', () => {
  // Produced by the unmodified configSchema at deployed 190d723 with the
  // synthetic config() input, not by the new EventManager implementation.
  assert.equal(legacyScope(config()), '9f868f571cf57ef51b92c556a138d5ce20dd3f9fad992dd8a6e0ff54a204b36a');
});
