import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pressEscape, escapeInput } from '../src/controls.js';
import { configSchema } from '../src/config.js';
import { CoreClient } from '../src/core.js';
import { makeServer } from '../src/server.js';
import { HostRuntime } from '../src/runtime.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const args = { host: 'local', terminal: 't1', action_id: 'cancel_01', inspected_and_authorized: true };
function fixture() {
  const calls = [];
  const terminal = { address: 't1', created_ms: 123, pid: 42, state: 'live', status: { state: 'idle' } };
  const approval = { action_id: 'cancel_01', terminal: 't1', created_ms: 123, pid: 42, action: 'dismiss-nonapproval-ui', status: 'idle', screen_sha256: createHash('sha256').update('menu').digest('hex'), expires_ms: Date.now() + 60000 };
  const ctx = { id: 'local', config: { coreId: 'test-core', escape: { enabled: true, approvals: [approval] } }, core: { async call(method, params, coreId) {
    calls.push({ method, params, coreId });
    if (method === 'terminal.list') return { terminals: [terminal] };
    if (method === 'terminal.read') return { text: 'menu', complete: true };
    return { status: 'idle', turn: 2 };
  } } };
  return { ctx, terminal, approval, calls };
}
test('Escape has strict bounded input; no keys, bytes, Enter, alias or omitted host', () => {
  for (const change of [{ keys: ['esc'] }, { key: 'enter' }, { prompt: '\x1b' }, { terminal: 'host/t1' }, { terminal: 'name' }, { inspected_and_authorized: false }, { host: undefined }]) assert.equal(escapeInput.safeParse({ ...args, ...change }).success, false);
});
test('explicit opt-in and core pin required; existing trusted/send policies grant nothing', async () => {
  assert.equal(configSchema.parse({ socketPath: '/tmp/test' }).escape, undefined);
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/test', escape: { enabled: true } }));
  for (const escape of [undefined, { enabled: false, approvals: [] }, { enabled: true, approvals: [] }]) {
    const f = fixture(); f.ctx.config = { coreId: 'test-core', accessMode: 'trusted-core', sendAllowlist: [{ address: 't1', created_ms: 123 }], escape };
    await assert.rejects(pressEscape(f.ctx, args)); assert.equal(f.calls.length, 0);
  }
});
test('exact approval sends one Escape, no force or if; requires readback and makes no dismissal claim', async () => {
  const f = fixture(); const r = await pressEscape(f.ctx, args);
  assert.deepEqual(f.calls.map(c => c.method), ['terminal.list', 'terminal.read', 'terminal.list', 'terminal.keys']);
  assert.deepEqual(f.calls.at(-1), { method: 'terminal.keys', params: { terminal: 't1', keys: ['esc'] }, coreId: 'test-core' });
  assert.equal(r.ui_dismissed, 'unverified'); assert.equal(r.atomic_status_guard, null); assert.equal(r.readback_required, true);
  await assert.rejects(pressEscape(f.ctx, args), /already attempted/);
});
for (const [label, change] of Object.entries({ recycled: { created_ms: 456 }, missingPid: { pid: undefined }, invalidPid: { pid: -1 }, fractionalPid: { pid: 1.5 }, differentPid: { pid: 43 }, finished: { state: 'finished' }, reason: { reason: 'dead' }, wrongTerminal: { address: 't2' } })) {
  test(`reject ${label}`, async () => {
    const f = fixture(); Object.assign(f.terminal, change);
    await assert.rejects(pressEscape(f.ctx, args), /not live/); assert.ok(!f.calls.some(c => c.method === 'terminal.keys'));
  });
}
for (const state of ['blocked', 'error', 'working', 'unknown', null, 'done']) test(`reject unapproved state ${state}`, async () => {
  const f = fixture(); f.terminal.status = { state };
  await assert.rejects(pressEscape(f.ctx, args), /exact approved/);
  assert.ok(!f.calls.some(c => c.method === 'terminal.keys'));
});
test('explicit done cancellation works; expiry/host/action mismatch fail without dispatch', async () => {
  const f = fixture(); f.approval.status = f.terminal.status.state = 'done';
  assert.equal((await pressEscape(f.ctx, args)).preflight_status, 'done');
  for (const change of [{ expires_ms: 0 }, { action: 'approve' }, { terminal: 't2' }]) {
    const g = fixture(); Object.assign(g.approval, change); await assert.rejects(pressEscape(g.ctx, args)); assert.equal(g.calls.length, 0);
  }
  await assert.rejects(pressEscape(fixture().ctx, { ...args, host: 'wrong' }), /host mismatch/);
});
test('exact screen, complete read and second status check are required', async () => {
  for (const mode of ['screen', 'incomplete', 'race', 'duplicates']) {
    const f = fixture(); const call = f.ctx.core.call; let lists = 0;
    f.ctx.core.call = async (...a) => {
      const r = await call(...a);
      if (a[0] === 'terminal.read') return { text: mode === 'screen' ? 'approval dialog' : 'menu', complete: mode !== 'incomplete' };
      if (a[0] === 'terminal.list' && ++lists === 2 && mode === 'race') f.terminal.status.state = 'blocked';
      if (a[0] === 'terminal.list' && mode === 'duplicates') r.terminals.push(f.terminal);
      return r;
    };
    await assert.rejects(pressEscape(f.ctx, args)); assert.ok(!f.calls.some(c => c.method === 'terminal.keys'));
  }
});
test('cancelled preflight never sends and can be reconsidered; concurrent attempts cannot duplicate input', async () => {
  const f = fixture(), controller = new AbortController(), call = f.ctx.core.call;
  f.ctx.core.call = async (...a) => { controller.abort(); return call(...a); };
  await assert.rejects(pressEscape(f.ctx, args, controller.signal), /cancelled/);
  f.ctx.core.call = call;
  const results = await Promise.allSettled([pressEscape(f.ctx, args), pressEscape(f.ctx, args)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'terminal.keys').length, 1);
});
test('malformed success is unknown delivery and consumes action', async () => {
  const f = fixture(), call = f.ctx.core.call;
  f.ctx.core.call = async (...a) => a[0] === 'terminal.keys' ? {} : call(...a);
  await assert.rejects(pressEscape(f.ctx, args), /UNKNOWN.*no automatic retry/);
  await assert.rejects(pressEscape(f.ctx, args), /already attempted/);
});

async function wire(t, failure, override = {}) {
  const calls = [], sockets = new Set();
  const hello = { version: '0.1.15', generation: 1, framed: false, core: { id: 'test-core' }, methods: ['terminal.keys'], ...override };
  const accept = s => {
    sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); let buffer = '';
    s.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); calls.push(m);
        if (m.method === 'hello') {
          const reply = () => s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: hello }) + '\n');
          if (failure === 'slow-hello') setTimeout(reply, 40); else reply();
        }
        else if (failure === 'disconnect') s.destroy();
        else if (failure === 'shape') s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
        else if (failure === 'flush') s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, data: { kind: 'unavailable' } } }) + '\n');
        else if (failure === 'rejected') s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, data: { kind: 'status_mismatch' } } }) + '\n');
        else if (failure === 'malformed') s.write('broken\n');
        else if (failure === 'success') s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { status: 'idle', turn: 1 } }) + '\n');
      }
    });
  };
  let server, dir, connect, socketPath;
  if (process.env.HC_MCP_INTEGRATION === '1') {
    dir = await mkdtemp(join(tmpdir(), 'escape-test-')); socketPath = join(dir, 'core.sock');
    server = net.createServer(accept); server.listen(socketPath); await once(server, 'listening');
  } else connect = () => {
    const a = new EventEmitter(), b = new EventEmitter(); let closed = false;
    a.write = data => queueMicrotask(() => { if (!closed) b.emit('data', Buffer.from(data)); });
    b.write = data => queueMicrotask(() => { if (!closed) a.emit('data', Buffer.from(data)); });
    a.destroy = b.destroy = () => { if (closed) return; closed = true; queueMicrotask(() => { a.emit('close'); b.emit('close'); }); };
    accept(b); queueMicrotask(() => a.emit('connect')); return a;
  };
  const core = new CoreClient({ socketPath, connect, timeoutMs: 100 });
  t.after(async () => { core.close(); for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); if (dir) await rm(dir, { recursive: true, force: true }); });
  return { core, calls };
}
for (const version of ['0.1.15', '0.1.18']) for (const failure of ['timeout', 'disconnect', 'malformed', 'shape', 'rejected', 'flush']) test(`keys ${version} ${failure} after dispatch is unknown and never retried`, async t => {
  const f = await wire(t, failure, { version });
  await assert.rejects(f.core.call('terminal.keys', { terminal: 't1', keys: ['esc'] }, 'test-core'), e => e.delivery === 'unknown' && /no automatic retry/.test(e.message));
  assert.equal(f.calls.filter(c => c.method === 'terminal.keys').length, 1);
});
for (const override of [{ version: '0.2.0' }, { version: '0.1.17' }, { version: '0.1.19' }, { version: '0.1.18-dev' }, { methods: [] }, { core: { id: 'wrong' } }]) test(`keys capability/version/identity fails closed: ${JSON.stringify(override)}`, async t => {
  const f = await wire(t, 'success', override);
  await assert.rejects(f.core.call('terminal.keys', { terminal: 't1', keys: ['esc'] }, 'test-core'));
  assert.ok(!f.calls.some(c => c.method === 'terminal.keys'));
});
test('cancellation during core handshake prevents key dispatch', async t => {
  const f = await wire(t, 'success'), controller = new AbortController(); controller.abort();
  await assert.rejects(f.core.call('terminal.keys', { terminal: 't1', keys: ['esc'] }, 'test-core', { signal: controller.signal }), /cancelled/);
  assert.ok(!f.calls.some(c => c.method === 'terminal.keys'));
});
test('MCP registers strict schema and routes exact named host without fallback', async t => {
  const f = fixture();
  const runtime = new HostRuntime({ defaultHost: 'local', hosts: { local: { ...f.ctx.config, connection: { type: 'unix', socketPath: '/tmp/mock' } } } }, () => f.ctx.core);
  const server = makeServer(runtime, {}), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  for (const change of [{ host: 'other' }, { keys: ['enter'] }, { inspected_and_authorized: false }]) assert.equal((await client.callTool({ name: 'press_escape', arguments: { ...args, ...change } })).isError, true);
  assert.equal(f.calls.length, 0);
  const r = await client.callTool({ name: 'press_escape', arguments: args }); assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(JSON.parse(r.content[0].text).delivery, 'core_acknowledged');
});

test('Escape policy rejects broad/ambiguous grants and wrong configuration scope', () => {
  const f = fixture();
  for (const change of [{ status: 'blocked' }, { action: 'approve' }, { pid: 0 }, { keys: ['enter'] }, { screen_sha256: '*' }]) {
    assert.throws(() => configSchema.parse({ socketPath: '/tmp/test', coreId: 'test-core', escape: { enabled: true, approvals: [{ ...f.approval, ...change }] } }));
  }
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/test', coreId: 'test-core', escape: { enabled: true, approvals: [f.approval, f.approval] } }));
  assert.throws(() => configSchema.parse({ defaultHost: 'local', escape: { enabled: true }, hosts: { local: { coreId: 'test-core', connection: { type: 'unix', socketPath: '/tmp/test' } } } }));
});
test('send_prompt still rejects Escape and other raw controls before touching core', async t => {
  const server = makeServer({ call() { assert.fail('Raw controls must never reach core'); } }, { sendAllowlist: [] });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  for (const prompt of ['\x1b', '\x03', '\r']) assert.equal((await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt } })).isError, true);
});

test('approval expiring during core handshake prevents key dispatch', async t => {
  const f = await wire(t, 'slow-hello');
  await assert.rejects(f.core.call('terminal.keys', { terminal: 't1', keys: ['esc'] }, 'test-core', { deadlineMs: Date.now() + 15 }), /expired before dispatch/);
  assert.ok(!f.calls.some(c => c.method === 'terminal.keys'));
});
test('Escape passes the exact approval expiry to the core dispatch gate', async () => {
  const f = fixture(), call = f.ctx.core.call;
  f.ctx.core.call = async (...a) => {
    if (a[0] === 'terminal.keys') assert.equal(a[3].deadlineMs, f.approval.expires_ms);
    return call(...a);
  };
  await pressEscape(f.ctx, args);
});

for (const version of ['0.1.16', '0.1.18']) test(`reviewed Escape version ${version} remains supported`, async t => {
  const f = await wire(t, 'success', { version });
  assert.deepEqual(await f.core.call('terminal.keys', { terminal: 't1', keys: ['esc'] }, 'test-core'), { status: 'idle', turn: 1 });
  assert.equal(f.calls.filter(c => c.method === 'terminal.keys').length, 1);
});
