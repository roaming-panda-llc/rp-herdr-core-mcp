import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { connect } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { importSPKI } from 'jose';
import { makeOwnerGrantApp } from './owner-grant.js';

const privateMode = (st, mode) => st.uid === process.getuid() && (st.mode & 0o777) === mode;
async function privateParent(file) {
  const st = await lstat(path.dirname(file));
  if (!st.isDirectory() || !privateMode(st, 0o700)) throw new Error('Native owner files require an owner-private directory');
}
async function privateRead(file) {
  await privateParent(file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || !privateMode(st, 0o600) || st.size > 4096) throw new Error('Invalid native owner file');
    const data = Buffer.alloc(4097);
    const {bytesRead} = await fd.read(data, 0, data.length, 0);
    if (bytesRead > 4096) throw new Error('Invalid native owner file size');
    return data.subarray(0, bytesRead).toString('utf8');
  } finally { await fd.close(); }
}
async function exchange(socketPath, payload) {
  await privateParent(socketPath);
  const st = await lstat(socketPath);
  if (!st.isSocket() || !privateMode(st, 0o600)) throw new Error('Invalid native Pi socket');
  const conn = connect(socketPath);
  let body = '';
  const timer = setTimeout(() => conn.destroy(new Error('Native Pi deadline')), 2500);
  conn.on('data', b => {
    body += b.toString('utf8');
    if (Buffer.byteLength(body) > 8192) conn.destroy(new Error('Native Pi response too large'));
  });
  try {
    const end = once(conn, 'end');
    conn.end(JSON.stringify(payload));
    await end;
    return JSON.parse(body);
  } finally { clearTimeout(timer); conn.destroy(); }
}
export async function makeNativeOwnerApp(core, config) {
  const target = config.nativeOwner;
  const publicKey = await importSPKI(await privateRead(target.publicKeyPath), 'RS256');
  const grantIsOn = async () => (await privateRead(target.grantPath)) === 'ON\n';
  config.nativeSteer = async input => {
    try {
      if (input.host !== target.host || input.terminal !== target.terminal || input.created_ms !== target.created_ms ||
          !Number.isSafeInteger(input.pid) || input.pid <= 0 || Buffer.byteLength(input.prompt) > 256) throw new Error('target');
      const b = JSON.parse(await privateRead(target.bindingPath));
      if (b.address !== target.terminal || b.created_ms !== target.created_ms || b.pid !== input.pid ||
          typeof b.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(b.sessionId) ||
          typeof b.key !== 'string' || !/^[0-9a-f]{64}$/.test(b.key) ||
          !Number.isSafeInteger(b.deadline) || b.deadline <= Date.now() || !(await grantIsOn())) throw new Error('binding');
      const result = await exchange(target.socketPath, {address:b.address, created_ms:b.created_ms, pid:b.pid,
        sessionId:b.sessionId, key:b.key, deadline:b.deadline, prompt:input.prompt});
      if (result?.ok !== true || result.writes !== 1 || result.steers !== 1) throw new Error('receipt');
      return { delivered: true, native_steer: true };
    } catch {
      throw new Error('Native Pi send refused or delivery unknown; do not retry automatically');
    }
  };
  return makeOwnerGrantApp(core, config, { ...target, publicKey, grantIsOn, advertiseResource: true });
}
