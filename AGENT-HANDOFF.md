# Operator installation and migration handoff

Preserve existing hc sessions, state, credentials, socket paths and approved terminal
lifetimes. This package does not authorize deployment or security-setting changes.

1. Read README and VALIDATION. Verify trusted Node >=22 and hc 0.1.15/0.1.16; do not
   automatically upgrade, downgrade or restart hc.
2. Create a user-owned project directory such as `~/Projects/rp-herdr-core-mcp`.
   Preserve an existing installation as rollback; do not delete or overwrite its
   private config. Keep secrets/config outside the project and Git.
3. Extract or clone source into the project. Run `npm ci --ignore-scripts`,
   `npm run check`, and **`npm run test:integration`**. The last command exercises
   temporary mock Unix sockets and loopback HTTP, not live agents. Require zero
   failed/skipped integration tests before relying on those transports.
4. Preserve the existing verified socket and configuration identity pins. For a
   new installation retain an empty `sendAllowlist`. Run the read-only probe:
   `node scripts/inspect-core.js /absolute/private/config.json`.
5. Update only the approved MCP host/service command to the new absolute Node and
   script paths, keeping its private config path and credential references. Stop
   the old adapter/client before starting a replacement. When a tunnel is involved,
   preserve its identity and access controls; one active client per tunnel.
6. Discover exactly five tools and verify list/screen reads. Do not use send to
   test authentication. For approved follow-up support, set `sendMode: "normal"`
   explicitly in the private config, retain the same core/terminal lifetime pins,
   and accept the documented done-to-working race. Without this setting old
   idle-only behavior remains unchanged.
7. Read the chosen terminal before any owner-approved test prompt. Confirm delivery
   in its UI, not merely from a tool return. Never automatically replay uncertain
   sends or force through a blocked program. Do not spoof idle status.

## Git and rollback

Use a normal local Git project. Before staging, inspect `git status` and the staged
diff; include only source, tests, generic examples and public documentation. Never
commit live configs, tokens, keys, screen receipts, node_modules or vendor checkouts.
Use your configured identity; if a nonpersonal automation identity is needed, make
it explicit and repository-local. Creating a local commit is not publishing.
Do not add a remote or push without separate publication authorization.

If migration fails, stop the replacement and restore the previous host/service
command and retained installation; do not run both clients or alter hc state.

## Sanitized verification receipt

Report package version/commit, Node/hc versions, test counts, initialization/tool
names, read-only smoke outcome, selected send mode, and whether any explicitly
approved prompt was delivered. Report uncertainty honestly. Never include tokens,
auth headers, screen text, environment dumps or live config files. Record remote
TLS/auth/connector checks separately; local tests are not proof of connectivity.


## Enabling multi-host or creation access

Read MULTIHOST.md before changing policy. Code availability is not approval to add
hosts, auto-start a core, or enable trusted-core access. Obtain specific operator
approval for the selected account/session/core and creation profiles. Use verified
core IDs, not guessed prefixes. Confirm whether each intended agent is actually
managed by that core; do not infer this from a directory or another machine's
federated listing. Direct host tools use local terminal IDs, not qualified peer IDs.

Preserve existing SSH credentials/host keys. SSH requires an explicit session and
allowCoreAutoStart consent; do not invoke its bridge during no-start preflight.
Verify exact project directory/symlink targets and installed executable flags.
Keep all live host settings private and outside Git. No remote Node installation
is required for an hc SSH bridge. Initially test list_hosts/list/read; only then
perform a specifically authorized creation. Verify the returned lifetime/startup
and screen before sending a task. Use one stable creation request ID and never
replay uncertain creation with a new ID. Retain the session for investigation.
