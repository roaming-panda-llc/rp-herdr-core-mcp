// Opt-in, Linux-only synthetic PTY validation. Pass an explicitly reviewed core binary.
// Never uses an existing core: socket, state, configuration and programs are disposable.
import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CoreClient, ESCAPE_CORE_VERSIONS } from '../src/core.js';
import { controlLifecycle } from '../src/lifecycle.js';
import { pressEscape, pressMenuKey } from '../src/controls.js';
const execFile = promisify(execFileCallback);
if (process.platform !== 'linux' || !process.argv[2]) throw new Error('Usage on Linux: node scripts/validate-escape-pty.mjs /absolute/path/to/reviewed/herdr-core');
const lifecycle = process.argv.includes('--lifecycle');
const menu = process.argv[3] === '--menu';
const binary = resolve(process.argv[2]);
const root = await mkdtemp('/tmp/escape-pty-');
const env = { PATH: '/usr/bin:/bin', HC_SESSION: 'synthetic', HC_SOCKET: join(root, 'core.sock'), XDG_RUNTIME_DIR: join(root, 'run'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
for (const dir of ['run', 'state', 'config']) await mkdir(join(root, dir), { mode: 0o700 });
const fixture = join(root, 'fixture.py');
await writeFile(fixture, `import os,sys,tty,select,time
mode,status,receipt=sys.argv[1:]
tty.setraw(0)
if mode=='kitty': os.write(1,b'\\x1b[>1u')
os.write(1,b'\\x1b]7501;state='+status.encode()+b'\\x1b\\\\')
os.write(1,b'ESCAPE SYNTHETIC READY')
${menu ? "os.write(1,b' Selected: blue')" : ''}
end=time.monotonic()+15
received=b''
while time.monotonic()<end:
 if select.select([0],[],[],0.1)[0]:
  received+=os.read(0,128)
${menu ? "  if received in [bytes([13]),bytes([32])]: os.write(1,b' CHOSEN:blue')" : ''}
  with open(receipt,'w') as f: f.write(received.hex())
  os.write(1,b'\\r\\nRECEIVED:'+received.hex().encode())
`);
const child = spawn(binary, ['serve'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); }); child.stdout.resume();
let childError; child.on('error', e => { childError = e; });
const core = new CoreClient({ socketPath: env.HC_SOCKET, timeoutMs: 3000 });
const ownedPids = [], ownedTerminals = [], cases = [];
async function waitFor(fn, label) {
  const until = Date.now() + 5000;
  do { const value = await fn(); if (value) return value; await delay(25); } while (Date.now() < until);
  throw new Error(`Timed out: ${label}; core stderr: ${stderr}`);
}
let version, coreId, failure;
const cleanupErrors = [];
try {
  await waitFor(async () => { if (childError) throw childError; try { await access(env.HC_SOCKET); return true; } catch { return false; } }, 'disposable core socket');
  const hello = await core.call('hello', { generation: 1, framed: false });
  version = hello.version;
  assert.ok(ESCAPE_CORE_VERSIONS.includes(version));
  coreId = hello.core.id;
  const call = (method, params) => core.call(method, params, coreId);
  const tests = menu ? ['legacy', 'kitty'].flatMap(mode => ['up','down','left','right','tab','space','enter'].map(key => [mode,'idle',key])).concat([['legacy','done','enter'],['legacy','blocked','enter'],['legacy','error','enter'],['legacy','working','enter']]) : [['legacy','idle','esc'], ['kitty','idle','esc'], ['legacy','done','esc'], ['kitty','done','esc'], ['legacy','blocked','esc'], ['legacy','error','esc'], ['legacy','working','esc']];
  for (const [mode, status, key] of tests) {
    const receipt = join(root, `${mode}-${status}-${key}.hex`);
    const created = await call('terminal.run', { argv: ['/usr/bin/python3', fixture, mode, status, receipt], cwd: root, wait: false, no_parent: true, no_notify: true });
    const terminal = created.address;
    if (typeof terminal === 'string' && /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(terminal)) ownedTerminals.push(terminal);
    if (Number.isSafeInteger(created.pid) && created.pid > 0) ownedPids.push(created.pid);
    assert.match(terminal, /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/);
    const current = await waitFor(async () => {
      const t = (await call('terminal.list', { all: false })).terminals.find(t => t.address === terminal);
      return t?.status?.state === status && t.state === 'live' && t.pid > 0 ? t : null;
    }, `status ${status}`);
    ownedPids.push(current.pid);
    const screen = await waitFor(async () => { const s = await call('terminal.read', { terminal, lines: 0 }); return s.complete && s.text.includes('ESCAPE SYNTHETIC READY') ? s : null; }, 'complete ready screen');
    const action_id = `test_${mode}_${status}_${key}`;
    const ctx = { id: 'synthetic', core, config: { coreId, escape: { enabled: true, approvals: [{ action_id, terminal, created_ms: current.created_ms, pid: current.pid, action: 'dismiss-nonapproval-ui', status: status === 'done' ? 'done' : 'idle', screen_sha256: createHash('sha256').update(screen.text).digest('hex'), expires_ms: Date.now() + 5000 }] } } };
    if (menu) { ctx.config.menu = ctx.config.escape; delete ctx.config.escape; Object.assign(ctx.config.menu.approvals[0], { action: 'interact-nonapproval-menu', key, selection_text: 'Selected: blue' }); }
    const press = menu ? pressMenuKey : pressEscape;
    const args = { ...(menu ? { key } : {}), host: 'synthetic', terminal, action_id, inspected_and_authorized: true };
    // Operator approval here authorizes this synthetic test screen, never a user UI.
    if (['idle', 'done'].includes(status)) {
      const result = await press(ctx, args);
      assert.equal(result.delivery, 'core_acknowledged');
      assert.equal(result.ui_dismissed, 'unverified');
      const expected = key === 'esc' ? (mode === 'legacy' ? '1b' : '1b5b323775') : { up:'1b5b41',down:'1b5b42',left:'1b5b44',right:'1b5b43',tab:'09',space:'20',enter:'0d' }[key];
      const bytes = await waitFor(async () => { try { const r = await readFile(receipt, 'utf8'); return r.length >= expected.length ? r : false; } catch { return false; } }, 'PTY receipt');
      assert.equal(bytes, expected);
      const after = await waitFor(async () => { const s = await call('terminal.read', { terminal, lines: 0 }); return s.text.includes(`RECEIVED:${expected}`) ? s : null; }, 'post-action screen readback');
      assert.ok(after.complete);
      if (menu && ['enter','space'].includes(key)) assert.ok(after.text.includes('CHOSEN:blue'), 'synthetic menu confirmed the inspected choice');
      await assert.rejects(press(ctx, args), /already attempted/);
      await delay(100); assert.equal(await readFile(receipt, 'utf8'), expected, 'no duplicate key');
      cases.push({ mode, status, key, bytes, readback: true, replay_rejected: true });
    } else {
      await assert.rejects(press(ctx, args), /exact approved/);
      await delay(100);
      await assert.rejects(access(receipt), { code: 'ENOENT' });
      cases.push({ mode, status, key, rejected: true, bytes: '' });
    }
    if (lifecycle) {
      for (const action of ['terminate','remove_finished']) {
        const target = (await call('terminal.list', { all:true })).terminals.find(t => t.address === terminal);
        const inspected = await call('terminal.read', { terminal, lines:0 });
        const action_id = `life_${mode}_${status}_${action}`;
        ctx.config.lifecycle = { enabled:true, approvals:[{ action_id, terminal, created_ms:target.created_ms, pid:target.pid, action, status:target.status?.state ?? null, screen_sha256:createHash('sha256').update(inspected.text).digest('hex'), expires_ms:Date.now()+5000, work_preserved:true, include_process_tree:true,termination_scope:'root-and-all-local-remote-descendants',remove_terminal_artifacts:true, accept_nonatomic_targeting:true, purpose:'explicit-user-request' }] };
        const result = await controlLifecycle(ctx, { host:'synthetic',terminal,action_id,action,inspected_and_authorized:true });
        assert.equal(result.verified,true);
        cases.push({mode,status,action,observation:result.observation});
      }
    } else await call('terminal.kill', { terminal });
  }
} catch (error) {
  failure = error;
} finally {
  for (const terminal of ownedTerminals) {
    try { await core.call('terminal.kill', { terminal }, coreId); } catch { /* already finished or core exited; PID checks below still apply */ }
  }
  core.close();
  try { await execFile(binary, ['server', 'stop'], { cwd: root, env, timeout: 5000 }); }
  catch (error) { cleanupErrors.push(error); }
  finally {
    try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 'owned core exit');
    for (const pid of ownedPids) await waitFor(async () => {
      try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'); }
      catch (e) { if (e.code === 'ENOENT') return true; throw e; }
    }, `owned fixture PID ${pid} exit`);
    } catch (error) { cleanupErrors.push(error); }
    finally { try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); } }
  }
}
if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Synthetic Escape validation or cleanup failed');
console.log(JSON.stringify({ version, cases, passed: cases.length, cleanup: 'core and owned PTYs exited; temporary paths removed' }, null, 2));
