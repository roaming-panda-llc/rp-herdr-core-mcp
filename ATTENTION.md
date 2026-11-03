# Attention semantics

`list_sessions.needs_you` makes the known per-terminal attention mapping explicit.
It is an additive read-only field, not a new state or a send authorization.

## Pinned desktop evidence

Herdr desktop v0.1.12, commit `4aa3460749947e7771aa39a8a2cec58d46649926`:

- [model.rs lines 504–513](https://github.com/herdrdev/herdr-app/blob/4aa3460749947e7771aa39a8a2cec58d46649926/src/model.rs#L504):
  raw `blocked` or `error` maps to UI `blocked`; `working` remains working.
  Other status words use shared seen turn or local seen state for done/idle.
- [agents mod](https://github.com/herdrdev/herdr-app/blob/4aa3460749947e7771aa39a8a2cec58d46649926/defaults/mods/agents/main.js#L211):
  UI `blocked` renders as “Needs you”. Section urgency also incorporates children.
- [window.rs](https://github.com/herdrdev/herdr-app/blob/4aa3460749947e7771aa39a8a2cec58d46649926/src/window.rs#L1931):
  desktop consumes core status, not screen-text inference, for this mapping.
- [labels contract](https://github.com/herdrdev/herdr-app/blob/4aa3460749947e7771aa39a8a2cec58d46649926/docs/labels.md):
  `turn` and `herdr.seen` reconcile done/idle. Missing seen is not zero.

The adapter conservatively returns null for missing or unrecognized states; it
cannot assert future versions' attention meaning. No runtime desktop version is
queried, and this field is not a claim to reproduce arbitrary custom mods.

## Why the lists differ

The desktop presents agents placed in its layout, with parent/child grouping.
The MCP lists all local terminals on each selected host and excludes federated
copies. An Air desktop may display remote agents while Air's local MCP list is
empty. Count across the owning hosts, but do not equate that count with a sidebar.

The current adapter omits turn, labels (including placement/seen), and parent
relationships. Therefore it does not reproduce exact desktop membership, grouping,
or done/idle. Foreground process name is already included and does not determine
Needs You. We intentionally do not expose arbitrary labels, derive UI membership,
write seen labels, or alter send guards as part of this change.

A live read-only check of installed v0.1.12 confirmed four placed error agents
rendered as four Needs You entries; additional errors existed outside that layout.
The desktop CLI `ls`, `status`, and `shot` can inspect the running window without
changing focus or sending terminal input. Use the existing window and preserve its
state. A screen/model selector may still have a raw idle state: this is not proof
that the agent is ready for unattended input.
