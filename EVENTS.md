# MCP Events

Events remain opt-in (`events.enabled: true`). Discovery is available without a
store, but subscriptions require `events.stateDirectory`: an absolute, owner-only
(0700) directory outside this repository. No live configuration is changed by
this feature. Run only one adapter process per state directory. HTTP request
servers share one process-level event manager; closing a request does not cancel
its subscriptions. The entrypoint starts recovery/polling independently of new
client requests and stops the manager on shutdown.

## Protocol and authorization

The implementation targets the ChatGPT webhook profile documented at
https://developers.openai.com/plugins/build/mcp-events and the MCP draft at
https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
(reviewed 2026-11-03). The current draft allocates callback errors as -32027,
whereas the published ChatGPT profile specifies -32015; this adapter intentionally
uses -32015 with a categorized `data.reason` for that integration.

The three names are `terminal.created`, `terminal.status_changed`, and
`terminal.finished`. Payloads contain metadata only, never terminal output.
Status/finished subscriptions accept host, terminal address and optional
`created_ms` lifetime filters. Creation subscriptions accept a host filter.
Local addresses are tracked per host and creation timestamp; federated addresses
are excluded. The five tools and their existing access policies are unchanged.

HTTP uses the principal established by the existing bearer middleware, not a
request parameter. Stdio uses the local `stdio` principal. Changing the HTTP bearer
on restart cancels saved subscriptions belonging to the previous principal.
Changing the configured core scope requires a separate state directory; old
subscriptions must not silently become authorized for a different core.

Callback verification is signed, uses a fresh random challenge, constant-time
comparison, and the deterministic subscription ID in its header. Successful
verification is cached for five minutes per principal and URL. Subscriptions have
a finite granted lifetime: default/maximum 24 hours, minimum 60 seconds. Refresh
extends the grant; `ttlMs: null` receives the finite default. Replacing the signing
secret retains the previous key for a five-minute dual-signing window.

Every callback connection resolves and validates all DNS answers and pins the
connection to a validated public address, preserving the original TLS hostname
and certificate checks. No redirects or connection pooling. DNS, TLS and response
reading share a ten-second deadline; responses are limited to 16 KiB. No
NODE_ENV-based validation exceptions exist. Tests inject DNS and request functions.

## Durability, replay and bounds

Subscriptions, secrets, terminal checkpoints, creation history and queued exact
body bytes are saved as an AES-256-GCM encrypted snapshot. The random wrapping key
is stored in an owner-only 0600 `events.key`; snapshots are 0600 `events.enc`.
Writes use a fresh temporary file, fsync, atomic rename and directory fsync.
Preserve the key alongside the state in protected backups; neither belongs in Git.
Corrupt ciphertext, unsafe file permissions or write failures fail closed.
This is a single-process store, not a distributed queue or multi-writer database.

Bounds: 100 subscriptions, 1000 queued deliveries, 1000 retained creation events,
10000 observed terminals/creation deduplication entries, 32 MiB plaintext snapshot,
and 256 KiB per event body. Capacity exhaustion rejects new work instead of
silently evicting pending delivery. Poll observation changes and their events
are committed together. A failed observation is retried on the next poll.

An acknowledged creation event advances its subscription cursor. Pending earlier
creation events prevent advancing past them. Refresh/restart can replay retained
creation history; stale positions return `truncated: true`. Status and finished
events have null cursors. IDs and serialized bodies remain stable across retries
and restart; each retry gets a fresh signing timestamp and signature.

Retries use exponential backoff, five attempts per activation, and FIFO order per
subscription. A delayed subscriber does not block other subscribers. Exhausted
work stays bounded and suspended until refresh (which reactivates it) or expiry;
its cursor does not advance. HTTP 410/413 cancels that subscription and its queue.
Unsubscribe/expiry cancels queued work and aborts active requests. A receiver may
already have accepted an in-flight request when cancellation occurs; it cannot be
recalled. Shutdown aborts active callbacks and leaves pending work for restart.

## Observation limits

The adapter polls `terminal.list` every five seconds using the existing pinned
core connections. It does not consume the core event stream. It detects observed
status changes, new/reused terminal lifetimes, loss and disappearance. Initial
snapshot contents are a baseline, not newly created events. An unavailable host
is not interpreted as an empty terminal list.

Creation replay covers events this adapter actually recorded. Terminals created
and removed entirely between polls, or while the adapter is stopped, cannot be
reconstructed. Transient status changes between polls can be missed. The adapter
does not promise exactly-once delivery: a crash after receiver acceptance and
before local acknowledgement can redeliver the same ID. Receivers must deduplicate.

## Verification

Use `npm ci --ignore-scripts`, `npm run check`, and `npm run test:integration`.
Integration tests use temporary mock core sockets and loopback HTTP only.
Webhook tests use injected transport/clock/DNS, never live callbacks or private
remote endpoints. See `VALIDATION.md` for this branch's measured results.

## Stdio/tunnel readiness

See [EVENTS-READINESS.md](EVENTS-READINESS.md) for the current-main integration
review, entrypoint regression evidence, and the remaining live checklist. The
stdio manager lives for its adapter process, not for an individual MCP request.
The tunnel must keep one process alive during idle periods; multiple processes
must not share this single-writer store. Successful capability discovery alone
neither creates a subscription nor proves a live ChatGPT wake-up.

## Subscription diagnostics

Events request parameters accept the SDK's standard `_meta` field, including
progress tokens and extension metadata. Other subscription and unsubscribe
parameters remain strict.

The adapter writes one JSON line to stderr for each subscription outcome that
reaches its schema or handler. Records contain only `method`, `outcome`, and a
fixed `category`, for example:

```json
{"method":"events/subscribe","outcome":"rejected","category":"schema_invalid"}
{"method":"events/subscribe","outcome":"rejected","category":"challenge_failed"}
{"method":"events/subscribe","outcome":"accepted","category":"success"}
```

Categories distinguish `schema_invalid`, `handler_failed`, and callback failures
(`challenge_failed`, `timeout`, `http_4xx`, `http_5xx`, or `callback_failed`). They
exclude URLs, secrets, arguments, metadata values, IDs, headers, challenge values,
and exception messages. The host's stderr collector can supply timestamps.
A successful handler outcome does not prove delivery of its response or a task
wake-up. Failures before method dispatch (including malformed JSON-RPC envelopes
or metadata rejected by the transport/SDK) are not covered. No request payload
capture or transport instrumentation is enabled.

SDK error behavior is unchanged: the pinned SDK returns `-32603` for these schema
parse errors; Herdr handler errors use `-32602`, while callback verification errors
use `-32015`. Schema diagnostics do not change or suppress protocol responses.


## Escape policy compatibility

Events scope excludes only the top-level `escape` policy on each named host.
All other previously hashed fields, including host IDs, pinned core IDs,
connection details and profiles, retain their existing serialization and checks.
Legacy single-socket scope is unchanged. Adding, editing, disabling or removing
Escape approvals therefore does not require resetting Events or replacing keys.

Stores from before Escape retain the exact same fingerprint; startup needs no
scope rewrite. For stores written by the initial Escape release, startup accepts
the old full-host hash only when it matches the **exact current configuration**,
then persists the normalized fingerprint before polling/delivery. Subscriptions,
queued events, cursors/history and observation checkpoints are preserved, subject
to existing normal expiry cleanup. The encryption key is unchanged. A failed
migration write aborts startup; identity mismatches still fail closed.

If a legacy full-host store and its Escape policy were changed at the same time,
restore the original configuration for one startup with the fixed adapter before
editing the Escape policy. Do not edit/reset the protected state, replace the
wrapping key, guess a prior hash, or disable the scope check. Rollback to an older
adapter requires the pre-Escape host configuration (without `escape`) to match
the normalized fingerprint; an old adapter hashing Escape will reject it.
