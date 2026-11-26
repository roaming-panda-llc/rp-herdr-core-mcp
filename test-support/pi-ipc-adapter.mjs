import assert from 'node:assert/strict';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, rename, stat} from 'node:fs/promises';
import {connect} from 'node:net';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {generateKeyPair, SignJWT} from 'jose';
import {CoreClient} from '../src/core.js';
import {makeOwnerGrantApp} from '../src/owner-grant.js';

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
const {publicKey,privateKey}=await generateKeyPair('RS256');
const issuer='https://issuer.invalid',audience='https://fixture.invalid/mcp',subject='owner-fixture';
const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('2m').sign(privateKey);
const prompt='disposable addressed IPC steer';
let ipcCalls=0, lastReceipt;
async function ipc(payload) {
  ipcCalls++;
  const conn=connect(socketPath); let body='';
  conn.setTimeout(2500,()=>conn.destroy(new Error('IPC deadline')));
  conn.on('data',b=>{body+=b; if(Buffer.byteLength(body)>2048) conn.destroy(new Error('IPC response too large'));});
  const end=once(conn,'end');
  conn.end(JSON.stringify(payload));
  await end;
  return JSON.parse(body);
}
const config={port:0,publicOrigin:'https://fixture.invalid',coreId,sendAllowlist:[target],nativeOwner:{}, async nativeSteer(input){
  assert.equal(input.terminal,binding.address);
  assert.equal(input.created_ms,binding.created_ms);
  lastReceipt=await ipc({...binding,prompt:input.prompt});
  if (!lastReceipt.ok) throw new Error('Target lifetime denied by Pi endpoint');
  return {delivered:true};
}};
const app=makeOwnerGrantApp(core,config,{issuer,audience,subject,publicKey,grantIsOn:()=>true});
const server=app.listen(0,'127.0.0.1'); await once(server,'listening'); config.port=server.address().port;
const call=async terminal=>{
  const r=await fetch(`http://127.0.0.1:${config.port}/mcp`,{signal:AbortSignal.timeout(4500),method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_prompt',arguments:{terminal,prompt}}})});
  assert.equal(r.status,200);
  return (await r.json()).result;
};
try {
  assert.equal((await call('t999')).isError,true);
  assert.equal(ipcCalls,0);
  assert.equal((await call(target.address)).isError,true);
  assert.deepEqual(lastReceipt,{ok:false,writes:0,steers:0,currentDraft:'disposable unsent draft',users:['synthetic initial turn']});
  binding={...binding,deadline:Date.now()+3000}; await installBinding();
  const accepted=await call(target.address);
  assert.ok(accepted && !accepted.isError,JSON.stringify(accepted));
  const expected={writes:1,steers:1,currentDraft:'',users:['synthetic initial turn',prompt]};
  assert.deepEqual(lastReceipt,{ok:true,...expected});
  assert.deepEqual(JSON.parse(await readFile('receipt.json','utf8')),expected);
  console.log(JSON.stringify({realCore:true,observedWorking:true,exactLifetime:target,wrongTargetZeroIpc:true,expiredZeroSteer:true,...expected}));
} finally {await new Promise(resolve=>server.close(resolve));}
