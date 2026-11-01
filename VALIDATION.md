# Validation — adapter 0.1.2

Build checks performed on isolated Linux, Node v24.22.1/npm 11.9.0.

- `npm run check`: **40 passed, 0 failed, 2 skipped** (42 tests), including syntax.
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
  vulnerabilities at the time. Audit not rerun for 0.1.2.

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
