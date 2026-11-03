import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { validateCallbackUrl, webhookFetch } from './webhook.js';
import { EventStore } from './event-store.js';

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
        terminal: { type: 'string', description: 'Terminal address to filter by' },
        created_ms: { type: 'integer', description: 'Terminal lifetime timestamp to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        created_ms: { type: 'integer' },
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
        terminal: { type: 'string', description: 'Terminal address to filter by' },
        created_ms: { type: 'integer', description: 'Terminal lifetime timestamp to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        created_ms: { type: 'integer' },
        exit_code: { type: ['number', 'null'] },
        reason: { type: ['string', 'null'] },
        finished_ms: { type: 'number' }
      },
      required: ['host', 'terminal', 'finished_ms'],
      additionalProperties: false
    }
  }
];

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_SUBSCRIPTIONS = 100;
const MAX_OUTBOX = 1000;
const MAX_HISTORY = 1000;
const MAX_TERMINALS = 10000;
const TTL = 24 * 60 * 60 * 1000;
const ROTATION_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const keyOf = (...parts) => JSON.stringify(parts);
function makeTerminalKey(host, terminal) { return keyOf(host, terminal); }
function generateSubscriptionId(owner, url, eventName, args) {
  return 'sub_' + createHash('sha256').update(keyOf(owner, url, eventName, Object.fromEntries(Object.entries(args).sort()))).digest('hex');
}
function callbackError(reason) {
  return Object.assign(new Error('Callback verification failed'), { code: -32015, data: { reason } });
}

function validateSecret(secret) {
  if (!secret.startsWith('whsec_')) {
    throw new Error('Secret must start with whsec_');
  }
  const base64 = secret.slice(6);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Secret must be valid base64');
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
      return z.object({ host: z.string().max(128).optional() }).strict();
    case 'terminal.status_changed':
      return z.object({ host: z.string().max(128).optional(), terminal: z.string().max(32).optional(), created_ms: z.number().int().nonnegative().optional() }).strict();
    case 'terminal.finished':
      return z.object({ host: z.string().max(128).optional(), terminal: z.string().max(32).optional(), created_ms: z.number().int().nonnegative().optional() }).strict();
    default:
      return z.object({}).strict();
  }
}

export class EventManager {
  constructor(core, config, { transport = webhookFetch, now = Date.now, store, autoDispatch = true } = {}) {
    this.core = core;
    this.config = config;
    this.transport = transport;
    this.now = now;
    this.store = store ?? (config.events?.stateDirectory ? new EventStore(config.events.stateDirectory) : null);
    this.autoDispatch = autoDispatch;
    this.state = this.store?.load() ?? { version: 1, subscriptions: [], outbox: [], history: [], sequence: 0, terminals: [], initializedHosts: [], created: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.subscriptions) || !Array.isArray(this.state.outbox) || !Array.isArray(this.state.history) || !Array.isArray(this.state.terminals) || !Array.isArray(this.state.created) || !Array.isArray(this.state.initializedHosts) || !Number.isSafeInteger(this.state.sequence) || this.state.subscriptions.length > MAX_SUBSCRIPTIONS || this.state.outbox.length > MAX_OUTBOX || this.state.history.length > MAX_HISTORY || this.state.terminals.length > MAX_TERMINALS) throw new Error('Invalid event state');
    const scope = createHash('sha256').update(JSON.stringify({ hosts: config.hosts, coreId: config.coreId, socketPath: config.socketPath })).digest('hex');
    if (this.state.scope && this.state.scope !== scope) throw new Error('Event storage belongs to a different core configuration');
    this.state.scope = scope;
    this.verificationCache = new Map();
    this.pending = new Map();
    this.pendingCount = 0;
    this.verifying = new Map();
    this.controllers = new Map();
    this.pollingHosts = [];
    this.shuttingDown = false;
    this.cleanupExpired();
  }
  persist() {
    try { this.store?.save(this.state); }
    catch { this.shuttingDown = true; for (const c of this.controllers.values()) c.abort(); throw new Error('Event storage write failed; delivery stopped'); }
  }
  restrictOwner(owner) {
    for (const sub of [...this.state.subscriptions]) if (sub.owner !== owner) this.remove(sub.id);
    this.persist();
  }
  get subscriptions() { return new Map(this.state.subscriptions.map(s => [s.id, s])); }
  get outbox() { return this.state.outbox; }
  getCatalog() { return eventsCatalog; }
  getEventDefinition(name) { return eventsCatalog.find(e => e.name === name); }
  async handleList() { return { events: eventsCatalog, nextCursor: null }; }
  getSubscriptions() { return structuredClone(this.state.subscriptions); }
  async startPolling() {
    if (this.started || this.shuttingDown || !this.store) return;
    this.started = true;
    if (this.core?.hosts instanceof Map) {
      this.pollingHosts = [...this.core.hosts].filter(([, h]) => h.config.coreId).map(([hostId, h]) => ({ hostId, coreId: h.config.coreId, core: h.core }));
    } else if (this.core && this.config.coreId) this.pollingHosts = [{ hostId: 'local', coreId: this.config.coreId, core: this.core }];
    await this.pollTerminals();
    this.timer = setInterval(() => {
      if (!this.pollPromise && !this.shuttingDown) {
        this.pollPromise = this.pollTerminals().catch(() => {}).finally(() => { this.pollPromise = null; });
      }
      this.kick();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.kick();
  }
  async stopPolling() {
    this.shuttingDown = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([this.pollPromise, this.processing, ...this.pending.values()]);
    // Queued work remains durable for restart, rather than draining at shutdown.
  }
  active(id) { return this.state.subscriptions.find(s => s.id === id && s.expiresAt > this.now()); }
  remove(id) {
    this.state.subscriptions = this.state.subscriptions.filter(s => s.id !== id);
    this.state.outbox = this.state.outbox.filter(i => i.subscriptionId !== id);
    this.controllers.get(id)?.abort();
  }
  cleanupExpired() {
    let changed = false;
    for (const sub of [...this.state.subscriptions]) {
      if (sub.expiresAt <= this.now()) { this.remove(sub.id); changed = true; }
      else if (sub.oldSecret && sub.rotateUntil <= this.now()) { delete sub.oldSecret; delete sub.rotateUntil; changed = true; }
    }
    for (const [key, expiry] of this.verificationCache) if (expiry <= this.now()) this.verificationCache.delete(key);
    if (changed) this.persist();
  }
  async handleSubscribe(owner, params) {
    if (this.shuttingDown) throw new Error('Events are stopping');
    const { name, arguments: args = {}, delivery, cursor = null, ttlMs } = params ?? {};
    if (!owner) throw new Error('Authenticated event principal required');
    if (!this.getEventDefinition(name)) throw new Error(`Unknown event: ${name}`);
    if (!delivery || delivery.mode !== 'webhook') throw new Error('Only webhook delivery mode is supported');
    validateCallbackUrl(delivery.url);
    if (typeof delivery.secret !== 'string' || delivery.secret.length > 128 || delivery.url.length > 2048) throw new Error('Invalid delivery');
    validateSecret(delivery.secret);
    const parsedArguments = getEventInputZodSchema(name).safeParse(args);
    if (!parsedArguments.success) throw new Error('Invalid arguments for event');
    const arguments_ = parsedArguments.data;
    if (ttlMs != null && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) throw new Error('Invalid ttlMs');
    if (cursor !== null && (typeof cursor !== 'string' || !/^created:[0-9]+$/.test(cursor) || !Number.isSafeInteger(Number(cursor.slice(8))))) throw new Error('Invalid cursor');
    if (name !== 'terminal.created' && cursor !== null) throw new Error('Event does not support replay');
    if (!this.store) throw new Error('Configure events.stateDirectory before subscribing');
    this.cleanupExpired();
    const id = generateSubscriptionId(owner, delivery.url, name, arguments_);
    if (this.pendingCount >= MAX_SUBSCRIPTIONS) throw new Error('Pending subscription capacity exceeded');
    // Serialize mutations for an identity. Unsubscribe waits for this operation,
    // so it cannot be undone by a late verification response.
    this.pendingCount++;
    const previous = this.pending.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (this.shuttingDown) throw new Error('Events are stopping');
      const existing = this.active(id);
      if (!existing && this.state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error('Subscription capacity exceeded');
      const cacheKey = keyOf(owner, delivery.url);
      if ((this.verificationCache.get(cacheKey) ?? 0) <= this.now()) {
        let verification = this.verifying.get(cacheKey);
        if (!verification) {
          verification = this.sendVerification(delivery.url, delivery.secret, id);
          this.verifying.set(cacheKey, verification);
        }
        try { await verification; } finally { if (this.verifying.get(cacheKey) === verification) this.verifying.delete(cacheKey); }
        if (this.shuttingDown) throw new Error('Events are stopping');
        if (this.verificationCache.size >= MAX_SUBSCRIPTIONS) this.verificationCache.delete(this.verificationCache.keys().next().value);
        this.verificationCache.set(cacheKey, this.now() + ROTATION_MS);
      }
      if (!this.active(id) && this.state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error('Subscription capacity exceeded');
      let position = cursor === null ? (existing?.cursor ?? this.state.sequence) : Number(cursor.slice(8));
      if (position > this.state.sequence) throw new Error('Cursor is ahead of history');
      const floor = this.state.history[0]?.sequence ?? this.state.sequence + 1;
      const truncated = name === 'terminal.created' && position < floor - 1;
      position = Math.max(position, floor - 1);
      const sub = {
        id, owner, eventName: name, arguments: arguments_, delivery: { ...delivery },
        expiresAt: this.now() + Math.min(TTL, Math.max(60000, ttlMs ?? TTL)),
        cursor: name === 'terminal.created' ? position : null,
        createdAt: existing?.createdAt ?? this.now(), verified: true
      };
      if (existing?.delivery.secret !== delivery.secret && existing) {
        sub.oldSecret = existing.delivery.secret; sub.rotateUntil = this.now() + ROTATION_MS;
      } else if (existing?.rotateUntil > this.now()) {
        sub.oldSecret = existing.oldSecret; sub.rotateUntil = existing.rotateUntil;
      }
      const replay = name === 'terminal.created' ? this.state.history.filter(e => e.sequence > position && this.matchSubscription(sub, e.data) && !this.state.outbox.some(i => i.subscriptionId === id && i.eventId === e.eventId)) : [];
      if (this.state.outbox.length + replay.length > MAX_OUTBOX) throw new Error('Outbox capacity exceeded');
      this.state.subscriptions = this.state.subscriptions.filter(s => s.id !== id);
      this.state.subscriptions.push(sub);
      for (const event of replay) this.enqueue(sub, event);
      for (const item of this.state.outbox) if (item.subscriptionId === id && item.attempts >= 5) { item.attempts = 0; item.nextRetryAt = this.now(); }
      this.state.outbox.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const awaiting = this.state.outbox.filter(i => i.subscriptionId === id && i.sequence != null);
      if (awaiting.length) sub.cursor = Math.min(sub.cursor, ...awaiting.map(i => i.sequence - 1));
      this.persist();
      this.kick();
      return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: name === 'terminal.created' ? `created:${sub.cursor}` : null, truncated };
    });
    this.pending.set(id, operation);
    try { return await operation; }
    finally { this.pendingCount--; if (this.pending.get(id) === operation) this.pending.delete(id); }
  }
  async handleUnsubscribe(owner, params) {
    const { name, arguments: args = {}, delivery } = params ?? {};
    if (!owner || !delivery || delivery.mode !== 'webhook') throw new Error('Invalid unsubscribe');
    const parsedArguments = getEventInputZodSchema(name).safeParse(args);
    if (!parsedArguments.success) throw new Error('Invalid arguments for event');
    const arguments_ = parsedArguments.data;
    const id = generateSubscriptionId(owner, delivery.url, name, arguments_);
    await this.pending.get(id)?.catch(() => {});
    this.remove(id);
    this.persist();
    return {};
  }
  headers(sub, eventId, body) {
    const date = new Date(this.now());
    const secrets = [sub.delivery.secret];
    if (sub.oldSecret && sub.rotateUntil > this.now()) secrets.push(sub.oldSecret);
    return {
      'Content-Type': 'application/json', 'webhook-id': eventId,
      'webhook-timestamp': String(Math.floor(date.getTime() / 1000)),
      'webhook-signature': secrets.map(secret => new Webhook(secret).sign(eventId, date, body)).join(' '),
      'X-MCP-Subscription-Id': sub.id
    };
  }
  async sendVerification(url, secret, id) {
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    const controller = new AbortController();
    const controllerKey = `verification:${id}`;
    this.controllers.set(controllerKey, controller);
    try {
      const response = await this.transport(url, { body, headers: this.headers({ id, delivery: { secret } }, 'msg_verification_' + randomBytes(16).toString('hex'), body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw callbackError(response.status >= 500 ? 'http_5xx' : 'http_4xx');
      const data = await response.json();
      const received = Buffer.from(typeof data?.challenge === 'string' ? data.challenge : '');
      const expected = Buffer.from(challenge);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw callbackError('challenge_failed');
    } catch (error) {
      if (error.code === -32015) throw error;
      throw callbackError(error.name === 'TimeoutError' || /timeout/i.test(error.message) ? 'timeout' : 'challenge_failed');
    } finally { if (this.controllers.get(controllerKey) === controller) this.controllers.delete(controllerKey); }
  }
  matchSubscription(sub, payload) {
    return (!sub.arguments.host || sub.arguments.host === payload.host) && (!sub.arguments.terminal || sub.arguments.terminal === payload.terminal) && (sub.arguments.created_ms === undefined || sub.arguments.created_ms === payload.created_ms);
  }
  enqueue(sub, event) {
    const body = JSON.stringify({ eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: event.sequence == null ? null : `created:${event.sequence}` });
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw new Error('Event payload too large');
    this.state.outbox.push({ subscriptionId: sub.id, eventId: event.eventId, sequence: event.sequence, body, attempts: 0, nextRetryAt: this.now() });
  }
  deliverEvent(name, payload) {
    if (this.shuttingDown) return;
    const definition = this.getEventDefinition(name);
    if (!definition) throw new Error('Unknown event');
    const schema = definition.payloadSchema;
    if (!payload || schema.required.some(key => !(key in payload)) || Object.entries(payload).some(([key, value]) => {
      const type = schema.properties[key]?.type;
      const types = Array.isArray(type) ? type : [type];
      return !types.some(t => t === 'null' ? value === null : t === 'integer' ? Number.isSafeInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === t);
    })) throw new Error('Invalid event payload');
    if (!this.batching) this.cleanupExpired();
    const lifetime = keyOf(payload.host, payload.terminal, payload.created_ms);
    if (name === 'terminal.created' && this.state.created.includes(lifetime)) return;
    const matching = this.state.subscriptions.filter(s => s.eventName === name && this.matchSubscription(s, payload));
    if (this.state.outbox.length + matching.length > MAX_OUTBOX) throw new Error('Outbox capacity exceeded');
    const event = { eventId: 'evt_' + randomBytes(16).toString('hex'), name, timestamp: new Date(this.now()).toISOString(), data: payload, sequence: name === 'terminal.created' ? this.state.sequence + 1 : null };
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_PAYLOAD_BYTES - 64) throw new Error('Event payload too large');
    if (name === 'terminal.created') {
      this.state.sequence++;
      this.state.created.push(lifetime);
      this.state.created = this.state.created.slice(-MAX_TERMINALS);
      this.state.history.push(event);
      this.state.history = this.state.history.slice(-MAX_HISTORY);
    }
    for (const sub of matching) this.enqueue(sub, event);
    if (!this.batching) { this.persist(); this.kick(); }
  }
  kick() {
    if (!this.autoDispatch || this.shuttingDown) return;
    clearTimeout(this.retryTimer);
    void this.processOutbox().catch(() => {}).finally(() => {
      if (this.state.outbox.length && !this.shuttingDown) {
        const heads = new Map();
        for (const item of this.state.outbox) if (!heads.has(item.subscriptionId)) heads.set(item.subscriptionId, item.nextRetryAt);
        const due = Math.min(...heads.values());
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.kick(), Math.max(1, due - this.now()));
        this.retryTimer.unref?.();
      }
    });
  }
  async processOutbox() {
    if (this.processing) return this.processing;
    this.processing = this.runOutbox();
    try { await this.processing; } finally { this.processing = null; }
  }
  async runOutbox() {
    this.cleanupExpired();
    while (!this.shuttingDown) {
      // FIFO per subscription, but a delayed destination never blocks others.
      const seen = new Set();
      let item = this.state.outbox.find(i => { if (seen.has(i.subscriptionId)) return false; seen.add(i.subscriptionId); return i.nextRetryAt <= this.now(); });
      if (!item) return;
      const sub = this.active(item.subscriptionId);
      if (!sub) { this.remove(item.subscriptionId); this.persist(); continue; }
      const controller = new AbortController();
      this.controllers.set(sub.id, controller);
      let response;
      try {
        response = await this.transport(sub.delivery.url, { body: item.body, headers: this.headers(sub, item.eventId, item.body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(10000, sub.expiresAt - this.now())))]) });
      } catch { /* Retry only while the subscription remains authorized. */ }
      finally { if (this.controllers.get(sub.id) === controller) this.controllers.delete(sub.id); }
      if (this.shuttingDown) return;
      item = this.state.outbox.find(i => i.eventId === item.eventId && i.subscriptionId === sub.id);
      if (!item) continue;
      const current = this.active(sub.id);
      if (!current) { this.remove(sub.id); this.persist(); continue; }
      if (response?.ok) {
        this.state.outbox = this.state.outbox.filter(i => i !== item);
        current.lastDeliveryAt = this.now();
        if (item.sequence != null) {
          const awaiting = this.state.outbox.filter(i => i.subscriptionId === sub.id && i.sequence != null);
          current.cursor = Math.min(Math.max(current.cursor, item.sequence), ...awaiting.map(i => i.sequence - 1));
        }
      } else if (response?.status === 410 || response?.status === 413) this.remove(sub.id);
      else {
        item.attempts++;
        // Retain a failed head to avoid advancing a replay cursor across a gap.
        // Refresh can recreate it from history after expiry; no unbounded retries.
        if (item.attempts >= 5) item.nextRetryAt = current.expiresAt;
        else item.nextRetryAt = this.now() + 1000 * 2 ** (item.attempts - 1);
      }
      this.persist();
    }
  }
  async pollTerminals() {
    for (const host of this.pollingHosts) {
      if (this.shuttingDown) break;
      let result;
      try { result = await host.core.call('terminal.list', { all: true }, host.coreId); }
      catch { continue; } // A failed host read never means terminals disappeared.
      if (this.shuttingDown || !Array.isArray(result?.terminals)) continue;
      const records = result.terminals.filter(t => /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(t.address) && Number.isSafeInteger(t.created_ms));
      if (records.length + this.state.terminals.filter(t => t.host !== host.hostId).length > MAX_TERMINALS) throw new Error('Terminal state capacity exceeded');
      const initial = !this.state.initializedHosts.includes(host.hostId);
      const next = [], events = [];
      const finish = (previous, reason) => events.push(['terminal.finished', { host: previous.host, terminal: previous.address, created_ms: previous.created_ms, exit_code: null, reason: String(reason).slice(0, 128), finished_ms: this.now() }]);
      for (const terminal of records) {
        const previous = this.state.terminals.find(t => t.host === host.hostId && t.address === terminal.address);
        const same = previous?.created_ms === terminal.created_ms;
        const live = terminal.state === 'live' && terminal.pid > 0 && !terminal.reason;
        if (!initial && previous && !same && !previous.finished) finish(previous, 'replaced');
        if (!initial && !same) events.push(['terminal.created', {
          host: host.hostId, terminal: terminal.address, created_ms: terminal.created_ms,
          name: String(terminal.name ?? '').slice(0, 512), profile: String(terminal.labels?.rp_mcp_profile ?? '').slice(0, 128), project: String(terminal.labels?.rp_mcp_project ?? '').slice(0, 128)
        }]);
        const status = typeof terminal.status?.state === 'string' ? terminal.status.state.slice(0, 128) : null;
        if (!initial && same && status !== previous.status && status !== null) events.push(['terminal.status_changed', { host: host.hostId, terminal: terminal.address, created_ms: terminal.created_ms, previous_status: previous.status ?? 'unknown', new_status: status, timestamp_ms: this.now() }]);
        if (!initial && same && previous.live && !live && !previous.finished) finish(previous, terminal.reason ?? 'unknown');
        next.push({ host: host.hostId, address: terminal.address, created_ms: terminal.created_ms, status, live, finished: same ? previous.finished || !live : !live });
      }
      if (!initial) for (const previous of this.state.terminals.filter(t => t.host === host.hostId)) {
        if (!next.some(t => t.address === previous.address) && !previous.finished) finish(previous, 'disappeared');
      }
      // Queue events and checkpoint the observed lifetimes in one durable write.
      // There are no awaits in this transaction, so another request cannot save
      // an intermediate checkpoint or race an enqueue against cancellation.
      const before = structuredClone(this.state);
      this.batching = true;
      try {
        this.state.terminals = [...this.state.terminals.filter(t => t.host !== host.hostId), ...next];
        if (initial) this.state.initializedHosts.push(host.hostId);
        for (const [name, data] of events) this.deliverEvent(name, data);
        this.persist();
      } catch (error) { this.state = before; throw error; }
      finally { this.batching = false; }
      this.kick();
    }
    this.cleanupExpired();
  }

}

export function createEventManager(core, config) { return new EventManager(core, config); }
export { eventsCatalog, validateCallbackUrl, validateSecret, makeTerminalKey };
