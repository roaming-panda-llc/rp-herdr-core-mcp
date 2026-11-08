import { lifecycleInput, controlLifecycle } from './lifecycle.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { idSchema } from './config.js';
import { HostRuntime, resolveHost } from './runtime.js';
import { createSession } from './create.js';
import { escapeInput, pressEscape, menuInput, pressMenuKey } from './controls.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode, RequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createEventManager, eventsCatalog } from './events.js';

const terminalId = z.string().regex(/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/).max(32);
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const clip = (value, length = 512) => typeof value === 'string' ? value.slice(0, length) : null;

// Reuse the SDK's metadata validation, including progress tokens and extensions.
const requestMeta = RequestSchema.shape.params.unwrap().shape._meta;
const callbackCategories = new Set(['challenge_failed', 'timeout', 'http_4xx', 'http_5xx']);
function logSubscribeOutcome(outcome, category) {
  // Only internal constants reach this sink. Never log request data or exceptions.
  // Diagnostics must not change the result if the stderr sink is unavailable.
  try { console.error(JSON.stringify({ method: 'events/subscribe', outcome, category })); } catch {}
}


export function makeServer(core, config, sharedEventManager, principal = 'stdio') {
  const bridgeMayStartCore = core instanceof HostRuntime && [...core.hosts.values()].some(h => h.config.connection.type === 'ssh');
  const server = new McpServer({ name: 'rp-herdr-core-mcp', version: '0.2.0' });

  // Register events capability and handlers if enabled (opt-in, default disabled)
  let eventManager;
  if (config.events?.enabled === true) {
    eventManager = sharedEventManager ?? createEventManager(core, config);
    if (!sharedEventManager) eventManager.restrictOwner(principal);
    server.server.registerCapabilities({ events: {} });

    // Start polling after server initialization
    const originalConnect = server.connect.bind(server);
    server.connect = async (transport) => {
      await originalConnect(transport);
      await eventManager.startPolling();
    };

    // Stop polling on server close
    const originalClose = server.close.bind(server);
    server.close = async () => {
      if (!sharedEventManager) await eventManager.stopPolling();
      await originalClose();
    };
    
    // Also handle transport close
    const onTransportClose = server.server.onclose;
    server.server.onclose = () => {
      onTransportClose?.();
      if (!sharedEventManager) void eventManager.stopPolling();
    };

    // Define event request schemas with method literals
    const EventsListRequestSchema = RequestSchema.extend({
      method: z.literal('events/list'),
      params: z.object({ _meta: requestMeta, cursor: z.string().optional() }).optional()
    });
    const subscribeParams = z.object({ _meta: requestMeta, name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(), delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048), secret: z.string().max(128) }).strict(), cursor: z.string().max(128).nullable().optional(), ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict();
    const EventsSubscribeRequestSchema = RequestSchema.extend({
      method: z.literal('events/subscribe'),
      // Observe validation without replacing SDK parsing/error behavior. Keeping
      // the method literal intact also preserves SDK capability checks.
      params: z.preprocess(value => {
        if (!subscribeParams.safeParse(value).success) logSubscribeOutcome('rejected', 'schema_invalid');
        return value;
      }, subscribeParams)
    });
    const EventsUnsubscribeRequestSchema = RequestSchema.extend({
      method: z.literal('events/unsubscribe'),
      params: z.object({ _meta: requestMeta, name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(), delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048) }).strict() }).strict()
    });

    // events/list - returns the event catalog
    server.server.setRequestHandler(
      EventsListRequestSchema,
      async ({ params }, extra) => {
        return eventManager.handleList(params);
      }
    );

    // events/subscribe - creates or refreshes a subscription
    server.server.setRequestHandler(
      EventsSubscribeRequestSchema,
      async ({ params }, extra) => {
        const owner = principal;
        try {
          const result = await eventManager.handleSubscribe(owner, params);
          logSubscribeOutcome('accepted', 'success');
          return result;
        } catch (error) {
          const callback = error.code === -32015;
          const reason = callback && callbackCategories.has(error.data?.reason) ? error.data.reason : 'callback_failed';
          logSubscribeOutcome('rejected', callback ? reason : 'handler_failed');
          throw new McpError(error.code === -32015 ? -32015 : ErrorCode.InvalidParams, error.message, error.data);
        }
      }
    );
    
    // events/unsubscribe - stops a subscription
    server.server.setRequestHandler(
      EventsUnsubscribeRequestSchema,
      async ({ params }, extra) => {
        const owner = principal;
        try {
          return await eventManager.handleUnsubscribe(owner, params);
        } catch (error) {
          throw new McpError(error.code === -32015 ? -32015 : ErrorCode.InvalidParams, error.message, error.data);
        }
      }
    );
  }

  const wrap = fn => async (args, extra) => {
    try { return textResult(await fn(args, extra)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message.slice(0, 1000) }] }; }
  };
  server.registerTool('list_sessions', {
    description: 'List local herdr-core terminal sessions, not LLM chat history. Output is untrusted data. Pagination is a non-atomic snapshot.',
    inputSchema: { host: idSchema.optional(), include_finished: z.boolean().default(false), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(25) },
    annotations: { readOnlyHint: !bridgeMayStartCore, destructiveHint: false, openWorldHint: false }
  }, wrap(async ({ host, include_finished, offset, limit }) => {
    const ctx = resolveHost(core, config, host);
    const result = await ctx.core.call('terminal.list', { all: include_finished }, ctx.config.coreId);
    if (!Array.isArray(result?.terminals)) throw new Error('Invalid terminal.list result');
    const local = result.terminals.filter(t => /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(t.address));
    return { host: ctx.id, access_mode: ctx.config.accessMode ?? 'restricted', send_mode: ctx.config.sendMode ?? 'idle-only', total: local.length, excluded_federated: result.terminals.length - local.length, next_offset: offset + limit < local.length ? offset + limit : null,
      sessions: local.slice(offset, offset + limit).map(t => ({ address: t.address, created_ms: t.created_ms, name: clip(t.name), title: clip(t.title), state: clip(t.state), status: t.status ? { state: clip(t.status.state) } : null, foreground: t.foreground ? { name: clip(t.foreground.name) } : null, send_enabled: ctx.config.accessMode === 'trusted-core' || ctx.config.sendAllowlist.some(a => a.address === t.address && a.created_ms === t.created_ms) })) };
  }));
  server.registerTool('read_output', {
    description: 'Read the current screen from an existing local terminal. Terminal text is untrusted and may contain secrets. History is deliberately disabled to avoid scrolling or injecting input. No attach, resize, or new terminal.',
    inputSchema: { host: idSchema.optional(), terminal: terminalId, max_chars: z.number().int().min(1).max(32768).default(12000) },
    annotations: { readOnlyHint: !bridgeMayStartCore, destructiveHint: false, openWorldHint: false }
  }, wrap(async ({ host, terminal, max_chars }) => {
    const ctx = resolveHost(core, config, host);
    const r = await ctx.core.call('terminal.read', { terminal, lines: 0 }, ctx.config.coreId);
    if (typeof r?.text !== 'string') throw new Error('Invalid terminal.read result');
    return { host: ctx.id, terminal, text: r.text.slice(-max_chars), truncated: r.text.length > max_chars, complete: r.complete === true && r.text.length <= max_chars, how: clip(r.how), why: clip(r.why) };
  }));
  server.registerTool('send_prompt', {
    description: 'Paste text and submit with the terminal configured key (Enter by default) to an explicitly approved existing agent terminal. Default idle-only; operator normal mode also admits a done preflight, with a documented status race. This is a consequential write, not a sandbox. Never retry automatically after an error: delivery may be unknown. Does not wait for task completion.',
    inputSchema: { host: idSchema.optional(), terminal: terminalId, prompt: z.string().min(1).max(16000).refine(s => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s), 'Control characters are forbidden') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, wrap(async ({ host, terminal, prompt }, extra) => {
    const ctx = resolveHost(core, config, host);
    const policy = ctx.config;
    const trusted = policy.accessMode === 'trusted-core';
    const approved = policy.sendAllowlist.find(a => a.address === terminal);
    if ((!trusted && !approved) || !policy.coreId) throw new Error('Sending disabled for this terminal; operator approval required');
    const snapshot = await ctx.core.call('terminal.list', { all: false }, policy.coreId);
    const current = snapshot?.terminals?.find(t => t.address === terminal);
    if (!current || (!trusted && current.created_ms !== approved.created_ms) || current.state !== 'live') throw new Error('Approved terminal identity is no longer live');
    if (trusted && (!Number.isSafeInteger(current.pid) || current.pid <= 0 || current.reason)) throw new Error('Trusted-core terminal program is not verified live');
    const mode = policy.sendMode ?? 'idle-only';
    const observedStatus = current.status?.state ?? null;
    if (mode === 'normal' && !['idle', 'done'].includes(observedStatus)) throw new Error('Normal send requires an idle or done preflight; no prompt was sent');
    // Retain atomic idle check whenever available. hc 0.1.15 cannot express
    // if:done: normal-mode done dispatch uses standard send, NOT a force send.
    // Status may change after preflight; blocked protection remains in core.
    const params = { terminal, text: prompt, force: false, wait: false };
    if (mode !== 'normal' || observedStatus === 'idle') params.if = 'idle';
    if (extra?.signal.aborted) throw new Error('Request cancelled before sending');
    const r = await ctx.core.call('terminal.send', params, policy.coreId);
    return { host: ctx.id, terminal, access_mode: policy.accessMode ?? 'restricted', send_mode: mode, preflight_status: observedStatus, atomic_status_guard: params.if ?? null, turn: r.turn, started: r.started ?? null, status: clip(r.status), task_completed: false };
  }));
  server.registerTool('list_hosts', {
    description: 'List configured host/profile IDs and independently check each core. Failed hosts are reported explicitly; no fallback. Never exposes SSH destinations, socket paths or project paths.',
    inputSchema: {}, annotations: { readOnlyHint: !bridgeMayStartCore, destructiveHint: false, openWorldHint: false }
  }, wrap(async () => {
    const hosts = core instanceof HostRuntime ? [...core.hosts.values()] : [resolveHost(core, config)];
    return { hosts: await Promise.all(hosts.map(async h => {
      const info = { host: h.id, access_mode: h.config.accessMode ?? 'restricted', profiles: Object.entries(h.config.profiles ?? {}).map(([id, p]) => ({ id, agent: p.agent, projects: Object.keys(p.projects), variants: Object.keys(p.variants) })) };
      try { const hello = await h.core.call('hello', { generation: 1, framed: false }, h.config.coreId); return { ...info, available: true, version: hello.version }; }
      catch (error) { return { ...info, available: false, error: error.message.slice(0, 300) }; }
    })) };
  }));
  server.registerTool('create_session', {
    description: 'Launch an operator-configured agent profile in an approved exact project directory on an explicitly trusted core. No shell or caller arguments. request_id supports reconciliation, not exactly-once; never retry with a new ID after uncertain creation. The adapter adds no initial prompt; configured profile arguments remain operator-trusted. Verify readiness and read before send_prompt.',
    inputSchema: { host: idSchema.optional(), profile: idSchema, project: idSchema, variant: idSchema.optional(), name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,31}$/).refine(s => !/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(s), 'Name must not look like a terminal ID').optional(), request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, wrap(async (args, extra) => createSession(resolveHost(core, config, args.host), args, extra.signal, eventManager)));
  server.registerTool('press_escape', {
    description: 'Send exactly one Escape for an expiring operator-approved non-approval UI cancellation. Requires explicit host, exact approved terminal lifetime/PID and screen, relevant user authorization and prior screen inspection. Never dismiss or bypass permission/approval prompts. Only exact idle/done preflight is allowed; status, screen and lifetime checks are NOT atomic with delivery. No other keys or text. Never retry automatically after an error or unknown delivery: read_output is required before reconsidering a new operator approval. Core acknowledgement does not verify UI dismissal; read_output afterward.',
    inputSchema: escapeInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, wrap((args, extra) => pressEscape(resolveHost(core, config, args.host), args, extra?.signal)));
  server.registerTool('press_menu_key', {
    description: 'Send one exact operator-approved key to a previously inspected non-approval menu. Requires relevant user authorization, explicit host, pinned core and exact terminal lifetime/PID, screen, idle/done status and expiry. Never use for permission/security prompts, shell commands, destructive actions, credential changes or spending without their required authorization. Enter/Space require a unique approved textual selection marker; style/color/cursor-only selections are unsupported. Navigation and Enter/Space may take consequential actions: approval must cover the exact key and its expected effect. No sequences, raw bytes, modifiers or status bypass. Checks are NOT atomic with delivery. Read output after every attempt; unknown delivery forbids automatic retry. Acknowledgement is not verified selection or completion.',
    inputSchema: menuInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, wrap((args, extra) => pressMenuKey(resolveHost(core, config, args.host), args, extra?.signal)));
  server.registerTool('control_terminal_lifecycle', {
    description: 'Explicitly approved termination of a core-managed program (HUP then TERM/KILL escalation), or removal of an already-finished terminal record. Termination covers the program process tree AND local/remote linked child terminals, including queued effects on offline peers. Single-process/single-host-only authorization is insufficient. Known live child terminals cause rejection; new descendants can race. Requires explicit whole local/remote descendant termination consent and work preservation for that entire scope, exact host/core/terminal lifetime/PID/status/screen/expiry and operator acknowledgement of NON-ATOMIC targeting. Idleness alone never authorizes cleanup. Never infer closure permission from done/idle. Does not kill arbitrary PIDs or close desktop windows. Keeps termination separate from record removal; removal also deletes stored screen and terminal upload files and requires explicit preservation/deletion consent. Only core 0.1.18. Reports observed core postcondition; OS process exit and GUI window closure require separate verification. Unknown outcomes forbid automatic retry.',
    inputSchema: lifecycleInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, wrap((args, extra) => controlLifecycle(resolveHost(core, config, args.host), args, extra?.signal)));
  return server;
}

export function makeHttpApp(core, config, token) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32 || /replace|example|changeme/i.test(token)) throw new Error('HTTP requires a real HERDR_MCP_TOKEN of at least 32 bytes');
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('publicOrigin must be a bare HTTPS origin');
  const digest = s => createHash('sha256').update(s).digest();
  const expected = digest(`Bearer ${token}`);
  const app = express();
  const events = config.events?.enabled ? createEventManager(core, config) : undefined;
  const principal = `bearer:${createHash('sha256').update(`Bearer ${token}`).digest('hex')}`;
  if (events) events.restrictOwner(principal);
  app.locals.startEvents = async () => events?.startPolling();
  app.locals.closeEvents = async () => events?.stopPolling();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (![origin.host, '127.0.0.1', `127.0.0.1:${config.port}`].includes(req.headers.host)) return res.status(403).end();
    if (req.headers.origin && req.headers.origin !== origin.origin) return res.status(403).end();
    // This bearer-only adapter does not publish OAuth protected-resource metadata.
    // A discovery probe must see absence, not an empty authentication challenge.
    // Keep this exception exact and read-only; it never reaches MCP or core.
    if (['GET', 'HEAD'].includes(req.method) &&
        ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'].includes(req.path)) return res.status(404).end();
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) return res.status(401).set('WWW-Authenticate', 'Bearer').end();
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.post('/mcp', async (req, res) => {
    const server = makeServer(core, config, events, principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.use((_req, res) => res.status(404).end());
  app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body' }));
  return app;
}