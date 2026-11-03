# Validation — adapter 0.2.0

Local branch build checks on isolated Linux, Node v24.22.1/npm 11.9.0:

- `npm run check`: **62 passed, 0 failed, 2 skipped** (64 tests), including syntax.
- Existing protocol, stdio, policy and HTTP middleware regressions remain covered.
- New coverage: legacy restricted/default-host compatibility; named-host core pins;
  explicit SSH account/session/auto-start permission; fixed SSH args and quoting;
  host isolation/no fallback; partial host availability without private path leakage;
  trusted versus restricted write/create behavior; exact profile/project/variant
  selection; absolute argv creation and post-start verification; reused-request
  conflict/deduplication, restart label reconciliation, historical receipt semantics,
  bounded ledger, cancellation, unknown create outcome/no replay, and SSH child
  SIGTERM/SIGKILL cleanup through injected fake processes.
- hc 0.1.16 handshake acceptance is explicit; unknown 0.1.17 is rejected. Reviewed
  v0.1.15→v0.1.16 changes to API types/input/run/templates: relevant schemas/input
  unchanged; run changes only the empty-argv default shell, which profiles do not use.
- Status-mismatch non-delivery classification remains backed by pinned core source.
  Normal done preflight is not an atomic state guarantee.
- Dependency versions unchanged; prior 0.1.0 audit reported zero vulnerabilities at
  that time. Audit not rerun for this branch.

Two real transport tests are skipped here: stdio through a temporary Unix-socket
mock core and official MCP HTTP client through loopback. This workspace does not
allow socket binding; no bypass/retry was attempted. Run **`npm run test:integration`**
in an authorized local environment: all tests should run with zero failures/skips.
The prior 0.1.3 HTTP fixture correction is retained: actual ephemeral port matches
Host configuration; explicit Host probes use node:http rather than fetch overrides.

No live SSH host, remote core, agent creation, model/provider, account authentication,
or network/credential change was exercised for 0.2.0. Mock success is not deployment
or actual agent-readiness proof. Existing sessions were not touched. Profile flags,
project directory/symlink targets, remote session/core identity and approved access
must be verified separately before activation. The builder did not configure any
user host or grant trusted-core access.

## MCP Events repair — 2026-11-03

Independent cloud checkout started from remote branch `feature/mcp-events-v2`
at `95f1a274fb40ec14e20725be12c19c66e7b2931f`, Node v24.19.0/npm 11.9.0.
The original checkout's `npm test` passed **79 tests, 0 failed, 2 skipped**
(81 total), including the ordinary stdio startup/close test. The previously
reported stdio failure did not reproduce here; its cause is not established.

The first install attempt failed because the default `/home/agent/.npm` cache
was not writable. `npm ci --ignore-scripts --cache /tmp/herdr-npm-cache` succeeded
without dependency or lockfile changes.

After callback transport repair (`1d552a8`), `npm run test:integration` passed
86/86 tests, zero failures/skips. After durable manager/replay repairs:

- `npm run check`: 104 passed, 0 failed, 2 intentionally skipped (106 total).
- `npm test`: 104 passed, 0 failed, 2 intentionally skipped (106 total).
- `npm run test:integration`: 106 passed, 0 failed, 0 skipped.
- `git diff --check`: passed.

New deterministic tests exercise pinned DNS/TLS options, IPv4/IPv6 non-public
ranges, rebinding, redirects, response bounds, timeout, challenge/signatures,
rotation, principal isolation, cancellation including in-flight requests,
encrypted persistence and tamper rejection, restart/replay, bounded queue/history,
retention truncation, disk failure, shared manager lifetime, host/address reuse,
and finish/disappear deduplication. The check script now syntax-checks all three
new event modules.

No deployment, live callback, live core, external agent creation, credential
change, main merge or ChatGPT end-to-end callback test was performed. The storage
and observation limitations in EVENTS.md apply; these tests do not establish
production connectivity or recover events never observed by the adapter.

## Core 0.1.17 and advisory version compatibility — 2026-11-03

Isolated branch `feature/core-0.1.17-compat` starts from main
`a511edb5a11b311385b1b344f640fce4d115168d`. Node v24.19.0, npm 11.9.0.
Dependencies installed with `npm ci --ignore-scripts --cache /tmp/herdr-npm-cache`;
no dependency or lockfile changes. Baseline `npm run test:integration`: **64 passed,
0 failed, 0 skipped**.

Final code checks:

- `npm run check`: **99 passed, 0 failed, 2 intentional skips** (101 tests), plus syntax checks.
- `npm test`: **99 passed, 0 failed, 2 intentional skips** (101 tests).
- `npm run test:integration`: **101 passed, 0 failed, 0 skipped**.
- `git diff --check`: passed.

New protocol tests cover the 0.1.17 fixture, unchanged hard guards, plain hello,
MCP read/list and no-scrolling reads, guarded idle/normal done sends, blocked/error/
working rejection, exact known status rejection, unknown post-dispatch persistence
errors, timeout/connection loss, flattened creation response, get verification,
request-id deduplication and restart reconciliation. Untested older/newer/build
versions warn once and allow validated operations; their status/persistence errors
remain unknown outcomes. Reviewed versions produce no advisory warning.

Official source semantic review and pinned links are in CORE-COMPATIBILITY.md.
No core Rust build/test, Air connection, live mutation, service change, deployment,
main merge, or credential/access/security change was run. The parent's read-only
Air findings are external evidence, not tests performed by this checkout. Warnings
for untested versions cannot guarantee their mutation behavior. No Events or
escape-only-control branch changes are part of this isolated work.
