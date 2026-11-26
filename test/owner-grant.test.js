import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { SignJWT, generateKeyPair } from 'jose';
import { makeOwnerGrantApp } from '../src/owner-grant.js';

test('owner grant gates real MCP send_prompt before any stub call', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const issuer = 'https://issuer.invalid', audience = 'https://mcp.invalid/mcp', subject = 'fixture-owner';
  const now = Math.floor(Date.now() / 1000);
  const token = (iss = issuer, aud = audience, sub = subject, exp = now + 60, key = privateKey) =>
    new SignJWT({}).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).setIssuer(iss)
      .setAudience(aud).setSubject(sub).setIssuedAt(now - 30).setExpirationTime(exp).sign(key);
  let grant = true;
  const calls = [];
  const core = { async call(method, params, pin) {
    calls.push([method, params, pin]);
    if (method === 'terminal.list') return { terminals: [{ address: 't42', created_ms: 42, state: 'live', status: { state: 'idle' } }] };
    if (method === 'terminal.send') return { turn: 1, started: true, status: 'working' };
    throw new Error('Unexpected Core method');
  } };
  const config = { publicOrigin: 'https://mcp.invalid', port: 0, coreId: 'fixture-core', sendAllowlist: [{ address: 't42', created_ms: 42 }] };
  const app = makeOwnerGrantApp(core, config, { issuer, audience, subject, publicKey, grantIsOn: () => grant });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.port = server.address().port;
  const send = bearer => fetch(`http://127.0.0.1:${config.port}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_prompt', arguments: { terminal: 't42', prompt: 'synthetic one' } } }),
  });
  try {
    const owner = await token();
    const accepted = await send(owner);
    assert.equal(accepted.status, 200);
    const response = await accepted.json();
    assert.ok(response.result?.content?.length && !response.result.isError, JSON.stringify(response));
    assert.deepEqual(calls, [['terminal.list', { all: false }, 'fixture-core'],
      ['terminal.send', { terminal: 't42', text: 'synthetic one', force: false, wait: false, if: 'idle' }, 'fixture-core']]);
    calls.length = 0;
    grant = false;
    assert.equal((await send(owner)).status, 403);
    grant = true;
    assert.equal((await send(await token(issuer, audience, 'other-subject'))).status, 403);
    assert.equal((await send(await token('https://other.invalid'))).status, 401);
    assert.equal((await send(await token(issuer, 'other-audience'))).status, 401);
    assert.equal((await send(await token(issuer, audience, subject, now - 1))).status, 401);
    const other = await generateKeyPair('RS256');
    assert.equal((await send(await token(issuer, audience, subject, now + 60, other.privateKey))).status, 401);
    assert.deepEqual(calls, []);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
