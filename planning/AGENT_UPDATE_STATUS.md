---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-09
reviewers: []
---

# AGENT_UPDATE_STATUS

## Overview

- **Problem**: The agent status change wiring (IPC bridge + badge update) lives inline in `index.ts` (~40 lines at lines 577-611 and 506-519), adding to the monolith. These cross-cutting concerns should be event subscribers in the intent architecture.
- **Solution**: Introduce an `agent:update-status` intent with a trivial operation (no hooks) that emits an `agent:status-updated` domain event. Two event subscriber modules react: the IPC event bridge (forwards to renderer) and a badge module (updates app icon badge). The `AgentStatusManager.onStatusChanged()` callback dispatches the intent instead of wiring directly.
- **Interfaces**: No IPC channel changes. The existing `api:workspace:status-changed` channel and `WorkspaceStatus` type are preserved. No new boundary interfaces.
- **Risks**: Low. The `AgentStatusManager` already works correctly. We're only changing how its output is consumed. The status conversion logic moves from `index.ts` into the IPC event bridge subscriber.
- **Alternatives Considered**: Direct domain event emission (skip intent/operation layer). Rejected to maintain consistency with the intent architecture — everything enters through intents.

## Architecture

```
AgentStatusManager.onStatusChanged(workspacePath, aggregatedStatus)
    |
    v
dispatcher.dispatch({ type: INTENT_UPDATE_AGENT_STATUS, payload: { workspacePath, status } })
    |
    v
UpdateAgentStatusOperation.execute(ctx)
    | (no hooks -- trivial operation)
    |
    v
ctx.emit({ type: EVENT_AGENT_STATUS_UPDATED, payload: { workspacePath, status } })
    |
    |---> IpcEventBridge subscriber
    |       Converts AggregatedAgentStatus -> WorkspaceStatus
    |       Resolves projectId/workspaceName via workspace resolver
    |       Calls apiRegistry.emit("workspace:status-changed", ...)
    |
    |---> BadgeModule subscriber
    |       Maintains internal Map<WorkspacePath, AggregatedAgentStatus>
    |       Calls aggregateWorkspaceStates() + badgeManager.updateBadge()
    |
    v
workspace:deleted event (from delete-workspace operation)
    |
    |---> BadgeModule subscriber
            Evicts deleted workspace from internal map
            Re-aggregates and updates badge
```

**Key design decisions:**

1. The event payload carries `workspacePath: WorkspacePath` (branded type) + `AggregatedAgentStatus` (the raw status from `AgentStatusManager`). Conversion to `WorkspaceStatus` happens in the IPC bridge subscriber.
2. The `BadgeModule` maintains its own map of workspace statuses from received events and calls a standalone `aggregateWorkspaceStates()` pure function + `badgeManager.updateBadge()`. It also subscribes to `EVENT_WORKSPACE_DELETED` to evict deleted workspaces from its map.
3. `BadgeManager` loses its `connectToStatusManager()` and `disconnect()` methods — the module pattern replaces them. The `aggregateWorkspaceStates()` logic is extracted as a standalone pure function (not a public method on `BadgeManager`).
4. The intent dispatching happens in `index.ts` where `agentStatusManager.onStatusChanged()` is currently wired — we replace the inline callback with a dispatcher call. `badgeManager` is created in `index.ts` and passed to `startServices()` so bootstrap can create the badge module.
5. The IPC event bridge receives a narrow workspace resolver function `(workspacePath: string) => { projectId: ProjectId, workspaceName: WorkspaceName } | undefined` — not `AppState` directly. This avoids coupling the bridge to `AppState`.

## Testing Strategy

### Integration Tests

| #   | Test Case                                             | Entry Point                               | Boundary Mocks                                                             | Behavior Verified                                                                                             |
| --- | ----------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Status change produces domain event                   | `dispatcher.dispatch(updateStatusIntent)` | None (operation has no hooks)                                              | Domain event `agent:status-updated` is emitted with correct workspacePath and status payload                  |
| 2a  | Renderer receives workspace status (idle)             | Event emission via dispatcher             | Workspace resolver (returns project), registry (mock with recorded events) | Registry recorded event `workspace:status-changed` with `{ isDirty: false, agent: { type: "idle", counts } }` |
| 2b  | Renderer receives workspace status (busy)             | Event emission via dispatcher             | Same as 2a                                                                 | Registry recorded event with `agent: { type: "busy", counts }`                                                |
| 2c  | Renderer receives workspace status (mixed)            | Event emission via dispatcher             | Same as 2a                                                                 | Registry recorded event with `agent: { type: "mixed", counts }`                                               |
| 2d  | Renderer receives workspace status (none)             | Event emission via dispatcher             | Same as 2a                                                                 | Registry recorded event with `agent: { type: "none" }` (no counts field)                                      |
| 3   | Unknown workspace produces no IPC event               | Event emission for unknown workspace path | Workspace resolver (returns undefined), registry                           | No event recorded on registry                                                                                 |
| 4   | App icon shows busy indicator when agent becomes busy | Event emission via dispatcher             | `AppLayer`, `ImageLayer` (badge manager behavioral mocks)                  | `expect(appLayer.dock.setBadge).toBe("●")` (macOS) or equivalent platform check                               |
| 5   | Mixed workspaces show mixed badge                     | Multiple events for different workspaces  | `AppLayer`, `ImageLayer` (badge manager behavioral mocks)                  | Badge shows mixed indicator when some workspaces idle, some busy                                              |
| 6   | Deleting workspace clears stale badge entry           | Status event + workspace:deleted event    | `AppLayer`, `ImageLayer` (badge manager behavioral mocks)                  | After deleting the only busy workspace, badge clears to "none"                                                |

Tests #4-6 use a real `BadgeManager` wired with mocked `AppLayer`/`ImageLayer` (matching the existing `badge-manager.integration.test.ts` pattern). Tests #2a-2d use a registry mock with an in-memory recorded events list for behavioral verification.

### Manual Testing Checklist

- [ ] Open project, create workspace, verify badge appears when agent becomes busy
- [ ] Multiple workspaces with mixed agent states show correct badge (mixed indicator)
- [ ] Renderer sidebar shows correct agent status indicators (IPC events arrive)
- [ ] Deleting workspace clears badge appropriately

## Implementation Steps

- [x] **Step 1: Create UpdateAgentStatus operation**
  - Create `src/main/operations/update-agent-status.ts` with:
    - `UpdateAgentStatusPayload` with `workspacePath: WorkspacePath` (branded type from `src/shared/ipc.ts`) and `status: AggregatedAgentStatus`
    - `UpdateAgentStatusIntent` extending `Intent<void>`
    - `AgentStatusUpdatedEvent` extending `DomainEvent`
    - `UpdateAgentStatusOperation` — no hooks, just emits the event
    - Constants: `INTENT_UPDATE_AGENT_STATUS`, `EVENT_AGENT_STATUS_UPDATED`
  - Test: `src/main/operations/update-agent-status.integration.test.ts` (test #1)

- [x] **Step 2: Add agent:status-updated handler to IPC event bridge**
  - In `src/main/modules/ipc-event-bridge.ts`:
    - Import `EVENT_AGENT_STATUS_UPDATED` and event types
    - Extend `createIpcEventBridge` to accept a workspace resolver with narrow interface: `(workspacePath: string) => { projectId: ProjectId, workspaceName: WorkspaceName } | undefined`
    - Add `[EVENT_AGENT_STATUS_UPDATED]` handler that:
      - Calls the workspace resolver to get projectId/workspaceName (returns early if undefined)
      - Converts `AggregatedAgentStatus` → `WorkspaceStatus` (handling the `"none"` vs other discriminants)
      - Emits `workspace:status-changed` on the registry
  - Test: Create `src/main/modules/ipc-event-bridge.integration.test.ts` (tests #2a-2d, #3)

- [x] **Step 3: Create badge module and extract aggregation function**
  - Extract `aggregateWorkspaceStates` from `BadgeManager` into a standalone pure function (e.g., in `src/main/modules/badge-module.ts` or a shared util). Signature: `(statuses: Map<WorkspacePath, AggregatedAgentStatus>) => BadgeState`
  - Create `src/main/modules/badge-module.ts`:
    - Factory function `createBadgeModule(badgeManager: BadgeManager): IntentModule`
    - Module subscribes to `EVENT_AGENT_STATUS_UPDATED` — updates internal map, re-aggregates, calls `badgeManager.updateBadge()`
    - Module also subscribes to `EVENT_WORKSPACE_DELETED` — evicts deleted workspace from internal map, re-aggregates, calls `badgeManager.updateBadge()`
  - Refactor `BadgeManager`:
    - Remove `connectToStatusManager()`, `disconnect()`, and `aggregateWorkspaceStates()` methods
    - Remove `statusManagerUnsubscribe` field and `AgentStatusManager` import
    - Keep `updateBadge()`, `dispose()`, and image generation methods
  - Migrate existing `badge-manager.integration.test.ts` tests that exercise `connectToStatusManager` — these tests move to `badge-module.integration.test.ts` using the new module pattern
  - Test: `src/main/modules/badge-module.integration.test.ts` (tests #4, #5, #6)

- [x] **Step 4: Wire everything in bootstrap and index.ts**
  - In `src/main/bootstrap.ts`:
    - Register `UpdateAgentStatusOperation` with dispatcher
    - Accept `badgeManager` as a parameter in `startServices()` (created in `index.ts`, passed down)
    - Create badge module via `createBadgeModule(badgeManager)`
    - Create workspace resolver function from `appState.findProjectForWorkspace()` + `generateProjectId()` + `basename()` and pass to `createIpcEventBridge()`
    - Add badge module to `wireModules()` call
  - In `src/main/index.ts`:
    - Replace the `agentStatusCleanup` callback (lines 577-611) with:
      ```typescript
      agentStatusManager.onStatusChanged((workspacePath, status) =>
        dispatcher.dispatch({
          type: INTENT_UPDATE_AGENT_STATUS,
          payload: { workspacePath, status },
        })
      );
      ```
    - Remove `badgeManager.connectToStatusManager(agentStatusManager)` (line 519)
    - Pass `badgeManager` to bootstrap's `startServices()`
    - Remove `agentStatusCleanup` variable declaration and cleanup logic
  - Test: Existing tests pass, manual smoke test

- [x] **Step 5: Update documentation**
  - Update `CLAUDE.md` intent dispatcher section to include `agent:update-status` in the list of operations using the intent dispatcher
  - Update `docs/AGENTS.md` status flow diagram to reflect the new intent-based path: `AgentStatusManager` → dispatcher intent → domain event → IPC bridge + badge module (replaces the current direct callback diagram)

## Dependencies

None.

## Documentation Updates

### Files to Update

| File             | Changes Required                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`      | Add `agent:update-status` to the list of operations using the intent dispatcher in the "Intent Dispatcher" section    |
| `docs/AGENTS.md` | Update status flow architecture diagram to reflect intent-based path instead of direct `AgentStatusManager` callbacks |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed (badge + IPC status updates work)
