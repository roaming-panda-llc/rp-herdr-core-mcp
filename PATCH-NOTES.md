# Changes

## 0.1.3

- Corrected the HTTP integration fixture to use its actual assigned loopback port.
  Node fetch strips custom Host headers, so prior probes inadvertently tested the
  wrong port. Explicit Host probes now use node:http instead.
- Added a configured-port Host regression and explicit official-SDK tool discovery
  to the full HTTP round-trip test. No runtime auth/Host/core/send policy changes.
- Full real-transport validation must still run in an environment allowing sockets.

## 0.1.2

- Added operator-only `sendMode`: default `idle-only` preserves existing behavior;
  opt-in `normal` admits idle/done preflights. Idle retains the atomic core predicate;
  done uses documented normal send without `if`, retaining `force:false`.
- Normal mode rejects working, blocked, error and unknown states before dispatch.
  Identity/lifetime pins remain mandatory. Results disclose preflight status and
  whether the core call carried an atomic status predicate.
- Explicitly document the done-to-working race: standard core send may deliver into
  work that begins after preflight. No claim of atomic idle-or-done semantics.
- Exact validated core status_mismatch (`-32000`) is classified as not sent, based on
  pinned input implementation. Other post-dispatch failures stay conservatively
  unknown. No retries, forced sends, fake idle, history scrolling or core changes.
- Added MIT license and repository-safe installation/migration guidance.

## 0.1.1

Unsupported protected-resource metadata GET/HEAD probes on the two documented exact
paths return 404 after Host/Origin checks, instead of an empty bearer challenge.
Actual MCP requests and other paths/methods still require authentication. No OAuth
implementation or authorization-server/OpenID route was added. This compatibility
change does not establish the cause or fix of any external connector error.

## 0.1.0

Initial narrow adapter with list, screen read and allowlisted idle-only send;
official MCP SDK stdio and authenticated loopback Streamable HTTP. Stdio support
predates the metadata patch. Supported code paths do not imply a live deployment.
