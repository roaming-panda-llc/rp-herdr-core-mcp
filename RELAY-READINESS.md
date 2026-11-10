# Relay and event diagnostics (Linux candidate, not deployed)

## Implemented slices

- `events_diagnostics` reads only the already-loaded manager and the current
  principal's subscription/queue counts. It never returns IDs, callback URLs,
  secrets or transcript data and never performs expiry cleanup, persistence or
  core calls. Disabled events are explicit. `live_receipt_verified: null` means
  unknown, not a successful callback or assistant wake.
- `list_sessions` retains `send_enabled` as policy eligibility and adds
  `send_preflight` to distinguish authorization from current readiness. Idle is
  eligible with the core idle predicate; done is eligible only in normal mode,
  without an atomic done predicate. Working/blocked/error/unknown are not ready.
  `delivered: false` means this observation did not send anything. Observations
  are not reservations: existing `send_prompt` action-time guards are unchanged.
- `observation.adapter_observed_at_ms` is the adapter's successful list receipt
  time. Producer freshness and reporting capability remain unknown. No whole
  core status object, raw argv, paths or transcript fields are forwarded.
- `rebindSendTargetExtension` is an **offline pure operator primitive**, not an
  exposed tool or an automatic startup exception. It accepts an exact prior
  config, next config and single lifetime target. Both configs are schema
  validated; the only permitted difference is appending that grant to an
  existing restricted idle-only named host. The entire prior event scope must
  match. All subscription/principal/outbox/history fields remain unchanged.
  Startup still fails closed for any un-migrated scope mismatch.

## Runtime observations (not source-test proof)

Mini installed adapter is clean detached `190d723447e842d8fcf7174b3cb1d7262485ba98`.
Its separate dirty feature/mcp-events source at `b525d736` was not modified.
The installed `bo-control` bridge can hello/list the pinned Linux core and sees
`t1`, lifetime `1794282753953`. Its restricted allowlist does not grant that
lifetime. At observation t1 was working, so even a grant would not make an idle-
only send admissible. No live prompt, callback, subscription or security change
was made by this candidate.

## Conditional activation gates (parent owns release)

Mark approved only adding `{"address":"t1","created_ms":1794282753953}` to
`hosts["bo-control"].sendAllowlist` in the existing Mini config, preserving
restricted/idle-only access and pinned core identity. This approval is conditional
on parent verification of compatibility, backup/rollback and targeted reload.

1. Review exact candidate diff and tests; stage a separate exact-SHA adapter
   release without overwriting dirty source. No merge or deployment is implied.
2. Establish a supported single-adapter pause/reload that leaves the shared
   tunnel/core running. Installed tunnel 0.0.19 documents restart on unexpected
   child loss but CLI help has no single-child reload operation. Do not kill a
   child to exploit that recovery policy. This gate is currently unproved.
3. Only after the parent releases activation, stop the sole state writer through
   that supported mechanism; preserve owner-only encrypted state, key, config,
   installed version and exact rollback receipts locally. Never recreate a store
   or subscription. Do not print protected contents.
4. Construct exact before/after parsed configs, append only the approved target,
   and run the pure rebind against the existing loaded state while offline.
   Save with the existing EventStore/key (fsynced temp + atomic rename). Store
   access and writes require the parent's released activation; source tests use
   only synthetic fixtures. No new config migration bypass flag is added.
5. Reload only the adapter. Confirm version/core pin, event counts and exact
   target lifetime. If validation/startup fails, stop the writer, restore the
   original encrypted file/config/version and unchanged key using atomic rename,
   then verify the old adapter. Do not silently accept a broader scope.
6. Test an actual dots MCP nonce request when t1 is idle, observe receipt and
   read a unique response via MCP. Working/blocked input must remain unsent.
   There is no durable prompt queue implemented here: callers must retain a
   definitely-unsent message until ready and reconcile unknown mutation outcomes
   before any retry. Allowlisting is not round-trip proof.
7. Separately prove a matching real event, real callback receipt and intended
   assistant wake/reply. Unit tests, queue counts, source publication and HTTP
   success alone do not satisfy this. No subscription recreation is authorized.

## Remaining scope

Durable relay queuing/reply correlation, actual dots round trip and event wake
remain unproved/unimplemented as applicable. The existing complete-controls
candidate also still excludes working/blocked/error menus and has no atomic
lifetime mutation or GUI-window-close primitive. This change does not loosen
those guards or claim complete control.
