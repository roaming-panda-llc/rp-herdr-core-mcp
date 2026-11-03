import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configSchema } from '../src/config.js';
import { HostRuntime } from '../src/runtime.js';
import { CoreClient } from '../src/core.js';
import { makeServer } from '../src/server.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';

function mockCore(identity) {
  const calls = [];
  return {
    calls,
    close() {},
    async call(method, params, expected) {
      calls.push({ method, params, expected });
      assert.equal(expected, identity);
      if (method === 'hello') return { version: '0.1.15', generation: 1, framed: false, core: { id: identity }, methods: ['terminal.list', 'terminal.read', 'terminal.send'] };
      if (method === 'terminal.list') return { terminals: [] };
      if (method === 'terminal.read') return { text: identity, complete: true, how: 'screen' };
      throw new Error('Unexpected method');
    }
  };
}

async function setup(t, eventsEnabled = false) {
  const core = mockCore('test-core');
  const config = configSchema.parse({ socketPath: '/tmp/test.sock', events: { enabled: eventsEnabled } });
  const server = makeServer(core, config);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return { core, config, server, client };
}

const data = r => JSON.parse(r.content[0].text);

test('events capability is absent by default', async t => {
  const { server } = await setup(t, false);
  const caps = server.server.getCapabilities();
  assert.equal(caps.events, undefined);
});

test('events capability is present when enabled', async t => {
  const { server } = await setup(t, true);
  const caps = server.server.getCapabilities();
  assert.deepEqual(caps.events, {});
});

test('events/list returns exact catalog with correct schemas', async t => {
  const { client } = await setup(t, true);
  const result = await client.request({ method: 'events/list', params: {} }, ResultSchema);
  assert.ok(Array.isArray(result.events));
  assert.equal(result.events.length, 3);
  assert.equal(result.nextCursor, null);
  
  const names = result.events.map(e => e.name).sort();
  assert.deepEqual(names, ['terminal.created', 'terminal.finished', 'terminal.status_changed']);
  
  for (const event of result.events) {
    assert.ok(event.name);
    assert.ok(event.description);
    assert.deepEqual(event.delivery, ['webhook']);
    assert.ok(event.inputSchema);
    assert.ok(event.payloadSchema);
    assert.equal(event.inputSchema.type, 'object');
    assert.equal(event.inputSchema.additionalProperties, false);
    assert.equal(event.payloadSchema.type, 'object');
    assert.equal(event.payloadSchema.additionalProperties, false);
  }
  
  // Verify terminal.created schema
  const created = result.events.find(e => e.name === 'terminal.created');
  assert.ok(created);
  assert.deepEqual(Object.keys(created.inputSchema.properties), ['host']);
  assert.deepEqual(created.payloadSchema.required.sort(), ['created_ms', 'host', 'terminal'].sort());
  
  // Verify terminal.status_changed schema
  const statusChanged = result.events.find(e => e.name === 'terminal.status_changed');
  assert.ok(statusChanged);
  assert.deepEqual(Object.keys(statusChanged.inputSchema.properties).sort(), ['host', 'terminal'].sort());
  assert.deepEqual(statusChanged.payloadSchema.required.sort(), ['host', 'new_status', 'previous_status', 'terminal', 'timestamp_ms'].sort());
  
  // Verify terminal.finished schema
  const finished = result.events.find(e => e.name === 'terminal.finished');
  assert.ok(finished);
  assert.deepEqual(Object.keys(finished.inputSchema.properties).sort(), ['host', 'terminal'].sort());
  assert.deepEqual(finished.payloadSchema.required.sort(), ['finished_ms', 'host', 'terminal'].sort());
});

test('events/list ignores cursor parameter', async t => {
  const { client } = await setup(t, true);
  const result = await client.request({ method: 'events/list', params: { cursor: 'some-cursor' } }, ResultSchema);
  assert.equal(result.events.length, 3);
  assert.equal(result.nextCursor, null);
});

test('events/subscribe returns MethodNotFound (stub)', async t => {
  const { client } = await setup(t, true);
  await assert.rejects(
    client.request({ method: 'events/subscribe', params: { name: 'terminal.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://example.com/callback', secret: 'whsec_test' } } }, ResultSchema),
    /MethodNotFound|not implemented/
  );
});

test('events/unsubscribe returns MethodNotFound (stub)', async t => {
  const { client } = await setup(t, true);
  await assert.rejects(
    client.request({ method: 'events/unsubscribe', params: { name: 'terminal.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://example.com/callback' } } }, ResultSchema),
    /MethodNotFound|not implemented/
  );
});

test('unknown event method returns MethodNotFound', async t => {
  const { client } = await setup(t, true);
  await assert.rejects(
    client.request({ method: 'events/unknown', params: {} }, ResultSchema),
    /Method not found|MethodNotFound/
  );
});

test('all five original tools unchanged and listed', async t => {
  for (const eventsEnabled of [false, true]) {
    const { client } = await setup(t, eventsEnabled);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['create_session', 'list_hosts', 'list_sessions', 'read_output', 'send_prompt']);
  }
});

test('raw initialize response includes events capability when enabled', async t => {
  const { server } = await setup(t, true);
  const caps = server.server.getCapabilities();
  assert.ok('events' in caps);
  assert.deepEqual(caps.events, {});
});

test('raw initialize response excludes events capability when disabled', async t => {
  const { server } = await setup(t, false);
  const caps = server.server.getCapabilities();
  assert.equal(caps.events, undefined);
});

test('events/list not a registered tool', async t => {
  const { client } = await setup(t, true);
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert.equal(tools.includes('events/list'), false);
  assert.equal(tools.includes('events_list'), false);
  assert.equal(tools.includes('events'), false);
});

test('config schema accepts events.enabled boolean', () => {
  const c1 = configSchema.parse({ socketPath: '/tmp/a.sock', events: { enabled: true } });
  assert.equal(c1.events.enabled, true);
  const c2 = configSchema.parse({ socketPath: '/tmp/a.sock', events: { enabled: false } });
  assert.equal(c2.events.enabled, false);
  const c3 = configSchema.parse({ socketPath: '/tmp/a.sock' });
  assert.equal(c3.events, undefined);
});

test('config schema rejects invalid events config', () => {
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/a.sock', events: { enabled: 'yes' } }));
  assert.throws(() => configSchema.parse({ socketPath: '/tmp/a.sock', events: { unknown: true } }));
});