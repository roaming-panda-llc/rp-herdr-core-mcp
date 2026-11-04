import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { EventStore } from '../src/event-store.js';

const integration = process.env.HC_MCP_INTEGRATION === '1';
async function eventually(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for mock event state');
}

test('real stdio entrypoint persists subscriptions across requests and restart with mocked signed HTTPS', { skip: !integration }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-stdio-events-'));
  const socketPath = join(directory, 'core.sock');
  const stateDirectory = join(directory, 'events');
  const callbackLog = join(directory, 'callbacks.jsonl');
  const configPath = join(directory, 'config.json');
  await writeFile(callbackLog, '');
  let terminals = [], reads = 0;
  const sockets = new Set();
  const mockCore = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
        assert.ok(['hello', 'terminal.list'].includes(message.method));
        const result = message.method === 'hello'
          ? { version: '0.1.17', generation: 1, framed: false, core: { id: 'mock-core' }, methods: ['hello', 'terminal.list'] }
          : (reads++, { terminals, hidden_finished: 0, machines: [] });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
      }
    });
  });
  mockCore.listen(socketPath); await once(mockCore, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => mockCore.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await writeFile(configPath, JSON.stringify({ socketPath, coreId: 'mock-core', events: { enabled: true, stateDirectory } }));
  const callbacks = async () => (await readFile(callbackLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', resolve('test-support/webhook-preload.mjs'), resolve('src/index.js'), configPath],
      env: { HERDR_TEST_CALLBACK_LOG: callbackLog }, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'mock-tunnel', version: '1' });
    await client.connect(transport);
    t.after(() => client.close());
    return { client, transport, stderr: () => stderr };
  };
  const first = await connect();
  await eventually(() => reads > 0);
  const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
  const params = { _meta: { progressToken: 7, 'example/context': 'test-only' }, name: 'terminal.created', arguments: { host: 'local' }, delivery: { mode: 'webhook', url: 'https://callback.example/hooks', secret } };
  await assert.rejects(first.client.request({ method: 'events/subscribe', params: { ...params, unexpected: 'private-test-value' } }, ResultSchema), e => e.code === -32603);
  const subscription = await first.client.request({ method: 'events/subscribe', params }, ResultSchema);
  assert.equal((await callbacks())[0].subscriptionId, subscription.id);
  assert.equal((await first.client.request({ method: 'events/list', params: {} }, ResultSchema)).events.length, 3);
  terminals = [{ address: 't1', created_ms: 10, state: 'live', pid: 42, status: { state: 'idle' } }];
  await eventually(async () => (await callbacks()).some(e => e.name === 'terminal.created'));
  await eventually(() => new EventStore(stateDirectory).load().outbox.length === 0);
  const firstPid = first.transport.pid;
  await first.client.close();
  assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' });
  assert.deepEqual(first.stderr().trim().split('\n').map(JSON.parse), [{ method: 'events/subscribe', outcome: 'rejected', category: 'schema_invalid' }, { method: 'events/subscribe', outcome: 'accepted', category: 'success' }]);
  const stored = new EventStore(stateDirectory).load();
  assert.equal(stored.subscriptions.length, 1);
  assert.equal(stored.subscriptions[0].owner, 'stdio');
  assert.equal(stored.subscriptions[0].cursor, 1);
  // The restarted process must resume without another subscription handshake.
  terminals.push({ address: 't2', created_ms: 20, state: 'live', pid: 43, status: { state: 'idle' } });
  const second = await connect();
  await eventually(async () => (await callbacks()).filter(e => e.name === 'terminal.created').length === 2);
  assert.equal((await callbacks()).filter(e => e.kind === 'verification').length, 1);
  const { secret: unused, ...delivery } = params.delivery;
  await second.client.request({ method: 'events/unsubscribe', params: { ...params, delivery } }, ResultSchema);
  const checkpoint = reads;
  terminals.push({ address: 't3', created_ms: 30, state: 'live', pid: 44 });
  await eventually(() => reads >= checkpoint + 2);
  assert.equal((await callbacks()).filter(e => e.name === 'terminal.created').length, 2);
  await second.client.close();
  assert.equal(new EventStore(stateDirectory).load().subscriptions.length, 0);
  assert.equal(second.stderr(), '');
});
