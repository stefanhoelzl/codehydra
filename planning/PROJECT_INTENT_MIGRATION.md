---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-08
reviewers: [review-arch, review-quality, review-testing]
---

# PROJECT_INTENT_MIGRATION

## Overview

- **Problem**: The three project operations (`project:open`, `project:close`, `project:clone`) live in CoreModule as direct calls to AppState. They bypass the intent dispatcher — no hooks, no domain events, no interceptors. This blocks the Phase 3 goal of deleting CoreModule.

- **Solution**:
  1. Add `existingWorkspace?` to `workspace:create` so it can activate discovered workspaces (skip worktree creation)
  2. Add `removeWorktree` flag to `workspace:delete` so it can tear down runtime only (`removeWorktree: false`) or also delete the worktree (`removeWorktree: true`)
  3. Create `project:open` operation with idempotency interceptor that resolves/clones, discovers workspaces, registers state, then dispatches `workspace:create` per workspace
  4. Create `project:close` operation that dispatches `workspace:delete { removeWorktree: false }` per workspace, then cleans up project state

- **Interfaces**: No IPC channel changes. Internal type changes only:
  - `CreateWorkspacePayload` gains `existingWorkspace?` field and `projectPath?` field
  - `DeleteWorkspacePayload` gains `removeWorktree: boolean` (required)
  - New intent types: `OpenProjectIntent`, `CloseProjectIntent`
  - New domain events: `project:opened`, `project:closed`

- **Risks**:
  - AppState.openProject() decomposition (120 LOC) — mitigated by extracting into hook handlers that call the same AppState methods
  - `existingWorkspace` changes workspace:create semantics — mitigated by conditional in WorktreeModule only, rest of pipeline unchanged. **Important**: future hook modules registered on `workspace:create` must consider both the new-worktree and existing-workspace paths.
  - Partial failure during per-workspace `workspace:create` in project:open — mitigated by best-effort strategy (continue with remaining workspaces, log failures)

- **Alternatives Considered**:
  - **Thin wrapper**: Single hook calling AppState.openProject() directly. Rejected: doesn't enable per-workspace intent reuse.
  - **Multi-hook decomposition**: 4 separate hooks for project:open. Rejected: combined into single hook since actions are sequential and tightly coupled.
  - **Separate workspace:activate intent**: For existing workspace activation. Rejected in favor of reusing workspace:create with `existingWorkspace` flag.
  - **Rename workspace:create/delete to open/close**: Rejected: unnecessary churn, keep names simple.

- **Future scope**: Read-only queries (`projectList`, `projectGet`, `projectFetchBases`) remain in CoreModule for now and can migrate to intent-based operations later for consistency.

## Architecture

### Intent Flow

```
project:open (local path or URL)
  │
  ├── [Idempotency interceptor: cancel if project already open]
  │
  ├── hook: "open"
  │    ├── ProjectResolver: clone if URL, validate git, create provider
  │    ├── ProjectManager: discover workspaces, orphan cleanup
  │    └── ProjectRegistry: generate ID, load config, store state, persist
  │
  ├── For each discovered workspace (best-effort, continue on failure):
  │    dispatch workspace:create { existingWorkspace: discoveredData }
  │    ├── WorktreeModule: populate context from existing (skip worktree creation)
  │    ├── AgentModule: start server (setup hook)
  │    ├── CodeServerModule: workspace file (finalize hook)
  │    └── Event: workspace:created → state module + view module (incl. preload)
  │
  ├── Set first workspace as active
  └── emit project:opened

project:close (projectId)
  │
  ├── Resolve projectId → projectPath (BEFORE any state removal)
  ├── Get workspace list (BEFORE any state removal)
  │
  ├── For each workspace:
  │    dispatch workspace:delete { removeWorktree: false, skipSwitch: true }
  │    ├── "shutdown" hook only (stop server, destroy view)
  │    └── Event: workspace:deleted → state module unregisters
  │    Note: skipSwitch prevents intermediate workspace switches during
  │    sequential teardown — without it, each delete would try to switch
  │    to the next workspace that's about to be deleted too.
  │
  ├── Set active workspace to null if no other projects open
  │
  ├── hook: "close"
  │    ├── ProjectManager: dispose provider, delete dir if removeLocalRepo
  │    └── ProjectRegistry: remove from state + store
  │
  └── emit project:closed
```

### Workspace Intent Changes

```
workspace:create (existing intent, extended)
  - Payload gains:
    - existingWorkspace?: ExistingWorkspaceData  (path, branch, metadata, name)
    - projectPath?: string  (authoritative when existingWorkspace set, avoids projectId resolution)
  - WorktreeModule: if existingWorkspace → populate context from it; else → create worktree
  - When existingWorkspace is set, projectPath is used directly (no resolution from projectId)
  - Hook points unchanged: "create", "setup", "finalize"
  - Event unchanged: workspace:created
  - NOTE: New modules registering on workspace:create must handle both paths

workspace:delete (existing intent, extended)
  - Payload gains: removeWorktree: boolean (REQUIRED, not optional)
  - removeWorktree: true  → full pipeline (shutdown + release + delete) — current behavior
  - removeWorktree: false → "shutdown" hook only, skip "release" + "delete"
  - All existing dispatch sites updated to pass removeWorktree: true explicitly
  - Event unchanged: workspace:deleted
```

### Type Definitions

```typescript
/** Data for activating an existing (discovered) workspace via workspace:create */
interface ExistingWorkspaceData {
  readonly path: string; // Normalized workspace path (string at payload boundary)
  readonly name: string; // Workspace name
  readonly branch: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/** New AppState method signatures */
interface AppStateProjectMethods {
  registerProject(project: {
    id: ProjectId;
    name: string;
    path: Path;
    workspaces: readonly InternalWorkspace[];
    provider: IWorkspaceProvider;
    remoteUrl?: string;
  }): void;

  deregisterProject(projectPath: string): void;
}
```

### Module Contributions

```
OpenProjectOperation
  interceptor: IdempotencyInterceptor (cancel if project path already open)
  hook: "open"
    ├── ProjectResolver  (clone, validate, create provider)
    ├── ProjectManager   (discover workspaces)
    └── ProjectRegistry  (ID, config, state, persist)

CloseProjectOperation
  hook: "close"
    ├── ProjectManager   (dispose provider, delete cloned dir)
    └── ProjectRegistry  (remove state + store)

workspace:create (extended)
  hook: "create"   → WorktreeModule (conditional on existingWorkspace)
  hook: "setup"    → KeepFilesModule, AgentModule
  hook: "finalize" → CodeServerModule

workspace:delete (extended)
  hook: "shutdown" → ViewModule, AgentModule
  hook: "release"  → WindowsLockModule (skipped when removeWorktree=false)
  hook: "delete"   → WorktreeModule, CodeServerModule (skipped when removeWorktree=false)
```

## Testing Strategy

### Integration Tests

Tests are split into two files: `open-project.integration.test.ts` and `close-project.integration.test.ts`. Workspace intent extension tests extend the existing `create-workspace.integration.test.ts` and `delete-workspace.integration.test.ts` files.

Tests use existing `createTestAppState()` / `createTestViewManager()` patterns from delete-workspace tests for AppState and ViewManager mocking, plus boundary mocks (GitClient, FileSystem, ProcessRunner) via `*.state-mock.ts` factories.

**project:open (`open-project.integration.test.ts`):**

| #   | Test Case                                         | Entry Point                              | Mocks                                        | Behavior Verified                                                                                          |
| --- | ------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Opens local project and activates workspaces      | `dispatcher.dispatch(openProjectIntent)` | GitClient, FileSystem, AppState, ViewManager | Project state contains all discovered workspaces, each workspace has view created and agent server running |
| 2   | Clones remote project then opens                  | `dispatcher.dispatch(openProjectIntent)` | GitClient, FileSystem, AppState              | Project state has remoteUrl, cloned directory exists in filesystem mock, project registered                |
| 3   | Returns existing project if already open          | `dispatcher.dispatch(openProjectIntent)` | AppState (pre-populated)                     | Interceptor cancels, state unchanged (`toBeUnchanged(snapshot)`)                                           |
| 4   | Returns existing project if URL already cloned    | `dispatcher.dispatch(openProjectIntent)` | GitClient, FileSystem, AppState              | Finds existing path via projectStore, opens that path, no second clone                                     |
| 5   | project:opened event emitted after open           | `dispatcher.dispatch(openProjectIntent)` | GitClient, AppState                          | Event subscriber receives project:opened with correct project data                                         |
| 6   | Continues best-effort when workspace:create fails | `dispatcher.dispatch(openProjectIntent)` | GitClient (error on one ws), AppState        | Remaining workspaces still activated, failed workspace logged                                              |
| 7   | Rejects invalid git path                          | `dispatcher.dispatch(openProjectIntent)` | GitClient (validation error)                 | Error thrown, no state changes                                                                             |
| 8   | Rejects invalid clone URL                         | `dispatcher.dispatch(openProjectIntent)` | —                                            | Error thrown for malformed URL                                                                             |

**project:close (`close-project.integration.test.ts`):**

| #   | Test Case                                              | Entry Point                               | Mocks                 | Behavior Verified                                                                    |
| --- | ------------------------------------------------------ | ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| 9   | Closes project and tears down workspaces               | `dispatcher.dispatch(closeProjectIntent)` | AppState, ViewManager | All workspace views destroyed, all agent servers stopped, project removed from state |
| 10  | Close with removeLocalRepo deletes cloned dir          | `dispatcher.dispatch(closeProjectIntent)` | FileSystem, AppState  | Cloned directory removed from filesystem mock                                        |
| 11  | Close with removeLocalRepo skips for local projects    | `dispatcher.dispatch(closeProjectIntent)` | AppState              | Filesystem mock unchanged for project directory                                      |
| 12  | project:closed event emitted after close               | `dispatcher.dispatch(closeProjectIntent)` | AppState              | Event subscriber receives project:closed                                             |
| 13  | Close with unknown projectId throws                    | `dispatcher.dispatch(closeProjectIntent)` | AppState (empty)      | Error thrown, no state changes                                                       |
| 14  | skipSwitch prevents intermediate switches during close | `dispatcher.dispatch(closeProjectIntent)` | AppState, ViewManager | No switchToNextWorkspace calls, active workspace set to null after all deletes       |

**workspace:create extensions (in `create-workspace.integration.test.ts`):**

| #   | Test Case                                   | Entry Point                         | Mocks               | Behavior Verified                                                           |
| --- | ------------------------------------------- | ----------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| 15  | existingWorkspace skips worktree creation   | `dispatcher.dispatch(createIntent)` | GitClient, AppState | Workspace registered with existing path/branch, no new worktree in git mock |
| 16  | existingWorkspace uses projectPath directly | `dispatcher.dispatch(createIntent)` | AppState            | Context populated without projectId resolution                              |

**workspace:delete extensions (in `delete-workspace.integration.test.ts`):**

| #   | Test Case                               | Entry Point                         | Mocks                                        | Behavior Verified                                                 |
| --- | --------------------------------------- | ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| 17  | removeWorktree=false skips delete hooks | `dispatcher.dispatch(deleteIntent)` | AppState, ViewManager                        | View destroyed, server stopped, worktree still exists in git mock |
| 18  | removeWorktree=true runs full pipeline  | `dispatcher.dispatch(deleteIntent)` | GitClient, FileSystem, AppState, ViewManager | Worktree removed from git mock, workspace file deleted            |

### Manual Testing Checklist

- [ ] Open local project → workspaces appear, agents start
- [ ] Clone remote project → clones, opens, workspaces appear
- [ ] Close project → all workspaces torn down, project removed from sidebar
- [ ] Close cloned project with removeLocalRepo → directory deleted
- [ ] Create new workspace → worktree created, agent starts
- [ ] Delete workspace → worktree removed
- [ ] Reopen project after close → workspaces rediscovered, agents restart

## Implementation Steps

- [x] **Step 1: Add `removeWorktree` flag to workspace:delete**
  - Add `removeWorktree: boolean` (required) to `DeleteWorkspacePayload`
  - Update `DeleteWorkspaceOperation.execute()`: when `removeWorktree` is false, skip "release" and "delete" hooks, only run "shutdown"
  - Still emit `workspace:deleted` event regardless of `removeWorktree` value (needed for state cleanup)
  - Update API bridge handler for `"workspaces.remove"`: pass `removeWorktree: true` (preserves current behavior)
  - Update all other dispatch sites to pass `removeWorktree: true` explicitly
  - Files: `src/main/operations/delete-workspace.ts`, `src/main/bootstrap.ts`
  - Tests (in `delete-workspace.integration.test.ts`):
    - Test #17: workspace:delete with `removeWorktree: false` — view destroyed, server stopped, worktree preserved
    - Test #18: workspace:delete with `removeWorktree: true` — full pipeline, worktree removed
    - Existing delete tests updated to pass `removeWorktree: true`

- [x] **Step 2: Add `existingWorkspace` support to workspace:create**
  - Add `ExistingWorkspaceData` interface: `{ path: string; name: string; branch: string | null; metadata: Readonly<Record<string, string>> }`
  - Add `existingWorkspace?: ExistingWorkspaceData` field to `CreateWorkspacePayload`
  - Add `projectPath?: string` field to `CreateWorkspacePayload` — authoritative when `existingWorkspace` is set, avoids re-resolution from `projectId`
  - Update WorktreeModule ("create" hook) in bootstrap.ts: if `existingWorkspace` is set, populate hook context from it instead of calling `provider.createWorkspace()`
  - Files: `src/main/operations/create-workspace.ts`, `src/main/bootstrap.ts`
  - Tests (in `create-workspace.integration.test.ts`):
    - Test #15: workspace:create with `existingWorkspace` — workspace registered with existing path/branch, no new worktree
    - Test #16: workspace:create with `existingWorkspace` uses `projectPath` directly
    - Existing create tests still pass (no `existingWorkspace` → unchanged behavior)

- [x] **Step 3: Create OpenProjectOperation + idempotency interceptor**
  - New file: `src/main/operations/open-project.ts`
  - Define `OpenProjectIntent` with `OpenProjectPayload`:
    ```typescript
    interface OpenProjectPayload {
      /** Local filesystem path or git URL. URL detected by resolver hook. */
      readonly input: string;
    }
    ```
  - Define `OpenProjectHookContext` with fields populated by hook handlers:
    - `projectPath?: string` — resolved path after clone/normalize
    - `provider?: IWorkspaceProvider` — created provider
    - `workspaces?: readonly InternalWorkspace[]` — discovered workspaces
    - `projectId?: ProjectId` — generated
    - `remoteUrl?: string` — from clone or config
    - `defaultBaseBranch?: string`
  - Define `ProjectOpenedEvent` with `EVENT_PROJECT_OPENED`
  - Define `ProjectOpenIdempotencyInterceptor` — cancel if project path already in AppState.openProjects. Tracks in-progress opens by path, clears on `project:opened` event.
  - Operation.execute():
    1. Run "open" hook → populates context
    2. Validate required fields: `projectPath`, `provider`, `projectId` (throw if missing)
    3. For each workspace (best-effort, continue on failure): dispatch `workspace:create { existingWorkspace, projectPath, projectId }`
    4. Set first workspace as active via ViewManager
    5. Emit `project:opened` event
    6. Return `Project` object
  - Files: `src/main/operations/open-project.ts`
  - Test criteria: Types compile, operation structure matches existing patterns

- [x] **Step 4: Create project:open hook modules**
  - Create helper function `wireProjectOperations()` in bootstrap.ts to keep `wireDispatcher()` manageable
  - Create inline modules:
  - **ProjectResolverModule** ("open" hook):
    - Detect URL input (isValidGitUrl after expandGitUrl)
    - If URL: check existing via projectStore.findByRemoteUrl, clone if new, save config with remoteUrl
    - If path: normalize with Path
    - Validate git repo, create workspace provider (global or standalone)
    - Set: `hookCtx.projectPath`, `hookCtx.provider`
  - **ProjectDiscoveryModule** ("open" hook):
    - Call `provider.discover()` → `hookCtx.workspaces`
    - Fire-and-forget `provider.cleanupOrphanedWorkspaces()`
  - **ProjectRegistryModule** ("open" hook):
    - Generate project ID → `hookCtx.projectId`
    - Load project config (remoteUrl) → `hookCtx.remoteUrl`
    - Store in `appState` via new `registerProject()` method
    - Get/cache default base branch → `hookCtx.defaultBaseBranch`
    - Persist to projectStore if new
  - Add `registerProject()` to AppState:
    ```typescript
    registerProject(project: {
      id: ProjectId; name: string; path: Path;
      workspaces: readonly InternalWorkspace[];
      provider: IWorkspaceProvider; remoteUrl?: string;
    }): void
    ```
  - Files: `src/main/bootstrap.ts`, `src/main/app-state.ts`
  - Tests (in `open-project.integration.test.ts`):
    - Test #1: open local project → workspaces activated
    - Test #2: clone remote project → clone + open
    - Test #3: already-open project → interceptor cancels, state unchanged
    - Test #4: already-cloned URL → finds existing, opens
    - Test #5: project:opened event emitted
    - Test #6: best-effort on workspace failure
    - Test #7: invalid git path → error
    - Test #8: invalid clone URL → error

- [x] **Step 5: Create CloseProjectOperation**
  - New file: `src/main/operations/close-project.ts`
  - Define `CloseProjectIntent` with `CloseProjectPayload`:
    ```typescript
    interface CloseProjectPayload {
      readonly projectId: ProjectId;
      readonly removeLocalRepo?: boolean;
    }
    ```
  - Define `CloseProjectHookContext` with fields: `projectPath: string`, `remoteUrl?: string`, `removeLocalRepo: boolean`
  - Define `ProjectClosedEvent` with `EVENT_PROJECT_CLOSED`
  - Operation.execute():
    1. Resolve projectId → projectPath via AppState (**CRITICAL: before any state removal**)
    2. Load project config (for remoteUrl)
    3. Get project workspaces list (**CRITICAL: before any state removal**)
    4. For each workspace: `await dispatch(workspace:delete { removeWorktree: false, skipSwitch: true })`
    5. Set active workspace to null if no other projects open
    6. Run "close" hook → dispose provider, remove state, delete dir
    7. Emit `project:closed` event
  - Files: `src/main/operations/close-project.ts`
  - Test criteria: Types compile, operation structure correct

- [x] **Step 6: Create project:close hook modules**
  - Create inline modules in `wireProjectOperations()`:
  - **ProjectCloseManagerModule** ("close" hook):
    - Dispose workspace provider (ProjectScopedWorkspaceProvider.dispose())
    - If removeLocalRepo + remoteUrl: delete project directory via projectStore.deleteProjectDirectory()
  - **ProjectCloseRegistryModule** ("close" hook):
    - Remove from appState via new `deregisterProject()` method
    - Remove from projectStore
  - Add `deregisterProject(projectPath: string): void` to AppState — removes from openProjects map
  - Files: `src/main/bootstrap.ts`, `src/main/app-state.ts`
  - Tests (in `close-project.integration.test.ts`):
    - Test #9: close project → workspaces torn down, state removed
    - Test #10: removeLocalRepo deletes cloned dir
    - Test #11: removeLocalRepo skips for local projects
    - Test #12: project:closed event emitted
    - Test #13: unknown projectId throws
    - Test #14: skipSwitch prevents intermediate switches

- [x] **Step 7: Wire operations and create API bridge handlers**
  - Register `OpenProjectOperation` and `CloseProjectOperation` with dispatcher
  - Wire `ProjectOpenIdempotencyInterceptor`
  - Create IPC event bridge entries for `project:opened` and `project:closed`
  - Create API bridge handlers:
    - `"projects.open"` → dispatch `project:open` intent with `{ input: path }`
    - `"projects.clone"` → dispatch `project:open` intent with `{ input: url }` (URL detected in resolver hook)
    - `"projects.close"` → dispatch `project:close` intent with `{ projectId, removeLocalRepo }`
  - Remove `projectOpen`, `projectClose`, `projectClone` from CoreModule
  - Keep `projectList`, `projectGet`, `projectFetchBases` in CoreModule (read-only queries, out of scope)
  - Files: `src/main/bootstrap.ts`, `src/main/modules/core/index.ts`, `src/main/modules/ipc-event-bridge.ts`
  - Test criteria: `pnpm validate:fix` passes, all tests pass

- [x] **Step 8: Update documentation**
  - Update `docs/ARCHITECTURE.md`: add project:open and project:close to intent dispatcher section
  - Update `docs/API.md`: verify event payload compatibility for `project:opened` and `project:closed` (mechanism changes from `api.emit()` to IpcEventBridge), update Private API events table if payloads differ
  - Update `CLAUDE.md`: mention project operations in intent dispatcher section, note `existingWorkspace` flag semantics for workspace:create
  - Files: `docs/ARCHITECTURE.md`, `docs/API.md`, `CLAUDE.md`
  - Test criteria: Documentation accurately reflects new architecture

## Dependencies

None — pure refactoring within existing infrastructure.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add project:open and project:close to intent dispatcher section                     |
| `docs/API.md`          | Verify event payload compatibility, update Private API events if needed             |
| `CLAUDE.md`            | Update intent dispatcher section: project operations, `existingWorkspace` semantics |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `workspace:create` extended with `existingWorkspace` support
- [ ] `workspace:delete` extended with `removeWorktree` flag (required boolean)
- [ ] `project:open` dispatches `workspace:create` per discovered workspace (best-effort)
- [ ] `project:close` dispatches `workspace:delete { removeWorktree: false }` per workspace
- [ ] `project:open` idempotency interceptor prevents concurrent/duplicate opens
- [ ] `projects.open`, `projects.close`, `projects.clone` removed from CoreModule
- [ ] Domain events `project:opened` and `project:closed` emitted and bridged to IPC
- [ ] All 18 integration tests pass
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated (ARCHITECTURE.md, API.md, CLAUDE.md)
- [ ] Manual smoke test passed
