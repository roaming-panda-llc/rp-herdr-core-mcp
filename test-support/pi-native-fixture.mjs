import assert from 'node:assert/strict';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {generateKeyPair, SignJWT} from 'jose';
import {makeOwnerGrantApp} from '../src/owner-grant.js';

const scope = process.env.PI_SDK_SCOPE;
const load = path => import(pathToFileURL(scope + '/' + path));
const sdk = await load('pi-coding-agent/dist/index.js');
const {createAssistantMessageEventStream} = await load('pi-ai/dist/utils/event-stream.js');
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const draft = 'disposable unsent draft', prompt = 'disposable addressed steer';
let editor, writes = 0, steers = 0;
const resourceLoaderOptions = { noExtensions: true, extensionFactories: [pi => {
  pi.on('session_start', (_, ctx) => { editor = ctx.ui; });
}] };
const settingsManager = sdk.SettingsManager.inMemory({compaction:{enabled:false}, retry:{enabled:false}});
const modelRuntime = await sdk.ModelRuntime.create({authPath:agentDir+'/auth.json', modelsPath:agentDir+'/models.json'});
await modelRuntime.setRuntimeApiKey('openai', 'synthetic-offline-fixture-not-a-credential');
const base = modelRuntime.getModel('openai','gpt-4o');
assert.ok(base, 'fixture model schema');
const model = {...base, id:'synthetic-model', name:'Synthetic fixture', baseUrl:'http://127.0.0.1:1'};
const manager = sdk.SessionManager.inMemory(cwd);
const runtime = await sdk.createAgentSessionRuntime(async ({sessionManager, sessionStartEvent}) => {
  const services = await sdk.createAgentSessionServices({cwd, agentDir, resourceLoaderOptions, settingsManager, modelRuntime});
  const result = await sdk.createAgentSessionFromServices({services, sessionManager, sessionStartEvent, model, noTools:true});
  return {...result, services, diagnostics:services.diagnostics};
}, {cwd, agentDir, sessionManager:manager});
const session = runtime.session;
const noop = () => {};
const terminal = {start:noop,stop:noop,drainInput:async()=>{},write:noop,columns:100,rows:30,kittyProtocolActive:false,moveBy:noop,hideCursor:noop,showCursor:noop,clearLine:noop,clearFromCursor:noop,clearScreen:noop,setTitle:noop,setProgress:noop,setProgramStatus:noop};
const ui = new sdk.InteractiveMode(runtime,{terminal});
const entered = Promise.withResolvers();
const gate = Promise.withResolvers();
let passes = 0;
session.agent.streamFunction = (_model, _context) => {
  const stream = createAssistantMessageEventStream();
  const n = ++passes;
  const message = {role:'assistant', content:[{type:'text',text:`synthetic response ${n}`}], api:model.api,provider:model.provider,model:model.id, stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  if (n === 1) {entered.resolve(); void gate.promise.then(() => stream.push({type:'done',reason:'stop',message}));}
  else queueMicrotask(() => stream.push({type:'done',reason:'stop',message}));
  return stream;
};
let server, run;
try {
  await ui.init();
  assert.ok(editor, 'interactive session_start editor binding');
  editor.setEditorText(draft);
  run = session.prompt('synthetic initial turn');
  await Promise.race([entered.promise,run.then(()=>{throw Error('run settled before entering synthetic stream')})]);
  assert.equal(session.isStreaming,true);
  assert.equal(editor.getEditorText(),draft);
  const {publicKey,privateKey} = await generateKeyPair('RS256');
  const issuer='https://issuer.invalid', audience='https://fixture.invalid/mcp', subject='disposable-owner';
  const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('2m').sign(privateKey);
  const target={address:'t42',created_ms:42};
  const id=session.sessionId;
  let on=true;
  let reads=0;
  const core={async call(method) {
    assert.equal(method,'terminal.list','no TTY path'); reads++;
    return {terminals:[{...target,state:'live',status:{state:session.isStreaming?'working':'idle'}}]};
  }};
  const config={publicOrigin:'https://fixture.invalid',port:0,coreId:'disposable-core',sendAllowlist:[target], nativeOwner:{}, async nativeSteer(input) {
    assert.equal(input.terminal,target.address);
    assert.equal(input.created_ms,target.created_ms);
    assert.equal(runtime.session,session);
    assert.equal(runtime.session.sessionId,id);
    assert.equal(session.isStreaming,true);
    assert.equal(editor.getEditorText(),draft);
    editor.setEditorText(''); writes++;
    const disposition=await session.steer(input.prompt); steers++;
    assert.equal(disposition,'queued');
    return { disposition };
  }};
  server=makeOwnerGrantApp(core,config,{issuer,audience,subject,publicKey,grantIsOn:()=>on}).listen(0,'127.0.0.1');
  await once(server,'listening'); config.port=server.address().port;
  const call = async terminal => {
    const r=await fetch(`http://127.0.0.1:${config.port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_prompt',arguments:{terminal,prompt}}})});
    return [r.status,r.status===200?await r.json():null];
  };
  assert.equal((await call('t43'))[1]?.result?.isError,true);
  on=false;
  assert.equal((await call('t42'))[0],403);
  assert.deepEqual([reads,writes,steers,editor.getEditorText()],[0,0,0,draft]);
  on=true;
  const [status,response]=await call('t42');
  assert.equal(status,200);
  assert.ok(response.result && !response.result.isError,JSON.stringify(response));
  assert.deepEqual([reads,writes,steers,editor.getEditorText()],[1,1,1,'']);
  gate.resolve(); await run; await session.waitForIdle();
  const users=session.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
  assert.deepEqual(users,['synthetic initial turn',prompt]);
  assert.equal(passes,2);
  console.log(JSON.stringify({working:true,wrongTargetAndOffZeroDispatch:true,composerClears:writes,steers,users,providerCalls:passes}));
} finally {
  gate.resolve();
  if (server) await new Promise(resolve=>server.close(resolve));
  if (run) await run.catch(()=>{});
  ui.stop(); await runtime.dispose();
}
