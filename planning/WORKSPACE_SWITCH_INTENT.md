---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-09
reviewers: []
---

# WORKSPACE_SWITCH_INTENT

## Overview

- **Problem**: `workspace:switch` is the last workspace operation still handled directly by `CoreModule` instead of the intent dispatcher. The `workspace:switched` event is emitted indirectly via a ViewManager callback wired in `index.ts`, and the window title update lives as a standalone subscriber in `wireApiEvents` (`api-handlers.ts`). Multiple other operations (`workspace:create`, `workspace:delete`, `project:open`, `project:close`) also call `viewManager.setActiveWorkspace()` directly from their hook modules, bypassing any unified switch logic.
- **Solution**: Migrate `workspace:switch` to the intent dispatcher. Other operations that change the active workspace dispatch `workspace:switch` intents from their operation code (operations are orchestrators). The `null` deactivation case (delete last workspace, close last project) is emitted directly by those operations as `workspace:switched(null)`. Hook modules stop calling `setActiveWorkspace` directly. The `onWorkspaceChange` callback in `index.ts` is removed entirely.
- **Interfaces**: No new IPC channels or API signatures. Reuses existing `api:ui:switch-workspace` (input) and `api:workspace:switched` (output). No new boundary interfaces.
- **Risks**: Multiple operations change simultaneously. Mitigated by: (a) each change is mechanical (replace `setActiveWorkspace` call with `ctx.dispatch`), (b) existing tests cover these flows, (c) grep verification of all `setActiveWorkspace` callers.
- **Alternatives Considered**: (a) Keep `onWorkspaceChange` callback for non-switch callers — rejected, inconsistent. (b) Hook modules dispatch intents — rejected, operations are orchestrators.

## Architecture

```
API bridge: ui.switchWorkspace (bootstrap.ts)
  │ dispatch(SwitchWorkspaceIntent)
  ▼
SwitchWorkspaceOperation.execute()           (switch-workspace.ts)
  │
  ├─ hooks.run("activate", hookCtx)
  │     └── SwitchViewModule                 (bootstrap.ts)
  │           ├─ resolveWorkspace()
  │           └─ viewManager.setActiveWorkspace(path, focus)
  │
  └─ ctx.emit(workspace:switched)
        ├── IpcEventBridge                   (ipc-event-bridge.ts)
        │     └─ apiRegistry.emit("workspace:switched", ...)
        └── SwitchTitleModule                (bootstrap.ts)
              └─ formatWindowTitle() + setTitle()
```

**Other operations dispatch workspace:switch:**

```
CreateWorkspaceOperation.execute()
  ├─ hooks.run("create") / hooks.run("setup") / hooks.run("finalize")
  ├─ ctx.emit(workspace:created)
  └─ ctx.dispatch(workspace:switch)        ← NEW (if !keepInBackground)

OpenProjectOperation.execute()
  ├─ hooks.run("open")
  ├─ ctx.dispatch(workspace:create) × N
  ├─ ctx.emit(project:opened)
  └─ ctx.dispatch(workspace:switch)        ← NEW (first workspace)

DeleteWorkspaceOperation.execute()
  ├─ hooks.run("shutdown")
  ├─ ctx.dispatch(workspace:switch, next)  ← NEW (if active, next available)
  │   OR ctx.emit(workspace:switched(null))← NEW (if no next)
  ├─ hooks.run("release") / hooks.run("delete")
  └─ ctx.emit(workspace:deleted)

CloseProjectOperation.execute()
  ├─ hooks.run("resolve")
  ├─ ctx.dispatch(workspace:delete) × N
  ├─ hooks.run("close")
  ├─ ctx.emit(workspace:switched(null))    ← NEW (if no other projects)
  └─ ctx.emit(project:closed)
```

**What changes:**

| Before                                                                       | After                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `CoreModule.switchWorkspace()` handles directly                              | Dispatcher bridge → `SwitchWorkspaceOperation`                         |
| `onWorkspaceChange` callback in `index.ts` emits event via `registry.emit()` | Removed entirely                                                       |
| `wireApiEvents` subscriber handles IPC + title                               | `IpcEventBridge` module (IPC) + `SwitchTitleModule` (title)            |
| `formatWindowTitle` in `api-handlers.ts`                                     | Inlined into `SwitchTitleModule` (bootstrap.ts)                        |
| `viewModule` calls `setActiveWorkspace` on workspace:created                 | `CreateWorkspaceOperation` dispatches `workspace:switch`               |
| `deleteViewModule` calls `setActiveWorkspace`/`switchToNext`                 | `DeleteWorkspaceOperation` dispatches `workspace:switch` or emits null |
| `projectViewModule` calls `setActiveWorkspace` on project:opened             | `OpenProjectOperation` dispatches `workspace:switch`                   |
| `projectCloseViewModule` calls `setActiveWorkspace(null)`                    | `CloseProjectOperation` emits `workspace:switched(null)`               |

**Null (deactivation) strategy:** The `workspace:switch` intent always targets a concrete workspace. When no workspace is available (delete last, close last project), the operation emits `workspace:switched(null)` directly via `ctx.emit()` and calls `viewManager.setActiveWorkspace(null, false)` from its hook module. This avoids a separate "deactivate" intent for a rare edge case.

## Testing Strategy

### Integration Tests

Test through the dispatcher bridge handler registered on the API registry, following the same pattern as `set-mode.integration.test.ts`.

**ViewManager mock**: Behavioral mock with in-memory state tracking `activeWorkspacePath` and `focusState`, following the `MockViewManager` pattern from `set-mode.integration.test.ts` (lines 58-74) extended for workspace switching. Assertions verify resulting state, not method calls.

**IPC edge boundary**: Tests #8-11 verify IPC bridge and title module behavior. Since IPC emission has no observable in-memory state, these tests use call-tracking verification (matching the existing pattern in `set-mode.integration.test.ts` line 264 for `apiRegistry.emit`). This is an accepted trade-off at the IPC boundary.

**Test file**: `src/main/operations/switch-workspace.integration.test.ts`

| #   | Test Case                                                 | Entry Point              | Boundary Mocks           | Behavior Verified                                                                          |
| --- | --------------------------------------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | switches to resolved workspace                            | dispatcher bridge        | ViewManager (behavioral) | `viewManager.activeWorkspacePath === resolvedPath`                                         |
| 2   | emits workspace:switched event with correct payload       | dispatcher bridge        | ViewManager (behavioral) | domain event contains projectId, workspaceName, path                                       |
| 3   | defaults focus to true                                    | dispatcher bridge        | ViewManager (behavioral) | `viewManager.focusState === true` when focus not specified                                 |
| 4   | passes focus=false when specified                         | dispatcher bridge        | ViewManager (behavioral) | `viewManager.focusState === false`                                                         |
| 5   | throws when workspace not found                           | dispatcher bridge        | ViewManager (behavioral) | rejects with error, `viewManager.activeWorkspacePath` unchanged                            |
| 6   | no-op when switching to already-active workspace          | dispatcher bridge        | ViewManager (behavioral) | `viewManager.activeWorkspacePath` unchanged, no event emitted                              |
| 7   | bridge handler defaults focus when omitted in API payload | API bridge               | ViewManager (behavioral) | intent dispatched with `focus` defaulting correctly                                        |
| 8   | IPC bridge forwards workspace:switched event              | IpcEventBridge           | -                        | `apiRegistry.emit("workspace:switched", ...)` called (IPC edge)                            |
| 9   | title module updates window title on switch               | SwitchTitleModule        | -                        | `setTitle` called with formatted title including version and update suffix (IPC edge)      |
| 10  | title module formats title with update-available suffix   | SwitchTitleModule        | -                        | `setTitle` includes "(update available)" when `hasUpdateAvailable` returns true (IPC edge) |
| 11  | interceptor cancellation prevents operation and event     | dispatcher + interceptor | ViewManager (behavioral) | operation does not run, no event emitted                                                   |

### Focused Tests

None — `formatWindowTitle` is now part of `SwitchTitleModule` and tested through integration tests #9-10.

### Manual Testing Checklist

- [ ] Click workspace in sidebar — switches correctly
- [ ] Keyboard shortcuts (arrow keys, 1-9) — switch correctly
- [ ] Window title updates to show project/workspace name
- [ ] Window title shows "(update available)" suffix when update is available
- [ ] Creating a workspace auto-switches to it
- [ ] Deleting active workspace switches to next workspace
- [ ] Deleting last workspace clears title
- [ ] Opening a project activates first workspace
- [ ] Closing last project clears title
- [ ] Shortcut mode (Alt+X) preserves UI focus during switch

## Implementation Steps

- [x] **Step 1: Create operation file**
  - Create `src/main/operations/switch-workspace.ts`
  - Define `SwitchWorkspacePayload`: `{ readonly projectId: string; readonly workspaceName: string; readonly focus?: boolean }`
  - Define `SwitchWorkspaceIntent extends Intent<void>`: `{ readonly type: "workspace:switch"; readonly payload: SwitchWorkspacePayload }`
  - Define `SwitchWorkspaceHookContext extends HookContext`: `{ resolvedPath?: string; projectPath?: string }` — optional fields populated by the `activate` hook handler
  - Define `WorkspaceSwitchedPayload`: `{ readonly projectId: string; readonly workspaceName: string; readonly path: string }`
  - Define `WorkspaceSwitchedEvent extends DomainEvent`: `{ readonly type: "workspace:switched"; readonly payload: WorkspaceSwitchedPayload }`
  - Export `EVENT_WORKSPACE_SWITCHED` constant and `INTENT_SWITCH_WORKSPACE` constant
  - The `null` deactivation case is NOT routed through this intent — operations emit `workspace:switched(null)` directly via `ctx.emit()` for that edge case
  - Implement `SwitchWorkspaceOperation` with single `activate` hook point:
    1. Run `activate` hook (populates `resolvedPath`, `projectPath`)
    2. Check `hookCtx.error` and re-throw if set
    3. Validate `hookCtx.resolvedPath` is defined
    4. Emit `WorkspaceSwitchedEvent` via `ctx.emit()`
  - Files: `src/main/operations/switch-workspace.ts` (new)
  - Test criteria: types compile, operation structure matches set-mode pattern

- [x] **Step 2: Create modules in bootstrap.ts**
  - **SwitchViewModule**: hook on `activate` — resolves workspace via `resolveWorkspace()`, sets `hookCtx.resolvedPath` and `hookCtx.projectPath`, calls `viewManager.setActiveWorkspace(path, focus)`
  - **SwitchTitleModule**: event subscriber on `workspace:switched` — contains `formatWindowTitle` (moved from `api-handlers.ts`) and receives title dependencies via closure:
    - `appState.findProjectForWorkspace()` for `getProjectName`
    - `windowLayer.setTitle()` for title setter
    - `buildInfo.version` / `buildInfo.gitBranch` for version suffix
    - `hasUpdateAvailable()` callback for update suffix
    - Calls `formatWindowTitle(projectName, workspaceName, version, hasUpdate)` + `setTitle()`
    - Handles `null` payload: calls `formatWindowTitle(undefined, undefined, version, hasUpdate)` + `setTitle()`
  - Add both modules to the `wireModules` array in a `// workspace:switch modules` section
  - Files: `src/main/bootstrap.ts`
  - Test criteria: modules follow existing patterns (hook handlers, event declarations)

- [x] **Step 3: Extend IpcEventBridge**
  - Add `workspace:switched` event handler to `createIpcEventBridge`
  - Import `EVENT_WORKSPACE_SWITCHED` and `WorkspaceSwitchedEvent` from operation file
  - Forward to `apiRegistry.emit("workspace:switched", ...)` with correct payload shape
  - Handle `null` payload (forward as-is for deactivation)
  - Files: `src/main/modules/ipc-event-bridge.ts`
  - Test criteria: event is forwarded to apiRegistry

- [x] **Step 4: Register operation and API bridge handler**
  - Register `SwitchWorkspaceOperation` on dispatcher in `wireDispatcher`
  - Create `registry.register("ui.switchWorkspace", ...)` bridge handler that:
    - Receives `UiSwitchWorkspacePayload`
    - Builds `SwitchWorkspaceIntent` with `focus` defaulting from payload
    - Dispatches and awaits result
  - Files: `src/main/bootstrap.ts`
  - Test criteria: bridge handler converts API payload to intent correctly

- [x] **Step 5: Update other operations to dispatch workspace:switch**
  - **CreateWorkspaceOperation** (`src/main/operations/create-workspace.ts`):
    - After emitting `workspace:created`, dispatch `workspace:switch` intent via `ctx.dispatch()` if `!keepInBackground`
    - Uses `hookCtx.projectId` and `hookCtx.workspaceName` to build the switch intent
  - **viewModule** (`bootstrap.ts:755-770`):
    - Remove `setActiveWorkspace` call (line 766) — switching now done by operation
    - Keep `createWorkspaceView` and `preloadWorkspaceUrl` calls
  - **OpenProjectOperation** (`src/main/operations/open-project.ts`):
    - After workspace creation loop and emitting `project:opened`, dispatch `workspace:switch` for the first workspace
  - **projectViewModule** (`bootstrap.ts:1273-1286`):
    - Remove `setActiveWorkspace` call (line 1279) — switching now done by operation
    - Keep `preloadWorkspaceUrl` calls for remaining workspaces
  - **DeleteWorkspaceOperation** (`src/main/operations/delete-workspace.ts`):
    - After `shutdown` hook, if active workspace was deleted:
      - Try to find next workspace (move `switchToNextWorkspaceIfAvailable` logic into operation or keep as helper)
      - If next found: dispatch `workspace:switch` intent
      - If no next: call `viewManager.setActiveWorkspace(null, false)` via hook + emit `workspace:switched(null)` directly via `ctx.emit()`
  - **deleteViewModule** (`bootstrap.ts:776-817`):
    - Remove `switchToNextWorkspaceIfAvailable` and `setActiveWorkspace(null)` calls — switching now done by operation
    - Keep `destroyWorkspaceView` call
  - **CloseProjectOperation** (`src/main/operations/close-project.ts`):
    - After workspace deletion loop and `close` hook, if no other projects exist: emit `workspace:switched(null)` directly via `ctx.emit()`
  - **projectCloseViewModule** (`bootstrap.ts:1322-1337`):
    - Remove `setActiveWorkspace(null)` call — now done by operation
    - May become empty (remove if no remaining logic)
  - Files: `src/main/operations/create-workspace.ts`, `src/main/operations/open-project.ts`, `src/main/operations/delete-workspace.ts`, `src/main/operations/close-project.ts`, `src/main/bootstrap.ts`
  - Test criteria: existing operation tests still pass with updated assertions

- [x] **Step 6: Remove old wiring**
  - Remove `switchWorkspace` method from `CoreModule` (`src/main/modules/core/index.ts`)
  - Remove `api.register("ui.switchWorkspace", ...)` from CoreModule constructor
  - Remove `workspace:switched` subscriber from `wireApiEvents` in `src/main/ipc/api-handlers.ts` (IPC forwarding now handled by Step 3 IpcEventBridge extension; title update now handled by Step 2 SwitchTitleModule)
  - Remove `formatWindowTitle` and `TitleConfig` from `api-handlers.ts` (now inlined in SwitchTitleModule)
  - Remove `onWorkspaceChange` callback wiring in `src/main/index.ts` (lines 698-714) — all callers now dispatch through the intent system
  - Remove `onLoadingChange` callback if it was only used for the workspace:switched path (verify)
  - Verify no remaining direct `setActiveWorkspace` calls outside of `SwitchViewModule` and the null-deactivation paths (grep)
  - Files: `src/main/modules/core/index.ts`, `src/main/index.ts`, `src/main/ipc/api-handlers.ts`
  - Test criteria: old code paths removed, no remaining references

- [x] **Step 7: Write integration tests**
  - Create `src/main/operations/switch-workspace.integration.test.ts`
  - Test through dispatcher bridge following existing patterns in `set-mode.integration.test.ts`
  - Use behavioral ViewManager mock with in-memory state
  - Cover all test cases from testing strategy table
  - Files: `src/main/operations/switch-workspace.integration.test.ts` (new)
  - Test criteria: all 11 test cases pass

- [x] **Step 8: Update existing tests**
  - `src/main/modules/core/index.integration.test.ts` — remove test that checks `ui.switchWorkspace` is registered on CoreModule
  - `src/main/ipc/api-handlers.test.ts` — remove `formatWindowTitle` tests (now covered by SwitchTitleModule tests) and `workspace:switched` subscriber tests from `wireApiEvents` tests
  - `src/main/ipc/api-handlers.integration.test.ts` — remove `workspace:switched` forwarding test (now covered by IpcEventBridge tests)
  - Update IpcEventBridge tests to cover new `workspace:switched` handler
  - Update `create-workspace` / `delete-workspace` / `open-project` / `close-project` integration tests for the new dispatch pattern
  - Files: existing test files listed above
  - Test criteria: `pnpm validate:fix` passes

## Dependencies

None.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`            | Add `workspace:switch` to the list of operations using the intent dispatcher in the Intent Dispatcher section. Note that operations dispatch `workspace:switch` intents for active-workspace changes. |
| `docs/ARCHITECTURE.md` | Grep for `workspace:switched` or `onWorkspaceChange` — update if event flow is documented, otherwise no changes needed                                                                                |

## Definition of Done

- [ ] All implementation steps complete
- [ ] No direct `setActiveWorkspace` calls remain outside of SwitchViewModule and null-deactivation paths
- [ ] `onWorkspaceChange` callback fully removed
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed (manual checklist)
- [ ] CI passed
- [ ] Merged to main
