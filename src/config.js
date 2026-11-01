import { z } from 'zod';
export const configSchema = z.object({
  socketPath: z.string().startsWith('/').max(103),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  sendMode: z.enum(['idle-only', 'normal']).default('idle-only'),
  coreId: z.string().min(1).optional(),
  sendAllowlist: z.array(z.object({ address: z.string().regex(/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/), created_ms: z.number().int().nonnegative().safe() }).strict()).max(100).default([]),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
  port: z.number().int().min(1024).max(65535).default(8787),
  publicOrigin: z.string().url().optional()
}).strict().superRefine((v, c) => {
  if (v.sendAllowlist.length && !v.coreId) c.addIssue({ code: 'custom', message: 'Sending requires coreId' });
  if (v.transport === 'http' && !v.publicOrigin) c.addIssue({ code: 'custom', message: 'HTTP requires publicOrigin' });
});
