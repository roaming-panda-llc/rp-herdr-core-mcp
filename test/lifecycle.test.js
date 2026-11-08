import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {controlLifecycle,lifecyclePolicy,lifecycleInput} from '../src/lifecycle.js';
const args={host:'local',terminal:'t1',action_id:'close_001',action:'terminate',inspected_and_authorized:true};
function fixture(action='terminate'){
 const t={address:'t1',created_ms:10,pid:20,state:action==='terminate'?'live':'finished',status:{state:'done'}};
 const a={...args,created_ms:10,pid:20,status:'done',screen_sha256:createHash('sha256').update('saved').digest('hex'),expires_ms:Date.now()+60000,work_preserved:true,include_process_tree:true,termination_scope:'root-and-all-local-remote-descendants',remove_terminal_artifacts:true,accept_nonatomic_targeting:true,purpose:'explicit-user-request',action};delete a.host;delete a.inspected_and_authorized;
 const calls=[];let records=[t];const ctx={id:'local',config:{coreId:'synthetic',lifecycle:{enabled:true,approvals:[a]}},core:{async call(method,params,id,options){calls.push({method,params,id,options});if(method==='terminal.list')return{terminals:records};if(method==='terminal.read')return{text:'saved',complete:true};if(method==='terminal.kill'){t.state='finished';return{...t};}if(method==='terminal.rm'){records=[];return{removed:'t1'};}throw Error('unexpected');}}};return{ctx,t,a,calls};
}
test('lifecycle strict schema, preservation consent and separate exact action required',()=>{
 for(const change of [{pid:42},{signal:'KILL'},{terminal:'other/t1'},{action:'kill_all'},{inspected_and_authorized:false}])assert.equal(lifecycleInput.safeParse({...args,...change}).success,false);
 for(const change of [{work_preserved:false},{accept_nonatomic_targeting:false},{purpose:'idle'},{pid:null},{termination_scope:undefined},{termination_scope:'single-host'}])assert.equal(lifecyclePolicy.safeParse({enabled:true,approvals:[{...fixture().a,...change}]}).success,false);
});
test('removal requires explicit stored-artifact deletion consent',()=>{const f=fixture('remove_finished');delete f.a.remove_terminal_artifacts;assert.equal(lifecyclePolicy.safeParse(f.ctx.config.lifecycle).success,false);});
test('termination and removal verify distinct core postconditions without claiming GUI closure',async()=>{
 for(const action of ['terminate','remove_finished']){const f=fixture(action);const r=await controlLifecycle(f.ctx,{...args,action});assert.equal(r.verified,true);assert.equal(r.gui_window_closed,'unverified');assert.equal(r.os_process_exit_verified,false);assert.deepEqual(f.calls.find(c=>c.method==='terminal.kill'||c.method==='terminal.rm').params,{terminal:'t1'});await assert.rejects(controlLifecycle(f.ctx,{...args,action}),/already attempted/);}
});
test('idleness is not permission; mismatches and unpreserved work never mutate',async()=>{
 for(const mutate of [f=>delete f.ctx.config.lifecycle,f=>f.ctx.config.lifecycle.enabled=false,f=>f.ctx.config.lifecycle.approvals=[],f=>f.ctx.id='other',f=>delete f.ctx.config.coreId,f=>f.a.work_preserved=false,f=>f.a.expires_ms=0,f=>f.t.created_ms++,f=>f.t.pid++,f=>f.t.state='finished',f=>f.t.status.state='idle',f=>f.t.reason='holder_lost']){const f=fixture();mutate(f);await assert.rejects(controlLifecycle(f.ctx,args));assert.ok(!f.calls.some(c=>c.method==='terminal.kill'));}
 const f=fixture('remove_finished');f.t.state='live';await assert.rejects(controlLifecycle(f.ctx,{...args,action:'remove_finished'}));assert.ok(!f.calls.some(c=>c.method==='terminal.rm'));
});
test('explicit termination accepts exact working/blocked/error status without typing',async()=>{
 for(const status of ['working','blocked','error',null]){const f=fixture();f.a.status=status;f.t.status={state:status};await controlLifecycle(f.ctx,args);assert.ok(!f.calls.some(c=>['terminal.keys','terminal.send'].includes(c.method)));}
});
test('changed screen, incomplete screen, second-list race and cancellation fail closed',async()=>{
 for(const mode of ['screen','incomplete','race','abort']){const f=fixture(),original=f.ctx.core.call,controller=new AbortController();let lists=0;f.ctx.core.call=async(...a)=>{const r=await original(...a);if(a[0]==='terminal.read'){if(mode==='screen')r.text='unsaved';if(mode==='incomplete')r.complete=false;if(mode==='abort')controller.abort();}if(a[0]==='terminal.list'&&++lists===2&&mode==='race')f.t.pid++;return r;};await assert.rejects(controlLifecycle(f.ctx,args,controller.signal));assert.ok(!f.calls.some(c=>c.method==='terminal.kill'));}
});
test('post-dispatch failures or unverified results remain unknown and consume approval',async()=>{
 for(const mode of ['disconnect','shape','readback']){const f=fixture(),original=f.ctx.core.call;let dispatched=false;f.ctx.core.call=async(...a)=>{if(a[0]==='terminal.kill'){dispatched=true;if(mode==='disconnect')throw Error('disconnect');if(mode==='shape')return{};}if(dispatched&&a[0]==='terminal.list'&&mode==='readback')throw Error('readback unavailable');return original(...a);};await assert.rejects(controlLifecycle(f.ctx,args),/UNKNOWN/);await assert.rejects(controlLifecycle(f.ctx,args),/already attempted/);}
});
test('concurrent lifecycle attempts dispatch once',async()=>{const f=fixture();const r=await Promise.allSettled([controlLifecycle(f.ctx,args),controlLifecycle(f.ctx,args)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.filter(c=>c.method==='terminal.kill').length,1);});
test('known child and indirect child terminals fail closed for kill and removal',async()=>{
 for(const action of ['terminate','remove_finished'])for(const indirect of [false,true])for(const prefix of ['', 'remote/'])for(const childState of ['live',undefined,'pending']){
  const f=fixture(action),original=f.ctx.core.call;
  f.ctx.core.call=async(...a)=>{const r=await original(...a);if(a[0]==='terminal.list'){r.terminals.push({address:prefix+'t2',parent:'t1',state:indirect?'finished':childState});if(indirect)r.terminals.push({address:prefix+'t3',parent:prefix+'t2',state:childState});}return r;};
  await assert.rejects(controlLifecycle(f.ctx,{...args,action}),/live child/);assert.ok(!f.calls.some(c=>c.method==='terminal.kill'||c.method==='terminal.rm'));
 }
});
test('registered lifecycle MCP tool rejects wrong host and arbitrary signal, dispatches exact action',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js'),{makeServer}=await import('../src/server.js'),{HostRuntime}=await import('../src/runtime.js');
 const f=fixture(),runtime=new HostRuntime({defaultHost:'local',hosts:{local:{...f.ctx.config,connection:{type:'unix',socketPath:'/tmp/synthetic'}}}},()=>f.ctx.core);
 const server=makeServer(runtime,{}),client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 for(const change of [{host:'other'},{signal:'KILL'}])assert.equal((await client.callTool({name:'control_terminal_lifecycle',arguments:{...args,...change}})).isError,true);
 assert.equal(f.calls.length,0);const r=await client.callTool({name:'control_terminal_lifecycle',arguments:args});assert.ok(!r.isError,JSON.stringify(r));assert.equal(JSON.parse(r.content[0].text).verified,true);
});
