import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { menuInput, menuPolicy, pressMenuKey, pressEscape } from '../src/controls.js';
import { configSchema } from '../src/config.js';
import { EventManager } from '../src/events.js';
const args = { host: 'local', terminal: 't1', action_id: 'menu_001', key: 'enter', inspected_and_authorized: true };
function fixture() {
  const calls = [], terminal = { address: 't1', created_ms: 7, pid: 9, state: 'live', status: { state: 'idle' } };
  const approval = { action_id: args.action_id, terminal: 't1', created_ms: 7, pid: 9, status: 'idle', key: 'enter', action: 'interact-nonapproval-menu', selection_text:'Choose blue', screen_sha256: createHash('sha256').update('Choose blue').digest('hex'), expires_ms: Date.now()+60000 };
  const ctx = { id: 'local', config: { coreId: 'synthetic', menu: { enabled: true, approvals: [approval] } }, core: { async call(method, params, id, options) {
    calls.push({ method, params, id, options });
    if (method === 'terminal.list') return { terminals: [terminal] };
    if (method === 'terminal.read') return { text: 'Choose blue', complete: true };
    return { status: 'idle', turn: 3 };
  } } };
  return { ctx, calls, terminal, approval };
}
test('strict one-key schema and policy reject broad controls, aliases and approval prompts', () => {
  for (const change of [{ key:'esc' }, { key:'ctrl+c' }, { key:'return' }, { key:'a' }, { keys:['down','enter'] }, { key:'\r' }, { prompt:'yes' }, { host:undefined }, { inspected_and_authorized:false }]) assert.equal(menuInput.safeParse({ ...args,...change }).success,false);
  for (const change of [{ action:'approve' },{ status:'blocked' },{ key:'ctrl+c' },{ pid:0 }]) assert.equal(menuPolicy.safeParse({ enabled:true,approvals:[{ ...fixture().approval,...change }] }).success,false);
  assert.throws(()=>configSchema.parse({ socketPath:'/tmp/core',menu:{enabled:true} }));
  assert.equal(configSchema.parse({socketPath:'/tmp/core'}).menu,undefined);
});
test('one exact key only, acknowledgement unverified, replay rejected across tools', async () => {
  for (const key of ['up','down','left','right','tab','space','enter']) {
    const f=fixture(); f.approval.key=key;
    const result=await pressMenuKey(f.ctx,{...args,key});
    assert.deepEqual(f.calls.at(-1).params,{terminal:'t1',keys:[key]});
    assert.equal(f.calls.at(-1).options.deadlineMs,f.approval.expires_ms);
    assert.equal(result.outcome,'unverified'); assert.equal(result.readback_required,true);
    await assert.rejects(pressMenuKey(f.ctx,{...args,key}),/already attempted/);
    f.ctx.config.escape={enabled:true,approvals:[{...f.approval,action:'dismiss-nonapproval-ui'}]};
    await assert.rejects(pressEscape(f.ctx,{...args,key:undefined}),/Unrecognized/);
    const {key:unused,...escapeArgs}=args;
    await assert.rejects(pressEscape(f.ctx,escapeArgs),/already attempted/);
  }
});
test('exact targeting and action checks fail before key dispatch', async () => {
  for(const mutate of [f=>delete f.ctx.config.menu,f=>f.ctx.config.menu.enabled=false,f=>delete f.ctx.config.coreId,f=>f.ctx.id='other',f=>f.approval.key='down',f=>f.approval.expires_ms=0,f=>f.terminal.created_ms++,f=>f.terminal.pid++,f=>f.terminal.pid=0,f=>f.terminal.state='finished',...['working','error','blocked',null,'unknown','done'].map(s=>f=>f.terminal.status={state:s})]) {
    const f=fixture(); mutate(f); await assert.rejects(pressMenuKey(f.ctx,args)); assert.equal(f.calls.some(c=>c.method==='terminal.keys'),false);
  }
});
test('complete inspected screen and second status are checked; cancellation and races send nothing', async () => {
  for(const mode of ['changed','incomplete','race','duplicate','abort']) {
    const f=fixture(), original=f.ctx.core.call, controller=new AbortController(); let lists=0;
    f.ctx.core.call=async(...a)=>{const r=await original(...a); if(a[0]==='terminal.read'){if(mode==='changed')r.text='Permission required';if(mode==='incomplete')r.complete=false;if(mode==='abort')controller.abort();} if(a[0]==='terminal.list'){if(++lists===2&&mode==='race')f.terminal.status.state='blocked';if(mode==='duplicate')r.terminals.push(f.terminal);} return r;};
    await assert.rejects(pressMenuKey(f.ctx,args,controller.signal));assert.equal(f.calls.some(c=>c.method==='terminal.keys'),false);
  }
});
test('unknown outcome consumes action; concurrent requests send once; exact done allowed',async()=>{
  for(const broken of [false,true]){const f=fixture(),original=f.ctx.core.call; f.ctx.core.call=async(...a)=>a[0]==='terminal.keys'?(broken?{}:Promise.reject(new Error('delivery UNKNOWN; no automatic retry'))):original(...a);await assert.rejects(pressMenuKey(f.ctx,args),/UNKNOWN/);await assert.rejects(pressMenuKey(f.ctx,args),/already attempted/);}
  const f=fixture();f.approval.status=f.terminal.status.state='done';const results=await Promise.allSettled([pressMenuKey(f.ctx,args),pressMenuKey(f.ctx,args)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.filter(c=>c.method==='terminal.keys').length,1);
});
test('menu policy changes preserve prior Events identity, while core changes still fail closed',()=>{
  const c={hosts:{local:{coreId:'synthetic',connection:{type:'unix',socketPath:'/tmp/core'}}}};
  const old=new EventManager(null,c,{autoDispatch:false});const state=structuredClone(old.state);
  const store={load:()=>structuredClone(state),save:()=>assert.fail('No migration needed')};
  const next=structuredClone(c);next.hosts.local.menu={enabled:true,approvals:[fixture().approval]};next.hosts.local.lifecycle={enabled:false,approvals:[]};
  assert.deepEqual(new EventManager(null,next,{store,autoDispatch:false}).state,state);
  next.hosts.local.coreId='different';assert.throws(()=>new EventManager(null,next,{store,autoDispatch:false}),/different core/);
});

test('confirmation requires a unique textual selection; style-only menus are unsupported',async()=>{
  for(const marker of [undefined,'missing','e']){const f=fixture();f.approval.selection_text=marker;await assert.rejects(pressMenuKey(f.ctx,args));assert.ok(!f.calls.some(c=>c.method==='terminal.keys'));}
});

test('MCP menu tool enforces strict schema and named-host routing',async t=>{
  const { Client }=await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport }=await import('@modelcontextprotocol/sdk/inMemory.js');
  const { makeServer }=await import('../src/server.js');
  const { HostRuntime }=await import('../src/runtime.js');
  const f=fixture(), runtime=new HostRuntime({defaultHost:'local',hosts:{local:{...f.ctx.config,connection:{type:'unix',socketPath:'/tmp/synthetic'}}}},()=>f.ctx.core);
  const server=makeServer(runtime,{}),client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
  for(const change of [{host:'other'},{keys:['down','enter']},{key:'ctrl+c'}])assert.equal((await client.callTool({name:'press_menu_key',arguments:{...args,...change}})).isError,true);
  assert.equal(f.calls.length,0);
  const r=await client.callTool({name:'press_menu_key',arguments:args});assert.ok(!r.isError,JSON.stringify(r));
  assert.deepEqual(f.calls.at(-1).params,{terminal:'t1',keys:['enter']});assert.equal(f.calls.at(-1).options.requiredVersion,'0.1.18');
});
