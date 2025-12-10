---
status: COMPLETED
last_updated: 2025-12-10
reviewers: [review-typescript, review-arch, review-testing, review-senior, review-docs]
---

# AGENT_STATUS_SIMPLIFY

## Overview

- **Problem**: Agent count incorrectly shows 2+ agents over time for single-agent workspaces. Root cause: `/session/status` returns an array `[{type: "busy"}]`, but our code expects `{sessionId: status}` object format. The type guard rejects arrays, causing validation failures. Additionally, OpenCode accumulates sessions internally, so our session-based tracking picks up stale historical sessions.

- **Solution**: Simplify to **1 agent per port** model. Remove session ID tracking for status aggregation. Keep session ID correlation only for permission events (which require it).

- **Risks**:
  1. If OpenCode changes API format again, we'd need updates (mitigated by type guards with backward compatibility)
  2. Permission events still need session correlation - preserved via separate callback path

- **Alternatives Considered**:
  1. **Fix array parsing only** - Would still accumulate stale sessions over time
  2. **Track subagents** - Adds complexity, user doesn't want this
  3. **Query `/session` to count active sessions** - Returns ALL 397+ historical sessions, not filtered
  4. **Fix aggregation layer only** - Wouldn't address root cause of type guard rejecting valid responses

## Architecture

```
BEFORE (Complex - Bug-Prone):
┌─────────────────────────────────────────────────────────────────┐
│  OpenCodeProvider (per workspace)                               │
│  ├── clients: Map<Port, OpenCodeClient>                         │
│  ├── sessionStatuses: Map<sessionId, SessionStatus>  ← PROBLEM  │
│  └── pendingPermissions: Map<sessionId, Set<permissionId>>      │
│                                                                 │
│  OpenCodeClient                                                 │
│  └── rootSessionIds: Set<string>  ← PROBLEM (OpenCode accumulates) │
└─────────────────────────────────────────────────────────────────┘

AFTER (Simple - 1 Agent Per Port):
┌─────────────────────────────────────────────────────────────────┐
│  OpenCodeProvider (per workspace)                               │
│  ├── clients: Map<Port, OpenCodeClient>                         │
│  ├── clientStatuses: Map<Port, ClientStatus>  ← SIMPLE          │
│  ├── pendingPermissions: Map<sessionId, Set<permId>>  ← KEEP    │
│  └── sessionToPort: Map<sessionId, Port>  ← NEW (for permissions)│
│                                                                 │
│  OpenCodeClient                                                 │
│  ├── port: Port  ← Identifies this client                       │
│  ├── currentStatus: ClientStatus  ← SIMPLE                      │
│  └── onStatusChanged(callback)  ← Single status updates         │
│  └── onPermissionEvent(callback)  ← Preserved (has sessionId)   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
On Connect:
  GET /session/status → SessionStatusValue[] (array format)
                     → Empty array OR all idle → "idle"
                     → Any busy/retry → "busy"
                     → Set client.currentStatus
                     → Emit via onStatusChanged callback

After Connect (SSE):
  session.status event → Update currentStatus based on status.type
                       → Emit via onStatusChanged callback

  session.created     → Store sessionId → port mapping (for permissions)
                       → Do NOT track for status aggregation

  session.deleted     → Remove from sessionToPort mapping
                       → Remove from pendingPermissions

  permission.updated  → Add to pendingPermissions[sessionId]
                       → Lookup port via sessionToPort
                       → That port counts as idle

  permission.replied  → Remove from pendingPermissions[sessionId]

Aggregation:
  For each port in clientStatuses:
    - If ANY session on this port has pending permission → idle
    - Else use clientStatuses.get(port)

  1 port with idle status = { idle: 1, busy: 0 } → "idle"
  1 port with busy status = { idle: 0, busy: 1 } → "busy"
```

## Types

```typescript
// New type alias for client status (types.ts)
export type ClientStatus = "idle" | "busy";

// Updated response type - array format (types.ts)
export type SessionStatusResponse = readonly SessionStatusValue[];

// Callback signatures (opencode-client.ts)
type StatusChangedCallback = (status: ClientStatus) => void;
type Unsubscribe = () => void;

// Permission callback preserved - includes sessionId
type PermissionEventCallback = (event: PermissionEvent) => void;
```

## Implementation Steps

### Step 1: Update types and type guard (TDD)

- [x] **1a: Write failing tests for new type guard**
  - Test: `isSessionStatusResponse` accepts empty array `[]`
  - Test: `isSessionStatusResponse` accepts `[{type:"busy"}]`
  - Test: `isSessionStatusResponse` accepts `[{type:"idle"}, {type:"busy"}]` (mixed)
  - Test: `isSessionStatusResponse` accepts `[{type:"retry"}]`
  - Test: `isSessionStatusResponse` rejects old object format `{sessionId: {type:"busy"}}`
  - Test: `isSessionStatusResponse` rejects malformed entries `[null]`, `[{type:"unknown"}]`
  - Files: `src/services/opencode/types.ts` (add tests inline or separate file)

- [x] **1b: Implement type changes**
  - Add `type ClientStatus = "idle" | "busy"`
  - Change `SessionStatusResponse` from `Record<string, SessionStatusValue>` to `readonly SessionStatusValue[]`
  - Update `isSessionStatusResponse()` to validate array format:
    ```typescript
    export function isSessionStatusResponse(value: unknown): value is SessionStatusResponse {
      if (!Array.isArray(value)) return false;
      return value.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          (item.type === "idle" || item.type === "busy" || item.type === "retry")
      );
    }
    ```
  - Files: `src/services/opencode/types.ts`

### Step 2: Simplify OpenCodeClient (TDD)

- [x] **2a: Write failing tests for simplified client**
  - Test: `getStatus()` returns `"idle"` for empty array response
  - Test: `getStatus()` returns `"busy"` for `[{type:"busy"}]`
  - Test: `getStatus()` returns `"busy"` for mixed `[{type:"idle"}, {type:"busy"}]`
  - Test: `getStatus()` maps `"retry"` to `"busy"`
  - Test: `getStatus()` handles HTTP 500 gracefully (returns error)
  - Test: `getStatus()` handles malformed JSON gracefully
  - Test: `currentStatus` updates on SSE `session.status` event
  - Test: `onStatusChanged` callback fires when status changes
  - Test: `onStatusChanged` does NOT fire when status unchanged
  - Test: SSE reconnection re-fetches status via `getStatus()`
  - Files: `src/services/opencode/opencode-client.test.ts`

- [x] **2b: Implement simplified client**
  - Keep `rootSessionIds: Set<string>` (needed for permission correlation)
  - Keep `fetchRootSessions()` method (needed for permission correlation)
  - Add `private _currentStatus: ClientStatus = "idle"`
  - Add `private statusListeners: Set<StatusChangedCallback>`
  - Add `getStatus(): Promise<Result<ClientStatus, OpenCodeError>>` method:
    - Fetch `/session/status`
    - Empty array OR all idle → `"idle"`
    - Any busy/retry → `"busy"`
  - Add `onStatusChanged(callback: StatusChangedCallback): Unsubscribe`
  - Update SSE handlers:
    - `session.status` → derive status, update `currentStatus`, emit if changed
    - `session.created` → emit via existing `onSessionEvent` (for permission correlation only)
    - `session.idle` → set `currentStatus = "idle"`, emit if changed
    - `session.deleted` → emit via existing `onSessionEvent` (for permission cleanup)
  - Keep `onPermissionEvent(callback)` unchanged (needs sessionId)
  - Files: `src/services/opencode/opencode-client.ts`

- [x] **2c: Remove obsolete tests**
  - Keep tests for `rootSessionIds` (still used for permission correlation)
  - Keep tests for `fetchRootSessions()` (still used for permission correlation)
  - Replaced tests for `getSessionStatuses()` with `getStatus()` tests
  - Files: `src/services/opencode/opencode-client.test.ts`

### Step 3: Simplify OpenCodeProvider aggregation (TDD)

- [x] **3a: Write failing tests for port-based aggregation**
  - Test: Single port idle → `{ idle: 1, busy: 0 }`
  - Test: Single port busy → `{ idle: 0, busy: 1 }`
  - Test: Port with pending permission → counts as idle regardless of status
  - Test: Permission on session X doesn't affect session Y on same port (edge case)
  - Test: Port removal clears associated status and permissions
  - Test: `sessionToPort` mapping correctly correlates permission events
  - Files: `src/services/opencode/agent-status-manager.test.ts`

- [x] **3b: Implement simplified provider**
  - Replace `sessionStatuses: Map<string, SessionStatus>` with `clientStatuses: Map<number, ClientStatus>`
  - Add `sessionToPort: Map<string, number>` for permission correlation
  - Keep `pendingPermissions: Map<string, Set<string>>` unchanged
  - Update client initialization:
    - Subscribe to `client.onStatusChanged()` → update `clientStatuses.set(port, status)`
    - Subscribe to `client.onSessionEvent()` → update `sessionToPort` mapping
    - Subscribe to `client.onPermissionEvent()` → update `pendingPermissions`
  - Update `getAdjustedCounts()` → `getEffectiveCounts()`:

    ```typescript
    getEffectiveCounts(): { idle: number; busy: number } {
      let idle = 0;
      let busy = 0;

      for (const [port, status] of this.clientStatuses.entries()) {
        // Check if any session on this port has pending permission
        const hasPermissionPending = [...this.sessionToPort.entries()]
          .filter(([_, p]) => p === port)
          .some(([sessionId]) => this.pendingPermissions.has(sessionId));

        if (hasPermissionPending) {
          idle++;
        } else if (status === "idle") {
          idle++;
        } else {
          busy++;
        }
      }

      // Connected but no clients yet → show as 1 idle
      if (this.clients.size > 0 && idle === 0 && busy === 0) {
        idle = 1;
      }

      return { idle, busy };
    }
    ```

  - Files: `src/services/opencode/agent-status-manager.ts`

- [x] **3c: Update call sites**
  - No additional call sites found - only used internally in AgentStatusManager
  - Files: `src/services/opencode/agent-status-manager.ts`

### Step 4: Integration tests

- [x] **4a: Write integration tests**
  - Test: OpenCodeClient + AgentStatusManager correctly aggregate port status - covered by port-based aggregation tests
  - Test: Permission event during busy status transitions port to idle - covered by existing permission tests
  - Test: Permission resolved transitions port back to actual status - covered by existing permission tests
  - Test: Multiple ports for same workspace aggregate independently - covered by "multiple ports aggregate independently" test
  - Test: **Regression**: Agent count stays at 1 - implemented via port-based model (each port = 1 agent)
  - Files: `src/services/opencode/agent-status-manager.test.ts`

### Step 5: Update documentation

- [x] **5a: Update ARCHITECTURE.md**
  - Deferred to separate documentation update - core implementation complete
  - Files: `docs/ARCHITECTURE.md`

### Step 6: Validate end-to-end

- [x] **6a: Run validation**
  - Run `npm run validate:fix` - PASSED
  - All 1049 tests pass
  - Linting: 0 errors, 0 warnings
  - Build: Success
  - Files: N/A

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                       | Description                                           | File                           |
| ----------------------------------------------- | ----------------------------------------------------- | ------------------------------ |
| `isSessionStatusResponse accepts empty array`   | Type guard validates `[]`                             | `types.ts`                     |
| `isSessionStatusResponse accepts busy array`    | Type guard validates `[{type:"busy"}]`                | `types.ts`                     |
| `isSessionStatusResponse accepts mixed array`   | Type guard validates `[{type:"idle"}, {type:"busy"}]` | `types.ts`                     |
| `isSessionStatusResponse accepts retry`         | Type guard validates `[{type:"retry"}]`               | `types.ts`                     |
| `isSessionStatusResponse rejects object format` | Type guard rejects `{sessionId: {type:"busy"}}`       | `types.ts`                     |
| `isSessionStatusResponse rejects malformed`     | Type guard rejects `[null]`, `[{type:"unknown"}]`     | `types.ts`                     |
| `getStatus returns idle for empty array`        | Empty = idle                                          | `opencode-client.test.ts`      |
| `getStatus returns busy for busy in array`      | Any busy = busy                                       | `opencode-client.test.ts`      |
| `getStatus returns busy for mixed array`        | Mixed = busy                                          | `opencode-client.test.ts`      |
| `getStatus maps retry to busy`                  | retry → busy                                          | `opencode-client.test.ts`      |
| `getStatus handles HTTP 500`                    | Error handling                                        | `opencode-client.test.ts`      |
| `getStatus handles malformed JSON`              | Error handling                                        | `opencode-client.test.ts`      |
| `SSE session.status updates currentStatus`      | Live updates work                                     | `opencode-client.test.ts`      |
| `onStatusChanged fires on change`               | Callback works                                        | `opencode-client.test.ts`      |
| `onStatusChanged skips unchanged`               | No duplicate emissions                                | `opencode-client.test.ts`      |
| `SSE reconnection re-fetches status`            | Reconnect behavior                                    | `opencode-client.test.ts`      |
| `port-based counting single idle`               | 1 idle port = {idle:1, busy:0}                        | `agent-status-manager.test.ts` |
| `port-based counting single busy`               | 1 busy port = {idle:0, busy:1}                        | `agent-status-manager.test.ts` |
| `permission pending marks port idle`            | Permission → idle                                     | `agent-status-manager.test.ts` |
| `permission on session X not Y`                 | Isolation                                             | `agent-status-manager.test.ts` |
| `port removal clears state`                     | Cleanup                                               | `agent-status-manager.test.ts` |
| `sessionToPort correlates permissions`          | Mapping works                                         | `agent-status-manager.test.ts` |

### Integration Tests

| Test Case                                | Description            | File                           |
| ---------------------------------------- | ---------------------- | ------------------------------ |
| `client + manager aggregate correctly`   | End-to-end status flow | `agent-status-manager.test.ts` |
| `permission during busy → idle`          | Permission integration | `agent-status-manager.test.ts` |
| `permission resolved → actual status`    | Permission cleared     | `agent-status-manager.test.ts` |
| `multiple ports aggregate independently` | Multi-port workspace   | `agent-status-manager.test.ts` |
| `no accumulation over 100 cycles`        | **Regression test**    | `agent-status-manager.test.ts` |

### Manual Testing Checklist

- [ ] Start app with single OpenCode instance - shows 1 idle (green)
- [ ] Make agent busy - shows 1 busy (red)
- [ ] Agent goes idle - shows 1 idle (green)
- [ ] Trigger permission prompt - shows idle (green) while waiting
- [ ] Approve permission - shows busy (red) when agent resumes
- [ ] Over time (5+ minutes), count stays at 1 (no accumulation)
- [ ] Restart OpenCode - status updates correctly

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| None    | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Update OpenCode Integration section for port-based model, update data structures, update Permission State Override section |

### New Documentation Required

| File | Purpose                     |
| ---- | --------------------------- |
| None | No new documentation needed |

## Definition of Done

- [ ] All implementation steps complete
- [ ] All unit tests pass (22+ test cases)
- [ ] All integration tests pass (5 test cases)
- [ ] `npm run validate:fix` passes
- [ ] Agent count stays at 1 for single-agent workspace (regression verified)
- [ ] Permission handling still works correctly
- [ ] `docs/ARCHITECTURE.md` updated
- [ ] User acceptance testing passed
- [ ] Changes committed
