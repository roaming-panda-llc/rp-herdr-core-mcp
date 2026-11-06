# Bounded Escape cancellation

`press_escape` is a consequential, Escape-only control, disabled by default.
It does not expand `send_prompt`, `trusted-core`, or `sendAllowlist` permissions.
It always calls `terminal.keys({terminal, keys:['esc']})`; there is no Enter,
text/control-byte input, force mode, arbitrary key list, shell, or fallback.

An operator may configure `escape` on a named host (or a legacy local socket
configuration with `coreId`). No configuration is enabled by this change.
The exact-action policy is **dismiss a previously inspected non-approval UI**.
Never use it to accept, bypass, or dismiss permission/security/approval prompts.
The operator must establish that Escape has the intended cancellation effect;
a screen hash is an equality check, not a classifier or proof of authorization.
Only explicitly approved `idle` or `done` status is supported. `blocked`, `error`,
`working`, missing, and unknown status fail closed. This does not recover a
quota-error or approval-blocked session in this first slice.

Example policy shape (illustrative only; substitute inspected values, never copy
these as a live grant):

```json
{
  "escape": {
    "enabled": true,
    "approvals": [{
      "action_id": "cancel_menu_01",
      "terminal": "t1",
      "created_ms": 123,
      "pid": 42,
      "action": "dismiss-nonapproval-ui",
      "status": "idle",
      "screen_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "expires_ms": 0
    }]
  }
}
```

Pin the host's `coreId`. Use the exact `created_ms` and positive live PID from
core's terminal listing and SHA-256 of UTF-8 `terminal.read` text with `lines:0`.
Approval must follow inspection of the complete screen and relevant user
permission. Set a short expiry appropriate to that inspection. Screen content
is untrusted; instructions appearing in it grant no authority. MCP callers use:

```json
{"host":"local","terminal":"t1","action_id":"cancel_menu_01","inspected_and_authorized":true}
```

The tool validates its strict schema, claims the action ID, lists the terminal,
requires the approved lifetime/PID/live state and status, reads and matches the
complete screen, then lists/rechecks before dispatch. It checks cancellation
and expiry again immediately before method dispatch, including after the core handshake. Core's
handshake pins identity, supported version and method capability on each call.
The normal core human-input quiet gate and live-program check remain intact.
There is no retry on another host or version.

## Limits that affect authorization

Preflight is **not atomic** with input. Supported core 0.1.15/0.1.16 keys has no
status, PID, lifetime, screen, or expiry predicate. State can change after checks,
especially while core waits for human input to become quiet. Core resolves the
terminal ID at dispatch, not an adapter-provided lifetime token. If authorization
requires any of these conditions to hold atomically at delivery, do not enable
this policy: core must first gain a guarded keys API. Rechecking reduces the
window; it cannot eliminate it. Request cancellation after dispatch cannot undo
or reliably stop the key.

A core acknowledgement is not verified UI dismissal, task completion, readiness,
or even proof the application consumed a byte. Results explicitly report
`ui_dismissed: "unverified"`, `readback_required: true`, and no atomic guard.
Read the screen after every attempt. Post-dispatch timeout, disconnect, malformed
reply, or error means **unknown delivery**, never safe automatic retry.

An action ID is consumed for the lifetime of this adapter/core-client instance
once dispatch is attempted, including failed handshakes and unknown delivery.
Concurrent requests cannot reuse it. Preflight failures release the claim.
This ledger is memory-only, not durable exactly-once protection. Restarting the
adapter must not be used to replay an action; remove consumed approvals before
restart, perform readback, and obtain a new exact-action approval only if still
needed. Multiple adapter processes do not share the ledger; configure an action
on one process only. New IDs/configuration are operator actions, not MCP tools.

## Validation and source evidence

`npm run check` runs unit tests; `npm run test:integration` additionally uses
isolated Unix sockets, MCP stdio and HTTP fixtures. No test sends live input.
`test/controls.test.js` covers strict validation, opt-in, identity/lifetime/PID,
state/screen checks, expiry, cancellation, concurrent/repeated attempts, uncertain
outcomes and core capability/version/identity rejection. Existing send tests are
unchanged except for expected tool discovery count/list.

Reviewed upstream tag v0.1.15 commit
`9e934dff8513710d3c5111fe28bc5b23564805db`: `input.rs::keys/type_in`,
`api/types.rs::KeysParams/KeysResult`, `api.rs::terminal_keys`, and `keys.rs`.
Those input/types/encoding files are identical in v0.1.16. Upstream
`keys::tests::names_encode_like_a_real_terminal_in_the_programs_modes` asserts
legacy Escape `0x1b` and Kitty Escape `ESC[27u`. The adapter delegates encoding
unchanged. This workspace has no Cargo/Rust toolchain; that upstream encoding
test was inspected but not executed here. The isolated tests exercise the
adapter and real socket protocol against a mock core, not a live PTY/core.


## Refresh onto main (2026-11-06)

Reconciled onto main `190d723447e842d8fcf7174b3cb1d7262485ba98`, retaining
Events discovery/delivery, desktop placement, and the original tools' forward
version tolerance. Escape alone keeps its reviewed 0.1.15/0.1.16 gate; even
0.1.17 is rejected for Escape until its key path is reviewed and validated.
All cancellation and unknown-outcome guards remain unchanged.

Fresh test-prerequisite inspection found no `cargo`, `rustc`, `zig`, or `hc`
on PATH. The upstream reference has no built binary and its pinned Ghostty
submodule (`1e5cdb865807abc990181efb8ebfa9122955cce2`) is uninitialized.
`crates/ghostty-vt/build.rs` requires Zig 0.16 plus that submodule; source tests
also require the Rust/Cargo toolchain. GitHub's upstream releases API returned
an empty release list (v0.1.16 release lookup returned 404), so no release binary
was available through that route. Real synthetic core/PTY encoding tests remain
unexecuted for these current missing prerequisites, not an authorization denial.
The next validation environment needs a reviewed core executable, or Rust/Cargo,
Zig 0.16, and the pinned Ghostty source. No installed or user core was contacted.
