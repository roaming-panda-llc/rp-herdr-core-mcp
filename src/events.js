import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';

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

function validateCallbackUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Callback URL must use HTTPS');
  }
  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    throw new Error('Callback URL must not target localhost');
  }
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) || /^169\.254\./.test(hostname)) {
    throw new Error('Callback URL must not target private IP ranges');
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
    this.terminalStates = new Map(); // terminal address -> { host, status, state, created_ms, pid, reason }
    this.pollInterval = null;
    this.pollingHosts = new Set();
  }

  startPolling() {
    if (this.pollInterval) return;
    
    // Determine which hosts to poll
    this.pollingHosts.clear();
    if (this.core && typeof this.core.hosts === 'object' && this.core.hosts instanceof Map) {
      // HostRuntime with multiple hosts
      for (const [hostId, host] of this.core.hosts) {
        if (host.config.coreId) {
          this.pollingHosts.add({ hostId, coreId: host.config.coreId, core: host.core });
        }
      }
    } else if (this.core && this.config.coreId) {
      // Single core (legacy)
      this.pollingHosts.add({ hostId: 'local', coreId: this.config.coreId, core: this.core });
    }
    
    // Initial state capture
    this.captureInitialState();
    
    // Start polling every 5 seconds
    this.pollInterval = setInterval(() => this.pollTerminals(), 5000);
    this.pollInterval.unref(); // Don't prevent process exit
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async captureInitialState() {
    for (const hostInfo of this.pollingHosts) {
      try {
        const result = await hostInfo.core.call('terminal.list', { all: true }, hostInfo.coreId);
        if (Array.isArray(result?.terminals)) {
          for (const terminal of result.terminals) {
            if (!terminal.address) continue;
            this.terminalStates.set(terminal.address, {
              host: hostInfo.hostId,
              status: terminal.status?.state ?? null,
              state: terminal.state ?? null,
              created_ms: terminal.created_ms ?? null,
              pid: terminal.pid ?? null,
              reason: terminal.reason ?? null
            });
          }
        }
      } catch (error) {
        console.error(`Failed to capture initial state for ${hostInfo.hostId}:`, error.message);
      }
    }
  }

  async pollTerminals() {
    for (const hostInfo of this.pollingHosts) {
      try {
        const result = await hostInfo.core.call('terminal.list', { all: true }, hostInfo.coreId);
        if (!Array.isArray(result?.terminals)) continue;
        
        const currentTerminals = new Set();
        
        for (const terminal of result.terminals) {
          if (!terminal.address) continue;
          currentTerminals.add(terminal.address);
          
          const previous = this.terminalStates.get(terminal.address);
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
            this.terminalStates.set(terminal.address, {
              host: hostInfo.hostId,
              status: currentStatus,
              state: currentState,
              created_ms: terminal.created_ms ?? null,
              pid: terminal.pid ?? null,
              reason: terminal.reason ?? null
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
                exit_code: terminal.pid ? 0 : null, // We don't have actual exit code from list
                reason: terminal.reason ?? 'unknown',
                finished_ms: Date.now()
              });
            }
            
            // Update state
            this.terminalStates.set(terminal.address, {
              host: hostInfo.hostId,
              status: currentStatus,
              state: currentState,
              created_ms: terminal.created_ms ?? null,
              pid: terminal.pid ?? null,
              reason: terminal.reason ?? null
            });
          }
        }
        
        // Check for terminals that disappeared (finished)
        for (const [address, previous] of this.terminalStates.entries()) {
          if (previous.host !== hostInfo.hostId) continue;
          if (!currentTerminals.has(address)) {
            // Terminal disappeared - emit finished
            await this.deliverEvent('terminal.finished', {
              host: hostInfo.hostId,
              terminal: address,
              exit_code: null,
              reason: 'disappeared',
              finished_ms: Date.now()
            });
            this.terminalStates.delete(address);
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

  async handleSubscribe(owner, params) {
    const { name, arguments: args = {}, delivery, cursor, ttlMs } = params;
    
    const eventDef = this.getEventDefinition(name);
    if (!eventDef) {
      throw new Error(`Unknown event: ${name}`);
    }

    if (!delivery || delivery.mode !== 'webhook') {
      throw new Error('Only webhook delivery mode is supported');
    }

    validateCallbackUrl(delivery.url);
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
        redirect: 'error',
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

      await this.deliverToSubscription(subscription, eventName, payload);
    }
  }

  matchSubscription(subscription, payload) {
    const { arguments: filters } = subscription;
    if (filters.host && filters.host !== payload.host) return false;
    if (filters.terminal && filters.terminal !== payload.terminal) return false;
    return true;
  }

  async deliverToSubscription(subscription, eventName, payload) {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const response = await fetch(subscription.delivery.url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': webhookTimestamp,
          'webhook-signature': signature,
          'X-MCP-Subscription-Id': subscription.id
        },
        body
      });

      clearTimeout(timeout);

      if (response.ok) {
        subscription.lastDeliveryAt = Date.now();
      } else if (response.status === 410 || response.status === 413) {
        this.subscriptions.delete(subscription.id);
      }
    } catch (error) {
      clearTimeout(timeout);
      console.error(`Webhook delivery failed for ${subscription.id}:`, error.message);
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

export { eventsCatalog };