// Operator-run probe: no terminal creation. Opted-in SSH hc connect may start core.
import { readFileSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { HostRuntime } from '../src/runtime.js';
let core;
try {
  if (![3, 4].includes(process.argv.length)) throw new Error('Usage: node scripts/inspect-core.js /absolute/path/config.json [host-id]');
  const config = configSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  core = new HostRuntime(config);
  const host = core.resolve(process.argv[3]);
  const hello = await host.core.call('hello', { generation: 1, framed: false }, host.config.coreId);
  const result = await host.core.call('terminal.list', { all: false }, hello.core.id);
  console.log(JSON.stringify({ host: host.id, coreId: hello.core.id, version: hello.version,
    terminals: result.terminals.filter(t => /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(t.address)).map(t => ({ address: t.address, created_ms: t.created_ms, state: t.state, foreground: t.foreground?.name ?? null, status: t.status?.state ?? null })) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { core?.close(); }
