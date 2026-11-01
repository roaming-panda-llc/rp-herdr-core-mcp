import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { CoreClient } from './core.js';
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
export function sshArguments(connection) {
  if (!connection.allowCoreAutoStart) throw new Error('SSH bridge auto-start permission is not enabled');
  const remote = `${connection.session ? `env ${quote(`HC_SESSION=${connection.session}`)} ` : ''}${quote(connection.hcPath)} connect`;
  return ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=10', '-oClearAllForwardings=yes', '--', connection.destination, remote];
}
export function sshConnector(connection, spawnProcess = spawn) {
  const args = sshArguments(connection);
  return () => {
    const child = spawnProcess('/usr/bin/ssh', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    let killTimer;
    child.stderr.resume(); // Drain only; never log credentials or remote output.
    child.once('spawn', () => stream.emit('connect'));
    child.once('error', error => stream.destroy(error));
    child.once('close', () => { clearTimeout(killTimer); stream.destroy(); });
    stream.once('close', () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
        killTimer.unref();
      }
    });
    return stream;
  };
}
export class HostRuntime {
  constructor(config, makeClient = options => new CoreClient(options)) {
    this.defaultHost = config.defaultHost ?? 'local';
    const hosts = config.hosts ?? { local: { ...config, connection: { type: 'unix', socketPath: config.socketPath }, profiles: {} } };
    this.hosts = new Map(Object.entries(hosts).map(([id, settings]) => [id, {
      id, config: settings, ledger: new Map(),
      core: makeClient({ timeoutMs: settings.timeoutMs, ...(settings.connection.type === 'unix' ? { socketPath: settings.connection.socketPath } : { connect: sshConnector(settings.connection) }) })
    }]));
  }
  resolve(id = this.defaultHost) {
    const host = this.hosts.get(id);
    if (!host) throw new Error('Unknown configured host; no fallback was attempted');
    return host;
  }
  close() { for (const h of this.hosts.values()) h.core.close(); }
}
// Dependency injection keeps legacy in-memory clients/tests compatible.
export function resolveHost(core, config, id) {
  if (core instanceof HostRuntime) return core.resolve(id);
  if (id && id !== 'local') throw new Error('Unknown configured host; no fallback was attempted');
  return { id: 'local', core, config, ledger: null };
}
