import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebhookTransport, isPublicAddress, validateCallbackUrl } from '../src/webhook.js';

const options = { headers: {}, body: '{}' };
function fakeRequest(inspect, status = 200, body = '{}') {
  return (url, config, respond) => {
    inspect(url, config);
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = status;
      response.destroy = () => {};
      respond(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
    });
    return req;
  };
}

test('rejects non-public IPv4 and IPv6 including mapped, alternate and transition forms', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '127.1.2.3', '100.100.100.100', '169.254.169.254', '172.31.0.1', '192.168.0.1', '198.18.0.1', '192.0.2.1', '203.0.113.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe90::1', 'febf::1', 'fc00::1', 'fd00::1', 'ff02::1', '64:ff9b::a00:1', '2002:7f00:1::', '2001::1', '2001:db8::1', '3fff::1', 'bad']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['http://example.com', 'https://127.1', 'https://0x7f000001', 'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com/#secret']) assert.throws(() => validateCallbackUrl(url));
});

test('pins the validated IP and retains TLS hostname verification, without pooled connections', async () => {
  let lookups = 0;
  const transport = createWebhookTransport({
    lookup: async () => { lookups++; return [{ address: '1.1.1.1', family: 4 }]; },
    request: fakeRequest((url, config) => {
      assert.equal(url.hostname, 'callback.example');
      assert.equal(config.servername, 'callback.example');
      assert.equal(config.rejectUnauthorized, true);
      assert.equal(config.agent, false);
      config.lookup('callback.example', {}, (err, ip, family) => {
        assert.equal(err, null); assert.equal(ip, '1.1.1.1'); assert.equal(family, 4);
      });
      config.lookup('callback.example', { all: true }, (err, addresses) => assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]));
    })
  });
  assert.equal((await transport('https://callback.example/hook', options)).ok, true);
  assert.equal(lookups, 1);
});

test('revalidates DNS each attempt and rejects mixed public/private answers without connecting', async () => {
  let lookups = 0, connections = 0;
  const transport = createWebhookTransport({
    lookup: async () => ++lookups === 1 ? [{ address: '1.1.1.1', family: 4 }] : [{ address: '1.1.1.1', family: 4 }, { address: 'fe90::1', family: 6 }],
    request: fakeRequest(() => connections++)
  });
  await transport('https://callback.example', options);
  await assert.rejects(transport('https://callback.example', options), /public/);
  assert.equal(connections, 1);
});

test('rejects redirects, empty DNS, oversized responses and stalled DNS', async () => {
  const lookup = async () => [{ address: '1.1.1.1', family: 4 }];
  await assert.rejects(createWebhookTransport({ lookup, request: fakeRequest(() => {}, 302) })('https://callback.example', options), /redirect/);
  await assert.rejects(createWebhookTransport({ lookup: async () => [] })('https://callback.example', options), /public/);
  await assert.rejects(createWebhookTransport({ lookup, maxResponseBytes: 2, request: fakeRequest(() => {}, 200, 'large') })('https://callback.example', options), /limit/);
  await assert.rejects(createWebhookTransport({ lookup: () => new Promise(() => {}), timeoutMs: 5 })('https://callback.example', options), /timeout/);
});

test('NODE_ENV=test does not disable destination validation', async () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    await assert.rejects(createWebhookTransport({ lookup: async () => [{ address: '10.0.0.1', family: 4 }] })('https://callback.example', options), /public/);
  } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});
