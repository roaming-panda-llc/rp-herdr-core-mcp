# rp-herdr-core-mcp

A small single-user MCP adapter for **herdr-core (tested: 0.1.15, 0.1.16, 0.1.17)**, using the official MCP
SDK. Version **0.2.0**. MIT licensed. macOS/Linux; no Windows pipe support.

Five tools expose configured cores: `list_hosts`, `list_sessions`, `read_output`,
`send_prompt`, and opt-in `create_session`. No extra LLM or arbitrary-shell tool.
Legacy local configuration stays restricted. Named hosts and broad trusted-core
creation require explicit operator configuration/approval; see [MULTIHOST.md](MULTIHOST.md).
Unix connections never start core. An explicitly approved SSH `hc connect` bridge
may auto-start its selected core; no core shutdown/update is exposed. Output is
untrusted data and may contain secrets.

## Quick start

Use Node.js 22+ and an existing supported hc installation:

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

This probe prints core ID and terminal lifetime metadata. Configure your
MCP host using `examples/mcp.json`, replacing all absolute paths. Run Node directly
for stdio, not npm, so package-manager output cannot pollute protocol stdout.
Discover the tools and verify list/screen reads before enabling writes. SSH probes may auto-start core only when explicitly opted in.
See [AGENT-HANDOFF.md](AGENT-HANDOFF.md) for migration and verification.

## Tools and bounds

- **list_hosts**: configured public host/profile IDs and independent availability;
  failures remain visible, with no fallback or private connection details.
- **create_session**: trusted-core only, configured agent/project/variant aliases,
  stable request ID, startup verification and no adapter-added initial prompt.
- **list_sessions**: local terminal records, optionally finished, paginated at 25
  by default (maximum 100). Non-atomic snapshot; no reconstructed chat history.
- **read_output**: current screen only, last 12,000 characters by default (maximum
  32,768), with truncation/completeness flags. Always `lines: 0`: hc history stitching
  can inject scrolling input, so it is deliberately not exposed.
- **send_prompt**: paste text and submit using the terminal's configured key (Enter
  by default). Maximum 16,000 characters; terminal control characters rejected.
  Never `force`, never waits for task completion, never automatically retries.

Core connections are capped at eight per host (at most 16 hosts), received bytes at 1 MiB per call, and timeout
at 15 seconds by default (configurable 100–60,000 ms). Large upstream lists can
exceed the byte limit before pagination; this fails explicitly. The adapter checks
JSON-RPC IDs and reply shape, generation 1, plain framing, required methods, and
configured core identity. Versions 0.1.15, 0.1.16 and 0.1.17 are reviewed. Other
well-formed older/newer versions warn on stderr and proceed after those checks;
version alone is not a rejection. Mutation errors on untested versions remain
unknown outcomes, including status_mismatch: inspect before retrying. Warnings
are emitted once per untested version per CoreClient (bounded to 16 versions).
Shutdown closes adapter connections only; existing terminals continue.

## Approving writes and send modes

In default restricted access, sending requires an operator-approved terminal address and creation timestamp plus
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

**Normal mode is not an atomic idle-or-done guarantee.** These hc versions only accept
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
`9e934dff8513710d3c5111fe28bc5b23564805db`, plus reviewed tag `v0.1.16`
(`e07c2a1bedd62cf4787ee026ee23ee79c7d95491`) and `v0.1.17`
(`ce87721557176f6cddaac1c7aefbf76929923263`). See
[the 0.1.17 compatibility review](CORE-COMPATIBILITY.md) for semantic changes and risks:

- [Transport/API](https://github.com/herdrdev/herdr-core/blob/v0.1.15/schema/README.md)
- [OpenRPC schema](https://github.com/herdrdev/herdr-core/blob/v0.1.15/schema/hc.openrpc.json)
- [Normal consumer workflow](https://github.com/herdrdev/herdr-core/blob/v0.1.15/crates/herdr-core/src/SKILL.md)
- [Input/state checks](https://github.com/herdrdev/herdr-core/blob/v0.1.15/crates/herdr-core/src/input.rs)
- [Security/endpoints](https://github.com/herdrdev/herdr-core/blob/v0.1.15/docs/security.md)
- [Pi status reporting](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/program-status-reporter.ts)
- [Official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)

The adapter does not depend on oldherdrTUI. Review and test source/schema changes
before adding another version to the reviewed set. Untested versions warn by default.

## Multiple hosts and creation

See [MULTIHOST.md](MULTIHOST.md) for explicit host IDs/core pins, strict SSH bridging,
restricted versus trusted-core policy, configured Pi/Claude profiles, model/provider
argument variants, exact project directories, creation verification and uncertainty.
No actual host is configured or enabled by installing this source.

## Optional MCP Events

See [EVENTS.md](EVENTS.md) for opt-in discovery, durable subscription storage,
webhook delivery, replay, configuration requirements and polling limits.

### Desktop workspace placement

An operator may configure `desktopSpaces` on an agent profile, mapping an existing
project ID to a Herdr desktop workspace ID, for example
`"desktopSpaces": { "demo": "workspace-demo" }`. IDs contain 1–128 ASCII letters,
digits, underscores or hyphens and start with a letter or digit. Only configured
projects may be mapped; the mapping is optional and does not change tool inputs.

Creation includes the configured workspace as the `herdr.space` terminal label
in the initial `terminal.run` request. Receipts expose `desktop_space` and
`desktop_visibility_requested`; these describe placement metadata, not proof that
a desktop window rendered the terminal. No desktop document or existing terminal
is rewritten. Reconciliation retains an existing terminal's placement even if the
operator later changes the mapping, and cached receipts remain explicitly stale.
