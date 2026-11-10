import { createHash } from 'node:crypto';
import { configSchema, idSchema } from './config.js';
import { z } from 'zod';

export function eventScope(config) {
  const hosts = config.hosts && Object.fromEntries(Object.entries(config.hosts).map(([id, host]) => {
    const { escape, ...eventHost } = host;
    return [id, eventHost];
  }));
  return createHash('sha256').update(JSON.stringify({ hosts, coreId: config.coreId, socketPath: config.socketPath })).digest('hex');
}

const targetSchema = z.object({
  host: idSchema,
  address: z.string().regex(/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/).max(32),
  created_ms: z.number().int().nonnegative().safe()
}).strict();

// Offline operator-only primitive, NOT an MCP tool or automatic startup path.
// Caller must stop the sole adapter writer and arrange encrypted backup/rollback
// before saving the returned state with the existing EventStore/key. This pure
// function performs no I/O, delivery, cleanup or subscription recreation.
export function rebindSendTargetExtension(state, beforeInput, afterInput, targetInput) {
  const before = configSchema.parse(beforeInput);
  const after = configSchema.parse(afterInput);
  const target = targetSchema.parse(targetInput);
  const host = before.hosts?.[target.host];
  if (!before.events?.enabled || !before.events.stateDirectory || !host || host.accessMode !== 'restricted' || host.sendMode !== 'idle-only' || !host.coreId) throw new Error('Requires an existing restricted idle-only named host and durable events');
  if (host.sendAllowlist.some(a => a.address === target.address)) throw new Error('Target address already has a grant; replacement is not an extension');
  const expected = structuredClone(before);
  expected.hosts[target.host].sendAllowlist.push({ address: target.address, created_ms: target.created_ms });
  if (JSON.stringify(expected) !== JSON.stringify(after)) throw new Error('Only the exact appended lifetime grant may change');
  if (state?.version !== 1 || state.scope !== eventScope(before) || !['subscriptions', 'outbox', 'history', 'terminals', 'initializedHosts', 'created'].every(k => Array.isArray(state[k])) || !Number.isSafeInteger(state.sequence)) throw new Error('Existing event state does not match the exact prior configuration');
  return { ...structuredClone(state), scope: eventScope(after) };
}
