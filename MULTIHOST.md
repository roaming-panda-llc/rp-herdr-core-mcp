# Named hosts and agent creation (0.2.0)

These are opt-in capabilities, not automatic host discovery or permission to connect.
Enabling a new host or `trusted-core` access requires the operator's specific approval.
No credentials, SSH host keys, remote installation or live configuration are created
by this package. The adapter runtime needs Node; remote SSH hosts only need hc.

## Named hosts

Legacy `socketPath` configuration remains supported and maps to `local`. Existing
tool calls without `host` still use the configured default host. With named hosts,
set `hosts` and `defaultHost` instead of top-level `socketPath`. Every named host must
have a verified `coreId`. Versions accepted are exactly **0.1.15 and 0.1.16**.
All operations—including list/read—pin that identity. Unknown/unavailable/mismatched
hosts fail; there is no fallback to another host or federated peer.

`examples/config.multihost.json` deliberately contains placeholders and
`allowCoreAutoStart:false`; it **refuses startup** until the SSH host is explicitly
approved and this setting changed, or that host is removed. Do not blindly activate
it. Use an explicit user@host destination, absolute hc executable, and selected existing
`HC_SESSION`; do not assume every machine uses the same account or default session.
If multiple cores already run, establish which one owns the intended terminals
before selecting a session. A directory containing agent files is not proof of an
hc-managed agent.

The SSH bridge runs a fixed `/usr/bin/ssh` argument array: batch mode, strict existing
host-key verification, connect timeout, no TTY, no forwarding. Its fixed remote
command is `env HC_SESSION=SELECTED /absolute/hc connect`, correctly shell-quoted.
There is no `--stdio` flag: `hc connect` already bridges plain JSON-RPC stdin/stdout.
Caller tool arguments cannot change the SSH destination, command, credentials,
options or environment. Existing SSH configuration/keys remain operator-managed.

**Core auto-start caveat:** hc connect may start a missing core. There is no
existing-only bridge flag in these versions. Thus every SSH bridge requires explicit
`allowCoreAutoStart:true`; even list/read/probe operations can start that selected
core. Read-tool annotations disclose this when SSH hosts are configured. Choose
Unix sockets if no-start semantics are required. Bridge cleanup terminates only the
local SSH client, not hc or its terminals. No remote agent/core shutdown is issued.

`list_hosts` returns bounded public host/profile/project/variant IDs with independent
availability results. One unavailable host does not hide others. It does not expose
private destinations/socket paths. Use `host` on list/read/send/create to select a
host. Addresses are local to that selected core (`t3`), not `machine/t3`. Core lists
can include federated peers; those entries are excluded and counted in
`excluded_federated`. Configure a peer as its own direct host instead of routing
implicitly through unrelated cores.

## Access modes

- `restricted` (default): existing address + creation-timestamp write allowlist;
  no session creation. Read behavior remains available on the configured core.
- `trusted-core`: explicit broad authorization to interact with **all live local
  terminals on that pinned core**, including newly created sessions, without
  manual per-session allowlisting. It is not limited to sessions created by this
  adapter and not a sandbox. Writes verify a live program and apply the selected
  `sendMode`; blocked protection is never forced off.

Prefer dedicated agent cores/accounts for broad trust. Core IDs and self-reported
agent status do not attest to the executable or prevent later shell replacement.
Trust must be deliberately granted to the selected core, not inferred from a
successful connection. All MCP clients of this adapter share its configured access.

## Configured creation profiles

Add profiles only to a specifically approved trusted host, for example this host
policy fragment (not a complete config):

```json
{
  "accessMode": "trusted-core",
  "sendMode": "normal",
  "profiles": {
    "coding": {
      "agent": "pi",
      "executable": "/home/agent/.local/bin/pi",
      "args": [],
      "variants": {
        "fast": ["--provider", "configured-provider", "--model", "configured-model"]
      },
      "projects": { "demo": "/home/agent/projects/demo" }
    },
    "review": {
      "agent": "claude",
      "executable": "/home/agent/.local/bin/claude",
      "args": [],
      "variants": {},
      "projects": { "demo": "/home/agent/projects/demo" }
    }
  }
}
```

Verify installed agent CLI flags and existing authentication before configuring
profiles. Provider/model selections are operator-defined **argument-array variants**,
not caller-supplied shell strings or arbitrary options. No model/provider is chosen
or credential provisioned by this example. The operator is responsible for the
actual executable's identity and configured flags; profile labels are not attestations.

Projects map aliases to exact normalized absolute directories. The caller supplies
an alias, never a path; no traversal or arbitrary cwd is accepted. Verify each actual
directory and symlink target on its host. hc exposes no canonical-path validation
primitive, so this is **not a symlink-safe filesystem sandbox** and does not constrain
what files the launched agent can access. A broad workspace may itself be an approved
exact directory. Arbitrary descendant paths are intentionally not supported.

## Create, verify, then prompt

Call `create_session` with `host`, `profile`, `project`, optional `variant`/`name`, and
a stable `request_id` (8–64 letters/digits/underscore/hyphen). Names are bounded by
hc's rules; a deterministic name is generated when omitted.

The adapter calls `terminal.run` with an absolute executable and separate arguments,
`wait:false`, `keep:false`, `rm:false`, no parent and no notifications. Absolute
executables bypass hc template lookup; no shell `line`, arbitrary caller environment,
remote `on`, or template task is exposed. **The adapter adds no initial prompt.** Operator-configured executable arguments
can themselves request startup tasks or noninteractive behavior; approving those
arguments remains the operator’s responsibility. It then calls
`terminal.get`, checks identity/lifetime/labels/argv and a live PID. `verified` and
`ready` describe this observation, not successful task completion. A starting agent
may not yet report idle/done; use list/read to confirm readiness before send_prompt.
New trusted-core sessions do not require manual timestamp allowlist edits.

## Creation uncertainty and reconciliation

A request label and parameter fingerprint are stored in hc. Same-process concurrent
or repeated request IDs share one attempt; different parameters conflict. A bounded
ledger holds 256 requests per host, including failures, with no automatic eviction
or retry. Repeated successful calls return a **historical cached receipt**, explicitly
not currently verified/ready. Inspect the current terminal before further action.

After restart, the adapter searches retained hc records by request label before
creating anything. Matching records are reverified, not relaunched. A timeout or
disconnect after dispatch is **UNKNOWN creation outcome**: the agent might exist.
Never retry with a new request ID/name merely to get past that uncertainty. Inspect
hc records and reconcile first. Missing/pruned/removed records, core state resets,
and concurrent independent adapter processes mean this is **not durable exactly-once
execution**. Keep one adapter writer per core for coordinated creation. Do not restart
the adapter just to clear a failed request. No automatic agent kill or cleanup is
attempted after uncertainty; preserve sessions for operator inspection.
