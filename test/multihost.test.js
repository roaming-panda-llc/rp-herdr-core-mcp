import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configSchema } from '../src/config.js';
import { HostRuntime, sshArguments, sshConnector } from '../src/runtime.js';
import { CoreClient } from '../src/core.js';
import { makeServer } from '../src/server.js';
const profile = { agent: 'pi', executable: '/opt/bin/pi', args: [], variants: { fast: ['--provider', 'configured-provider', '--model', 'configured-model'] }, projects: { demo: '/srv/demo' } };
function configuration() {
  return configSchema.parse({ defaultHost: 'local', hosts: {
    local: { connection: { type: 'unix', socketPath: '/tmp/a.sock' }, coreId: 'core-a', accessMode: 'trusted-core', sendMode: 'normal', profiles: { coding: profile } },
    remote: { connection: { type: 'ssh', destination: 'agent@worker.example', hcPath: '/opt/bin/hc', session: 'chosen', allowCoreAutoStart: true }, coreId: 'core-b' }
  } });
}
function mockCore(identity) {
  const calls = []; let records = [];
  return { calls, close() {}, get records() { return records; }, set records(v) { records = v; },
    async call(method, params, expected) {
      calls.push({ method, params, expected });
      assert.equal(expected, identity);
      if (method === 'hello') return { version: '0.1.15' };
      if (method === 'terminal.list') return { terminals: records.filter(t => !params.labels || Object.entries(params.labels).every(([k, v]) => t.labels?.[k] === v)) };
      if (method === 'terminal.run') {
        const r = { ...params, address: 't1b', created_ms: 123, pid: 42, state: 'live', reason: null, status: { state: 'idle' } };
        records.push(r); return r;
      }
      if (method === 'terminal.get') return records.find(r => r.address === params.terminal);
      if (method === 'terminal.send') return { turn: 1, status: 'idle' };
      if (method === 'terminal.read') return { text: identity, complete: true, how: 'screen' };
      throw new Error('Unexpected method');
    }
  };
}
async function setup(t, cfg = configuration(), overrides = []) {
  const cores = [mockCore('core-a'), mockCore('core-b')].map((c, i) => overrides[i] ?? c);
  let i = 0; const runtime = new HostRuntime(cfg, () => cores[i++]);
  const server = makeServer(runtime, cfg), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); runtime.close(); });
  return { cores, runtime, client, cfg };
}
const data = r => JSON.parse(r.content[0].text);
const createArgs = { profile: 'coding', project: 'demo', variant: 'fast', request_id: 'request-001' };
test('legacy config remains restricted/default local and forbids ambiguous host configuration', () => {
  const c = configSchema.parse({ socketPath: '/tmp/core.sock' });
  assert.equal(c.accessMode, 'restricted'); assert.equal(c.sendMode, 'idle-only');
  for (const extra of [{ hosts: {} }, { defaultHost: 'other' }, { accessMode: 'trusted-core' }]) assert.throws(() => configSchema.parse({ socketPath: '/tmp/core.sock', ...extra }));
});
test('named hosts require explicit identities, default selection and SSH auto-start approval', () => {
  const c = configuration();
  for (const mutate of [v => delete v.hosts.remote.coreId, v => v.hosts.remote.connection.destination = 'worker.example', v => v.accessMode = 'trusted-core', v => v.hosts.remote.connection.allowCoreAutoStart = false, v => delete v.hosts.remote.connection.session, v => v.hosts.remote.connection.session = '..', v => v.defaultHost = 'missing', v => v.hosts.local.accessMode = 'restricted']) {
    const copy = structuredClone(c); mutate(copy); assert.throws(() => configSchema.parse(copy));
  }
});
test('SSH command is operator-only fixed arg array with strict host keys and session quoting', () => {
  const conn = configuration().hosts.remote.connection;
  const args = sshArguments({ ...conn, hcPath: "/opt/owner's/hc" });
  assert.ok(args.includes('-oStrictHostKeyChecking=yes')); assert.ok(args.includes('-oBatchMode=yes'));
  assert.equal(args.at(-2), 'agent@worker.example');
  assert.equal(args.at(-1), "env 'HC_SESSION=chosen' '/opt/owner'\\''s/hc' connect");
  assert.throws(() => sshArguments({ ...conn, allowCoreAutoStart: false }));
});
test('host selection is isolated, pinned on reads, and never falls back', async t => {
  const { client, cores } = await setup(t);
  assert.equal(data(await client.callTool({ name: 'read_output', arguments: { terminal: 't1' } })).text, 'core-a');
  assert.equal(data(await client.callTool({ name: 'read_output', arguments: { host: 'remote', terminal: 't1' } })).text, 'core-b');
  const counts = cores.map(c => c.calls.length);
  assert.equal((await client.callTool({ name: 'read_output', arguments: { host: 'missing', terminal: 't1' } })).isError, true);
  assert.deepEqual(cores.map(c => c.calls.length), counts);
});
test('list_hosts reports partial availability without leaking transport or project paths', async t => {
  const broken = { close() {}, async call() { throw new Error('Core connection failed'); } };
  const { client } = await setup(t, configuration(), [undefined, broken]);
  const result = data(await client.callTool({ name: 'list_hosts', arguments: {} }));
  assert.deepEqual(result.hosts.map(h => h.available), [true, false]);
  assert.equal(result.hosts[1].error, 'Core connection failed');
  assert.equal(JSON.stringify(result).includes('/srv/demo'), false);
  assert.equal(JSON.stringify(result).includes('worker.example'), false);
  assert.deepEqual(result.hosts[0].profiles[0].variants, ['fast']);
});
test('create launches exact configured argv/cwd without a shell or task, verifies startup, allows follow-up', async t => {
  const { client, cores } = await setup(t);
  const result = data(await client.callTool({ name: 'create_session', arguments: createArgs }));
  assert.equal(result.verified, true); assert.equal(result.ready, true); assert.equal(result.adapter_prompt_sent, false);
  const run = cores[0].calls.find(c => c.method === 'terminal.run').params;
  assert.deepEqual(run.argv, ['/opt/bin/pi', '--provider', 'configured-provider', '--model', 'configured-model']);
  assert.equal(run.cwd, '/srv/demo'); assert.equal(run.keep, false); assert.equal(run.wait, false);
  assert.equal(run.line, undefined); assert.equal(run.env, undefined); assert.equal(run.on, undefined);
  assert.equal((await client.callTool({ name: 'send_prompt', arguments: { terminal: result.terminal, prompt: 'approved task' } })).isError, undefined);
  assert.equal(cores[1].calls.length, 0);
});
test('restricted host cannot create or implicitly gain write access', async t => {
  const { client, cores } = await setup(t);
  assert.equal((await client.callTool({ name: 'create_session', arguments: { ...createArgs, host: 'remote' } })).isError, true);
  assert.equal((await client.callTool({ name: 'send_prompt', arguments: { host: 'remote', terminal: 't1', prompt: 'hello' } })).isError, true);
  assert.equal(cores[1].calls.length, 0);
});
test('caller cannot select arbitrary project paths, variants, profiles or a shell line', async t => {
  const { client, cores } = await setup(t);
  for (const change of [{ project: '../outside' }, { project: 'missing' }, { variant: '--model=evil' }, { variant: 'missing' }, { profile: 'constructor' }, { name: 'bad;name' }, { name: '-foo' }, { name: '.foo' }, { name: 't1b' }]) {
    assert.equal((await client.callTool({ name: 'create_session', arguments: { ...createArgs, ...change } })).isError, true);
  }
  assert.equal(cores[0].calls.filter(c => c.method === 'terminal.run').length, 0);
});
test('concurrent/repeated request IDs share one run and differing parameters conflict', async t => {
  const { client, cores } = await setup(t);
  const responses = await Promise.all([1, 2].map(() => client.callTool({ name: 'create_session', arguments: createArgs })));
  assert.equal(data(responses[0]).terminal, data(responses[1]).terminal);
  assert.equal(data(responses[1]).cached_receipt, true);
  assert.equal(data(responses[1]).verification_is_current, false);
  assert.equal(cores[0].calls.filter(c => c.method === 'terminal.run').length, 1);
  assert.equal((await client.callTool({ name: 'create_session', arguments: { ...createArgs, name: 'different' } })).isError, true);
});
test('request label reconciliation survives adapter restart without recreating a session', async t => {
  const first = await setup(t);
  await first.client.callTool({ name: 'create_session', arguments: createArgs });
  const second = await setup(t, configuration(), first.cores);
  const result = data(await second.client.callTool({ name: 'create_session', arguments: createArgs }));
  assert.equal(result.created_now, false); assert.equal(result.verified, true);
  assert.equal(first.cores[0].calls.filter(c => c.method === 'terminal.run').length, 1);
});
test('uncertain create failure is cached and never automatically replayed', async t => {
  const core = mockCore('core-a'); const call = core.call.bind(core);
  core.call = async (method, params, expected) => { if (method === 'terminal.run') { core.calls.push({ method }); throw new Error('creation outcome UNKNOWN'); } return call(method, params, expected); };
  const { client } = await setup(t, configuration(), [core]);
  for (let i = 0; i < 2; i++) assert.equal((await client.callTool({ name: 'create_session', arguments: createArgs })).isError, true);
  assert.equal(core.calls.filter(c => c.method === 'terminal.run').length, 1);
});
test('failed startup verification is not advertised as ready or followed by another run', async t => {
  const core = mockCore('core-a'); const call = core.call.bind(core);
  core.call = async (method, params, expected) => method === 'terminal.get' ? { address: 't1b', created_ms: 999 } : call(method, params, expected);
  const { client } = await setup(t, configuration(), [core]);
  const result = data(await client.callTool({ name: 'create_session', arguments: createArgs }));
  assert.equal(result.verified, false); assert.equal(result.ready, false);
  assert.equal(core.calls.filter(c => c.method === 'terminal.run').length, 1);
});
test('SSH child bridge uses no local shell and closes its child after bounded RPC', async () => {
  let spawned, killed = [];
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = signal => { killed.push(signal); child.signalCode = signal; queueMicrotask(() => child.emit('close')); };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk;
    const i = buffer.indexOf('\n'); if (i < 0) return;
    const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'hello' ? { version: '0.1.16', generation: 1, framed: false, core: { id: 'core-b' }, methods: ['terminal.list'] } : { terminals: [] } }) + '\n');
  });
  const connect = sshConnector(configuration().hosts.remote.connection, (command, args, options) => { spawned = { command, args, options }; queueMicrotask(() => child.emit('spawn')); return child; });
  const core = new CoreClient({ connect, timeoutMs: 1000 });
  assert.deepEqual(await core.call('terminal.list', {}, 'core-b'), { terminals: [] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned.command, '/usr/bin/ssh'); assert.equal(spawned.options.shell, false);
  assert.deepEqual(killed, ['SIGTERM']); core.close();
});

test('cached creation receipt never claims current readiness after the session exits', async t => {
  const { client, cores } = await setup(t);
  await client.callTool({ name: 'create_session', arguments: createArgs });
  cores[0].records[0].state = 'finished'; cores[0].records[0].pid = null;
  const result = data(await client.callTool({ name: 'create_session', arguments: createArgs }));
  assert.equal(result.cached_receipt, true); assert.equal(result.ready, false); assert.equal(result.verified, false);
  assert.equal(result.verification_is_current, false);
  assert.equal(cores[0].calls.filter(c => c.method === 'terminal.run').length, 1);
});
test('SSH-capable read tool annotations disclose that the bridge may start a core', async t => {
  const { client } = await setup(t);
  for (const tool of (await client.listTools()).tools.filter(t => ['list_hosts', 'list_sessions', 'read_output'].includes(t.name))) assert.equal(tool.annotations.readOnlyHint, false);
});

test('creation cancellation after reconciliation prevents terminal.run', async t => {
  const core = mockCore('core-a'); const call = core.call.bind(core);
  core.call = async (method, params, expected) => { if (method === 'terminal.list') await new Promise(r => setTimeout(r, 60)); return call(method, params, expected); };
  const { client } = await setup(t, configuration(), [core]);
  const abort = new AbortController();
  const result = client.callTool({ name: 'create_session', arguments: createArgs }, undefined, { signal: abort.signal });
  setTimeout(() => abort.abort(), 10); await assert.rejects(result);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(core.calls.filter(c => c.method === 'terminal.run').length, 0);
});
test('trusted-core still refuses a lost/absent program before sending', async t => {
  const { client, cores } = await setup(t);
  cores[0].records = [{ address: 't1', created_ms: 1, state: 'live', pid: null, reason: 'holder_lost', status: { state: 'idle' } }];
  assert.equal((await client.callTool({ name: 'send_prompt', arguments: { terminal: 't1', prompt: 'hello' } })).isError, true);
  assert.equal(cores[0].calls.filter(c => c.method === 'terminal.send').length, 0);
});
test('creation ledger rejects growth at its bound rather than evicting uncertain requests', async t => {
  const { client, runtime, cores } = await setup(t);
  const ledger = runtime.resolve().ledger;
  for (let i = 0; i < 256; i++) ledger.set(`existing-${i}`, {});
  assert.equal((await client.callTool({ name: 'create_session', arguments: createArgs })).isError, true);
  assert.equal(cores[0].calls.length, 0);
});

test('SSH bridge timeout terminates a stuck child and escalates only that child', async () => {
  const child = new EventEmitter(); const killed = [];
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = signal => { killed.push(signal); if (signal === 'SIGKILL') { child.signalCode = signal; queueMicrotask(() => child.emit('close')); } };
  const connect = sshConnector(configuration().hosts.remote.connection, () => { queueMicrotask(() => child.emit('spawn')); return child; });
  const core = new CoreClient({ connect, timeoutMs: 20 });
  await assert.rejects(core.call('terminal.list', {}, 'core-b'), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']); assert.equal(core.sockets.size, 0); core.close();
});
