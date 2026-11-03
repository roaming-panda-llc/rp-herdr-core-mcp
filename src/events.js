import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import dns from 'node:dns/promises';

const eventsCatalog = [
  {
    name: 'terminal.created',
    description: 'A new terminal session was created on the configured core',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host/profile ID to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        created_ms: { type: 'number' },
        name: { type: 'string' },
        profile: { type: 'string' },
        project: { type: 'string' }
      },
      required: ['host', 'terminal', 'created_ms'],
      additionalProperties: false
    }
  },
  {
    name: 'terminal.status_changed',
    description: 'Terminal status transitioned (idle/working/done/blocked/error)',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host/profile ID to filter by' },
        terminal: { type: 'string', description: 'Terminal address to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        previous_status: { type: 'string' },
        new_status: { type: 'string' },
        timestamp_ms: { type: 'number' }
      },
      required: ['host', 'terminal', 'previous_status', 'new_status', 'timestamp_ms'],
      additionalProperties: false
    }
  },
  {
    name: 'terminal.finished',
    description: 'Terminal session finished (exited, was terminated, or holder lost)',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host/profile ID to filter by' },
        terminal: { type: 'string', description: 'Terminal address to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        exit_code: { type: ['number', 'null'] },
        reason: { type: ['string', 'null'] },
        finished_ms: { type: 'number' }
      },
      required: ['host', 'terminal', 'finished_ms'],
      additionalProperties: false
    }
  }
];

const SubscriptionSchema = z.object({
  id: z.string(),
  eventName: z.string(),
  arguments: z.record(z.unknown()),
  delivery: z.object({
    mode: z.literal('webhook'),
    url: z.string().url(),
    secret: z.string()
  }),
  cursor: z.unknown().nullable().optional(),
  owner: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  verified: z.boolean(),
  lastDeliveryAt: z.number().nullable()
});

const SUBSCRIPTION_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
const SUBSCRIPTION_TTL_MIN_MS = 60 * 1000;
const VERIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const POLL_INTERVAL_MS = 5000;
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 300000;

function generateSubscriptionId(owner, url, eventName, arguments_) {
  const canonicalArgs = JSON.stringify(arguments_, Object.keys(arguments_).sort());
  const input = `${owner}|${url}|${eventName}|${canonicalArgs}`;
  return 'sub_' + createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function generateEventId() {
  return 'evt_' + randomBytes(16).toString('hex');
}

function generateChallenge() {
  return randomBytes(32).toString('base64url');
}

function makeTerminalKey(hostId, terminalAddress) {
  return `${hostId}|${terminalAddress}`;
}

function isPrivateOrLoopbackIp(ip) {
  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.').map(Number);
    // 127.0.0.0/8 - loopback
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 - private
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 - private
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 - private
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 - link-local
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0/8 - reserved
    if (parts[0] === 0) return true;
    // 224.0.0.0/4 - multicast
    if (parts[0] >= 224 && parts[0] <= 239) return true;
    // 240.0.0.0/4 - reserved
    if (parts[0] >= 240) return true;
    return false;
  }
  // IPv6
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    // ::1/128 - loopback
    if (lower === '::1') return true;
    // ::/128 - unspecified
    if (lower === '::') return true;
    // fe80::/10 - link-local
    if (lower.startsWith('fe80:')) return true;
    // fc00::/7 - unique local (private)
    const firstHextet = parseInt(lower.split(':')[0], 16);
    if (!isNaN(firstHextet) && (firstHextet & 0xfe00) === 0xfc00) return true;
    // ff00::/8 - multicast
    if (lower.startsWith('ff')) return true;
    // 2001:db8::/32 - documentation
    if (lower.startsWith('2001:db8:')) return true;
    return false;
  }
  return false;
}

async function resolveAndValidateHostname(hostname) {
  try {
    const results = await dns.lookup(hostname, { all: true, family: 0 });
    for (const { address, family } of results) {
      if (isPrivateOrLoopbackIp(address)) {
        return { safe: false, reason: `resolved to ${family === 6 ? 'IPv6' : 'IPv4'} ${address} (private/loopback/link-local)` };
      }
    }
    return { safe: true, addresses: results.map(r => r.address) };
  } catch (error) {
    return { safe: false, reason: `DNS resolution failed: ${error.message}` };
  }
}

async function validateCallbackUrl(url, allowPrivateForTesting = false) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Callback URL must use HTTPS');
  }
  const hostname = parsed.hostname;
  
  // Quick hostname checks before DNS resolution
  if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
    throw new Error('Callback URL must not target localhost');
  }
  
  if (!allowPrivateForTesting) {
    // Resolve and validate all IPs
    const validation = await resolveAndValidateHostname(hostname);
    if (!validation.safe) {
      throw new Error(`Callback URL validation failed: ${validation.reason}`);
    }
  } else {
    // Testing mode - still check literal IPs and localhost
    if (isPrivateOrLoopbackIp(hostname)) {
      throw new Error('Callback URL must not target private/loopback/link-local addresses');
    }
  }
  
  return parsed;
}

function validateSecret(secret) {
  if (!secret.startsWith('whsec_')) {
    throw new Error('Secret must start with whsec_');
  }
  const base64 = secret.slice(6);
  let decoded;
  try {
    decoded = Buffer.from(base64, 'base64');
  } catch {
    throw new Error('Secret must be valid base64');
  }
  if (decoded.length < 24 || decoded.length > 64) {
    throw new Error('Secret must decode to 24-64 bytes');
  }
}

function getEventInputZodSchema(eventName) {
  switch (eventName) {
    case 'terminal.created':
      return z.object({ host: z.string().optional() }).strict();
    case 'terminal.status_changed':
      return z.object({ host: z.string().optional(), terminal: z.string().optional() }).strict();
    case 'terminal.finished':
      return z.object({ host: z.string().optional(), terminal: z.string().optional() }).strict();
    default:
      return z.object({}).strict();
  }
}

export class EventManager {
  constructor(core, config) {
    this.core = core;
    this.config = config;
    this.subscriptions = new Map();
    this.verificationCache = new Map();
    this.terminalStates = new Map(); // host|terminalAddress -> { host, status, state, created_ms, pid, reason, createdAt }
    this.pollInterval = null;
    this.pollingHosts = [];
    this.isPolling = false;
    this.pollPromise = null;
    this.outbox = []; // array of { subscription, eventName, payload, attempts, nextRetryAt }
    this.outboxProcessing = false;
    this.shuttingDown = false;
  }

  async startPolling() {
    if (this.isPolling) return;
    
    // Determine which hosts to poll
    this.pollingHosts = [];
    if (this.core && typeof this.core.hosts === 'object' && this.core.hosts instanceof Map) {
      // HostRuntime with multiple hosts
      for (const [hostId, host] of this.core.hosts) {
        if (host.config.coreId) {
          this.pollingHosts.push({ hostId, coreId: host.config.coreId, core: host.core });
        }
      }
    } else if (this.core && this.config.coreId) {
      // Single core (legacy)
      this.pollingHosts.push({ hostId: 'local', coreId: this.config.coreId, core: this.core });
    }
    
    if (this.pollingHosts.length === 0) {
      return;
    }
    
    this.isPolling = true;
    this.shuttingDown = false;
    
    // Initial state capture - await completion
    await this.captureInitialState();
    
    // Start polling
    this.pollPromise = this.pollLoop();
  }

  async stopPolling() {
    this.shuttingDown = true;
    this.isPolling = false;
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    // Wait for any in-flight poll to complete
    if (this.pollPromise) {
      try {
        await this.pollPromise;
      } catch (e) {
        // Ignore errors during shutdown
      }
      this.pollPromise = null;
    }
    
    // Process remaining outbox with bounded retries
    await this.drainOutbox();
  }

  async captureInitialState() {
    for (const hostInfo of this.pollingHosts) {
      try {
        const result = await hostInfo.core.call('terminal.list', { all: true }, hostInfo.coreId);
        if (Array.isArray(result?.terminals)) {
          for (const terminal of result.terminals) {
            if (!terminal.address) continue;
            const key = makeTerminalKey(hostInfo.hostId, terminal.address);
            this.terminalStates.set(key, {
              host: hostInfo.hostId,
              status: terminal.status?.state ?? null,
              state: terminal.state ?? null,
              created_ms: terminal.created_ms ?? null,
              pid: terminal.pid ?? null,
              reason: terminal.reason ?? null,
              createdAt: Date.now()
            });
          }
        }
      } catch (error) {
        console.error(`Failed to capture initial state for ${hostInfo.hostId}:`, error.message);
      }
    }
  }

  async pollLoop() {
    while (this.isPolling && !this.shuttingDown) {
      const startTime = Date.now();
      
      try {
        await this.pollTerminals();
      } catch (error) {
        console.error('Poll cycle error:', error.message);
      }
      
      if (this.shuttingDown) break;
      
      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, POLL_INTERVAL_MS - elapsed);
      
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async pollTerminals() {
    for (const hostInfo of this.pollingHosts) {
      if (this.shuttingDown) break;
      
      try {
        const result = await hostInfo.core.call('terminal.list', { all: true }, hostInfo.coreId);
        if (!Array.isArray(result?.terminals)) continue;
        
        const currentTerminals = new Set();
        
        for (const terminal of result.terminals) {
          if (!terminal.address) continue;
          const key = makeTerminalKey(hostInfo.hostId, terminal.address);
          currentTerminals.add(key);
          
          const previous = this.terminalStates.get(key);
          const currentStatus = terminal.status?.state ?? null;
          const currentState = terminal.state ?? null;
          
          if (!previous) {
            // New terminal - emit terminal.created if it has our labels
            if (terminal.labels?.rp_mcp_request) {
              await this.deliverEvent('terminal.created', {
                host: hostInfo.hostId,
                terminal: terminal.address,
                created_ms: terminal.created_ms ?? Date.now(),
                name: terminal.name ?? '',
                profile: terminal.labels?.rp_mcp_profile ?? '',
                project: terminal.labels?.rp_mcp_project ?? ''
              });
            }
            // Track all terminals for status changes
            this.terminalStates.set(key, {
              host: hostInfo.hostId,
              status: currentStatus,
              state: currentState,
              created_ms: terminal.created_ms ?? null,
              pid: terminal.pid ?? null,
              reason: terminal.reason ?? null,
              createdAt: Date.now()
            });
          } else {
            // Check for status change
            if (previous.status !== currentStatus && currentStatus !== null) {
              await this.deliverEvent('terminal.status_changed', {
                host: hostInfo.hostId,
                terminal: terminal.address,
                previous_status: previous.status ?? 'unknown',
                new_status: currentStatus,
                timestamp_ms: Date.now()
              });
            }
            
            // Check for finished (terminal no longer live)
            const wasLive = previous.state === 'live' && previous.pid && previous.pid > 0 && !previous.reason;
            const isLive = currentState === 'live' && terminal.pid && terminal.pid > 0 && !terminal.reason;
            
            if (wasLive && !isLive) {
              await this.deliverEvent('terminal.finished', {
                host: hostInfo.hostId,
                terminal: terminal.address,
                exit_code: null, // Unknown - core doesn't expose exit code via list
                reason: terminal.reason ?? 'unknown',
                finished_ms: Date.now()
              });
            }
            
            // Update state
            this.terminalStates.set(key, {
              host: hostInfo.hostId,
              status: currentStatus,
              state: currentState,
              created_ms: terminal.created_ms ?? null,
              pid: terminal.pid ?? null,
              reason: terminal.reason ?? null,
              createdAt: previous.createdAt
            });
          }
        }
        
        // Check for terminals that disappeared (finished)
        for (const [key, previous] of this.terminalStates.entries()) {
          if (previous.host !== hostInfo.hostId) continue;
          if (!currentTerminals.has(key)) {
            // Terminal disappeared - emit finished
            await this.deliverEvent('terminal.finished', {
              host: hostInfo.hostId,
              terminal: previous.address || key.split('|')[1],
              exit_code: null,
              reason: 'disappeared',
              finished_ms: Date.now()
            });
            this.terminalStates.delete(key);
          }
        }
      } catch (error) {
        console.error(`Failed to poll terminals for ${hostInfo.hostId}:`, error.message);
      }
    }
    
    // Cleanup expired subscriptions
    this.cleanupExpired();
  }

  getCatalog() {
    return eventsCatalog;
  }

  getEventDefinition(name) {
    return eventsCatalog.find(e => e.name === name);
  }

  async handleList(params) {
    return { events: eventsCatalog, nextCursor: null };
  }

  async handleSubscribe(owner, params, allowPrivateForTesting = false) {
    const { name, arguments: args = {}, delivery, cursor, ttlMs } = params;
    
    const eventDef = this.getEventDefinition(name);
    if (!eventDef) {
      throw new Error(`Unknown event: ${name}`);
    }

    if (!delivery || delivery.mode !== 'webhook') {
      throw new Error('Only webhook delivery mode is supported');
    }

    // Validate callback URL with SSRF protection
    await validateCallbackUrl(delivery.url, allowPrivateForTesting);
    validateSecret(delivery.secret);

    // Validate arguments against event's inputSchema
    const eventInputSchema = getEventInputZodSchema(name);
    const parseResult = eventInputSchema.safeParse(args);
    if (!parseResult.success) {
      throw new Error(`Invalid arguments for event ${name}: ${parseResult.error.message}`);
    }

    const cacheKey = `${owner}|${delivery.url}`;
    const cached = this.verificationCache.get(cacheKey);
    const now = Date.now();
    if (!cached || now - cached.verifiedAt > VERIFICATION_CACHE_TTL_MS) {
      const challenge = generateChallenge();
      await this.sendVerification(delivery.url, delivery.secret, challenge, owner);
      this.verificationCache.set(cacheKey, { verifiedAt: now, url: delivery.url });
    }

    const subscriptionId = generateSubscriptionId(owner, delivery.url, name, args);
    const existing = this.subscriptions.get(subscriptionId);
    let expiresAt = existing?.expiresAt ?? null;

    if (ttlMs !== undefined && ttlMs !== null) {
      const requestedTtl = Math.max(ttlMs, SUBSCRIPTION_TTL_MIN_MS);
      expiresAt = Date.now() + requestedTtl;
    } else if (!expiresAt) {
      expiresAt = Date.now() + SUBSCRIPTION_TTL_DEFAULT_MS;
    }

    const subscription = {
      id: subscriptionId,
      eventName: name,
      arguments: args,
      delivery,
      cursor: cursor ?? null,
      owner,
      createdAt: existing?.createdAt ?? Date.now(),
      expiresAt,
      verified: true,
      lastDeliveryAt: existing?.lastDeliveryAt ?? null
    };

    this.subscriptions.set(subscriptionId, subscription);
    return {
      id: subscriptionId,
      refreshBefore: expiresAt ? new Date(expiresAt).toISOString() : null,
      cursor: subscription.cursor,
      truncated: false
    };
  }

  async handleUnsubscribe(owner, params) {
    const { name, arguments: args = {}, delivery } = params;
    
    if (!delivery || delivery.mode !== 'webhook') {
      throw new Error('Only webhook delivery mode is supported');
    }

    const subscriptionId = generateSubscriptionId(owner, delivery.url, name, args);
    const subscription = this.subscriptions.get(subscriptionId);
    
    if (subscription && subscription.owner === owner) {
      this.subscriptions.delete(subscriptionId);
    }
    
    return {};
  }

  async sendVerification(url, secret, challenge, owner) {
    const webhook = new Webhook(secret.slice(6));
    const body = JSON.stringify({ type: 'verification', challenge });
    const webhookId = `msg_verification_${generateEventId().slice(4)}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = webhook.sign(webhookId, new Date(timestamp * 1000), body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error', // Disable redirects - SSRF protection
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signature,
          'X-MCP-Subscription-Id': owner
        },
        body
      });

      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`Verification failed with status ${response.status}`);
      }

      const data = await response.json();
      if (data.challenge !== challenge) {
        throw new Error('Challenge mismatch');
      }
    } catch (error) {
      clearTimeout(timeout);
      throw new Error(`Callback verification failed: ${error.message}`);
    }
  }

  async deliverEvent(eventName, payload) {
    const now = Date.now();
    const eventDef = this.getEventDefinition(eventName);
    if (!eventDef) return;

    for (const subscription of this.subscriptions.values()) {
      if (subscription.eventName !== eventName) continue;
      if (subscription.expiresAt && subscription.expiresAt < now) continue;
      if (!subscription.verified) continue;

      const matches = this.matchSubscription(subscription, payload);
      if (!matches) continue;

      // Add to outbox for reliable delivery with retries
      this.enqueueDelivery(subscription, eventName, payload);
    }
  }

  matchSubscription(subscription, payload) {
    const { arguments: filters } = subscription;
    if (filters.host && filters.host !== payload.host) return false;
    if (filters.terminal && filters.terminal !== payload.terminal) return false;
    return true;
  }

  enqueueDelivery(subscription, eventName, payload) {
    const eventId = generateEventId();
    const timestamp = new Date().toISOString();
    const event = {
      eventId,
      name: eventName,
      timestamp,
      data: payload,
      cursor: subscription.cursor
    };

    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      console.error(`Event payload exceeds ${MAX_PAYLOAD_BYTES} bytes, skipping delivery`);
      return;
    }

    const webhook = new Webhook(subscription.delivery.secret.slice(6));
    const signedAt = new Date();
    const webhookId = eventId;
    const webhookTimestamp = String(Math.floor(signedAt.getTime() / 1000));
    const signature = webhook.sign(webhookId, signedAt, body);

    this.outbox.push({
      subscriptionId: subscription.id,
      subscription,
      eventName,
      payload,
      body,
      webhookId,
      webhookTimestamp,
      signature,
      attempts: 0,
      nextRetryAt: Date.now()
    });

    // Kick off outbox processing
    this.processOutbox();
  }

  async processOutbox() {
    if (this.outboxProcessing || this.outbox.length === 0) return;
    
    this.outboxProcessing = true;
    
    while (this.outbox.length > 0) {
      const now = Date.now();
      const item = this.outbox[0];
      
      if (item.nextRetryAt > now) {
        // Wait until next retry time
        const delay = Math.min(item.nextRetryAt - now, 1000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Remove from queue (we'll re-add if retry needed)
      this.outbox.shift();
      
      try {
        const response = await fetch(item.subscription.delivery.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'webhook-id': item.webhookId,
            'webhook-timestamp': item.webhookTimestamp,
            'webhook-signature': item.signature,
            'X-MCP-Subscription-Id': item.subscriptionId
          },
          body: item.body
        });

        if (response.ok) {
          // Success - update last delivery time
          item.subscription.lastDeliveryAt = Date.now();
        } else if (response.status === 410 || response.status === 413) {
          // Gone or payload too large - permanently remove subscription
          this.subscriptions.delete(item.subscriptionId);
        } else {
          // Retryable error
          item.attempts++;
          if (item.attempts < MAX_RETRY_ATTEMPTS) {
            const delay = Math.min(
              INITIAL_RETRY_DELAY_MS * Math.pow(2, item.attempts - 1),
              MAX_RETRY_DELAY_MS
            );
            item.nextRetryAt = Date.now() + delay;
            this.outbox.unshift(item); // Re-add to front for next retry
          } else {
            console.error(`Max retries reached for subscription ${item.subscriptionId}, event ${item.eventName}`);
          }
        }
      } catch (error) {
        // Network error - retry
        item.attempts++;
        if (item.attempts < MAX_RETRY_ATTEMPTS) {
          const delay = Math.min(
            INITIAL_RETRY_DELAY_MS * Math.pow(2, item.attempts - 1),
            MAX_RETRY_DELAY_MS
          );
          item.nextRetryAt = Date.now() + delay;
          this.outbox.unshift(item);
        } else {
          console.error(`Max retries reached for subscription ${item.subscriptionId}, event ${item.eventName}: ${error.message}`);
        }
      }
    }
    
    this.outboxProcessing = false;
  }

  async drainOutbox() {
    // Process remaining items with immediate retries (bounded)
    while (this.outbox.length > 0) {
      const item = this.outbox.shift();
      item.nextRetryAt = Date.now(); // Process immediately
      this.outbox.unshift(item);
      await this.processOutbox();
      if (this.outbox.length > 0 && this.outbox[0].attempts >= MAX_RETRY_ATTEMPTS) {
        // Skip items that have exhausted retries
        this.outbox.shift();
      }
    }
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [id, sub] of this.subscriptions.entries()) {
      if (sub.expiresAt && sub.expiresAt < now) {
        this.subscriptions.delete(id);
      }
    }
  }

  getSubscriptions() {
    return Array.from(this.subscriptions.values());
  }
}

export function createEventManager(core, config) {
  return new EventManager(core, config);
}

export { eventsCatalog, validateCallbackUrl, validateSecret, makeTerminalKey };