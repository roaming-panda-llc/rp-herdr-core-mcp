import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createSession } from '../src/create.js';
const hc017 = JSON.parse(readFileSync(new URL('./fixtures/core-0.1.17.json', import.meta.url), 'utf8'));
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
const realTransport = process.env.HC_MCP_INTEGRATION === '1';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CoreClient } from '../src/core.js';
import { makeServer, makeHttpApp } from '../src/server.js';
import { configSchema } from '../src/config.js';
const hello = { generation: 1, version: '0.1.15', framed: false, core: { id: 'test-core' }, methods: ['terminal.list', 'terminal.read', 'terminal.send'], features: [] };
async function fixture(t, handler, override = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hc-mcp-'));
  const path = join(dir, 'core.sock');
  const sockets = new Set(), calls = [];
  const accept = socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); calls.push(message);
        const reply = value => socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }) + '\n');
        if (message.method === 'hello') reply({ ...hello, ...override });
        else handler(message, reply, socket);
      }
    });
  };
  let server;
  let connect;
  if (realTransport) {
    server = net.createServer(accept);
    server.listen(path); await once(server, 'listening');
  } else {
    connect = () => {
      const client = new EventEmitter(), peer = new EventEmitter();
      let closed = false;
      client.write = chunk => { queueMicrotask(() => { if (!closed) peer.emit('data', Buffer.from(chunk)); }); return true; };
      peer.write = chunk => { queueMicrotask(() => { if (!closed) client.emit('data', Buffer.from(chunk)); }); return true; };
      client.destroy = peer.destroy = error => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => { if (error) client.emit('error', error); client.emit('close'); peer.emit('close'); });
      };
      accept(peer);
      queueMicrotask(() => { if (!closed) client.emit('connect'); });
      return client;
    };
  }
  const core = new CoreClient({ socketPath: path, timeoutMs: 200, ...(connect ? { connect } : {}) });
  t.after(async () => { core.close(); for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { core, calls, path, dir };
}
async function clientFor(t, core, config = { sendAllowlist: [] }) {
  const server = makeServer(core, config), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const unpack = r => JSON.parse(r.content[0].text);
test('core uses pinned hello and correct params, handles split UTF-8 lines', async t => {
  const f = await fixture(t, (m, _reply, socket) => {
    const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { text: 'héllo' } }) + '\n');
    const split = line.indexOf(Buffer.from('é')) + 1;
    socket.write(line.subarray(0, split)); socket.write(line.subarray(split));
  });
  assert.equal((await f.core.call('terminal.read', { terminal: 't1', lines: 2 })).text, 'héllo');
  assert.deepEqual(f.calls.map(x => x.method), ['hello', 'terminal.read']);
  assert.equal(f.core.sockets.size, 0);
});
for (const [name, override] of [['malformed version', { version: 17 }], ['generation', { generation: 2 }], ['framing', { framed: true }], ['methods', { methods: [] }], ['malformed methods', { methods: 7 }]]) {
  test(`reject incompatible ${name} before operation`, async t => {
    const f = await fixture(t, () => assert.fail('Operation must not run'), override);
    await assert.rejects(f.core.call('terminal.list', {}), /compatible/);
  });
}
test('reject core identity mismatch before operation', async t => {
  const f = await fixture(t, () => assert.fail('Operation must not run'));
  await assert.rejects(f.core.call('terminal.send', {}, 'different'), /identity mismatch/);
});
for (const [name, payload] of [['bad JSON', 'garbage\n'], ['wrong id', '{"jsonrpc":"2.0","id":99,"result":{}}\n'], ['oversized', 'x'.repeat(1048577)]]) {
  test(`reject ${name} and close connection`, async t => {
    const f = await fixture(t, (_m, _r, s) => s.write(payload));
    await assert.rejects(f.core.call('terminal.list', {})); assert.equal(f.core.sockets.size, 0);
  });
}
test('send timeout is unknown delivery and is never retried', async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(f.core.call('terminal.send', {}), /delivery is UNKNOWN/);
  assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
});
test('shutdown rejects active calls and prevents new ones', async t => {
  const f = await fixture(t, () => {});
  const pending = f.core.call('terminal.list', {}); f.core.close();
  await assert.rejects(pending); await assert.rejects(f.core.call('terminal.list', {}), /unavailable/);
});
test('config rejects accidental write enablement and unknown options', () => {
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/a', sendAllowlist: [{ address: 't1', created_ms: 1 }] }));
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/a', shell: 'sh' }));
});
test('tools list, bounded read/list and disabled send', async t => {
  const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.list' ? { terminals: [{ address: 't1', created_ms: 1, title: 'a'.repeat(5000), status: { state: 'idle' } }, { address: 'remote/t2' }] } : { text: 'abcxyz', complete: true, how: 'screen' }));
  const client = await clientFor(t, f.core);
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['events_diagnostics', 'list_sessions', 'read_output', 'send_prompt', 'list_hosts', 'create_session', 'press_escape']);
  const list = unpack(await client.callTool({ name: 'list_sessions', arguments: {} }));
  assert.equal(list.total, 1); assert.equal(list.sessions[0].title.length, 512);
  const output = unpack(await client.callTool({ name: 'read_output', arguments: { terminal: 't1', max_chars: 3 } }));
  assert.equal(output.text, 'xyz'); assert.equal(output.complete, false);
  const send = await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'hello' } });
  assert.equal(send.isError, true); assert.ok(!f.calls.some(c => c.method === 'terminal.send'));
});
test('approved send pins core and terminal creation and enforces idle, not force or wait', async t => {
  const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.list' ? { terminals: [{ address: 't1', created_ms: 123, state: 'live' }] } : { turn: 5, started: null }));
  const client = await clientFor(t, f.core, { coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }] });
  const result = unpack(await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'hello\nthere' } }));
  assert.equal(result.task_completed, false);
  assert.deepEqual(f.calls.at(-1).params, { terminal: 't1', text: 'hello\nthere', if: 'idle', force: false, wait: false });
});
test('reused terminal id cannot receive prompt', async t => {
  const f = await fixture(t, (_m, reply) => reply({ terminals: [{ address: 't1', created_ms: 999, state: 'live' }] }));
  const client = await clientFor(t, f.core, { coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }] });
  assert.equal((await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'hello' } })).isError, true);
  assert.ok(!f.calls.some(c => c.method === 'terminal.send'));
});
test('MCP stdio child discovers and reads through mock core and closes cleanly', { skip: !realTransport }, async t => {
  const f = await fixture(t, (_m, reply) => reply({ text: 'mock screen', complete: true, how: 'screen' }));
  const config = join(f.dir, 'config.json'); await writeFile(config, JSON.stringify({ socketPath: f.path }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/index.js'), config], stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close()); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 7);
  assert.equal(unpack(await client.callTool({ name: 'read_output', arguments: { terminal: 't1' } })).text, 'mock screen');
  await client.close();
});
test('HTTP fails closed, rejects origin/host/body and serves authenticated official MCP client', { skip: !realTransport }, async t => {
  const f = await fixture(t, (_m, reply) => reply({ terminals: [] }));
  const config = { publicOrigin: 'https://herdr.example.com', port: 8787, sendAllowlist: [] };
  assert.throws(() => makeHttpApp(f.core, config, undefined));
  const token = 'test-only-not-a-real-secret-'.repeat(3);
  // Bind the mock listener first so the Host allowlist matches its real port.
  // Node fetch removes user-supplied Host: never rely on a Host override here.
  const listener = http.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  config.port = listener.address().port;
  const app = makeHttpApp(f.core, config, token);
  listener.on('request', app);
  t.after(() => new Promise(r => { listener.closeAllConnections(); listener.close(r); }));
  const url = `http://127.0.0.1:${listener.address().port}/mcp`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' })).status, 403);
  // Test literal Host handling using node:http, not fetch's ignored Host header.
  const rawHostStatus = host => new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...headers, host } }, res => {
      const status = res.statusCode;
      res.resume(); res.once('end', () => resolve(status)); res.once('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP Host probe timed out')));
    req.once('error', reject); req.end('{}');
  });
  assert.equal(await rawHostStatus('evil.test'), 403);
  // A valid public Host reaches MCP parsing (rather than Host rejection).
  assert.equal(await rawHostStatus('herdr.example.com'), 406);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(70000) })).status, 413);
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(new URL(path, url), { method });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('www-authenticate'), null);
    }
  }
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['events_diagnostics', 'list_sessions', 'read_output', 'send_prompt', 'list_hosts', 'create_session', 'press_escape']);
  assert.equal(unpack(await client.callTool({ name: 'list_sessions', arguments: {} })).total, 0);
});

test('HTTP startup rejects missing, weak or placeholder credentials and non-HTTPS origin', () => {
  const config = { publicOrigin: 'https://herdr.example.com', sendAllowlist: [] };
  for (const token of [undefined, '', 'short', 'replace-me-'.repeat(10)]) assert.throws(() => makeHttpApp({}, config, token));
  assert.throws(() => makeHttpApp({}, { ...config, publicOrigin: 'http://herdr.example.com' }, 'test-secret-'.repeat(8)));
});
test('stdio process starts, discovers tools, and exits on client close without hc', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-stdio-'));
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ socketPath: '/tmp/nonexistent-herdr-test.sock' }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/index.js'), config], stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 7);
  await client.close();
});

test('base-30 hc terminal IDs are accepted and read always requests screen only', async t => {
  const f = await fixture(t, (_m, reply) => reply({ text: 'screen', complete: true, how: 'screen' }));
  const client = await clientFor(t, f.core);
  const result = await client.callTool({ name: 'read_output', arguments: { terminal: 't1b' } });
  assert.ok(!result.isError);
  assert.deepEqual(f.calls.at(-1).params, { terminal: 't1b', lines: 0 });
});

test('HTTP auth middleware enforces bearer, host and origin without a listener', () => {
  const token = 'test-only-not-a-real-secret-'.repeat(3);
  const app = makeHttpApp({}, { publicOrigin: 'https://herdr.example.com', port: 8787 }, token);
  const guard = app.router.stack[0].handle;
  const valid = { authorization: `Bearer ${token}`, host: 'herdr.example.com', origin: 'https://herdr.example.com' };
  for (const [headers, expected] of [[{ host: 'herdr.example.com' }, 401], [{ ...valid, authorization: 'Bearer wrong' }, 401], [{ ...valid, host: 'evil.test' }, 403], [{ ...valid, origin: 'null' }, 403], [{ ...valid, origin: 'https://evil.test' }, 403], [valid, 200]]) {
    let status;
    const res = { set() { return this; }, status(n) { status = n; return this; }, end() {} };
    guard({ headers }, res, () => { status = 200; });
    assert.equal(status, expected);
  }
});
test('cancellation during preflight never begins a send', async t => {
  let sent = false;
  const core = { async call(method) {
    if (method === 'terminal.send') { sent = true; return { turn: 1 }; }
    await new Promise(resolve => setTimeout(resolve, 60));
    return { terminals: [{ address: 't1', created_ms: 1, state: 'live' }] };
  } };
  const client = await clientFor(t, core, { coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 1 }] });
  const controller = new AbortController();
  const result = client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'hello' } }, undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(result);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent, false);
});

function probeGuard(method, path, headers = {}) {
  const token = 'test-only-not-a-real-secret-'.repeat(3);
  const core = { call() { assert.fail('Metadata/auth guard must never access hc'); } };
  const app = makeHttpApp(core, { publicOrigin: 'https://herdr.example.com', port: 8787, sendAllowlist: [] }, token);
  const guard = app.router.stack[0].handle;
  const result = { status: undefined, headers: {}, advanced: false };
  const res = {
    set(name, value) { result.headers[name] = value; return this; },
    status(value) { result.status = value; return this; },
    end() {}
  };
  guard({ method, path, headers: { host: '127.0.0.1:8787', ...headers } }, res, () => { result.advanced = true; });
  return result;
}
test('unsupported protected-resource GET/HEAD metadata is unauthenticated 404, not a challenge', () => {
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const result = probeGuard(method, path);
      assert.equal(result.status, 404);
      assert.equal(result.headers['WWW-Authenticate'], undefined);
      assert.equal(result.headers['Cache-Control'], 'no-store');
      assert.equal(result.advanced, false);
    }
  }
});
test('MCP and all non-exempt method/path combinations still require bearer auth', () => {
  for (const [method, path] of [
    ['GET', '/mcp'], ['HEAD', '/mcp'], ['POST', '/mcp'], ['DELETE', '/mcp'],
    ['POST', '/.well-known/oauth-protected-resource'], ['OPTIONS', '/.well-known/oauth-protected-resource/mcp'],
    ['GET', '/.well-known/oauth-protected-resource/other'], ['GET', '/.well-known/oauth-protected-resource/mcp/'],
    ['GET', '/.well-known/oauth-authorization-server'], ['GET', '/.well-known/openid-configuration'], ['GET', '/other']
  ]) {
    const result = probeGuard(method, path);
    assert.equal(result.status, 401, `${method} ${path}`);
    assert.equal(result.headers['WWW-Authenticate'], 'Bearer');
    assert.equal(result.advanced, false);
  }
});
test('metadata exception never bypasses Host or Origin validation', () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    for (const headers of [{ host: 'evil.test' }, { origin: 'https://evil.test' }, { origin: 'null' }]) {
      for (const method of ['GET', 'HEAD']) assert.equal(probeGuard(method, path, headers).status, 403);
    }
  }
});
test('valid MCP bearer still advances and metadata does not mutate send configuration', () => {
  const result = probeGuard('POST', '/mcp', { authorization: `Bearer ${'test-only-not-a-real-secret-'.repeat(3)}` });
  assert.equal(result.advanced, true);
  const config = { publicOrigin: 'https://herdr.example.com', port: 8787, sendAllowlist: [] };
  const before = JSON.stringify(config);
  makeHttpApp({}, config, 'test-only-not-a-real-secret-'.repeat(3));
  assert.equal(JSON.stringify(config), before);
  assert.deepEqual(config.sendAllowlist, []);
});

test('sendMode defaults to idle-only and only accepts explicit supported modes', () => {
  assert.equal(configSchema.parse({ socketPath: '/tmp/a' }).sendMode, 'idle-only');
  assert.equal(configSchema.parse({ socketPath: '/tmp/a', sendMode: 'normal' }).sendMode, 'normal');
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/a', sendMode: 'force' }));
});
for (const state of ['idle', 'done']) {
  test(`normal mode ${state} follows documented guarded/standard send parameters`, async t => {
    const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.list' ? { terminals: [{ address: 't1', created_ms: 123, state: 'live', status: { state } }] } : { turn: 9, status: state, started: true }));
    const client = await clientFor(t, f.core, { sendMode: 'normal', coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }] });
    const result = unpack(await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'follow up' } }));
    assert.equal(result.preflight_status, state);
    assert.equal(result.atomic_status_guard, state === 'idle' ? 'idle' : null);
    assert.equal(result.send_mode, 'normal');
    const params = f.calls.at(-1).params;
    assert.equal(params.force, false); assert.equal(params.wait, false);
    assert.equal(Object.hasOwn(params, 'if'), state === 'idle');
    if (state === 'idle') assert.equal(params.if, 'idle');
    assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
  });
}
for (const state of ['working', 'blocked', 'error', null, 'unrecognized']) {
  test(`normal mode rejects ${state} preflight without a send`, async t => {
    const f = await fixture(t, (_m, reply) => reply({ terminals: [{ address: 't1', created_ms: 123, state: 'live', status: state === null ? null : { state } }] }));
    const client = await clientFor(t, f.core, { sendMode: 'normal', coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }] });
    const result = await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'follow up' } });
    assert.equal(result.isError, true);
    assert.ok(!f.calls.some(c => c.method === 'terminal.send'));
  });
}
test('normal mode retains both core and terminal lifetime identity checks', async t => {
  const f = await fixture(t, (_m, reply) => reply({ terminals: [{ address: 't1', created_ms: 999, state: 'live', status: { state: 'done' } }] }));
  for (const coreId of ['test-core', 'wrong-core']) {
    const client = await clientFor(t, f.core, { sendMode: 'normal', coreId, sendAllowlist: [{ address: 't1', created_ms: 123 }] });
    assert.equal((await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'follow up' } })).isError, true);
  }
  assert.ok(!f.calls.some(c => c.method === 'terminal.send'));
});
test('normal done preflight does not pretend to atomically prevent a working-state race', async t => {
  const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.list' ? { terminals: [{ address: 't1', created_ms: 123, state: 'live', status: { state: 'done' } }] } : { turn: 10, status: 'working', started: true }));
  const client = await clientFor(t, f.core, { sendMode: 'normal', coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }] });
  const result = unpack(await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'follow up' } }));
  assert.equal(result.preflight_status, 'done'); assert.equal(result.status, 'working');
  assert.equal(result.atomic_status_guard, null); assert.equal(result.task_completed, false);
  assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
});
for (const [code, kind, delivery] of [[-32000, 'status_mismatch', 'not_sent'], [-32001, 'status_mismatch', 'unknown'], [-32000, 'blocked', 'unknown']]) {
  test(`only exact validated status rejection is known non-delivery: ${code}/${kind}`, async t => {
    const f = await fixture(t, (m, _reply, socket) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message: 'rejected', data: { kind } } }) + '\n'));
    await assert.rejects(f.core.call('terminal.send', { terminal: 't1', text: 'hello', if: 'idle', force: false }, 'test-core'), error => {
      assert.equal(error.delivery, delivery);
      assert.match(error.message, delivery === 'not_sent' ? /NOT SENT/ : /UNKNOWN/);
      return true;
    });
    assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
  });
}

test('default idle-only still rejects a done terminal through the atomic core predicate', async t => {
  const f = await fixture(t, (m, reply, socket) => {
    if (m.method === 'terminal.list') return reply({ terminals: [{ address: 't1', created_ms: 123, state: 'live', status: { state: 'done' } }] });
    assert.equal(m.params.if, 'idle');
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'not idle', data: { kind: 'status_mismatch' } } }) + '\n');
  });
  const client = await clientFor(t, f.core, { coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }] });
  const result = await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'follow up' } });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /NOT SENT/);
  assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
});
test('normal mode cannot grant write access without a lifetime allowlist', async t => {
  const core = { call() { assert.fail('No core calls expected for an unapproved send'); } };
  const client = await clientFor(t, core, { sendMode: 'normal', coreId: 'test-core', sendAllowlist: [] });
  assert.equal((await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'follow up' } })).isError, true);
});


test('HTTP Host guard admits only the configured loopback port before bearer validation', () => {
  const app = makeHttpApp({}, { publicOrigin: 'https://herdr.example.com', port: 43210 }, 'test-only-not-a-real-secret-'.repeat(3));
  const guard = app.router.stack[0].handle;
  for (const [host, expected] of [['127.0.0.1:43210', 401], ['127.0.0.1:8787', 403], ['herdr.example.com', 401], ['evil.test', 403]]) {
    let status;
    const res = { set() { return this; }, status(value) { status = value; return this; }, end() {} };
    guard({ method: 'POST', path: '/mcp', headers: { host } }, res, () => assert.fail('Missing bearer must not advance'));
    assert.equal(status, expected, host);
  }
});

test('reviewed hc 0.1.16 is accepted with the same pinned identity and plain protocol', async t => {
  const f = await fixture(t, (_m, reply) => reply({ terminals: [] }), { version: '0.1.16' });
  assert.deepEqual(await f.core.call('terminal.list', {}, 'test-core'), { terminals: [] });
});
test('terminal.run timeout reports unknown creation and never replays', async t => {
  const f = await fixture(t, () => {}, { methods: ['terminal.run'] });
  await assert.rejects(f.core.call('terminal.run', { argv: ['/opt/bin/pi'] }, 'test-core'), error => {
    assert.equal(error.creation, 'unknown'); assert.match(error.message, /creation outcome is UNKNOWN/); return true;
  });
  assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
});

for (const [name, override] of [
  ['generation', { generation: 2 }], ['framing', { framed: true }],
  ['missing method', { methods: ['hello'] }], ['malformed method', { methods: ['terminal.list', 7] }],
  ['identity', { core: { id: 'other-core' } }],
  ['malformed version', { version: null }]
]) {
  test(`hc 0.1.17 retains ${name} rejection before dispatch`, async t => {
    const f = await fixture(t, () => assert.fail('Operation must not run'), { ...hc017.hello, ...override });
    await assert.rejects(f.core.call('terminal.list', {}, 'test-core'), /compatible|identity mismatch/);
    assert.deepEqual(f.calls.map(c => c.method), ['hello']);
  });
}

test('hc 0.1.17 lists and reads through MCP without attaching or scrolling', async t => {
  const f = await fixture(t, (m, reply) => {
    if (m.method === 'terminal.list') return reply({ terminals: [hc017.terminal], hidden_finished: 0, machines: [] });
    assert.equal(m.method, 'terminal.read');
    assert.deepEqual(m.params, { terminal: 't1', lines: 0 });
    reply(hc017.read);
  }, hc017.hello);
  const client = await clientFor(t, f.core, { coreId: 'test-core', sendAllowlist: [] });
  assert.equal(unpack(await client.callTool({ name: 'list_sessions', arguments: {} })).sessions[0].created_ms, 123);
  assert.equal(unpack(await client.callTool({ name: 'read_output', arguments: { terminal: 't1' } })).text, hc017.read.text);
  for (const call of f.calls.filter(c => c.method === 'hello')) assert.deepEqual(call.params, { generation: 1, framed: false });
  assert.ok(f.calls.every(c => ['hello', 'terminal.list', 'terminal.read'].includes(c.method)));
});

for (const state of ['idle', 'done', 'working', 'blocked', 'error']) {
  test(`hc 0.1.17 normal send preserves ${state} policy`, async t => {
    const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.list'
      ? { terminals: [{ ...hc017.terminal, status: { state } }], hidden_finished: 0, machines: [] } : hc017.send), hc017.hello);
    const client = await clientFor(t, f.core, { coreId: 'test-core', sendAllowlist: [{ address: 't1', created_ms: 123 }], sendMode: 'normal' });
    const result = await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'synthetic test' } });
    const sends = f.calls.filter(c => c.method === 'terminal.send');
    if (['idle', 'done'].includes(state)) {
      assert.equal(result.isError, undefined); assert.equal(sends.length, 1);
      assert.equal(sends[0].params.force, false); assert.equal(sends[0].params.wait, false);
      assert.equal(sends[0].params.if, state === 'idle' ? 'idle' : undefined);
      assert.equal(unpack(result).task_completed, false);
    } else { assert.equal(result.isError, true); assert.equal(sends.length, 0); }
  });
}

for (const [code, kind, delivery] of [
  [-32000, 'status_mismatch', 'not_sent'], [-32001, 'status_mismatch', 'unknown'],
  [-32000, 'unavailable', 'unknown'], [-32603, 'internal', 'unknown'], [-32000, 'blocked', 'unknown']
]) {
  test(`hc 0.1.17 send ${code}/${kind} retains ${delivery} outcome without retry`, async t => {
    const f = await fixture(t, (m, _reply, socket) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message: 'synthetic failure', data: { kind } } }) + '\n'), hc017.hello);
    await assert.rejects(f.core.call('terminal.send', { terminal: 't1', text: 'test', if: 'idle', force: false, wait: false }, 'test-core'), error => error.delivery === delivery);
    assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
  });
}

function creationHost(core) {
  return { id: 'local', core, ledger: new Map(), config: { coreId: 'test-core', accessMode: 'trusted-core', profiles: {
    coding: { executable: '/opt/bin/pi', args: ['--no-daemon'], variants: {}, projects: { demo: '/srv/demo' } }
  } } };
}
const creationInput = { profile: 'coding', project: 'demo', request_id: 'compat-017-creation' };

test('hc 0.1.17 flattened run result is verified by get and deduplicated without replay', async t => {
  let record;
  const f = await fixture(t, (m, reply) => {
    if (m.method === 'terminal.list') return reply({ terminals: record ? [record] : [], hidden_finished: 0, machines: [] });
    if (m.method === 'terminal.run') {
      assert.deepEqual(m.params.argv, ['/opt/bin/pi', '--no-daemon']);
      assert.equal(m.params.cwd, '/srv/demo');
      for (const key of ['wait', 'keep', 'rm']) assert.equal(m.params[key], false);
      assert.equal(m.params.no_parent, true); assert.equal(m.params.no_notify, true);
      record = { ...hc017.terminal, argv: m.params.argv, labels: m.params.labels };
      return reply(record);
    }
    assert.equal(m.method, 'terminal.get'); reply(record);
  }, hc017.hello);
  const host = creationHost(f.core);
  const first = await createSession(host, creationInput);
  assert.equal(first.verified, true); assert.equal(first.created_now, true);
  assert.equal((await createSession(host, creationInput)).cached_receipt, true);
  const reconciled = await createSession(creationHost(f.core), creationInput);
  assert.equal(reconciled.created_now, false); assert.equal(reconciled.verified, true);
  assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
});

for (const failure of ['flush-timeout', 'writer-stopped', 'connection-close', 'timeout']) {
  test(`hc 0.1.17 creation ${failure} stays unknown and cached attempts cannot recreate`, async t => {
    const f = await fixture(t, (m, reply, socket) => {
      if (m.method === 'terminal.list') return reply({ terminals: [], hidden_finished: 0, machines: [] });
      assert.equal(m.method, 'terminal.run');
      if (failure === 'timeout') return;
      if (failure === 'connection-close') return socket.destroy();
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: {
        code: failure === 'flush-timeout' ? -32000 : -32603, message: 'synthetic persistence failure',
        data: { kind: failure === 'flush-timeout' ? 'unavailable' : 'internal' }
      } }) + '\n');
    }, hc017.hello);
    const host = creationHost(f.core);
    for (let i = 0; i < 2; i++) await assert.rejects(createSession(host, creationInput), e => e.creation === 'unknown' && /reconcile request_id/.test(e.message));
    assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
  });
}

for (const version of ['0.1.14', '0.1.18', '0.2.0', '0.1.17-custom']) {
  test(`untested hc ${version} warns once and allows validated list/read`, async t => {
    const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.list' ? { terminals: [], hidden_finished: 0, machines: [] } : hc017.read), { ...hc017.hello, version });
    const warnings = []; f.core.warn = message => warnings.push(message);
    await f.core.call('terminal.list', {}, 'test-core');
    assert.equal((await f.core.call('terminal.read', { terminal: 't1', lines: 0 }, 'test-core')).text, hc017.read.text);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /untested/); assert.ok(warnings[0].includes(version));
  });
  test(`untested hc ${version} status rejection cannot claim known non-delivery`, async t => {
    const f = await fixture(t, (m, _reply, socket) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'not idle', data: { kind: 'status_mismatch' } } }) + '\n'), { ...hc017.hello, version });
    f.core.warn = () => {};
    await assert.rejects(f.core.call('terminal.send', { terminal: 't1', text: 'test', if: 'idle', force: false }, 'test-core'), e => e.delivery === 'unknown' && /UNKNOWN/.test(e.message));
    assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
  });
}

for (const override of [{ generation: 2 }, { framed: true }, { methods: [] }, { core: { id: 'wrong' } }]) {
  test(`untested version never relaxes protocol/identity guard ${JSON.stringify(override)}`, async t => {
    const f = await fixture(t, () => assert.fail('No operation allowed'), { ...hc017.hello, version: '0.2.0', ...override });
    const warnings = []; f.core.warn = message => warnings.push(message);
    await assert.rejects(f.core.call('terminal.send', {}, 'test-core'), /compatible|identity/);
    assert.deepEqual(f.calls.map(c => c.method), ['hello']);
    assert.equal(warnings.length, 0);
  });
}

test('all reviewed versions are silent and untested successful send/create remain usable', async t => {
  for (const version of ['0.1.15', '0.1.16', '0.1.17', '0.1.18']) {
    const f = await fixture(t, (m, reply) => reply(m.method === 'terminal.run' ? hc017.terminal : hc017.send), { ...hc017.hello, version });
    const warnings = []; f.core.warn = message => warnings.push(message);
    assert.equal((await f.core.call('terminal.send', { terminal: 't1', text: 'synthetic', force: false, wait: false }, 'test-core')).turn, 9);
    assert.equal((await f.core.call('terminal.run', { argv: ['/opt/bin/pi'], wait: false }, 'test-core')).address, 't1');
    assert.equal(warnings.length, version === '0.1.18' ? 1 : 0);
  }
});

for (const method of ['terminal.send', 'terminal.run']) {
  test(`untested version ${method} persistence failure is unknown and never replayed`, async t => {
    const f = await fixture(t, (m, _reply, socket) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'synthetic flush timeout', data: { kind: 'unavailable' } } }) + '\n'), { ...hc017.hello, version: '0.2.0' });
    f.core.warn = () => {};
    await assert.rejects(f.core.call(method, {}, 'test-core'), e => (method === 'terminal.send' ? e.delivery : e.creation) === 'unknown');
    assert.equal(f.calls.filter(c => c.method === method).length, 1);
  });
}
