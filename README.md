# rp-herdr-core-mcp

A small single-user MCP adapter for **herdr-core 0.1.15**, using the official MCP
SDK. Version **0.1.3**. MIT licensed. macOS/Linux; no Windows pipe support.

Three tools expose existing local terminals: `list_sessions`, `read_output`, and
`send_prompt`. No extra LLM, agent spawning, shell-execution tool, or core lifecycle
management. The adapter uses an existing Unix socket and never starts, stops or
updates hc. Output is untrusted data and may contain secrets.

## Quick start

Use Node.js 22+ and an existing hc 0.1.15 installation:

```sh
npm ci --ignore-scripts
npm run check
npm run test:integration
```

Copy `examples/config.stdio.json` to a **private location outside the repository**,
set the actual absolute `socketPath`, and keep `sendAllowlist: []` initially.
The example path is not discovery: `HC_SOCKET`, hc config, XDG directories and the
selected session can change the endpoint. Do not move core state or replace sockets.

```sh
node scripts/inspect-core.js /absolute/private/config.json
```

This read-only probe prints core ID and terminal lifetime metadata. Configure your
MCP host using `examples/mcp.json`, replacing all absolute paths. Run Node directly
for stdio, not npm, so package-manager output cannot pollute protocol stdout.
Discover the tools and verify list/screen reads before enabling writes.
See [AGENT-HANDOFF.md](AGENT-HANDOFF.md) for migration and verification.

## Tools and bounds

- **list_sessions**: local terminal records, optionally finished, paginated at 25
  by default (maximum 100). Non-atomic snapshot; no reconstructed chat history.
- **read_output**: current screen only, last 12,000 characters by default (maximum
  32,768), with truncation/completeness flags. Always `lines: 0`: hc history stitching
  can inject scrolling input, so it is deliberately not exposed.
- **send_prompt**: paste text and submit using the terminal's configured key (Enter
  by default). Maximum 16,000 characters; terminal control characters rejected.
  Never `force`, never waits for task completion, never automatically retries.

Core connections are capped at eight, received bytes at 1 MiB per call, and timeout
at 15 seconds by default (configurable 100–60,000 ms). Large upstream lists can
exceed the byte limit before pagination; this fails explicitly. The adapter checks
JSON-RPC IDs and reply shape, generation 1, plain framing, and exact version 0.1.15.
Shutdown closes adapter connections only; existing terminals continue.

## Approving writes and send modes

Sending requires an operator-approved terminal address and creation timestamp plus
the actual core ID from the probe. Keep private config outside Git. Example:

```json
{
  "socketPath": "/absolute/private/existing.sock",
  "transport": "stdio",
  "coreId": "COPY-ACTUAL-CORE-ID",
  "sendMode": "normal",
  "sendAllowlist": [{ "address": "t1b", "created_ms": 1234567890000 }]
}
```

`sendMode` is operator configuration, not a caller-controlled tool argument:

| Mode | Behavior |
| --- | --- |
| `idle-only` (default) | Existing behavior: always sends with core's atomic `if: "idle"` check. A `done` terminal is rejected. |
| `normal` (opt-in) | Preflight must report `idle` or `done`; working, blocked, error and unknown states are rejected before dispatch. Idle retains `if: "idle"`; done uses hc's documented normal send with no `if`, still `force:false`. |

**Normal mode is not an atomic idle-or-done guarantee.** hc 0.1.15 only accepts
`idle` or `working` in `if`; `done` is not expressible. After a done preflight the
program may become working before input arrives. Core serializes input, waits for
keyboard quiet and refuses blocked programs, but does not wait for task completion.
Normal-mode approval accepts that race. Results expose `send_mode`,
`preflight_status`, and `atomic_status_guard` (null when absent), as well as core's
observed send status. No false idle report, interruption, forced send or core fork
is used. Pi normally reports `done` after successful work, so idle-only is too
restrictive for that follow-up workflow.

Only approve dedicated trusted agent terminals. Core ID and creation timestamp
checks mitigate stale-ID reuse, but do not authenticate the executable. OSC 7501
status is self-reported; a terminal's foreground program can change. A prompt can
cause the downstream agent to execute commands or change files. Approval grants
that program's effective authority; never repurpose an approved terminal as a shell.

Read before each consequential follow-up. A successful send is **not task completion**.
The exact validated core `status_mismatch` rejection (`-32000`, after the pinned
handshake) is labeled **NOT SENT** because core rejects it before input writes.
Other post-dispatch errors/timeouts remain conservatively **UNKNOWN**. Neither
classification triggers automatic replay; inspect and make a fresh decision.
Cancellation during preflight prevents a subsequent send; cancellation after
submission cannot undo terminal input.

## Optional authenticated HTTP

`examples/config.http.json` enables stateless MCP Streamable HTTP at `/mcp`, bound
only to `127.0.0.1`. Supply a private `HERDR_MCP_TOKEN` of at least 32 high-entropy
bytes through your existing secret environment; missing or placeholder credentials
fail startup closed. No credential is generated or included by this project.

Remote use requires operator-managed HTTPS proxy/private transport. Preserve
Authorization and configured Host; reject untrusted forwarding headers, disable
sensitive logging/caching, and apply connection/rate limits. Never expose raw hc
sockets or a plaintext public listener. Every `/mcp` request requires bearer auth;
Host/Origin validation runs first and request bodies are capped at 64 KiB.

Only exact GET/HEAD probes to `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource` return unauthenticated 404, without a
challenge: the documents are unsupported. Other paths/methods remain protected.

This is **not an OAuth authorization server**. A client choosing “No authentication”
will not supply HTTP bearer credentials. Clients requiring OAuth need a separately
configured compatible gateway; never remove auth to work around incompatibility.
An authenticated tunnel that owns a local stdio process is an alternative only if
its access controls are independently verified. Stdio uses process access instead
of HTTP bearer auth; it does not authorize an unprotected public HTTP endpoint.

## Verification and provenance

See [VALIDATION.md](VALIDATION.md) for performed checks and limitations and
[PATCH-NOTES.md](PATCH-NOTES.md) for changes. No deployment or live integration is
implied by passing mocked tests.

Verified core contract: tag `v0.1.15`, commit
`9e934dff8513710d3c5111fe28bc5b23564805db`:

- [Transport/API](https://github.com/herdrdev/herdr-core/blob/v0.1.15/schema/README.md)
- [OpenRPC schema](https://github.com/herdrdev/herdr-core/blob/v0.1.15/schema/hc.openrpc.json)
- [Normal consumer workflow](https://github.com/herdrdev/herdr-core/blob/v0.1.15/crates/herdr-core/src/SKILL.md)
- [Input/state checks](https://github.com/herdrdev/herdr-core/blob/v0.1.15/crates/herdr-core/src/input.rs)
- [Security/endpoints](https://github.com/herdrdev/herdr-core/blob/v0.1.15/docs/security.md)
- [Pi status reporting](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/program-status-reporter.ts)
- [Official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)

The adapter does not depend on oldherdrTUI. Review and test source/schema changes
before relaxing the pinned core version guard.
