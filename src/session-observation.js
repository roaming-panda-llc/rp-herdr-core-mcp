const clip = value => typeof value === 'string' ? value.slice(0, 512) : null;

// Observation, not authorization or a reservation: send_prompt still checks the
// live target and core guard at action time. Never infer producer freshness.
export function sessionProjection(t, policy, observedAt) {
  const trusted = policy.accessMode === 'trusted-core';
  const approved = policy.sendAllowlist.some(a => a.address === t.address && a.created_ms === t.created_ms);
  const enabled = trusted || approved;
  const status = t.status?.state ?? null;
  let reason = null;
  if (!enabled || !policy.coreId) reason = 'not_authorized';
  else if (t.state !== 'live') reason = 'not_live';
  else if (trusted && (!Number.isSafeInteger(t.pid) || t.pid <= 0 || t.reason)) reason = 'program_not_verified';
  else if (status !== 'idle' && !(policy.sendMode === 'normal' && status === 'done')) reason = 'status_not_ready';
  return {
    address: t.address, created_ms: t.created_ms, name: clip(t.name), title: clip(t.title),
    state: clip(t.state), status: t.status ? { state: clip(status) } : null,
    foreground: t.foreground ? { name: clip(t.foreground.name) } : null,
    send_enabled: enabled,
    send_preflight: { eligible: reason === null, reason, atomic_status_guard: status === 'done' && policy.sendMode === 'normal' ? null : 'idle', delivered: false },
    observation: { adapter_observed_at_ms: observedAt, producer_last_reported_at_ms: null, reporting_capability: null }
  };
}
