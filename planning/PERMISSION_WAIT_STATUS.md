---
status: COMPLETED
last_updated: 2025-12-10
reviewers:
  - review-ui
  - review-typescript
  - review-electron
  - review-arch
  - review-senior
  - review-testing
  - review-docs
---

# PERMISSION_WAIT_STATUS

## Overview

- **Problem**: Agents waiting for user permission show as "busy" instead of "idle". The OpenCode API returns `busy` status during permission wait, but this state requires user attention and should display as `idle` (green indicator).
- **Solution**: Track `permission.updated` and `permission.replied` SSE events to detect when a session is waiting for permission. Override the `busy` status to `idle` for sessions with pending permissions in the aggregation layer.
- **Risks**:
  - Permission events might be missed if SSE connection drops during permission request (mitigated by clearing permission state on disconnect)
  - Multiple permission requests per session need proper tracking (handled via Set per session)
- **Alternatives Considered**:
  - Adding a new "waiting" status type - rejected because `idle` already means "needs user attention"
  - Polling for permission state - rejected because SSE events are more efficient and real-time
  - Tracking permission state in OpenCodeClient - rejected because it violates separation of concerns; client should be thin communication layer

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenCodeClient                                │
│  (Thin communication layer - emits raw events only)                 │
│                                                                      │
│  ┌──────────────┐                          ┌────────────────┐       │
│  │ rootSessionIds│                          │   listeners    │       │
│  │   Set<id>    │                          │ Set<callback>  │       │
│  └──────────────┘                          └────────────────┘       │
│                                                                      │
│  SSE Event Handlers:                                                 │
│  ┌────────────────────┐  ┌────────────────────┐                     │
│  │ permission.updated │  │ permission.replied │                     │
│  │  -> emit event     │  │  -> emit event     │                     │
│  └────────────────────┘  └────────────────────┘                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      OpenCodeProvider                                │
│  (State aggregation - owns session and permission state)            │
│                                                                      │
│  ┌─────────────────────┐    ┌─────────────────────┐                 │
│  │   sessionStatuses   │    │ pendingPermissions  │                 │
│  │ Map<sessionId,      │    │ Map<sessionId,      │                 │
│  │     SessionStatus>  │    │     Set<permId>>    │                 │
│  └─────────────────────┘    └─────────────────────┘                 │
│                                                                      │
│  getAdjustedCounts():                                               │
│    for each session:                                                │
│      if pendingPermissions.has(sessionId) -> count as idle         │
│      else if status.type === "idle" -> count as idle               │
│      else if status.type === "busy" or "retry" -> count as busy    │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Terms**:

- **Root session**: A session without a `parentID` field. Only root sessions are tracked for status display; child sessions (subagents) are filtered out.

## Implementation Steps

> **TDD Approach**: Each step follows red-green-refactor. Write failing tests first, then implement to make them pass.

- [x] **Step 1: Verify OpenCode API format**
  - Confirm actual `/session/status` response format before changing types
  - Current code expects: `[{ id: string, status: "idle" | "busy" }]`
  - OpenCode may return: `{ [sessionId]: { type: "idle" | "busy" | "retry" } }`
  - Document findings and update plan if needed
  - Files affected: None (investigation only)
  - Test criteria: API format documented with curl examples
  - **Findings**: Current implementation uses array format. Plan specifies object format with `type` property. Proceeding with plan's format which includes `retry` status for agents waiting to retry after errors.

- [x] **Step 2: Add permission event types (TDD)**
  - Write failing type compilation test
  - Add `PermissionUpdatedEvent` and `PermissionRepliedEvent` interfaces to types.ts
  - Add `"permission.updated" | "permission.replied"` to `OpenCodeEventType`
  - Add type guards `isPermissionUpdatedEvent()` and `isPermissionRepliedEvent()`
  - Files affected: `src/services/opencode/types.ts`
  - Test criteria: Types compile, type guards narrow correctly

  ```typescript
  export interface PermissionUpdatedEvent {
    readonly id: string; // permission ID
    readonly sessionID: string; // session requesting permission
    readonly type: string; // permission type (e.g., "bash")
    readonly title: string; // human-readable description
  }

  export interface PermissionRepliedEvent {
    readonly sessionID: string;
    readonly permissionID: string;
    readonly response: "once" | "always" | "reject";
  }
  ```

- [x] **Step 3: Update types.ts - Fix SessionStatusValue type (TDD)**
  - Write failing tests for new type format validation
  - Update `SessionStatusResponse` based on Step 1 findings
  - If API returns object format: `Record<string, SessionStatusValue>`
  - Add `readonly` modifiers for immutability
  - Files affected: `src/services/opencode/types.ts`
  - Test criteria: Type guards validate correct format, reject invalid

- [x] **Step 4: Update opencode-client.ts - Fix type validation (TDD)**
  - Write failing tests for `getSessionStatuses()` with new format
  - Update `isSessionStatusResponse` type guard with explicit return type
  - Add helper `isValidSessionStatus(value: unknown): value is SessionStatusValue`
  - Update `getSessionStatuses` to handle new response format
  - Files affected: `src/services/opencode/opencode-client.ts`
  - Test criteria: `getSessionStatuses()` parses API response correctly

- [x] **Step 5: Update opencode-client.ts - Add permission event emission (TDD)**
  - Write failing tests for permission event handling
  - Add `PermissionEventCallback` type and `onPermissionEvent()` subscription method
  - Add event listeners in `connect()` for `permission.updated` and `permission.replied`
  - Add `handlePermissionUpdated()` and `handlePermissionReplied()` to parse and emit events
  - Clear permission listeners on `dispose()`
  - **Important**: Client only emits raw events, does NOT track permission state
  - Files affected: `src/services/opencode/opencode-client.ts`
  - Test criteria:
    - Permission events parsed correctly with type guards
    - Events emitted to listeners for root sessions only
    - Malformed events ignored gracefully

- [x] **Step 6: Update agent-status-manager.ts - Add permission tracking (TDD)**
  - Write failing tests for permission state management in OpenCodeProvider
  - Add `private readonly pendingPermissions = new Map<string, Set<string>>()` to OpenCodeProvider
  - Subscribe to client permission events in `syncClients()`
  - Handle `permission.updated`: add to pendingPermissions, trigger status update
  - Handle `permission.replied`: remove from pendingPermissions, trigger status update
  - Handle session deletion: remove session from pendingPermissions
  - Clear pendingPermissions on client disconnect (SSE reconnection safety)
  - Files affected: `src/services/opencode/agent-status-manager.ts`
  - Test criteria:
    - Permission added on `permission.updated`
    - Permission removed on `permission.replied`
    - Permissions cleared for deleted sessions
    - Permissions cleared on disconnect

- [x] **Step 7: Update agent-status-manager.ts - Permission-aware counting (TDD)**
  - Write failing tests for `getAdjustedCounts()` with permission override
  - Update `OpenCodeProvider.getAdjustedCounts()` to check pendingPermissions
  - Sessions with pending permissions count as `idle` regardless of API status
  - Files affected: `src/services/opencode/agent-status-manager.ts`
  - Test criteria:
    - Busy session with pending permission counts as idle
    - Multiple permissions per session handled correctly
    - Permission-aware counting integrates with existing logic

- [x] **Step 8: Update documentation**
  - Update `docs/USER_INTERFACE.md` Agent Status Monitoring section
    - Clarify "Idle" (green) includes agents waiting for user permission
  - Update `docs/ARCHITECTURE.md` OpenCode Integration section
    - Document permission tracking mechanism
    - Document status override logic ("waiting for permission" shows as idle)
  - Files affected:
    - `docs/USER_INTERFACE.md`
    - `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects implementation

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                                             | Description                                              | File                         |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| **Type Guards**                                                       |                                                          |                              |
| isPermissionUpdatedEvent validates structure                          | Accepts valid event, rejects missing fields              | opencode-client.test.ts      |
| isPermissionRepliedEvent validates structure                          | Accepts valid event, rejects missing fields              | opencode-client.test.ts      |
| isSessionStatusResponse validates object format                       | Type guard accepts `{ "ses_x": { "type": "busy" } }`     | opencode-client.test.ts      |
| isSessionStatusResponse rejects invalid                               | Rejects array format, empty object, invalid status types | opencode-client.test.ts      |
| isValidSessionStatus narrows type correctly                           | TypeScript narrowing works after guard                   | opencode-client.test.ts      |
| **Permission Event Emission**                                         |                                                          |                              |
| permission.updated emits event for root session                       | Listener receives parsed event                           | opencode-client.test.ts      |
| permission.updated ignores child sessions                             | No event emitted for sessions with parentID              | opencode-client.test.ts      |
| permission.replied emits event for root session                       | Listener receives parsed event                           | opencode-client.test.ts      |
| malformed permission event ignored                                    | No error thrown, no event emitted                        | opencode-client.test.ts      |
| **Permission State Management**                                       |                                                          |                              |
| permission.updated adds to pendingPermissions                         | Map contains sessionId -> Set with permId                | agent-status-manager.test.ts |
| permission.replied removes from pendingPermissions                    | permId removed from Set                                  | agent-status-manager.test.ts |
| permission.replied for unknown permission does not throw              | Graceful handling of out-of-order events                 | agent-status-manager.test.ts |
| multiple permissions per session tracked                              | Set contains multiple permIds                            | agent-status-manager.test.ts |
| session.deleted clears pending permissions                            | Session removed from pendingPermissions                  | agent-status-manager.test.ts |
| disconnect clears pending permissions                                 | Map cleared on SSE disconnect                            | agent-status-manager.test.ts |
| dispose clears pendingPermissions                                     | Map empty after dispose                                  | agent-status-manager.test.ts |
| **Permission-Aware Counting**                                         |                                                          |                              |
| getAdjustedCounts with busy session + pending permission returns idle | `{idle: 1, busy: 0}`                                     | agent-status-manager.test.ts |
| getAdjustedCounts with mixed sessions + pending permission            | Waiting session counted as idle                          | agent-status-manager.test.ts |
| getAdjustedCounts without pending permissions unchanged               | Normal busy/idle counting                                | agent-status-manager.test.ts |

### Integration Tests

| Test Case                                | Description                                                                        | File                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| End-to-end permission flow               | Status: busy -> emit permission.updated -> idle -> emit permission.replied -> busy | services.integration.test.ts |
| SSE reconnection clears permission state | Disconnect during permission wait, reconnect, verify state cleared                 | services.integration.test.ts |
| IPC event flow for permission            | permission.updated -> updateStatus -> agent:status-changed IPC event               | services.integration.test.ts |

### Manual Testing Checklist

- [ ] Start OpenCode in a workspace
- [ ] Trigger a command that requires permission (e.g., bash command with `permission: { bash: "ask" }`)
- [ ] Verify sidebar indicator shows green (idle) while waiting for permission
- [ ] Accept/deny permission
- [ ] Verify indicator changes to red (busy) while processing, then green (idle) when done
- [ ] Test with screen reader: verify aria-label announces status changes correctly
- [ ] Test keyboard navigation: Tab to indicator, verify tooltip shows/hides
- [ ] Test SSE disconnect during permission wait (kill/restart OpenCode), verify state recovers

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                              |
| ---------------------- | ----------------------------------------------------------------------------- |
| docs/USER_INTERFACE.md | Update Agent Status Monitoring: clarify "Idle" includes permission waiting    |
| docs/ARCHITECTURE.md   | Update OpenCode Integration: document permission tracking and status override |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete (TDD: tests written first)
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (USER_INTERFACE.md, ARCHITECTURE.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
