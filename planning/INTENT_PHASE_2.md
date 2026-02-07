---
status: APPROVED
last_updated: 2026-02-07
reviewers: []
---

# INTENT_PHASE_2

## Overview

- **Problem**: Phase 1 validated the intent-operation infrastructure with metadata operations. Now 5 operations remain in CoreModule/UiModule that should use the intent-based pattern: workspace status query, agent session query, agent restart, UI mode changes, and active workspace query. UiModule cannot be deleted until its operations are migrated or relocated.

- **Solution**: Migrate 5 operations to intent-operation infrastructure following the Phase 1 pattern. Consolidate to a single shared dispatcher (replacing the per-domain `wireMetadataDispatcher()`). Relocate `selectFolder` and `switchWorkspace` from UiModule to CoreModule. Delete UiModule entirely.

- **Deferred**: `workspace:switch` is NOT migrated to an intent in this phase. The `workspace:switched` event is currently emitted by a `ViewManager.onWorkspaceChange` callback in `index.ts` that fires for ALL workspace changes (create, delete, startup, etc.). Migrating just `workspace:switch` as an intent would create dual event emission. `switchWorkspace` is temporarily relocated to CoreModule as a plain method. It becomes an intent in a future phase, after all workspace-changing operations (create, delete) are migrated and the `index.ts` callback can be removed.

- **Interfaces**:

  No IPC contract changes. All IPC channels remain identical. ApiRegistry bridge handlers translate existing IPC calls to `dispatcher.dispatch()` — renderer sees no difference.

  **New intent types** (each in its own operation file under `src/main/operations/`):

  | Intent Interface           | `type` literal              | Payload                                       | Result (phantom R)     |
  | -------------------------- | --------------------------- | --------------------------------------------- | ---------------------- |
  | `GetWorkspaceStatusIntent` | `"workspace:get-status"`    | `{ projectId, workspaceName }`                | `WorkspaceStatus`      |
  | `GetAgentSessionIntent`    | `"agent:get-session"`       | `{ projectId, workspaceName }`                | `AgentSession \| null` |
  | `RestartAgentIntent`       | `"agent:restart"`           | `{ projectId, workspaceName }`                | `number`               |
  | `SetModeIntent`            | `"ui:set-mode"`             | `{ mode: UIMode }` (from `src/shared/ipc.ts`) | `void`                 |
  | `GetActiveWorkspaceIntent` | `"ui:get-active-workspace"` | `{}`                                          | `WorkspaceRef \| null` |

  All intents extend `Intent<R>` from `src/main/intents/infrastructure/types.ts`.

  **New domain event types**:

  | Event Interface       | `type` literal      | Payload                                    |
  | --------------------- | ------------------- | ------------------------------------------ |
  | `AgentRestartedEvent` | `"agent:restarted"` | `{ projectId, workspaceName, path, port }` |
  | `ModeChangedEvent`    | `"ui:mode-changed"` | `{ mode: UIMode, previousMode: UIMode }`   |

  All events extend `DomainEvent` from `src/main/intents/infrastructure/types.ts`.

  **New extended HookContext types** (for queries and operations that return data):

  Each operation that returns a result uses an extended `HookContext` to communicate between the hook handler and the operation. The operation validates `ctx.field !== undefined` before returning — `undefined` means the hook didn't populate the result (error), while `null` is a valid result value (e.g., no session exists).

  | HookContext Interface           | Extra Field                           | Used By                     |
  | ------------------------------- | ------------------------------------- | --------------------------- |
  | `GetWorkspaceStatusHookContext` | `status?: WorkspaceStatus`            | GetWorkspaceStatusOperation |
  | `GetAgentSessionHookContext`    | `session?: AgentSession \| null`      | GetAgentSessionOperation    |
  | `GetActiveWorkspaceHookContext` | `workspaceRef?: WorkspaceRef \| null` | GetActiveWorkspaceOperation |
  | `RestartAgentHookContext`       | `port?: number`                       | RestartAgentOperation       |
  | `SetModeHookContext`            | `previousMode?: UIMode`               | SetModeOperation            |

  **Changed interfaces**:

  | Interface        | Change                                                                                                                                                                 |
  | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `BootstrapDeps`  | `uiDepsFn` stays until Step 7 when UiModule is deleted. Add `viewManagerFn` for hook handler wiring (Steps 1-6). In Step 7, remove `uiDepsFn` and add `dialogFn`.      |
  | `CoreModuleDeps` | Add `dialog: MinimalDialog` for relocated `selectFolder` (Step 7). `switchWorkspace` uses existing `viewManager` + `appState` deps.                                    |
  | `IpcEventBridge` | Add event subscriptions for `agent:restarted`, `ui:mode-changed`. Each handler follows the double-cast pattern: `(event as SpecificEvent).payload as SpecificPayload`. |

  **Deleted interfaces**:

  | Interface        | Reason                            |
  | ---------------- | --------------------------------- |
  | `UiModuleDeps`   | UiModule deleted                  |
  | `UiModule` class | All methods migrated or relocated |

- **Risks**:
  1. **Shared dispatcher timing** — Dispatcher created in `startServices()` needs access to services (AppState, ViewManager, AgentServerManager) that are also initialized there. Mitigation: Wire hooks after all services are available, same pattern as current `wireMetadataDispatcher()`.
  2. **Event bridge expansion** — More domain event types forwarded through IpcEventBridge. Mitigation: Type constants ensure string matching; tests verify event flow.
  3. **Method relocation** — Moving `selectFolder` and `switchWorkspace` from UiModule to CoreModule. Mitigation: ApiRegistry has no order dependency; IPC channels stay the same; `switchWorkspace` uses same `resolveWorkspace()` + `viewManager.setActiveWorkspace()` pattern.

- **Alternatives Considered**:
  - _Two separate dispatchers (metadata + phase2)_: Rejected — unnecessary complexity, a single dispatcher is simpler and prepares for Phase 3.
  - _Direct service calls in operations (no hooks for simple ops)_: Rejected — consistency is more valuable than saving a few lines; hooks enable future extensibility.
  - _Separate ui:enter-shortcut-mode and ui:change-view-mode intents_: Rejected — the underlying implementation is a single `setMode()` call; one `ui:set-mode` intent is a cleaner mapping.
  - _Migrate workspace:switch as intent in Phase 2_: Rejected — the `workspace:switched` event is emitted by a `ViewManager.onWorkspaceChange` callback in `index.ts` that fires for all workspace changes (create, delete, startup). Migrating just the explicit switch as an intent would create dual event emission. Deferred until all workspace-changing operations are migrated.

## Architecture

```
BEFORE (Phase 1):
  IPC ─→ ApiRegistry ─→ CoreModule.method()    ─→ AppState ─→ services
                    ├─→ UiModule.method()       ─→ ViewManager
                    └─→ wireMetadataDispatcher() ─→ [private dispatcher] ─→ metadata ops

AFTER (Phase 2):
  IPC ─→ ApiRegistry ─→ [bridge handlers]       ─→ [shared dispatcher] ─→ all operations
                    ├─→ CoreModule (expanded)    ─→ AppState (create/delete/project ops)
                    │                            ─→ ViewManager (switchWorkspace, selectFolder)
                    └─→ (UiModule DELETED)

Shared Dispatcher Pipeline:
  ┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
  │ Intent      │────→│ Interceptors │────→│ Operation     │────→│ Hook Points  │
  │ (typed DU)  │     │ (future)     │     │ (orchestrator)│     │ (handlers)   │
  └─────────────┘     └──────────────┘     └───────┬───────┘     └──────────────┘
                                                   │
                                            ┌──────┴──────┐
                                            │ Domain Event│
                                            │ → IPC Bridge│
                                            └─────────────┘
```

### Operation Descriptions

#### `workspace:get-status` — GetWorkspaceStatusOperation

Query returning combined dirty + agent status for a workspace.

```
Intent: workspace:get-status { projectId, workspaceName }
  │
  ├── Hook: "get"
  │     └── Handler (bootstrap): resolveWorkspace() → provider.isDirty() + agentStatusManager.getStatus()
  │                               → populates ctx.status
  │
  └── No events (query)

Operation validates: if (ctx.status === undefined) throw Error
```

**Hook implementors:**

- Bootstrap hook handler: Resolves workspace, casts `workspace.path as WorkspacePath`, gets `GitWorktreeProvider` from appState, calls `isDirty()`. Gets `AgentStatusManager` from appState, calls `getStatus()`. If no AgentStatusManager, returns `{ type: "none" }`. Combines into `WorkspaceStatus` and sets on `GetWorkspaceStatusHookContext.status`.

**Event subscribers:** None (read-only query).

---

#### `agent:get-session` — GetAgentSessionOperation

Query returning agent session info for TUI attachment.

```
Intent: agent:get-session { projectId, workspaceName }
  │
  ├── Hook: "get"
  │     └── Handler (bootstrap): resolveWorkspace() → agentStatusManager.getSession()
  │                               → populates ctx.session (null if no session)
  │
  └── No events (query)

Operation validates: if (ctx.session === undefined) throw Error
                     (null is a valid result — means no session exists)
```

**Hook implementors:**

- Bootstrap hook handler: Resolves workspace, casts `workspace.path as WorkspacePath`, gets `AgentStatusManager` from appState, calls `getSession(workspacePath)`. Sets `ctx.session = result ?? null` on `GetAgentSessionHookContext.session`.

**Event subscribers:** None (read-only query).

---

#### `agent:restart` — RestartAgentOperation

Restarts the agent server for a workspace.

```
Intent: agent:restart { projectId, workspaceName }
  │
  ├── Hook: "restart"
  │     └── Handler (bootstrap): resolveWorkspace() → serverManager.restartServer(path)
  │                               → populates ctx.port; throws on failure with result.error
  │
  └── Event: agent:restarted { projectId, workspaceName, path, port }
        └── Subscriber (IpcEventBridge): → apiRegistry.emit("agent:restarted", payload)

Operation validates: if (ctx.port === undefined) throw Error
```

**Hook implementors:**

- Bootstrap hook handler: Resolves workspace, casts `workspace.path as WorkspacePath`, gets `AgentServerManager` from appState. Calls `restartServer(workspacePath)`. On success (`result.success === true`), sets `ctx.port = result.port`. On failure, throws `new Error(result.error)` — preserving the exact error message pattern from the current CoreModule implementation.

**Event subscribers:**

- `IpcEventBridge`: Forwards to `apiRegistry.emit("agent:restarted", ...)`.

---

#### `ui:set-mode` — SetModeOperation

Changes the UI mode (workspace, shortcut, dialog, hover).

```
Intent: ui:set-mode { mode: UIMode }
  │
  ├── Hook: "set"
  │     └── Handler (bootstrap): capture previousMode via viewManager.getMode()
  │                               → viewManager.setMode(mode) → set ctx.previousMode
  │
  └── Event: ui:mode-changed { mode, previousMode }
        └── Subscriber (IpcEventBridge): → apiRegistry.emit("ui:mode-changed", payload)

Operation validates: if (ctx.previousMode === undefined) throw Error
```

**Hook implementors:**

- Bootstrap hook handler: Captures `previousMode = viewManager.getMode()` before calling `viewManager.setMode(intent.payload.mode)`. Sets `ctx.previousMode = previousMode` on `SetModeHookContext`. This keeps the previousMode capture in the hook (where the work happens), not the operation.

**Event subscribers:**

- `IpcEventBridge`: Forwards to `apiRegistry.emit("ui:mode-changed", ...)`.

**Note:** The UiModule currently subscribes to `ViewManager.onModeChange` to emit API events. This subscription is replaced by the domain event path. The hook handler captures previousMode before calling setMode(), then the operation emits the domain event with both mode and previousMode.

---

#### `ui:get-active-workspace` — GetActiveWorkspaceOperation

Query returning the currently active workspace reference.

```
Intent: ui:get-active-workspace {}
  │
  ├── Hook: "get"
  │     └── Handler (bootstrap): viewManager.getActiveWorkspacePath()
  │                               → appState.findProjectForWorkspace()
  │                               → build WorkspaceRef → populates ctx.workspaceRef
  │
  └── No events (query)

Operation validates: if (ctx.workspaceRef === undefined) throw Error
                     (null is a valid result — means no active workspace)
```

**Hook implementors:**

- Bootstrap hook handler: Gets active workspace path from `viewManager.getActiveWorkspacePath()`. If null, sets `ctx.workspaceRef = null`. Otherwise, finds project via `appState.findProjectForWorkspace()`. If project not found, sets `ctx.workspaceRef = null` (matching existing UiModule behavior). Otherwise, builds `WorkspaceRef` with `generateProjectId()` and `extractWorkspaceName()`. Sets on `GetActiveWorkspaceHookContext.workspaceRef`.

**Event subscribers:** None (read-only query).

### File Layout (new files)

```
src/main/operations/
  get-workspace-status.ts
  get-workspace-status.integration.test.ts
  get-agent-session.ts
  get-agent-session.integration.test.ts
  restart-agent.ts
  restart-agent.integration.test.ts
  set-mode.ts
  set-mode.integration.test.ts
  get-active-workspace.ts
  get-active-workspace.integration.test.ts
```

## Testing Strategy

### Test Setup Pattern

Each operation test file creates a full dispatch pipeline: `HookRegistry` + `Dispatcher` + operation registration + hook handler registration. This follows the exact pattern from `set-metadata.integration.test.ts`.

**Entry point:** Tests dispatch intents directly via `dispatcher.dispatch()` (not through ApiRegistry bridge handlers). The bridge handler is a trivial adapter tested separately.

**Event verification:** Operation tests verify events via `dispatcher.subscribe()`. IpcEventBridge forwarding is tested separately in test #13.

### Behavioral Mocks Required

Tests use lightweight inline mocks (not full state-mock pattern) since these are service-level tests, not API-level tests. Each mock tracks state changes for behavioral assertions.

| Mock                    | State Tracked                                                | Behavioral Methods                                                                                                       |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **WorkspaceAccessor**   | Map of projectId → project with workspaces                   | `resolveWorkspace()` returns workspace by ID+name                                                                        |
| **ViewManager**         | `activeWorkspacePath: string \| null`, `currentMode: UIMode` | `setMode()` updates currentMode; `getMode()` returns currentMode; `getActiveWorkspacePath()` returns activeWorkspacePath |
| **AgentStatusManager**  | Map of workspacePath → `{ status, session }`                 | `getStatus()` returns status; `getSession()` returns session                                                             |
| **AgentServerManager**  | `restartResult: RestartServerResult`                         | `restartServer()` returns configured result                                                                              |
| **GitWorktreeProvider** | Map of workspacePath → `{ isDirty }`                         | `isDirty()` returns configured value                                                                                     |

### Integration Tests

| #   | Test Case                                                 | Entry Point                            | Mocks                                                           | Behavior Verified                                                                                                 |
| --- | --------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | get-workspace-status returns dirty + agent status         | `dispatcher.dispatch(statusIntent)`    | GitWorktreeProvider, AgentStatusManager                         | Returns `{ isDirty: true, agent: { type: "busy", counts: ... } }`                                                 |
| 2   | get-workspace-status returns none agent when no manager   | `dispatcher.dispatch(statusIntent)`    | GitWorktreeProvider (no AgentStatusManager)                     | Returns `{ isDirty, agent: { type: "none" } }`                                                                    |
| 3   | get-agent-session returns session info                    | `dispatcher.dispatch(sessionIntent)`   | AgentStatusManager                                              | Returns `{ port: 8080, sessionId: "ses-001" }`                                                                    |
| 4   | get-agent-session returns null when no session            | `dispatcher.dispatch(sessionIntent)`   | AgentStatusManager (no session)                                 | Returns `null`                                                                                                    |
| 5   | restart-agent returns new port on success                 | `dispatcher.dispatch(restartIntent)`   | AgentServerManager (success)                                    | Returns port number                                                                                               |
| 6   | restart-agent throws on failure with error message        | `dispatcher.dispatch(restartIntent)`   | AgentServerManager (failure)                                    | Throws Error with `result.error` message                                                                          |
| 7   | restart-agent emits agent:restarted event on success      | `dispatcher.dispatch(restartIntent)`   | AgentServerManager (success)                                    | Event received via `dispatcher.subscribe()` with port and workspace path                                          |
| 8   | set-mode changes mode and captures previousMode           | `dispatcher.dispatch(setModeIntent)`   | ViewManager (initial mode: "workspace")                         | `viewManager.currentMode` changed; event contains correct previousMode                                            |
| 9   | set-mode emits ui:mode-changed with mode and previousMode | `dispatcher.dispatch(setModeIntent)`   | ViewManager                                                     | Event received via `dispatcher.subscribe()` with `{ mode, previousMode }`                                         |
| 10  | get-active-workspace returns ref when active              | `dispatcher.dispatch(getActiveIntent)` | ViewManager (has active path), WorkspaceAccessor                | Returns WorkspaceRef with projectId, workspaceName, path                                                          |
| 11  | get-active-workspace returns null when none active        | `dispatcher.dispatch(getActiveIntent)` | ViewManager (no active path)                                    | Returns `null`                                                                                                    |
| 12  | get-active-workspace returns null when project not found  | `dispatcher.dispatch(getActiveIntent)` | ViewManager (has path), WorkspaceAccessor (no matching project) | Returns `null`                                                                                                    |
| 13  | IPC event bridge forwards all new event types             | `dispatcher.emit()` via operation      | ApiRegistry (mock)                                              | `apiRegistry.emit()` called with correct event name and payload for each of: `agent:restarted`, `ui:mode-changed` |
| 14  | interceptor cancellation prevents operation execution     | `dispatcher.dispatch(any)`             | —                                                               | Hook context field remains undefined, no event emitted, returns undefined                                         |

### Manual Testing Checklist

- [ ] Check workspace status badge updates
- [ ] Press Alt+X — verify shortcut mode activates
- [ ] Restart agent from MCP — verify agent restarts with new port
- [ ] Verify IPC events still reach renderer (no UI regressions)
- [ ] Switch between workspaces — verify view changes (relocated method, same behavior)

## Implementation Steps

### Implementation Rules

- All hook handlers that call `resolveWorkspace()` must cast `workspace.path as WorkspacePath` when passing to services that expect the branded string type.
- All query/result operations must validate `ctx.field !== undefined` before returning. `undefined` means the hook didn't provide a result (error). `null` is a valid result value.
- All IpcEventBridge event handlers must follow the double-cast pattern: `(event as SpecificEvent).payload as SpecificPayload`.

---

- [x] **Step 1: Consolidate to shared dispatcher**
  - Refactor `wireMetadataDispatcher()` in bootstrap.ts into a `wireDispatcher()` function
  - Create a single `HookRegistry` + `Dispatcher` at the start of `wireDispatcher()`
  - Move metadata operation/hook registration into `wireDispatcher()`
  - `wireDispatcher()` is called at the end of `startServices()`, after all modules are created and all service dependencies are available
  - Add `viewManagerFn: () => IViewManager` to `BootstrapDeps` for hook handlers that need ViewManager
  - Keep all existing behavior identical — this is a pure refactor
  - Files: `src/main/bootstrap.ts`
  - Test criteria: Existing metadata operation tests still pass (`pnpm test:related -- operations/`)

  > **STOP — Checkpoint 1:** Run tests, then pause and present the shared dispatcher wiring in bootstrap.ts for user review. Do NOT proceed to Step 2 until the user approves.

- [x] **Step 2: Create workspace:get-status query**
  - Create `src/main/operations/get-workspace-status.ts` with:
    - `GetWorkspaceStatusPayload` (projectId, workspaceName)
    - `GetWorkspaceStatusIntent extends Intent<WorkspaceStatus>` with type `"workspace:get-status"`
    - `GetWorkspaceStatusHookContext extends HookContext` with `status?: WorkspaceStatus`
    - `GetWorkspaceStatusOperation` with "get" hook point
    - Operation validates: `if (hookCtx.status === undefined) throw new Error("Get workspace status hook did not provide status result")`
  - Register operation in `wireDispatcher()`
  - Register hook handler: `resolveWorkspace()` → cast `workspace.path as WorkspacePath` → `provider.isDirty()` + `agentStatusManager.getStatus()` → combine into `WorkspaceStatus` → set `ctx.status`
  - Register bridge handler for `workspaces.getStatus`
  - Remove `workspaceGetStatus` from CoreModule
  - Create `get-workspace-status.integration.test.ts`
  - Files: `src/main/operations/get-workspace-status.ts`, `src/main/operations/get-workspace-status.integration.test.ts`, `src/main/bootstrap.ts`, `src/main/modules/core/index.ts`
  - Test criteria: `get-workspace-status.integration.test.ts` passes

  > **STOP — Checkpoint 2:** Run tests, then pause and present the query operation pattern and hook handler for user review. Do NOT proceed to Step 3 until the user approves.

- [ ] **Step 3: Create agent:get-session query**
  - Create `src/main/operations/get-agent-session.ts` with:
    - `GetAgentSessionPayload` (projectId, workspaceName)
    - `GetAgentSessionIntent extends Intent<AgentSession | null>` with type `"agent:get-session"`
    - `GetAgentSessionHookContext extends HookContext` with `session?: AgentSession | null`
    - `GetAgentSessionOperation` with "get" hook point
    - Operation validates: `if (hookCtx.session === undefined) throw new Error("Get agent session hook did not provide session result")` — `null` is valid (no session)
  - Register operation in `wireDispatcher()`
  - Register hook handler: `resolveWorkspace()` → cast `workspace.path as WorkspacePath` → `agentStatusManager.getSession(workspacePath)` → set `ctx.session = result ?? null`
  - Register bridge handler for `workspaces.getAgentSession`
  - Remove `workspaceGetAgentSession` from CoreModule
  - Create `get-agent-session.integration.test.ts`
  - Files: `src/main/operations/get-agent-session.ts`, `src/main/operations/get-agent-session.integration.test.ts`, `src/main/bootstrap.ts`, `src/main/modules/core/index.ts`
  - Test criteria: `get-agent-session.integration.test.ts` passes

  > **STOP — Checkpoint 3:** Run tests, then pause and present the second query operation for user review. Should mirror get-workspace-status pattern. Do NOT proceed to Step 4 until the user approves.

- [ ] **Step 4: Create agent:restart operation**
  - Create `src/main/operations/restart-agent.ts` with:
    - `RestartAgentPayload` (projectId, workspaceName)
    - `RestartAgentIntent extends Intent<number>` with type `"agent:restart"`
    - `RestartAgentHookContext extends HookContext` with `port?: number`
    - `AgentRestartedPayload` (projectId, workspaceName, path, port)
    - `AgentRestartedEvent extends DomainEvent` with type `"agent:restarted"`
    - `RestartAgentOperation` with "restart" hook point; validates `ctx.port !== undefined`; emits `AgentRestartedEvent` on success
  - Register operation in `wireDispatcher()`
  - Register hook handler: `resolveWorkspace()` → cast `workspace.path as WorkspacePath` → `serverManager.restartServer(path)` → on `result.success`: set `ctx.port = result.port`; on failure: `throw new Error(result.error)` (preserving exact error message from current CoreModule)
  - Register bridge handler for `workspaces.restartAgentServer`
  - Expand `IpcEventBridge` with `agent:restarted` event forwarding using double-cast pattern
  - Remove `workspaceRestartAgentServer` from CoreModule
  - Create `restart-agent.integration.test.ts`
  - Files: `src/main/operations/restart-agent.ts`, `src/main/operations/restart-agent.integration.test.ts`, `src/main/bootstrap.ts`, `src/main/modules/ipc-event-bridge.ts`, `src/main/modules/core/index.ts`
  - Test criteria: `restart-agent.integration.test.ts` passes

  > **STOP — Checkpoint 4:** Run tests, then pause and present the command operation with event emission and error handling for user review. Do NOT proceed to Step 5 until the user approves.

- [ ] **Step 5: Create ui:set-mode operation**
  - Create `src/main/operations/set-mode.ts` with:
    - `SetModePayload` (mode: UIMode — imported from `src/shared/ipc.ts`)
    - `SetModeIntent extends Intent<void>` with type `"ui:set-mode"`
    - `SetModeHookContext extends HookContext` with `previousMode?: UIMode`
    - `ModeChangedPayload` (mode: UIMode, previousMode: UIMode)
    - `ModeChangedEvent extends DomainEvent` with type `"ui:mode-changed"`
    - `SetModeOperation` with "set" hook point; validates `ctx.previousMode !== undefined`; emits `ModeChangedEvent` with `{ mode: intent.payload.mode, previousMode: ctx.previousMode }`
  - The hook handler captures previousMode (not the operation): `const previousMode = viewManager.getMode()` → `viewManager.setMode(mode)` → `ctx.previousMode = previousMode`
  - Register operation in `wireDispatcher()`
  - Register bridge handler for `ui.setMode`
  - Expand `IpcEventBridge` with `ui:mode-changed` event forwarding using double-cast pattern
  - Remove `setMode` from UiModule
  - Remove the `ViewManager.onModeChange` subscription from UiModule constructor
  - Create `set-mode.integration.test.ts`
  - Files: `src/main/operations/set-mode.ts`, `src/main/operations/set-mode.integration.test.ts`, `src/main/bootstrap.ts`, `src/main/modules/ipc-event-bridge.ts`, `src/main/modules/ui/index.ts`
  - Test criteria: `set-mode.integration.test.ts` passes

  > **STOP — Checkpoint 5:** Run tests, then pause and present the mode operation for user review — especially the previousMode capture in the hook handler and the removal of the ViewManager.onModeChange subscription. Do NOT proceed to Step 6 until the user approves.

- [ ] **Step 6: Create ui:get-active-workspace query**
  - Create `src/main/operations/get-active-workspace.ts` with:
    - `GetActiveWorkspaceIntent extends Intent<WorkspaceRef | null>` with type `"ui:get-active-workspace"`
    - `GetActiveWorkspaceHookContext extends HookContext` with `workspaceRef?: WorkspaceRef | null`
    - `GetActiveWorkspaceOperation` with "get" hook point
    - Operation validates: `if (hookCtx.workspaceRef === undefined) throw new Error(...)` — `null` is valid (no active workspace)
  - Register operation in `wireDispatcher()`
  - Register hook handler: `viewManager.getActiveWorkspacePath()` → if null, set `ctx.workspaceRef = null`; otherwise `appState.findProjectForWorkspace()` → if project not found, set `ctx.workspaceRef = null` (matching existing UiModule behavior) → otherwise `generateProjectId()` + `extractWorkspaceName()` → build `WorkspaceRef`
  - Register bridge handler for `ui.getActiveWorkspace`
  - Remove `getActiveWorkspace` from UiModule
  - Create `get-active-workspace.integration.test.ts`
  - Files: `src/main/operations/get-active-workspace.ts`, `src/main/operations/get-active-workspace.integration.test.ts`, `src/main/bootstrap.ts`, `src/main/modules/ui/index.ts`
  - Test criteria: `get-active-workspace.integration.test.ts` passes

  > **STOP — Checkpoint 6:** Run tests, then pause and present the third query operation for user review. At this point UiModule should have only `selectFolder` and `switchWorkspace` remaining, which are relocated in Step 7. Do NOT proceed to Step 7 until the user approves.

- [ ] **Step 7: Relocate selectFolder and switchWorkspace to CoreModule, delete UiModule**
  - Move `selectFolder` method and its `MinimalDialog` type/dependency from UiModule to CoreModule
  - Move `switchWorkspace` method from UiModule to CoreModule (plain method, not intent — uses existing `resolveWorkspace()` + `viewManager.setActiveWorkspace()`)
  - Register `ui.selectFolder` in CoreModule with same IPC channel (`ApiIpcChannels.UI_SELECT_FOLDER`)
  - Register `ui.switchWorkspace` in CoreModule with same IPC channel (`ApiIpcChannels.UI_SWITCH_WORKSPACE`)
  - Update `CoreModuleDeps` to include `dialog: MinimalDialog`
  - `switchWorkspace` uses existing CoreModule deps (`appState`, `viewManager`) — no new deps needed for it
  - Delete UiModule entirely: `src/main/modules/ui/index.ts`, `src/main/modules/ui/index.test.ts`, `src/main/modules/ui/` directory
  - Remove UiModule creation from bootstrap.ts: remove `UiModuleDeps`, `uiDepsFn` from `BootstrapDeps`, remove `new UiModule(...)` call
  - Remove UiModule imports from bootstrap.ts
  - Update all callers that provided `uiDepsFn` — grep for `uiDepsFn` and `UiModuleDeps` across `src/main/index.ts`, `src/main/bootstrap.test.ts`, `src/main/bootstrap.integration.test.ts`, and any other test files
  - Files: `src/main/modules/ui/` (delete), `src/main/modules/core/index.ts`, `src/main/bootstrap.ts`, `src/main/index.ts`
  - Test criteria: `pnpm validate:fix` passes, UiModule files deleted, selectFolder and switchWorkspace still work via IPC

  > **STOP — Checkpoint 7:** Run tests, then pause and present the final state for user review — UiModule deleted, all operations on shared dispatcher, CoreModule has selectFolder and switchWorkspace. Do NOT proceed to Step 8 until the user approves.

- [ ] **Step 8: Final validation**
  - Run `pnpm validate:fix` — all tests pass, lint clean, types check
  - Verify no remaining references to deleted UiModule
  - Verify all IPC channels still operational
  - Test criteria: Full validation passes

  > **STOP — Checkpoint 8:** Pause and present the full validation results for final user review before marking Phase 2 complete.

## Dependencies

None required.

## Documentation Updates

Documentation updates deferred to Phase 5 (cleanup phase) per user decision. No docs modified in this phase.

## Definition of Done

- [ ] All 5 operations migrated to intent-operation infrastructure
- [ ] Single shared dispatcher used for all operations (metadata + Phase 2)
- [ ] UiModule fully deleted
- [ ] selectFolder and switchWorkspace relocated to CoreModule
- [ ] IPC event bridge forwards all new domain event types
- [ ] Integration tests for each new operation (14 test cases)
- [ ] `pnpm validate:fix` passes
- [ ] No remaining imports/references to UiModule
- [ ] Existing functionality unchanged (IPC contracts, renderer behavior)
