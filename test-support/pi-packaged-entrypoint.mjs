import assert from 'node:assert/strict';
import {once} from 'node:events';
import {execFileSync, spawn} from 'node:child_process';
import {readFile, writeFile, rename, stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {generateKeyPair, SignJWT, exportSPKI} from 'jose';
import {CoreClient} from '../src/core.js';

const cwd=process.cwd();
const hc=(...args)=>JSON.parse(execFileSync(process.env.HCBIN,args,{cwd,encoding:'utf8'}));
const coreId=hc('server','status').core.id;
const core=new CoreClient({socketPath:process.env.XDG_RUNTIME_DIR+'/herdr-core/'+process.env.HC_SESSION+'.sock'});
const snapshot=()=>core.call('terminal.list',{all:false},coreId);
assert.deepEqual((await snapshot()).terminals,[]);
const launched=hc('run','--bg','--json','--cwd',cwd,'--no-parent','--no-notify','--name','disposable-pi','--',process.execPath,new URL('./pi-ipc-child.mjs',import.meta.url).pathname);
console.log('launched isolated Pi',launched.address);
let ready, row;
for(let i=0;i<50;i++) {
  try {ready=JSON.parse(await readFile('pi-ready.json','utf8'));} catch(e) {if(e.code!=='ENOENT') throw e;}
  row=(await snapshot()).terminals.find(t=>t.address===launched.address);
  if(ready && row?.status?.state==='working') break;
  await delay(80);
}
assert.ok(ready, 'Pi did not expose private session socket');
assert.ok(row && row.pid===ready.pid && Number.isSafeInteger(row.created_ms) && row.status?.state==='working',JSON.stringify(row));
const socketPath=cwd+'/pi.sock';
assert.equal((await stat(cwd)).mode & 0o777,0o700);
assert.equal((await stat(socketPath)).mode & 0o777,0o600);
const target={address:row.address,created_ms:row.created_ms};
let binding={...target,...ready,key:randomBytes(32).toString('hex'),deadline:Date.now()-1};
async function installBinding() {
  await writeFile('binding.next',JSON.stringify(binding),{mode:0o600,flag:'wx'});
  await rename('binding.next','binding.json');
}
await installBinding();

const {publicKey,privateKey}=await generateKeyPair('RS256',{extractable:true});
const issuer='https://issuer.invalid',audience='https://fixture.invalid/mcp',subject='owner-fixture';
const tokenFor=(sub,aud=audience)=>new SignJWT({}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(issuer).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('2m').sign(privateKey);
const owner=await tokenFor(subject), other=await tokenFor('other-subject');
const wrongAudience=await tokenFor(subject,'https://fixture.invalid/other');
const bearer=randomBytes(32).toString('hex');
await writeFile('pub.pem',await exportSPKI(publicKey),{mode:0o600,flag:'wx'});
const scratch=createServer().listen(0,'127.0.0.1'); await once(scratch,'listening');
const port=scratch.address().port; await new Promise(resolve=>scratch.close(resolve));
assert.ok(port>=1024);
const common={port,publicOrigin:'https://fixture.invalid',transport:'http',coreId,socketPath:process.env.XDG_RUNTIME_DIR+'/herdr-core/'+process.env.HC_SESSION+'.sock'};
const filename=cwd+'/packaged.json';
const entry=new URL('../src/index.js',import.meta.url).pathname;
const prompt='disposable packaged steer';
async function start(config) {
  await writeFile(filename,JSON.stringify(config),{mode:0o600});
  const child=spawn(process.execPath,[entry,filename],{env:{...process.env,HERDR_MCP_TOKEN:bearer},stdio:['ignore','ignore','pipe']});
  const exited=once(child,'exit');
  let output='';
  try {
    await Promise.race([(async()=>{for await(const chunk of child.stderr){output+=chunk;if(output.includes('MCP on loopback'))return;} throw new Error(output);})(),
      delay(2200).then(()=>{throw new Error('startup timed out '+output);})]);
  } catch(error) {child.kill(); await exited; throw error;}
  return async()=>{child.kill(); await exited;};
}
const local=`http://127.0.0.1:${port}`;
const discoveryPath='/.well-known/oauth-protected-resource/mcp';
async function call(token,name,args={}) {
  const r=await fetch(local+'/mcp',{signal:AbortSignal.timeout(4500),method:'POST',headers:{...(token?{authorization:`Bearer ${token}`} : {}),accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  return [r.status,r.status===200?(await r.json()).result:null,r.headers.get('www-authenticate')];
}
const send=token=>call(token,'send_prompt',{terminal:target.address,prompt});
let stop=await start(common);
try {
  assert.equal((await fetch(local+discoveryPath)).status,404);
  assert.deepEqual(await call(null,'list_sessions'),[401,null,'Bearer']);
  const [status,list]=await call(bearer,'list_sessions');
  assert.equal(status,200);
  assert.equal(JSON.parse(list.content[0].text).total,1);
  assert.equal((await send(bearer))[1]?.isError,true);
  assert.equal((await send(owner))[0],401);
} finally {await stop();}
stop=await start({...common,sendAllowlist:[target],nativeOwner:{issuer,audience,subject,publicKeyPath:cwd+'/pub.pem',grantPath:cwd+'/grant',bindingPath:cwd+'/binding.json',socketPath,host:'local',terminal:target.address,created_ms:target.created_ms}});
try {
  const discovery=await fetch(local+discoveryPath);
  const metadata=discovery.headers.get('content-type')?.includes('application/json') ? await discovery.json() : null;
  const [unauth,,challenge]=await call(null,'list_sessions');
  const [badAud,,badAudChallenge]=await send(wrongAudience);
  console.log(JSON.stringify({discovery:discovery.status,metadata,unauth,challenge,badAud,badAudChallenge}));
  if (!process.env.HERDR_DISCOVERY_BASELINE) {
    const expected=`Bearer resource_metadata="https://fixture.invalid${discoveryPath}"`;
    assert.equal(discovery.status,200);
    assert.deepEqual(metadata,{resource:audience,authorization_servers:[issuer]});
    assert.deepEqual([unauth,challenge,badAud,badAudChallenge],[401,expected,401,expected]);
    assert.equal((await fetch(local+discoveryPath,{method:'HEAD'})).status,200);
    assert.equal((await fetch(local+'/.well-known/oauth-protected-resource')).status,404);
    assert.equal((await fetch(local+discoveryPath,{method:'POST'})).status,401);
  }
  assert.equal((await send(owner))[0],403);
  await writeFile('grant','ON\n',{mode:0o600,flag:'wx'});
  assert.equal((await send(other))[0],403);
  assert.equal((await send(bearer))[0],401);
  assert.equal((await call(owner,'send_prompt',{terminal:'t999',prompt}))[1]?.isError,true);
  assert.equal((await send(owner))[1]?.isError,true);
  await assert.rejects(readFile('receipt.json'),{code:'ENOENT'});
  binding={...binding,deadline:Date.now()+4000}; await installBinding();
  const [status,result]=await send(owner);
  assert.equal(status,200);
  assert.deepEqual(JSON.parse(result.content[0].text),{delivered:true,native_steer:true});
  const receipt=JSON.parse(await readFile('receipt.json','utf8'));
  assert.deepEqual(receipt,{writes:1,steers:1,currentDraft:'',users:['synthetic initial turn',prompt]});
  console.log(JSON.stringify({realCore:true,defaultOffRead:true,ownerOffDenied:true,otherDenied:true,bearerDeniedInOwnerMode:true,expiredDenied:true,receipt}));
} finally {await stop();}
