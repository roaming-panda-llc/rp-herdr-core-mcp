# Core 0.1.17 compatibility review

This change starts at main `a511edb5a11b311385b1b344f640fce4d115168d`.
Official upstream tag `v0.1.17` resolves to
`ce87721557176f6cddaac1c7aefbf76929923263`. The review compared source and OpenRPC
against reviewed `v0.1.16` (`e07c2a1bedd62cf4787ee026ee23ee79c7d95491`) and
`v0.1.15` (`9e934dff8513710d3c5111fe28bc5b23564805db`).

## Why 0.1.17 was rejected

The previous handshake accepted only exact versions 0.1.15 and 0.1.16. The parent's
read-only Air diagnosis found generation 1, plain framing, and the required methods;
version alone failed the adapter's old check. This branch did not access Air.

The adapter now records 0.1.17 as tested. Other syntactically valid older/newer
versions warn on stderr and continue if the protocol checks pass. This is not a
claim those versions have been reviewed. Malformed version metadata, wrong
generation, framed mode, missing/malformed methods, wrong configured core ID,
or invalid JSON-RPC replies still fail. No wildcard bypass replaces those checks.
Warnings are once per version per CoreClient, with a 16-version memory/log bound.

## Source findings

- [OpenRPC](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/schema/hc.openrpc.json):
  Terminal, ListResult, SendResult, HelloResult and flattened RunResult components
  are identical to 0.1.15. ReadResult changes only the description of `why`.
  Hello adds an optional features input; attach adds resize notification fields;
  machine-add documents SSH ports. None requires changing this adapter's calls.
- [Input implementation](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/crates/herdr-core/src/input.rs):
  unchanged from 0.1.15. `status_mismatch` is returned in the preparation callback
  before `type_in` executes write steps. The exact -32000/status_mismatch pair
  therefore retains known non-delivery classification for reviewed versions only.
  On untested versions even that pair is conservatively unknown after dispatch.
- [API](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/crates/herdr-core/src/api.rs)
  and [run](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/crates/herdr-core/src/api/run.rs):
  list/get/read/send/run now await registry flushing before returning. In send/run,
  the action precedes the flush. A later failure cannot prove that the action
  was not performed. Creation still uses flattened terminal fields, configured
  nonempty argv, and request labels for reconciliation; the default-shell change
  introduced in 0.1.16 does not affect those explicit argv calls.
- [Runtime flush](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/crates/herdr-core/src/runtime.rs)
  has a ten-second timeout, returning -32000/unavailable; writer termination can
  return -32603/internal. The adapter keeps both mutation outcomes unknown and
  never retries automatically. Ordinary disk-write failures are logged by the
  [registry writer](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/crates/herdr-core/src/runtime/persistence.rs),
  which still marks the snapshot completed. Thus an upstream success response is
  not proof of successful disk persistence.
- [Stitching](https://github.com/herdrdev/herdr-core/blob/ce87721557176f6cddaac1c7aefbf76929923263/crates/herdr-core/src/stitch.rs)
  now avoids scrolling blocked/error full-screen applications as well as working
  ones. This adapter already always reads `lines: 0`; tests enforce that invariant.
- Resize changes concern framed observer/attach streams. This adapter explicitly
  negotiates plain mode and does not attach. macOS launchd, Linux linger, registry
  writer and remote-readiness changes were inspected for scope; this branch does
  not start, restart, reconfigure or deploy a core or operating-system service.

## Tests and residual risks

`test/fixtures/core-0.1.17.json` contains synthetic, schema-shaped responses and
method names from the official tagged schema. It contains no Air/session data.
Tests run the actual CoreClient framing/parser against mock streams and, under
`test:integration`, temporary Unix sockets. MCP calls exercise list/read/send;
creation tests exercise real CoreClient requests plus createSession reconciliation.

Untested versions may change mutation semantics despite passing structural checks.
Warnings are advisory, not a safety certification. Success replies remain usable
under the existing policy; failures after mutation dispatch are unknown. The
normal done-to-working preflight race remains: only idle uses an atomic predicate.
Timeouts can be more common under persistence load, since upstream flushing takes
additional time; this change does not lengthen configured deadlines or replay work.

No core Rust tests/build, live mutation, live Air probe, deployment, main merge,
or credential/security change was performed. Existing parent-provided Air read-only
evidence is distinct from this branch's deterministic compatibility tests.
