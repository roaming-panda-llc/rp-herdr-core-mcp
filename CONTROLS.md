# Session control coverage

This is a source-only expansion, disabled until an operator configures it. It is
not complete unrestricted control. Core 0.1.18 has no atomic lifetime, PID, screen
or status predicate on keys/interrupt/kill. Exposing every RPC as an unrestricted
MCP tool would bypass the existing adapter policy.

| Core surface | MCP support / remaining prerequisite |
| --- | --- |
| hello, server.status, terminal.list/get/read | host/session listing and current screen reads; no history-driven input |
| terminal.run | configured agent profiles and exact approved projects via create_session |
| terminal.send | existing guarded send_prompt; raw control bytes remain rejected |
| terminal.keys | press_escape; new press_menu_key for exact one-key non-approval menu interaction |
| terminal.wait, templates.list | not exposed; bounded read-only wrappers remain future work |
| terminal.interrupt | not exposed; key choice depends on agent status; needs exact-action policy and guarded delivery |
| terminal.kill/rm | control_terminal_lifecycle: separately approved termination or finished-record removal, with non-atomic limits below |
| terminal.keep/label | not exposed; persistent restart policy and metadata writes need separately scoped policies |
| terminal.attach | not exposed; framed byte stream would bypass typed controls |
| server.stop/restart | not exposed; affects other sessions/services, requires separate operational authorization |
| machine.*, file.*, doc.*, terminal.put | not generic session controls; arbitrary process/file writes, persistent configuration and access need separately scoped policies |
| events.subscribe | existing durable bridge; actual callback/assistant wake remains separately unproved |

## Typed menu keys

`press_menu_key` accepts explicit `host`, terminal address, `action_id`, `key`, and
`inspected_and_authorized:true`. The only keys are `up`, `down`, `left`, `right`,
`tab`, `space`, `enter`. No raw bytes, text, aliases, modifiers, repeats or key
sequences are accepted. Each navigation step needs readback followed by its own
exact approval; a down/Enter batch cannot reuse the original screen approval.

Configure `menu` on the exact named host (or legacy local socket), independent of
Escape/send/create grants. Default is absent/disabled. Its approval shape is:

```json
{"enabled":true,"approvals":[{"action_id":"menu_step_001","terminal":"t1","created_ms":123,"pid":456,"action":"interact-nonapproval-menu","key":"down","status":"idle","screen_sha256":"0000000000000000000000000000000000000000000000000000000000000000","expires_ms":0}]}
```

This example is deliberately expired and is not a live grant. Use an inspected
complete screen and its UTF-8 SHA-256, positive live PID, exact creation timestamp,
short expiry and pinned core ID. Approval must authorize the specific key's
intended effect, including Enter/Space consequences. The hash checks equality;
it does not classify the UI or establish authorization. Never use this tool to
answer permission/security dialogs, execute shell commands, or create unapproved
spending, credential or security changes. Blocked/error/working/unknown status
remains rejected even when the visible screen appears to be an ordinary choice.
Idle/done is necessary, not sufficient proof that a menu is safe.

The same list/read/list preflight and post-handshake expiry/cancellation checks
as Escape apply. State and lifetime can still race during core's quiet gate.
Do not use this API where authorization requires atomic conditions at delivery;
a core-side guarded keys operation is a prerequisite for that use case.

The shared action ledger prevents cross-tool concurrent reuse, but is memory-only.
Remove consumed approvals before restart, never use restart or another adapter
to replay an action. Acknowledgement leaves the outcome unverified; read back.
Any post-dispatch error/disconnect/timeout is unknown delivery, no automatic retry.
Core 0.1.18 registry persistence can fail after input and is treated accordingly.

Events scope excludes the named-host menu policy, as it excludes Escape. Every
other identity/connection field remains bound. Existing pre-menu stores retain
the same scope; no key replacement or state reset is needed. Rolling back to
PR #2 requires removing menu policy from config (its strict schema predates menu),
without changing core identity or protected Events files. The same applies to the new lifecycle policy.

## Release boundary

This branch builds on the independently tested, pushed 0.1.18 compatibility
commit de3dddf69b144034afea639eb7c8f9e407909b6d. That commit's PR publication was
denied and has not been retried here. No merge/deploy or live configuration is
part of this source task. The typed menu controls are validated on core 0.1.18;
older versions remain supported only for the separately validated Escape tool.

Confirmation with Enter/Space requires `selection_text`: a unique textual marker
from the inspected screen that identifies the selected target (for example
`Selected: blue`). It must occur exactly once in the complete text snapshot.
Color/reverse-video/cursor-only selections are UNSUPPORTED: `terminal.read` text
does not encode those distinctions. A matching text hash cannot prove such a
selection. The operator must verify the marker truly represents the selection;
the marker must change when the selection changes; merely finding an option label in a list is not enough. This does not remove the
post-check race or authorize permission/security prompts.

Validation: repository check 230 passed/3 integration-only skips; integration
233 passed. The real synthetic core 0.1.18 PTY harness (`--menu`) covers seven
keys in legacy and Kitty modes, done-state confirmation, blocked/error/working
rejections, readback and replay rejection, with owned-process/path cleanup.

## Terminating processes and closing terminal records

`control_terminal_lifecycle` accepts the common explicit host/terminal/action_id/
inspection fields and `action: terminate` or `remove_finished`. It supports only
core 0.1.18. It does not execute shell commands, send control bytes, accept PIDs
from callers, kill unrelated processes, or close desktop windows.

An operator configures a separate disabled-by-default `lifecycle` policy whose
approvals bind the exact action, core-managed terminal address, `created_ms`, PID,
status (including explicit null for an unreported status), complete screen hash,
and expiry. They also require `work_preserved:true`,
`purpose:"explicit-user-request"`, and `accept_nonatomic_targeting:true`.
`include_process_tree:true` is also mandatory. Core termination can sweep detached
OS descendants carrying its inherited scope token; it is NOT single-PID isolation.
Known live child terminals (including indirect descendants) reject both operations.
Core can cascade termination to die-with-parent children, including children born
after preflight, so non-atomic consent also covers that race. If other child
terminal lifetimes must be preserved atomically, do not use this control.
These attestations are prerequisites, not substitutes for actual user authority
or preserving drafts, output and useful work. Idle/done alone NEVER permits
termination/removal. The tool cannot infer that files have been saved.

Termination requires a live positive PID and no holder-loss reason. Core uses
HUP, then TERM, then KILL with bounded waits; this is destructive and not a gentle
Escape cancellation. Exact approved blocked/error/working termination is allowed
only by this separate lifecycle policy; it sends no input and does not weaken any
send/menu/Escape status guards. Removal requires an already-finished record and
never implicitly kills a live program. Two separate approvals are needed to
terminate and then remove a record.

Both actions verify list/read/list before dispatch, pin identity/version and
expiry at handshake, and consume a one-shot action ID. Core lacks atomic lifetime
or PID predicates: a race can still change the target after preflight. Do not use
this feature if the authorization requires atomic targeting; an upstream guarded
lifecycle API is then required. Multiple processes and restarts do not share the
in-memory replay ledger. Reconcile and remove consumed approvals before restart.

After acknowledgement, termination verifies that the same lifetime is recorded
finished; removal verifies that the address is absent. This is a core observation,
not proof every OS descendant exited or a GUI window closed. Failed/ambiguous
acknowledgements or readback return UNKNOWN and prohibit automatic retry. Direct
OS process-exit evidence must be gathered by an authorized host owner when needed.

Herdr core has no desktop-window close RPC in this API. Its terminal records,
programs, viewer attachments and desktop windows are different objects. GUI close
needs a separately supported viewer/desktop API and exact window-to-terminal
mapping; no guessed window close, broad kill or input injection is implemented.

Events scope ignores lifecycle policy only, preserving all existing core/host/
connection identity fields. Do not reset/read protected state or replace keys.
Rollback removes unsupported menu/lifecycle configuration and restores the prior
adapter command while retaining Events identity and files.

### Remote termination scope is mandatory

Core `record_finish` calls `remote::orphaned_afar`, which can queue orphan
notifications for offline peers. Those peers may later terminate die-with-parent
children, recursively. The `afar` links are private and cannot be verified absent
using public `terminal.list`. Local child rejection does NOT establish isolation.
Termination therefore additionally requires the exact literal approval
`termination_scope:"root-and-all-local-remote-descendants"`; absent or narrower
scope is rejected. User authorization and `work_preserved:true` must cover that
entire descendant scope, including deferred remote effects, not merely the root
PID or one machine. Do not configure this approval for a single-process/single-host
request. If that scope cannot be authorized/preserved, termination is blocked
until core supports scoped guarded termination. No such broad live grant was
created by this source work. Removal does not send orphan/kill operations.

Removal additionally requires `remove_terminal_artifacts:true`: core removes the
stored screen snapshot and the terminal's uploaded-file directory as well as its
record. Preserve needed output/uploads before approval. This is not merely hiding
a viewer window. The response verifies root terminal/core state only; OS process
exit, remote descendant exit and GUI closure are explicitly unverified.

Final validation after lifecycle additions: check 250 passed, 3 integration-only
skips; integration 253 passed. Real `--lifecycle` harness passed 21 checks: the
seven Escape cases plus termination and finished-record removal for each owned
synthetic fixture. Owned PIDs/core exit and temporary-path cleanup were verified.
Remote cascade behavior was source-reviewed, not exercised against real peers.

Child rejection conservatively compares terminal-address suffixes across qualified
addresses. Same suffixes on different hosts may reject unrelated candidates;
this fails closed rather than weakening descendant protection.
