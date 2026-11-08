import { z } from 'zod';
import { createHash } from 'node:crypto';

const terminal = z.string().regex(/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/).max(32);
const integer = z.number().int().nonnegative().safe();
export const escapePolicy = z.object({
  enabled: z.boolean().default(false),
  approvals: z.array(z.object({
    action_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    terminal, created_ms: integer, pid: integer.positive(),
    action: z.literal('dismiss-nonapproval-ui'),
    status: z.enum(['idle', 'done']),
    screen_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expires_ms: integer
  }).strict()).max(100).default([])
}).strict().refine(p => new Set(p.approvals.map(a => a.action_id)).size === p.approvals.length, 'Duplicate Escape action IDs');
export const escapeInput = z.object({
  host: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), terminal,
  action_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  inspected_and_authorized: z.literal(true)
}).strict();
// Shared by HTTP requests: claiming an action before any await prevents concurrent
// replay. Consumed after dispatch even on uncertainty. This is not durable storage.
const attempts = new WeakMap();
export async function pressEscape(ctx, input, signal) {
  return pressApprovedKey(ctx, escapeInput.parse(input), signal, ctx.config.escape, 'dismiss-nonapproval-ui', 'esc');
}
export const menuKey = z.enum(['up', 'down', 'left', 'right', 'tab', 'space', 'enter']);
export const menuInput = escapeInput.extend({ key: menuKey }).strict();
export const menuPolicy = z.object({
  enabled: z.boolean().default(false),
  approvals: z.array(z.object({
    action_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    terminal, created_ms: integer, pid: integer.positive(),
    action: z.literal('interact-nonapproval-menu'), key: menuKey,
    selection_text: z.string().min(1).max(512).optional(),
    status: z.enum(['idle', 'done']),
    screen_sha256: z.string().regex(/^[a-f0-9]{64}$/), expires_ms: integer
  }).strict().refine(a => !['enter', 'space'].includes(a.key) || !!a.selection_text, 'Confirmation requires an inspected textual selection marker')).max(100).default([])
}).strict().refine(p => new Set(p.approvals.map(a => a.action_id)).size === p.approvals.length, 'Duplicate menu action IDs');
export async function pressMenuKey(ctx, input, signal) {
  const args = menuInput.parse(input);
  // Validate configuration even for direct callers, before reading or dispatching.
  const policy = ctx.config.menu ? menuPolicy.parse(ctx.config.menu) : undefined;
  try { return await pressApprovedKey(ctx, args, signal, policy, 'interact-nonapproval-menu', args.key); }
  catch (error) { error.message = error.message.replaceAll('Escape', 'Menu key'); throw error; }
}
async function pressApprovedKey(ctx, args, signal, policy, action, key) {
  if (args.host !== ctx.id) throw new Error('Escape host mismatch');
  if (!policy?.enabled || !ctx.config.coreId) throw new Error('Escape disabled; explicit operator opt-in and pinned core required');
  const approval = policy.approvals.find(a => a.action_id === args.action_id && a.terminal === args.terminal);
  if (!approval || approval.action !== action || (action === 'interact-nonapproval-menu' && approval.key !== key) || !['idle', 'done'].includes(approval.status)) throw new Error('No exact Escape cancellation approval');
  const check = () => {
    if (signal?.aborted) throw new Error('Request cancelled before Escape dispatch');
    if (Date.now() >= approval.expires_ms) throw new Error('Escape approval expired');
  };
  check();
  let used = attempts.get(ctx.core);
  if (!used) attempts.set(ctx.core, used = new Set());
  if (used.has(args.action_id)) throw new Error('Escape action already attempted or pending; read back before any new operator approval; no automatic retry');
  used.add(args.action_id);
  let dispatched = false;
  try {
    const verify = async () => {
      const snapshot = await ctx.core.call('terminal.list', { all: false }, ctx.config.coreId);
      const matches = snapshot?.terminals?.filter(t => t.address === args.terminal);
      const t = matches?.length === 1 ? matches[0] : null;
      if (!t || t.created_ms !== approval.created_ms || t.state !== 'live' || !Number.isSafeInteger(t.pid) || t.pid <= 0 || t.pid !== approval.pid || t.reason) throw new Error('Approved Escape terminal lifetime/program is not live');
      if (t.status?.state !== approval.status) throw new Error('Escape requires the exact approved idle/done state; no key was sent');
      check();
    };
    await verify();
    const screen = await ctx.core.call('terminal.read', { terminal: args.terminal, lines: 0 }, ctx.config.coreId);
    if (screen?.complete !== true || typeof screen.text !== 'string' || createHash('sha256').update(screen.text).digest('hex') !== approval.screen_sha256) throw new Error('Escape screen differs from inspected operator approval');
    if (action === 'interact-nonapproval-menu' && ['enter', 'space'].includes(key) && (!approval.selection_text || screen.text.split(approval.selection_text).length !== 2)) throw new Error('Menu selection marker must occur exactly once in the inspected screen');
    await verify();
    check();
    dispatched = true;
    const result = await ctx.core.call('terminal.keys', { terminal: args.terminal, keys: [key] }, ctx.config.coreId, { signal, deadlineMs: approval.expires_ms, ...(action === 'interact-nonapproval-menu' ? { requiredVersion: '0.1.18' } : {}) });
    if (!Number.isSafeInteger(result?.turn) || result.turn < 0 || !(result.status === null || typeof result.status === 'string')) throw new Error('Invalid Escape response; delivery is UNKNOWN; read back before any new approval; no automatic retry');
    return { ...(action === 'interact-nonapproval-menu' ? { key, outcome: 'unverified' } : {}), host: ctx.id, terminal: args.terminal, action_id: args.action_id, delivery: 'core_acknowledged', ui_dismissed: 'unverified', readback_required: true, preflight_status: approval.status, atomic_status_guard: null, atomic_lifetime_guard: false, turn: result.turn, status: result.status };
  } finally {
    if (!dispatched) used.delete(args.action_id);
  }
}
