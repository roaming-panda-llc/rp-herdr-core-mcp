import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HostRuntime } from './runtime.js';
import { makeServer, makeHttpApp } from './server.js';
import { configSchema } from './config.js';
let core, listener, server, closeEvents;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  core?.close();
  await closeEvents?.();
  listener?.close();
  listener?.closeAllConnections();
  await server?.close();
}
try {
  if (process.argv.length !== 3) throw new Error('Usage: node src/index.js /absolute/path/config.json');
  const config = configSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  core = new HostRuntime(config);
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  if (config.transport === 'stdio') {
    server = makeServer(core, config);
    const transport = new StdioServerTransport();
    process.stdin.once('end', () => { void stop(); });
    await server.connect(transport);
  } else {
    const app = makeHttpApp(core, config, process.env.HERDR_MCP_TOKEN);
    closeEvents = app.locals.closeEvents;
    await app.locals.startEvents();
    listener = app.listen(config.port, '127.0.0.1', () => console.error(`herdr-core MCP on loopback port ${config.port}; HTTPS proxy required`));
    listener.requestTimeout = 20000;
    listener.headersTimeout = 10000;
    listener.timeout = 65000;
    listener.on('error', () => { console.error('HTTP listener failed'); process.exitCode = 1; void stop(); });
  }
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
  await stop();
}
