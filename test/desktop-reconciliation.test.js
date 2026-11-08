import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../src/create.js';
test('config change after restart reconciles old terminal without claiming new visibility', async () => {
 let record; let runs=0;
 const core={call:async (method, params)=>{
  if(method==='terminal.list') return {terminals:record?[record]:[]};
  if(method==='terminal.run'){runs++;record={...params,address:'t1',created_ms:1,state:'live',pid:99,status:{state:'idle'}};return record;}
  if(method==='terminal.get') return record;
  throw Error(method);
 }};
 const profile={executable:'/usr/bin/true',args:[],variants:{},projects:{demo:'/tmp/demo'},desktopSpaces:{}};
 const host={id:'local',config:{accessMode:'trusted-core',coreId:'test',profiles:{pi:profile}},core,ledger:new Map()};
 const input={profile:'pi',project:'demo',request_id:'visibility-reconcile-test'};
 await createSession(host,input);
 profile.desktopSpaces.demo='fleet-demo';host.ledger=new Map();
 const r=await createSession(host,input);
 assert.equal(runs,1);assert.equal(r.terminal,'t1');assert.equal(r.desktop_space,null);assert.equal(r.desktop_visibility_requested,false);
});

// Synthetic configuration only: no deployment paths, identities or credentials.
import { configSchema } from '../src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HostRuntime } from '../src/runtime.js';
import { makeServer } from '../src/server.js';
function configured(spaces = { demo: 'workspace-demo' }) {
 return { defaultHost: 'local', hosts: { local: {
  connection: { type: 'unix', socketPath: '/tmp/synthetic-core.sock' },
  coreId: 'synthetic-core', accessMode: 'trusted-core',
  profiles: { coding: { agent: 'pi', executable: '/opt/bin/pi', projects: { demo: '/srv/demo' }, desktopSpaces: spaces } }
 } } };
}
function fixture(spaces) {
 const config = configSchema.parse(configured(spaces));
 const calls = []; let record; let failGet = false;
 const core = { close() {}, async call(method, params, expected) {
  calls.push({ method, params }); assert.equal(expected, 'synthetic-core');
  if (method === 'terminal.list') return { terminals: record ? [record] : [] };
  if (method === 'terminal.run') return record = { ...params, address: 't1', created_ms: 100, pid: 42, state: 'live', status: { state: 'idle' } };
  if (method === 'terminal.get') { if (failGet) throw Error('unavailable'); return record; }
  throw Error(method);
 } };
 const runtime = new HostRuntime(config, () => core);
 return { config, runtime, calls, host: runtime.resolve(), failGet: () => { failGet = true; } };
}
const request = { profile: 'coding', project: 'demo', request_id: 'synthetic-desktop-request' };
test('desktop mappings are optional, bounded and limited to configured project IDs', () => {
 const raw = configured(); delete raw.hosts.local.profiles.coding.desktopSpaces;
 assert.deepEqual(configSchema.parse(raw).hosts.local.profiles.coding.desktopSpaces, {});
 for (const mapping of [{ absent: 'workspace' }, { demo: '' }, { demo: '../space' }, { demo: 'space\nextra' }, { demo: 'x'.repeat(129) }]) {
  assert.throws(() => configSchema.parse(configured(mapping)));
 }
 assert.equal(configSchema.parse(configured({ demo: 'A_1-workspace' })).hosts.local.profiles.coding.desktopSpaces.demo, 'A_1-workspace');
});
test('MCP create labels the initial run for its configured desktop workspace and preserves the combined tool surface', async t => {
 const f = fixture(); const server = makeServer(f.runtime, f.config);
 const client = new Client({ name: 'desktop-test', version: '1' });
 const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
 t.after(async () => { await client.close(); await server.close(); f.runtime.close(); });
 assert.deepEqual((await client.listTools()).tools.map(x => x.name).sort(), ['control_terminal_lifecycle', 'create_session','list_hosts','list_sessions','press_escape','press_menu_key','read_output','send_prompt']);
 const response = await client.callTool({ name: 'create_session', arguments: request });
 assert.notEqual(response.isError, true);
 const result = JSON.parse(response.content[0].text);
 const run = f.calls.find(c => c.method === 'terminal.run').params;
 assert.equal(run.labels['herdr.space'], 'workspace-demo');
 assert.equal(run.cwd, '/srv/demo'); assert.deepEqual(run.argv, ['/opt/bin/pi']);
 assert.equal(run.no_parent, true); assert.equal(run.no_notify, true);
 assert.equal(result.desktop_space, 'workspace-demo'); assert.equal(result.desktop_visibility_requested, true);
 assert.equal(result.verified, true); assert.equal(result.adapter_prompt_sent, false);
 assert.equal(f.calls.some(c => ['terminal.send','doc.set','terminal.label'].includes(c.method)), false);
});
test('unmapped sessions keep their existing creation behavior without desktop labels', async () => {
 const f = fixture({}); const result = await createSession(f.host, request);
 assert.equal(f.calls.find(c => c.method === 'terminal.run').params.labels['herdr.space'], undefined);
 assert.equal(result.desktop_space, null); assert.equal(result.desktop_visibility_requested, false);
});
test('cached desktop receipt does not claim fresh verification or launch another session', async () => {
 const f = fixture(); await createSession(f.host, request);
 const result = await createSession(f.host, request);
 assert.equal(result.desktop_space, 'workspace-demo'); assert.equal(result.cached_receipt, true);
 assert.equal(result.verification_is_current, false); assert.equal(result.verified, false);
 assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
});
test('restart reconciliation preserves the original desktop label after mapping changes', async () => {
 const f = fixture(); await createSession(f.host, request);
 f.host.config.profiles.coding.desktopSpaces.demo = 'new-workspace'; f.host.ledger = new Map();
 const result = await createSession(f.host, request);
 assert.equal(result.created_now, false); assert.equal(result.desktop_space, 'workspace-demo');
 assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
 assert.equal(f.calls.some(c => c.method === 'terminal.label'), false);
});
test('failed verification reports requested desktop placement without claiming readiness', async () => {
 const f = fixture(); f.failGet(); const result = await createSession(f.host, request);
 assert.equal(result.desktop_space, 'workspace-demo'); assert.equal(result.desktop_visibility_requested, true);
 assert.equal(result.verification_is_current, false); assert.equal(result.verified, false); assert.equal(result.ready, false);
 assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
});
test('missing verification record returns an unverified receipt without a desktop claim', async () => {
 const f = fixture(); const call = f.host.core.call.bind(f.host.core);
 f.host.core.call = (method, ...args) => method === 'terminal.get' ? Promise.resolve(null) : call(method, ...args);
 const result = await createSession(f.host, request);
 assert.equal(result.verified, false); assert.equal(result.ready, false);
 assert.equal(result.desktop_space, null); assert.equal(result.desktop_visibility_requested, false);
 assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
});

test('Events emission preserves desktop placement and project metadata without duplicate creation', async () => {
 const f = fixture(); const events = [];
 const manager = { deliverEvent(name, payload) { events.push({ name, payload }); } };
 const first = await createSession(f.host, request, undefined, manager);
 await createSession(f.host, request, undefined, manager);
 assert.equal(first.desktop_space, 'workspace-demo');
 assert.equal(first.desktop_visibility_requested, true);
 const labels = f.calls.find(c => c.method === 'terminal.run').params.labels;
 assert.equal(labels['herdr.space'], 'workspace-demo');
 assert.equal(labels.rp_mcp_project, 'demo');
 assert.equal(events.length, 1);
 assert.equal(events[0].name, 'terminal.created');
 assert.equal(events[0].payload.project, 'demo');
 assert.equal(events[0].payload.created_ms, 100);
});
