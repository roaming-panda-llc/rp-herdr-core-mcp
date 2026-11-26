import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile, writeFile, chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import {timingSafeEqual} from 'node:crypto';

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
const ui = new sdk.InteractiveMode(runtime);
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

const socketPath = cwd + '/pi.sock';
const readyPath = cwd + '/pi-ready.json';
const bindingPath = cwd + '/binding.json';
let listener, run, spent = false;
const finished = Promise.withResolvers();
const deadline = setTimeout(() => finished.reject(new Error('fixture child timed out')), 15000);
const receipt = () => ({writes, steers, currentDraft:editor.getEditorText(),
  users:session.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''))});
try {
  await ui.init();
  assert.ok(editor);
  editor.setEditorText(draft);
  run = session.prompt('synthetic initial turn');
  await Promise.race([entered.promise,run.then(()=>{throw Error('run settled before synthetic stream')})]);
  listener = createServer({allowHalfOpen:true}, conn => {
    conn.on('error',()=>{});
    let frame = '';
    conn.setTimeout(1500,()=>conn.destroy());
    conn.on('data', data => {
      frame += data.toString('utf8');
      if (Buffer.byteLength(frame) > 2048) conn.destroy();
    });
    conn.on('end', async () => {
      try {
        const input = JSON.parse(frame);
        const binding = JSON.parse(await readFile(bindingPath,'utf8'));
        const auth = Buffer.from(typeof input.key === 'string' ? input.key : '');
        const expected = Buffer.from(binding.key);
        if (auth.length !== expected.length || !timingSafeEqual(auth,expected) ||
            input.address !== binding.address || input.created_ms !== binding.created_ms ||
            binding.pid !== process.pid || binding.sessionId !== session.sessionId ||
            input.sessionId !== session.sessionId || input.deadline !== binding.deadline ||
            !Number.isSafeInteger(input.deadline) || Date.now() >= input.deadline ||
            runtime.session !== session || spent || !session.isStreaming ||
            typeof input.prompt !== 'string' || !input.prompt.length || input.prompt.length > 256) {
          conn.end(JSON.stringify({ok:false,...receipt()}));
          return;
        }
        spent = true;
        assert.equal(editor.getEditorText(),draft);
        editor.setEditorText(''); writes++;
        assert.equal(await session.steer(input.prompt),'queued'); steers++;
        gate.resolve(); await run; await session.waitForIdle();
        const result = receipt();
        assert.equal(passes,2);
        await writeFile(cwd+'/receipt.json',JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});
        conn.end(JSON.stringify({ok:true,...result}),finished.resolve);
      } catch {
        conn.end(JSON.stringify({ok:false}));
      }
    });
  });
  listener.listen(socketPath); await once(listener,'listening'); await chmod(socketPath,0o600);
  await writeFile(readyPath,JSON.stringify({pid:process.pid,sessionId:session.sessionId})+'\n',{mode:0o600,flag:'wx'});
  await finished.promise;
} finally {
  clearTimeout(deadline); gate.resolve();
  if (listener) await new Promise(resolve=>listener.close(resolve));
  if (run) await run.catch(()=>{});
  ui.stop(); await runtime.dispose();
}
