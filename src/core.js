import net from 'node:net';

export const TESTED_CORE_VERSIONS = Object.freeze(['0.1.15', '0.1.16', '0.1.17']);

// Escape validation is separate from the broader send/create compatibility list.
export const ESCAPE_CORE_VERSIONS = Object.freeze(['0.1.15', '0.1.16', '0.1.18']);

export class CoreError extends Error {}
export class CoreClient {
  constructor({ socketPath, timeoutMs = 15000, maxBytes = 1048576, maxConnections = 8, connect = net.createConnection, warn = message => console.error(message) }) {
    Object.assign(this, { socketPath, timeoutMs, maxBytes, maxConnections, connect, warn });
    this.warnedVersions = new Set();
    this.sockets = new Set();
    this.closed = false;
  }
  close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy(new CoreError('Adapter shutting down'));
  }
  call(method, params, expectedCoreId, { signal, deadlineMs, requiredVersion } = {}) {
    if (this.closed || this.sockets.size >= this.maxConnections) return Promise.reject(new CoreError('Adapter unavailable or busy; no request was sent'));
    return new Promise((resolve, reject) => {
      const socket = this.connect({ path: this.socketPath });
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0), total = 0, phase = 1, settled = false, sent = false, testedVersion = false;
      const finish = (error, result, knownNotDelivered = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(socket);
        socket.destroy();
        if (error) {
          const sendDispatched = ['terminal.send', 'terminal.keys', 'terminal.kill', 'terminal.rm'].includes(method) && sent;
          const createDispatched = method === 'terminal.run' && sent;
          const suffix = knownNotDelivered ? '; delivery: NOT SENT (core status check rejected before typing); no automatic retry' : createDispatched ? '; creation outcome is UNKNOWN: reconcile request_id before any new attempt; no automatic retry' : sendDispatched ? '; delivery is UNKNOWN: inspect the terminal before any retry; no automatic retry' : '';
          const failure = new CoreError(`${error}${suffix}`);
          if (knownNotDelivered) failure.delivery = 'not_sent';
          else if (sendDispatched) failure.delivery = 'unknown';
          if (createDispatched) failure.creation = 'unknown';
          reject(failure);
        } else resolve(result);
      };
      const timer = setTimeout(() => finish('Core request timed out'), this.timeoutMs);
      socket.on('error', () => finish('Core connection failed'));
      socket.on('end', () => finish('Core closed before replying'));
      socket.on('close', () => finish('Core connection closed'));
      const write = (id, name, args) => socket.write(JSON.stringify({ jsonrpc: '2.0', id, method: name, params: args }) + '\n');
      socket.once('connect', () => write(1, 'hello', { generation: 1, framed: false }));
      socket.on('data', chunk => {
        total += chunk.length;
        if (total > this.maxBytes) return finish('Core response exceeded the byte limit');
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while (!settled && (end = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, end).toString('utf8');
          buffer = buffer.subarray(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { return finish('Invalid JSON from core'); }
          if (!message || message.jsonrpc !== '2.0' || message.id !== phase || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) return finish('Invalid JSON-RPC response from core');
          if (message.error) {
            // Exact, validated hc 0.1.15/0.1.16/0.1.17 terminal.send rejection only. input.rs
            // returns status_mismatch in prepare, before type_in executes writes.
            const notSent = testedVersion && phase === 2 && method === 'terminal.send' &&
              message.error.code === -32000 && message.error.data?.kind === 'status_mismatch';
            return finish(`Core rejected request (${String(message.error.data?.kind ?? message.error.code).slice(0, 100)})`, undefined, notSent);
          }
          if (phase === 1) {
            const hello = message.result;
            if (typeof hello?.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(hello.version) || hello.version.length > 128 || hello.generation !== 1 || hello.framed !== false || (!Array.isArray(hello.methods) || !hello.methods.every(m => typeof m === 'string') || !hello.methods.includes(method))) return finish('Core is not compatible: invalid version metadata, generation, framing or required method');
            if (expectedCoreId && hello.core?.id !== expectedCoreId) return finish('Core identity mismatch; request not sent');
            if (requiredVersion && hello.version !== requiredVersion) return finish('Core version does not match this reviewed control; no request was sent');
            if (method === 'terminal.keys' && !ESCAPE_CORE_VERSIONS.includes(hello.version)) return finish('Escape requires reviewed hc 0.1.15/0.1.16/0.1.18; no request was sent');
            testedVersion = TESTED_CORE_VERSIONS.includes(hello.version);
            if (!testedVersion && !this.warnedVersions.has(hello.version) && this.warnedVersions.size < 16) {
              this.warnedVersions.add(hello.version);
              this.warn(`Warning: hc ${JSON.stringify(hello.version)} is untested (tested: ${TESTED_CORE_VERSIONS.join(', ')}). Protocol checks passed; behavior may differ. Mutation errors remain unknown outcomes; inspect before retrying.`);
            }
            if (signal?.aborted) return finish('Request cancelled before dispatch; no request was sent');
            if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || Date.now() >= deadlineMs)) return finish('Request approval expired before dispatch; no request was sent');
            phase = 2;
            sent = true;
            write(2, method, params);
          } else if (method === 'terminal.keys' && (!Number.isSafeInteger(message.result?.turn) || message.result.turn < 0 || !(message.result.status === null || typeof message.result.status === 'string'))) {
            finish('Invalid terminal.keys result');
          } else finish(null, message.result);
        }
      });
    });
  }
}
