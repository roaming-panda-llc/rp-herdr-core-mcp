import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeServer } from '../src/server.js';

const sensitive = 'PRIVATE_SENTINEL_NEVER_LOG';
const params = () => ({ name: 'terminal.finished', arguments: {},
  delivery: { mode: 'webhook', url: `https://callback.example/${sensitive}`, secret: sensitive },
  _meta: { progressToken: 7, 'example/context': { private: sensitive } } });
async function setup(t) {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(JSON.parse(line)));
  const calls = [];
  const manager = {
    async startPolling() {},
    handleList(p) { calls.push(p); return { events: [] }; },
    async handleSubscribe(owner, p) { calls.push(p); return { id: 'synthetic' }; },
    async handleUnsubscribe(owner, p) { calls.push(p); return {}; }
  };
  const server = makeServer({}, { events: { enabled: true } }, manager);
  const client = new Client({ name: 'diagnostics-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, manager, calls, logs };
}
const record = category => ({ method: 'events/subscribe', outcome: category === 'success' ? 'accepted' : 'rejected', category });

test('all Events methods accept and preserve standard and extension metadata', async t => {
  const { client, calls, logs } = await setup(t);
  const p = params();
  await client.request({ method: 'events/list', params: { _meta: p._meta } }, ResultSchema);
  await client.request({ method: 'events/subscribe', params: p }, ResultSchema);
  const { secret, ...delivery } = p.delivery;
  await client.request({ method: 'events/unsubscribe', params: { ...p, delivery } }, ResultSchema);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call._meta, p._meta);
  assert.deepEqual(logs, [record('success')]);
});

test('invalid subscription schema logs once, does not call handler, and preserves SDK error code', async t => {
  const { client, calls, logs } = await setup(t);
  for (const p of [undefined, {}, { ...params(), unexpected: sensitive },
    { ...params(), delivery: { ...params().delivery, secret: 42 } }]) {
    await assert.rejects(client.request({ method: 'events/subscribe', params: p }, ResultSchema), e => e.code === -32603);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, Array.from({ length: 4 }, () => record('schema_invalid')));
});

test('handler and callback errors log only allowlisted categories, preserving protocol errors', async t => {
  const { client, manager, logs } = await setup(t);
  for (const reason of [null, 'challenge_failed', 'timeout', 'http_4xx', 'http_5xx', sensitive]) {
    const code = reason === null ? -32602 : -32015;
    manager.handleSubscribe = async () => {
      throw Object.assign(new Error(sensitive), { code, data: { reason, private: sensitive } });
    };
    await assert.rejects(client.request({ method: 'events/subscribe', params: params() }, ResultSchema), e => e.code === code && e.data.private === sensitive);
  }
  assert.deepEqual(logs, ['handler_failed', 'challenge_failed', 'timeout', 'http_4xx', 'http_5xx', 'callback_failed'].map(record));
  assert.ok(!JSON.stringify(logs).includes(sensitive));
});

test('diagnostic sink failure does not change a successful subscription response', async t => {
  const { client } = await setup(t);
  t.mock.method(console, 'error', () => { throw new Error('sink unavailable'); });
  assert.deepEqual(await client.request({ method: 'events/subscribe', params: params() }, ResultSchema), { id: 'synthetic' });
});
