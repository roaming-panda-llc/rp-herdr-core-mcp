# Validation — adapter 0.1.3

Build checks performed on isolated Linux, Node v24.22.1/npm 11.9.0.

- `npm run check`: **41 passed, 0 failed, 2 skipped** (43 tests), including syntax.
- Official SDK in-memory tool tests and real stdio child initialization/discovery.
- Mock byte-stream tests cover pinned handshake, incompatible version/generation/
  framing/method availability, malformed replies, fragmented UTF-8, bounds,
  timeout uncertainty, shutdown and no automatic replay.
- Tool tests cover lifetime identity checks, disabled sends, screen-only reads,
  default idle-only mode, opt-in normal idle/done sends, rejection of unsafe or
  unknown preflight states, explicit working-race reporting, cancellation, and
  exact status_mismatch non-delivery classification.
- HTTP middleware tests cover bearer/Host/Origin validation and narrowly scoped
  unsupported metadata 404 responses. No authentication bypass for MCP or other paths.
- Dependency versions unchanged from 0.1.0, whose audit reported zero known
  vulnerabilities at the time. Audit not rerun for 0.1.3.

Two real transport tests are skipped by default in this restricted build workspace:
stdio through a temporary Unix-socket mock core, and official MCP HTTP client through
a loopback server. Socket binding was unavailable. No retry of that restriction was
made. Run **`npm run test:integration`** in an authorized local environment to execute
both and switch protocol fixtures to real mock sockets.

These are adapter tests, not a live hc/macOS/agent/TLS/tunnel/connector certification.
No live prompt was sent by these tests. Core source proves that the exact pinned
status_mismatch rejection occurs before prompt input writes; mocks verify adapter
classification, not a rebuilt core binary. The normal-mode done preflight is not an
atomic state guarantee, as deliberately demonstrated by a race-contract test.

## 0.1.3 HTTP integration harness correction

The original HTTP fixture bound an ephemeral port but configured the Host guard
for port 8787, relying on a custom fetch Host header. Node's built-in fetch strips
that header; its actual loopback Host therefore failed the guard with 403 before
authentication. This behavior was reproduced with a fake fetch dispatcher without
network access and verified against the bundled Undici source.

The fixture now aligns configuration to the assigned ephemeral port before creating
the app and lets fetch use its natural Host. Literal public/hostile Host tests use
`node:http`, which supports explicit Host. A new no-listener regression checks that
only the configured loopback port passes Host validation. The full HTTP test still
requires real official-SDK initialization, discovery and list_sessions round-trip,
not merely an HTTP 401/406 probe. Runtime Host/auth policy is unchanged.

The corrected real-HTTP test remains skipped in this build workspace. This record
does not claim it passed on another machine; run `npm run test:integration` there
and retain the complete count and failure output.
