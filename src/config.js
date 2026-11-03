import { z } from 'zod';
import path from 'node:path';
export const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const absolutePath = z.string().min(1).max(1024).refine(s => s.startsWith('/') && !/[\x00-\x1f\x7f]/.test(s) && path.posix.normalize(s) === s, 'Use a normalized absolute Unix path');
const terminalId = z.string().regex(/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/).max(32);
const spaceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).max(128);
const policy = {
  coreId: z.string().min(1).max(256).optional(),
  accessMode: z.enum(['restricted', 'trusted-core']).default('restricted'),
  sendMode: z.enum(['idle-only', 'normal']).default('idle-only'),
  sendAllowlist: z.array(z.object({ address: terminalId, created_ms: z.number().int().nonnegative().safe() }).strict()).max(100).default([]),
  timeoutMs: z.number().int().min(100).max(60000).default(15000)
};
const argument = z.string().max(1024).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'No control characters');
const profile = z.object({
  agent: z.enum(['pi', 'claude']),
  executable: absolutePath,
  args: z.array(argument).max(40).default([]),
  variants: z.record(idSchema, z.array(argument).max(20)).default({}).refine(v => Object.keys(v).length <= 16, 'At most 16 variants'),
  projects: z.record(idSchema, absolutePath),
  desktopSpaces: z.record(idSchema, spaceId).default({}).refine(s => Object.keys(s).length <= 32, 'At most 32 desktop space mappings')
}).strict().refine(p => Object.keys(p.projects).length > 0 && Object.keys(p.projects).length <= 32, 'Configure 1–32 exact project directories').refine(p => Object.keys(p.desktopSpaces).every(k => Object.prototype.hasOwnProperty.call(p.projects, k)), 'desktopSpaces keys must be configured projects');
const host = z.object({
  ...policy,
  connection: z.discriminatedUnion('type', [
    z.object({ type: z.literal('unix'), socketPath: absolutePath.refine(s => s.length <= 103) }).strict(),
    z.object({ type: z.literal('ssh'), destination: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/),
      hcPath: absolutePath, session: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).refine(s => s !== '.' && s !== '..', 'Invalid hc session'),
      allowCoreAutoStart: z.boolean().default(false)
    }).strict()
  ]),
  profiles: z.record(idSchema, profile).default({})
}).strict().superRefine((v, c) => {
  if (!v.coreId) c.addIssue({ code: 'custom', message: 'Every named host requires a pinned coreId' });
  if (v.connection.type === 'ssh' && !v.connection.allowCoreAutoStart) c.addIssue({ code: 'custom', message: 'SSH hc connect may auto-start core; explicit allowCoreAutoStart:true is required' });
  if (Object.keys(v.profiles).length > 8) c.addIssue({ code: 'custom', message: 'At most 8 profiles per host' });
  if (Object.keys(v.profiles).length && v.accessMode !== 'trusted-core') c.addIssue({ code: 'custom', message: 'Creation profiles require explicit trusted-core access' });
});
const events = z.object({
  enabled: z.boolean().default(false),
  stateDirectory: absolutePath.optional()
}).strict();

export const configSchema = z.object({
  ...policy,
  socketPath: absolutePath.refine(s => s.length <= 103).optional(),
  hosts: z.record(idSchema, host).optional(),
  defaultHost: idSchema.optional(),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  port: z.number().int().min(1024).max(65535).default(8787),
  publicOrigin: z.string().url().optional(),
  events: events.optional()
}).strict().superRefine((v, c) => {
  if (!!v.hosts === !!v.socketPath) c.addIssue({ code: 'custom', message: 'Configure either legacy socketPath or named hosts, not both' });
  if (v.hosts && (v.coreId || v.sendAllowlist.length || v.accessMode !== 'restricted' || v.sendMode !== 'idle-only')) c.addIssue({ code: 'custom', message: 'Set write policies inside each named host, not at top level' });
  if (v.hosts && (Object.keys(v.hosts).length < 1 || Object.keys(v.hosts).length > 16 || !v.defaultHost || !Object.hasOwn(v.hosts, v.defaultHost))) c.addIssue({ code: 'custom', message: 'Configure 1–16 hosts and an existing defaultHost' });
  if (!v.hosts && v.defaultHost && v.defaultHost !== 'local') c.addIssue({ code: 'custom', message: 'Legacy defaultHost must be local' });
  if (!v.hosts && (v.sendAllowlist.length || v.accessMode === 'trusted-core') && !v.coreId) c.addIssue({ code: 'custom', message: 'Writes require coreId' });
  if (v.transport === 'http' && !v.publicOrigin) c.addIssue({ code: 'custom', message: 'HTTP requires publicOrigin' });
});
