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

Mini installed source on disk is clean detached
`190d723447e842d8fcf7174b3cb1d7262485ba98`; this is NOT proof of bytes/config
loaded by its existing process. Separate dirty feature/mcp-events source at
`b525d736` was not modified. A **standalone read-only HostRuntime connector**
using installed code and current on-disk config can hello/list the pinned Linux
core and sees `t1`, lifetime `1794282753953`. This is NOT a live adapter
`tools/call` or dots relay proof. Current on-disk restricted policy does not grant
that lifetime. At observation t1 was working, so even a grant would not make an
idle-only send admissible.

The original adapter process began November 3; on-disk config was modified
November 9 to add bo-control without a proven reload. During explicitly released
maintenance, the sole writer was stopped and an exact category-only protected
scope comparison returned MATCH_PRE_BO (four hosts). Parent authorized restoring
that exact prior configuration. The original source and four-host scope are now
healthy in independent kept terminal mini/t3b (parent null, outlives parent);
health, readiness and successful control-plane poll were positively verified.
No fifth host or grant was activated, no subscriptions were recreated, and
encrypted key/scope were preserved. Actual dots discovery, relay/reply and event
wake remain unproved. The prior one-grant helper still cannot add a host.

## Earlier one-grant activation gates (superseded by follow-on below)

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
   Pinned source at installed tunnel commit `01d67bb4` confirms no admin child
   reload/pause route. The documented alternative is stopping/restarting this
   tunnel instance, which exceeds adapter-only approval and requires separate
   authorization. It interrupts its MCP channel/in-flight calls; callers own
   reinitialization and must not replay uncertain mutations. Read-only doctor in
   existing hc execution context reports configured credential resolution PASS,
   without reading/copying/outputting any credential, so a same-profile start
   need not reconstruct the original shell environment.
3. Only after the parent releases activation, stop the sole state writer through
   that supported mechanism; preserve owner-only encrypted state, key, config,
   installed version and exact rollback receipts locally. A safe offline helper
   may compare the protected scope only against exact current and historical
   approved config fingerprints and report match categories (never state or
   secrets). Unknown scope or a historical scope without bo-control aborts this
   approved migration. A fifth-host event-policy change requires a new explicit
   approval; do not broad-match, ignore the scope, or silently initialize state.
   Never recreate a store
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

## Approved host-addition follow-on (implementation, not activation)

Mark explicitly approved decision 26da5635, relayed by parent t1 from
communicator t1s: direct communicator messaging and minimal bo-control
lifecycle/status events for existing unfiltered subscriptions (no transcripts).
Retain all four existing host policies/filter narrowing. The exact new host uses
the saved existing connection, pinned core 86c6b3f55faf561a6a50748faf643468,
restricted access, idle-only sends and no creation profiles. The approved grants
are t1 lifetime 1794282753953 and t1s lifetime 1794291397591. No wildcard,
forced/blocked send, credential/network/core changes or subscription recreation.

Mark also granted standing restart authority for the relevant tunnel instance;
no additional per-restart approval is required. This does not authorize security
widening beyond the explicit approved scope or bypass independent review and
parent activation release. Parent has NOT released this new candidate activation.

The separate pure offline rebindApprovedHostAddition helper accepts an exact
four-host prior config, five-host after config, existing encrypted state, and
operator approval snapshot containing host/core/connection/two grants plus
includeUnfilteredEvents:true. It constructs only the restricted idle-only host,
verifies every other policy remains identical and binds the exact previous
protected scope. It changes only the scope field in a cloned state; all
subscriptions, arguments/filters, owners, IDs, secrets, outbox bytes/attempts and
other state remain unchanged. Host-filtered subscriptions stay narrow; only
explicitly approved unfiltered subscriptions gain the new host's minimal events.
Startup has no automatic exception and still rejects a mismatched scope.

Before activation: finish source tests and independent review on the Mini
internal checkout; reverify exact target lifetimes/approval and sole writer;
prepare owner-only encrypted/key/config/version rollback; gracefully stop the
relevant verified tunnel; rebind/save only while stopped through existing atomic
EventStore with the unchanged key; activate the exact reviewed source/config;
restart the same profile as independent persistent service and verify health and
actual MCP discovery separately. On any mismatch restore the exact known
four-host source/config/encrypted backup/key; never initialize, broaden or reset
a store to repair startup. Keep rollback local to the Mini. No activation has
occurred during source implementation.

## Remaining scope

Durable relay queuing/reply correlation, actual dots round trip and event wake
remain unproved/unimplemented as applicable. The existing complete-controls
candidate also still excludes working/blocked/error menus and has no atomic
lifetime mutation or GUI-window-close primitive. This change does not loosen
those guards or claim complete control.
