import { createHash } from 'node:crypto';
const addressPattern = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;
const digest = value => createHash('sha256').update(value).digest('hex');
export async function createSession(host, input, signal, eventManager) {
  const { config, core, ledger } = host;
  if (config.accessMode !== 'trusted-core' || !config.coreId || !ledger) throw new Error('Session creation requires an explicitly trusted configured core');
  const profile = config.profiles && Object.hasOwn(config.profiles, input.profile) ? config.profiles[input.profile] : null;
  if (!profile) throw new Error('Unknown configured agent profile');
  const cwd = Object.hasOwn(profile.projects, input.project) ? profile.projects[input.project] : null;
  if (!cwd) throw new Error('Unknown approved project directory');
  const variant = input.variant === undefined ? [] : Object.hasOwn(profile.variants, input.variant) ? profile.variants[input.variant] : null;
  if (!variant) throw new Error('Unknown configured model/provider variant');
  const profileArgs = Array.isArray(profile.args) ? profile.args : [];
  const argv = [profile.executable, ...profileArgs, ...variant];
  const name = input.name ?? `mcp-${digest(input.request_id).slice(0, 20)}`;
  const fingerprint = digest(JSON.stringify({ argv, cwd, name }));
  const desktopSpace = profile.desktopSpaces && Object.prototype.hasOwnProperty.call(profile.desktopSpaces, input.project) ? profile.desktopSpaces[input.project] : null;
  const cached = ledger.get(input.request_id);
  if (cached) {
    if (cached.fingerprint !== fingerprint) throw new Error('request_id already used with different creation parameters');
    const receipt = await cached.result;
    return { ...receipt, cached_receipt: true, verification_is_current: false, verified: false, ready: false, outcome: 'cached_creation_receipt', cached_creation_outcome: receipt.outcome };
  }
  if (ledger.size >= 256) throw new Error('Creation request ledger is full; reconcile outstanding requests before restarting adapter');
  const result = (async () => {
    const labels = { rp_mcp_request: input.request_id, rp_mcp_fingerprint: fingerprint, rp_mcp_profile: input.profile };
    if (desktopSpace) labels['herdr.space'] = desktopSpace;
    const snapshot = await core.call('terminal.list', { all: true, labels: { rp_mcp_request: input.request_id } }, config.coreId);
    if (!Array.isArray(snapshot?.terminals)) throw new Error('Cannot reconcile creation request: invalid terminal list');
    const prior = snapshot.terminals.filter(t => addressPattern.test(t.address) && t.labels?.rp_mcp_request === input.request_id);
    if (prior.length > 1 || prior.some(t => t.labels?.rp_mcp_fingerprint !== fingerprint)) throw new Error('Creation request reconciliation conflict; no new terminal was launched');
    if (signal?.aborted) throw new Error('Request cancelled before creating a session');
    const record = prior[0] ?? await core.call('terminal.run', {
      argv, cwd, name, labels, wait: false, keep: false, rm: false,
      no_parent: true, no_notify: true
    }, config.coreId);
    if (!record || !addressPattern.test(record.address) || !Number.isSafeInteger(record.created_ms)) throw new Error('Creation outcome UNKNOWN: invalid run record; inspect request_id before any new attempt');
    let current;
    try { current = await core.call('terminal.get', { terminal: record.address }, config.coreId); }
    catch { return { host: host.id, terminal: record.address, created_ms: record.created_ms, request_id: input.request_id, created_now: !prior.length, cached_receipt: false, verification_is_current: false, verified: false, ready: false, outcome: 'created_or_reconciled_but_unverified', warning: 'Inspect session; verification failed. Do not recreate automatically.', desktop_space: record.labels?.['herdr.space'] ?? null, desktop_visibility_requested: !prior.length && !!desktopSpace }; }
    const same = current?.address === record.address && current.created_ms === record.created_ms &&
      current.labels?.rp_mcp_request === input.request_id && current.labels?.rp_mcp_fingerprint === fingerprint &&
      JSON.stringify(current.argv) === JSON.stringify(argv);
    const live = same && current.state === 'live' && Number.isSafeInteger(current.pid) && current.pid > 0 && !current.reason;
    const resultData = { host: host.id, terminal: record.address, created_ms: record.created_ms, request_id: input.request_id,
      created_now: !prior.length, cached_receipt: false, verification_is_current: true, verified: !!live, ready: !!live && ['idle', 'done'].includes(current.status?.state),
      status: typeof current?.status?.state === 'string' ? current.status.state.slice(0, 128) : null,
      outcome: live ? 'running_verified' : 'not_ready_or_unverified', adapter_prompt_sent: false,
      desktop_space: current?.labels?.['herdr.space'] ?? null, desktop_visibility_requested: !!current?.labels?.['herdr.space'] };
    
    if (eventManager && !prior.length) {
      try {
        await eventManager.deliverEvent('terminal.created', {
          host: host.id,
          terminal: record.address,
          created_ms: record.created_ms,
          name: record.name ?? '',
          profile: input.profile,
          project: input.project
        });
      } catch (e) {
        // Don't fail the request if event delivery fails
        console.error('Failed to emit terminal.created event:', e.message);
      }
    }
    
    return resultData;
  })();
  // Set before awaiting: concurrent identical calls share the same attempt. Never
  // evict/replay failures. Core labels support restart reconciliation, not exactly-once.
  ledger.set(input.request_id, { fingerprint, result });
  return result;
}
