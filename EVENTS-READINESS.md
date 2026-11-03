# Events integration review — 2026-11-03

## Branch reconciliation

Reviewed main `e2d7eecb8a715fb112f2b5e17f7711a2e0476891` was merged into the
existing `feature/mcp-events-v2` branch at `a9626ab`. Main itself was not changed.
The merge retains 0.1.17 compatibility/advisory version warnings and desktopSpaces
configuration, initial `herdr.space` labels, desktop receipts and reconciliation.
No escape-only-control branch was incorporated.

The integrated baseline passed all 151 integration-enabled tests. This review
then inspected the manager, SDK ownership, entrypoint shutdown, durable store,
creation hook and callback path independently of the earlier completion report.

## Findings and repairs

1. The transport-close handler was on `McpServer.onclose`, which this SDK does not
   invoke. It is now on `server.server.onclose`, preserving any previous callback.
   Owned stdio managers stop; per-request HTTP servers leave the shared manager alive.
2. The initial poll was not registered as in-flight work. Shutdown could finish
   and the returning startup poll could install a new timer. Startup now tracks
   that promise and checks shutdown before installing the timer. The entrypoint
   installs its stdin EOF handler before awaiting startup and closes its own core
   connections before waiting for event shutdown. This does not stop a core.
3. Creation's event hook and main's desktop receipt additions conflicted. Both
   paths are retained, with regression coverage. New records also carry the
   approved project ID in `rp_mcp_project`, so later poll observations have the same
   project metadata as the direct creation event. No existing record is relabeled.
4. An existing encrypted snapshot with a missing wrapping key previously caused a
   replacement key to be generated before decryption failed. It now fails before
   generating a replacement and asks for restoration of the original key.

## Evidence and what it does not prove

`test/events-stdio.test.js` uses the real `src/index.js` subprocess, official MCP
stdio client and a temporary Unix-socket mock core. A test-only Node preload
replaces callback DNS and HTTPS and accelerates the polling timer. It verifies
actual Standard Webhooks signatures over the emitted bytes, confirms the returned
subscription ID on the challenge, and exercises:

- discovery and successful events/subscribe over stdio;
- persistent ownership across later requests on the same process;
- observed terminal creation and delivery;
- process close, saved subscription/cursor and restart;
- resumed polling/delivery without resubscription;
- unsubscribe and absence of subsequent delivery;
- clean child exit and no protocol/diagnostic noise on stderr.

The preload is in `test-support/`, is only loaded by the test's explicit
`--import`, and has no production configuration switch. All data and signing
material used by this test are synthetic. No real callback or private remote
endpoint was contacted.

Final checks on Node v24.19.0/npm 11.9.0:

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| npm run check (including syntax) | 154 | 0 | 3 |
| npm test | 154 | 0 | 3 |
| npm run test:integration | 157 | 0 | 0 |

The three ordinary-mode skips are transport integration cases; the integration
command runs all of them. `git diff --check` also passed. No production tunnel
lifecycle, live callback, actual subscription, or ChatGPT wake-up was exercised.

## Operational prerequisites still requiring verification

- **One persistent process:** the current store is single-writer and has no
  multi-process lock or distributed coordination. The tunnel must keep exactly
  one adapter process alive while subscriptions are active, including while the
  chat is idle. A per-request/per-chat child lifecycle cannot provide continuous
  delivery. Do not share one state directory between overlapping adapter processes.
- **Authenticated identity boundary:** stdio subscriptions belong to the local
  process principal. The tunnel must retain its existing single-user access
  boundary; stdio does not independently authenticate remote tunnel users.
- **Durable state configuration:** `events.enabled` alone enables discovery.
  Valid subscriptions additionally require an approved `events.stateDirectory`
  (absolute, owner-only, outside Git) and a pinned core to observe. Preserve the
  directory and original wrapping key across adapter updates. Full core config is
  included in the stored scope fingerprint; changed host/profile config may
  require explicit state migration planning, not deletion or blind reuse.
- **Protocol and network path:** the tunnel must forward custom events/* methods
  and capability discovery. The adapter must reach the receiver's public HTTPS
  callback using pinned connections with certificate validation. No callback proxy
  or validation bypass is introduced by this branch.
- **Polling limits remain:** replay covers recorded creation events only. Changes
  entirely between polls or during downtime may be missed. Delivery is at least
  once; receiver-side deduplication by event ID remains required.

## Minimal remaining live steps (not performed)

1. Review and approve the revised branch before merging/deploying. Record the
   current adapter commit, command and private config for rollback; retain core,
   agent sessions, tunnel identity, host pins, desktopSpaces and existing secrets.
2. With deployment/config approval, install the reviewed adapter and configure
   Events storage without replacing the rest of the private config. Verify the
   persistent single-process prerequisite above. Restart only the adapter; confirm
   the five tools still list/read across Air and the other hosts.
3. Rescan event capabilities through the existing authenticated tunnel. Create an
   explicit subscription in ChatGPT for the user's selected host/terminal/lifetime.
   The client supplies its callback URL and signing secret; do not invent either.
   Verify a successful signed challenge and a persisted subscription before
   expecting events. Discovery alone is not a subscription.
4. Observe an authorized natural lifecycle/status change, confirm callback
   acknowledgement, then independently confirm the event wakes the intended
   ChatGPT task. A successful POST alone is not live wake-up proof.
5. Verify unsubscribe, expiry and approved adapter restart behavior. If rollout
   fails, stop only the replacement adapter and restore the recorded adapter
   command/config. Retain encrypted event state and its key for investigation;
   do not run old and new adapters concurrently or restart cores.
