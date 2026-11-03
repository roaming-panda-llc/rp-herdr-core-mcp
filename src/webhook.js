import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP, BlockList } from 'node:net';

// Only globally routable unicast destinations are eligible. IPv6 transition
// mechanisms are deliberately excluded: their embedded destination may be local.
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3]
]) blocked.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
]) blocked.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function validateCallbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Callback URL must use HTTPS');
  if (url.username || url.password || url.hash) throw new Error('Callback URL must not contain credentials or a fragment');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'localhost.localdomain') {
    throw new Error('Callback URL must not target localhost');
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Callback URL must target a public address');
  return url;
}

// Dependencies are injected only by tests, never by request input or NODE_ENV.
export function createWebhookTransport({ lookup = dns.lookup, request = https.request, timeoutMs = 10000, maxResponseBytes = 16384 } = {}) {
  return async function webhookFetch(value, options) {
    const url = validateCallbackUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onAbort;
    try {
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('Callback timeout or cancellation'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const resolve = async () => {
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) {
          throw new Error('Callback DNS must resolve only to public addresses');
        }
        return addresses[0];
      };
      const pinned = await Promise.race([resolve(), aborted]);
      signal.throwIfAborted();
      return await Promise.race([new Promise((resolveResponse, reject) => {
        const req = request(url, {
          method: 'POST', headers: options.headers, signal,
          agent: false, // No pooled socket may bypass the new validation.
          rejectUnauthorized: true,
          servername: isIP(hostname) ? undefined : hostname,
          family: pinned.family,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions?.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          }
        }, response => {
          const status = response.statusCode;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error('Callback redirects are forbidden'));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              response.destroy();
              req.destroy(new Error('Callback response exceeds limit'));
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('Callback response aborted')));
          response.on('end', () => resolveResponse({
            ok: status >= 200 && status < 300, status,
            json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8'))
          }));
        });
        req.on('error', reject);
        req.end(options.body);
      }), aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}

export const webhookFetch = createWebhookTransport();
