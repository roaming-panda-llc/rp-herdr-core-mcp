// Explicit operator-run, read-only probe. Never starts core or a terminal.
import { readFileSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { CoreClient } from '../src/core.js';
let core;
try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/inspect-core.js /absolute/path/config.json');
  const config = configSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  core = new CoreClient(config);
  const hello = await core.call('hello', { generation: 1, framed: false });
  const result = await core.call('terminal.list', { all: false }, hello.core.id);
  console.log(JSON.stringify({ coreId: hello.core.id, version: hello.version,
    terminals: result.terminals.filter(t => /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(t.address)).map(t => ({ address: t.address, created_ms: t.created_ms, state: t.state, foreground: t.foreground?.name ?? null, status: t.status?.state ?? null })) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { core?.close(); }
