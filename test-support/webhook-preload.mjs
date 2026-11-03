// Test-only Node --import hook. No production configuration enables this code.
// All callback DNS/HTTPS is replaced before the real entrypoint is imported.
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Webhook } from 'standardwebhooks';
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 30 : ms, ...args);
dns.lookup = async hostname => {
  assert.equal(hostname, 'callback.example');
  return [{ address: '1.1.1.1', family: 4 }];
};
https.request = (url, options, respond) => {
  assert.equal(url.hostname, 'callback.example');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, 'callback.example');
  options.lookup(url.hostname, {}, (error, ip) => { assert.equal(error, null); assert.equal(ip, '1.1.1.1'); });
  const req = new EventEmitter();
  req.destroy = error => req.emit('error', error);
  req.end = body => queueMicrotask(() => {
    if (options.signal.aborted) return req.destroy(new Error('cancelled'));
    const data = new Webhook(secret).verify(body, options.headers);
    // Record only synthetic metadata, never the secret, signatures or challenge.
    appendFileSync(process.env.HERDR_TEST_CALLBACK_LOG, JSON.stringify({ kind: data.type ?? 'event', subscriptionId: options.headers['X-MCP-Subscription-Id'], eventId: data.eventId, name: data.name, data: data.data }) + '\n');
    const response = new EventEmitter();
    response.statusCode = 200;
    response.destroy = () => {};
    respond(response);
    response.emit('data', Buffer.from(JSON.stringify(data.type === 'verification' ? { challenge: data.challenge } : {})));
    response.emit('end');
  });
  return req;
};
