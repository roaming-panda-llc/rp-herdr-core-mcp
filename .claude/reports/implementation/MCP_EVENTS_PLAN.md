# MCP Events Implementation Plan

## Milestone 1: Event Discovery Foundation (Current)

### Goals
- Advertise `events` capability in `initialize` response (opt-in, disabled by default)
- Implement `events/list` method returning a small metadata-only terminal lifecycle/status catalog
- Register `events/subscribe` and `events/unsubscribe` method handlers (stubs returning MethodNotFound for now)
- Preserve all 5 existing tools unchanged
- Add wire-level/in-memory tests proving:
  - Capability discovery works when enabled
  - `events/list` returns exact expected result
  - Default is disabled (no events capability advertised)
  - Five original tools unchanged
  - Unknown/invalid method inputs rejected

### Architecture

#### Shared Process-Level Runtime
- `HostRuntime` and `CoreClient` remain process-level singletons
- Per-HTTP-request `McpServer` instances created in `makeHttpApp`
- Events capability registered per `McpServer` instance

#### Event Catalog (Metadata-Only, No Terminal Text)
```javascript
const eventsCatalog = [
  {
    name: 'terminal.created',
    description: 'A new terminal session was created on the configured core',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host/profile ID to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        created_ms: { type: 'number' },
        name: { type: 'string' },
        profile: { type: 'string' },
        project: { type: 'string' }
      },
      required: ['host', 'terminal', 'created_ms'],
      additionalProperties: false
    }
  },
  {
    name: 'terminal.status_changed',
    description: 'Terminal status transitioned (idle/working/done/blocked/error)',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host/profile ID to filter by' },
        terminal: { type: 'string', description: 'Terminal address to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        previous_status: { type: 'string' },
        new_status: { type: 'string' },
        timestamp_ms: { type: 'number' }
      },
      required: ['host', 'terminal', 'previous_status', 'new_status', 'timestamp_ms'],
      additionalProperties: false
    }
  },
  {
    name: 'terminal.finished',
    description: 'Terminal session finished (exited, was terminated, or holder lost)',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host/profile ID to filter by' },
        terminal: { type: 'string', description: 'Terminal address to filter by' }
      },
      required: [],
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        terminal: { type: 'string' },
        exit_code: { type: ['number', 'null'] },
        reason: { type: ['string', 'null'] },
        finished_ms: { type: 'number' }
      },
      required: ['host', 'terminal', 'finished_ms'],
      additionalProperties: false
    }
  }
];
```

#### Filter Design
- Strict host/terminal/lifetime filters only
- No terminal text in payloads
- All filters optional (empty = match all)
- Pagination via `cursor`/`nextCursor` (not needed for small catalog, but schema supports it)

#### Configuration
- Add `events.enabled` boolean to config (default: false)
- When enabled, register `events` capability and three method handlers
- Never trust caller-supplied owner field (current auth is bearer/stdio)

#### SDK Integration
- Use `server.server.registerCapabilities({ events: {} })` before connect
- Use `server.server.setRequestHandler()` with strict Zod schemas for:
  - `events/list`
  - `events/subscribe` (stub)
  - `events/unsubscribe` (stub)

### Files to Modify
1. `src/config.js` - Add `events.enabled` to config schema
2. `src/server.js` - Register events capability and handlers in `makeServer`
3. `test/events.test.js` - New test file for events functionality

### Test Requirements
- Test capability appears in initialize response when enabled
- Test capability absent when disabled (default)
- Test `events/list` returns exact catalog with correct schemas
- Test `events/subscribe` and `events/unsubscribe` return MethodNotFound (stubs)
- Test unknown event method returns MethodNotFound
- Test all 5 original tools still work and are listed correctly
- Test raw initialize response includes events capability when enabled
- Use isolated temporary/mock endpoints only

---

## Milestone 2: Callback/Outbox (Future)

### Goals
- Implement `events/subscribe` with callback verification challenge
- Store subscriptions in memory with deterministic IDs
- Implement outbound webhook delivery with Standard Webhooks signing
- Add subscription refresh and expiration handling
- Implement `events/unsubscribe` to stop delivery

### Architecture
- In-memory subscription store (per-process, survives adapter restarts via file backup later)
- Callback URL validation: HTTPS only, no private/local addresses, no redirects
- Challenge verification with single-use random value
- Standard Webhooks HMAC signing (webhook-id, webhook-timestamp, webhook-signature, X-MCP-Subscription-Id)

---

## Milestone 3: Core Stream Integration (Future)

### Goals
- Connect to herdr-core event stream (if available) or poll terminal.list/terminal.get
- Emit events when terminals are created, status changes, or finish
- Filter events by subscription criteria before delivery
- Handle server restarts and subscription persistence
- Implement cursor-based replay for terminal.created events

---

## Quality Gates
- `npm run check` passes (syntax check all files + tests)
- `npm test` passes (all tests including new events tests)
- No modifications to existing 5 tools
- No deployment/service restart in this milestone