---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-08
reviewers: []
---

# WORKSPACE_CREATE_INTENT

## Overview

- **Problem**: `workspace:create` lives in `CoreModule.workspaceCreate()` as a monolithic method that directly orchestrates 6+ concerns: git worktree creation, keepfiles copying, agent server startup, workspace file creation, view management, and state updates. This is inconsistent with the intent-based architecture established in Phase 1 (metadata) and Phase 2 (workspace status, agent session, etc.).

- **Solution**: Migrate `workspace:create` to the intent dispatcher using 3 hook points (`create`, `setup`, `finalize`) with 3 hook modules (WorktreeModule, AgentModule, CodeServerModule) and 2 event modules (StateModule, ViewModule). KeepFiles copying is handled internally by `GitWorktreeProvider.createWorkspace()` called within WorktreeModule, not as a separate hook module. The operation emits a `workspace:created` domain event; StateModule and ViewModule respond to that event rather than running as hooks, accepting a timing gap where the renderer learns about the workspace before the view exists.

- **Interfaces**: No IPC changes. The `api:workspace:create` channel, `WorkspaceCreatePayload`, and `workspace:created` event contract remain identical. The internal implementation changes from CoreModule method to Dispatcher operation. Note: `CreateWorkspacePayload` (intent) is intentionally separate from `WorkspaceCreatePayload` (IPC registry) — intent types belong to the operation, IPC types belong to the API registry. The IPC bridge handler in Step 4 maps between them.

- **Risks**:
  1. **AppState.addWorkspace bypass**: Hook/event modules call services directly instead of `AppState.addWorkspace()`. This method becomes dead code. Risk: other callers of `addWorkspace` break. Mitigation: Search for all callers — currently only CoreModule.workspaceCreate uses it.
  2. **Timing change**: View creation moves to after event emission. The renderer receives `workspace:created` before the view exists. Mitigation: Workspace loading state already handles this gap. ViewModule's event handler calls `viewManager.createWorkspaceView()` and `viewManager.setActiveWorkspace()` synchronously (these are synchronous ViewManager methods that manipulate in-memory state and Electron views — no awaiting needed). The view is created before the next event loop tick.
  3. **Event handler ordering**: StateModule, ViewModule, and IpcEventBridge all subscribe to `workspace:created`. Their execution order should not matter — each is independent.

- **Alternatives Considered**:
  - **Single hook point**: One `create` hook with all logic. Rejected: doesn't separate concerns.
  - **Registration-order-dependent hooks**: Multiple modules on same hook, relying on registration order. Rejected: fragile and implicit.
  - **Two operations (create + activate)**: Separate intent for activation. Rejected: over-engineering for current scope.
  - **Event-driven only for view, hooks for state**: Split approach. Rejected in favor of both state and view responding to events for consistency.

## Architecture

```
Intent: workspace:create
  │
  ▼
┌─────────────────────────────────────────────┐
│         CreateWorkspaceOperation            │
│                                             │
│  Hook: "create"                             │
│    └─ WorktreeModule                        │
│       ├─ Create git branch (if needed)      │
│       ├─ Create git worktree                │
│       ├─ Register in workspace registry     │
│       └─ Save base branch to git config     │
│       → Sets on context: workspacePath,     │
│         branch, metadata, projectPath       │
│                                             │
│  Validate: workspacePath, branch, metadata, │
│            projectPath must be set          │
│                                             │
│  Hook: "setup"                              │
│    └─ AgentModule (try/catch internal)      │
│       ├─ Start agent server                 │
│       ├─ Set initial prompt (if provided)   │
│       └─ Get agent env vars                 │
│       → Sets on context: envVars            │
│                                             │
│  NOTE: KeepFiles copying is handled         │
│  internally by WorktreeProvider's           │
│  createWorkspace() method, not as a         │
│  separate hook module.                      │
│                                             │
│  (No validation — setup is best-effort)     │
│                                             │
│  Hook: "finalize"                           │
│    └─ CodeServerModule                      │
│       └─ Create .code-workspace file        │
│       → Uses ctx.envVars ?? {} for fallback │
│       → Sets on context: workspaceUrl       │
│                                             │
│  Validate: workspaceUrl must be set         │
│                                             │
│  Build Workspace return value from context  │
│  (workspaceName via extractWorkspaceName)   │
│  Emit domain event: workspace:created       │
│                                             │
└─────────────────────────────────────────────┘
  │
  ▼ (domain event subscribers)
  │
  ├─ StateModule
  │  ├─ appState.registerWorkspace(projectPath, workspace)
  │  └─ appState.setLastBaseBranch(projectPath, base)
  │
  ├─ ViewModule
  │  ├─ viewManager.createWorkspaceView(path, url, projectPath, true)
  │  ├─ viewManager.preloadWorkspaceUrl(path)
  │  └─ viewManager.setActiveWorkspace(path, true) if !keepInBackground
  │
  └─ IpcEventBridge
     └─ Transform domain event → IPC event shape
        { projectId, workspace: Workspace, hasInitialPrompt?, keepInBackground? }
```

### Intent Payload

```typescript
interface CreateWorkspacePayload {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly base: string;
  readonly initialPrompt?: InitialPrompt;
  readonly keepInBackground?: boolean;
}

interface CreateWorkspaceIntent extends Intent<Workspace> {
  readonly type: "workspace:create";
  readonly payload: CreateWorkspacePayload;
}

const INTENT_CREATE_WORKSPACE = "workspace:create" as const;
```

### Extended HookContext

```typescript
interface CreateWorkspaceHookContext extends HookContext {
  // Set by WorktreeModule (create hook)
  // Uses toString()-normalized strings (converted from Path in WorktreeModule)
  workspacePath?: string;
  branch?: string;
  metadata?: Readonly<Record<string, string>>;
  projectPath?: string;

  // Set by AgentModule (setup hook) — may be undefined if agent fails (best-effort)
  envVars?: Record<string, string>;

  // Set by CodeServerModule (finalize hook)
  workspaceUrl?: string;
}
```

### Domain Event

```typescript
interface WorkspaceCreatedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
  readonly branch: string;
  readonly base: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly workspaceUrl: string;
  readonly initialPrompt?: NormalizedInitialPrompt;
  readonly keepInBackground?: boolean;
}
```

**IPC event transformation** (in IpcEventBridge): The domain event payload is transformed to match the existing IPC contract `ApiEvents["workspace:created"]`:

```typescript
// IpcEventBridge handler for EVENT_WORKSPACE_CREATED
(event: DomainEvent) => {
  const p = (event as WorkspaceCreatedEvent).payload;
  apiRegistry.emit("workspace:created", {
    projectId: p.projectId,
    workspace: {
      projectId: p.projectId,
      name: p.workspaceName,
      branch: p.branch,
      metadata: p.metadata,
      path: p.workspacePath,
    },
    ...(p.initialPrompt && { hasInitialPrompt: true }),
    ...(p.keepInBackground && { keepInBackground: true }),
  });
};
```

**WorkspaceName derivation**: The operation's `execute()` method derives `WorkspaceName` from the workspace path after the "create" hook completes:

```typescript
const workspaceName = extractWorkspaceName(hookCtx.workspacePath!);
```

### Module Dependencies

Each hook module receives its dependencies through closure in `wireDispatcher()`:

| Module           | Dependencies                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| WorktreeModule   | `appState.getWorkspaceProvider()` (GitWorktreeProvider)                |
| AgentModule      | `appState.getServerManager()`, `appState.getAgentStatusManager()`      |
| CodeServerModule | `appState.getWorkspaceUrl()` or `WorkspaceFileService` + `wrapperPath` |
| StateModule      | `appState` (via new `registerWorkspace` method + `setLastBaseBranch`)  |
| ViewModule       | `viewManager`                                                          |

**Note**: KeepFiles copying is handled internally by `GitWorktreeProvider.createWorkspace()`, which is called within WorktreeModule's "create" hook. A separate KeepFilesModule is not needed because the provider already copies keepfiles as part of worktree creation.

### Error Handling Strategy

**Best-effort hooks (setup)**: AgentModule wraps its entire handler body in try/catch internally. Errors are logged but do not set `ctx.error`. This prevents the hook runner's error propagation from affecting subsequent hooks.

**Required hooks (create, finalize)**: WorktreeModule and CodeServerModule let errors propagate normally. If they fail, the operation fails.

**Fallback values**: CodeServerModule reads `ctx.envVars ?? {}` to handle the case where AgentModule failed and didn't set envVars. The `.code-workspace` file is still created, just without agent environment variables.

**Partial-success shape**: When AgentModule fails but the operation succeeds, the returned Workspace is fully valid (has path, branch, metadata). The `workspaceUrl` is still generated (CodeServerModule uses empty envVars). The domain event is still emitted with all fields. The agent will not be running, but the workspace is usable.

## Testing Strategy

### Integration Tests

Test the full dispatch pipeline through the Dispatcher, same pattern as existing operation tests.

| #   | Test Case                                               | Entry Point                         | Boundary Mocks                     | Behavior Verified                                                                           |
| --- | ------------------------------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Creates workspace with correct return value             | `dispatcher.dispatch(createIntent)` | WorktreeProvider, ServerManager    | Returns Workspace with correct path, branch, metadata                                       |
| 2   | Emits workspace:created event with full payload         | `dispatcher.dispatch(createIntent)` | WorktreeProvider, ServerManager    | Domain event contains projectId, workspaceName, path, branch, workspaceUrl                  |
| 3   | Worktree creation failure propagates error              | `dispatcher.dispatch(createIntent)` | WorktreeProvider (throws)          | Error propagated, no event emitted                                                          |
| 4   | Agent server failure produces workspace without envVars | `dispatcher.dispatch(createIntent)` | ServerManager (throws)             | Operation returns valid Workspace, event emitted, workspaceUrl generated with empty envVars |
| 5   | Best-effort setup failure still produces workspace      | `dispatcher.dispatch(createIntent)` | AgentModule (throws, no try/catch) | Operation returns valid Workspace, event emitted, setup error does not propagate            |
| 6   | Unknown project throws                                  | `dispatcher.dispatch(createIntent)` | —                                  | Error: "Project not found"                                                                  |
| 7   | Initial prompt included in event payload                | `dispatcher.dispatch(createIntent)` | ServerManager                      | Domain event payload contains normalizedInitialPrompt                                       |
| 8   | keepInBackground flag included in event payload         | `dispatcher.dispatch(createIntent)` | All mocks                          | Event payload includes keepInBackground: true                                               |
| 9   | Interceptor cancels creation                            | `dispatcher.dispatch(createIntent)` | —                                  | Returns undefined, no hooks run, no event                                                   |

### Boundary Mock Requirements

| Interface                                   | Exists?          | Changes Needed                                                                                     |
| ------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| GitWorktreeProvider (WorktreeProvider mock) | Inline in test   | Create behavioral mock with `createWorkspace()` that returns InternalWorkspace                     |
| ServerManager                               | Inline in test   | Create behavioral mock with `startServer()`, `setInitialPrompt()`, env var state                   |
| _(KeepFilesService)_                        | _(Not needed)_   | KeepFiles copying is internal to WorktreeProvider's `createWorkspace()`                            |
| WorkspaceFileService / getWorkspaceUrl      | Inline in test   | Create mock that returns deterministic URL                                                         |
| ViewManager                                 | Inline in test   | Create mock with `createWorkspaceView()`, `preloadWorkspaceUrl()`, `setActiveWorkspace()` tracking |
| AppState (for StateModule)                  | Inline in test   | Create mock with `registerWorkspace()`, `setLastBaseBranch()` state tracking                       |
| WorkspaceAccessor (resolveWorkspace)        | Existing pattern | Reuse inline pattern from restart-agent tests                                                      |

### Manual Testing Checklist

- [ ] Create workspace from UI — workspace appears, view loads, agent starts
- [ ] Create workspace with initial prompt — agent receives prompt
- [ ] Create workspace with keepInBackground — workspace appears in sidebar but view doesn't activate
- [ ] Create workspace when branch already exists — uses existing branch
- [ ] Create workspace with non-existent base branch — error shown to user
- [ ] MCP workspace:create — works through intent dispatcher

## Implementation Steps

- [x] **Step 1: Create the operation file**
  - Create `src/main/operations/create-workspace.ts`
  - Define `CreateWorkspaceIntent`, `CreateWorkspacePayload`, `CreateWorkspaceHookContext`
  - Define `WorkspaceCreatedEvent`, `EVENT_WORKSPACE_CREATED`
  - Implement `CreateWorkspaceOperation` with 3 hook points: `create`, `setup`, `finalize`
  - After each required hook, validate context fields are set (like `RestartAgentOperation` validates `hookCtx.port`)
  - Derive `WorkspaceName` via `extractWorkspaceName(hookCtx.workspacePath!)` when building the event
  - Operation builds `Workspace` return value from context and emits domain event
  - Files: `src/main/operations/create-workspace.ts`
  - Test criteria: Operation file compiles, types are correct

- [x] **Step 2: Create hook modules in wireDispatcher**
  - In `bootstrap.ts`, add hook modules for the 3 hook handlers:
    - **WorktreeModule**: `create` hook — resolves workspace provider, calls `provider.createWorkspace()`, sets context fields (`workspacePath`, `branch`, `metadata`, `projectPath` as `toString()`-normalized strings). Note: KeepFiles copying is handled internally by the provider's `createWorkspace()` method.
    - **AgentModule**: `setup` hook — wraps handler body in try/catch, starts server, sets prompt, gets env vars, sets `ctx.envVars`, logs errors without propagating
    - **CodeServerModule**: `finalize` hook — creates workspace file using `ctx.envVars ?? {}` for env vars, sets `ctx.workspaceUrl`
  - Register operation: `dispatcher.registerOperation(INTENT_CREATE_WORKSPACE, new CreateWorkspaceOperation())`
  - Wire modules: `wireModules([..., worktreeModule, agentModule, codeServerModule], ...)`
  - Files: `src/main/bootstrap.ts`
  - Test criteria: Modules wire without errors

- [x] **Step 3: Create event subscriber modules**
  - **StateModule**: Subscribes to `workspace:created` event, calls `appState.registerWorkspace(projectPath, workspace)` (new public method) and `appState.setLastBaseBranch(projectPath, base)`
  - **ViewModule**: Subscribes to `workspace:created` event, calls `viewManager.createWorkspaceView` (synchronous), preloads URL, conditionally activates via `viewManager.setActiveWorkspace` if `!keepInBackground`
  - **IpcEventBridge**: Forward `workspace:created` domain event, transforming the payload to match the IPC contract: construct `Workspace` object from flat fields (`{ projectId, name: workspaceName, branch, metadata, path: workspacePath }`), map `initialPrompt` to `hasInitialPrompt: true`
  - Files: `src/main/bootstrap.ts`, `src/main/modules/ipc-event-bridge.ts`
  - Test criteria: Event handlers compile, IPC event shape matches existing contract

- [x] **Step 4: Register IPC bridge handler**
  - In `wireDispatcher()`, register `workspaces.create` method that creates and dispatches the intent
  - Maps `WorkspaceCreatePayload` → `CreateWorkspaceIntent`
  - Returns the `Workspace` result from dispatch
  - Files: `src/main/bootstrap.ts`
  - Test criteria: IPC bridge compiles

- [x] **Step 5: Remove dead code from CoreModule**
  - Remove the `workspaceCreate` method
  - Remove the `this.api.register("workspaces.create", ...)` registration
  - Remove unused imports: `WorkspaceCreatePayload`, `normalizeInitialPrompt`
  - Keep `toApiWorkspace` (used by `workspaceGet`, `toApiProject`)
  - Files: `src/main/modules/core/index.ts`
  - Test criteria: CoreModule compiles, no unused imports

- [x] **Step 6: Add registerWorkspace to AppState and remove dead code**
  - Add new public method `registerWorkspace(projectPath: string, workspace: InternalWorkspace): void` that updates `openProjects` map (extracted from the relevant part of `addWorkspace`)
  - Remove `addWorkspace()` method — only caller was `CoreModule.workspaceCreate`
  - Keep `startAgentServer()` — also called by `openProject()`
  - Keep `getWorkspaceUrl()` — also called by `openProject()`
  - Remove any imports/types that become unused after `addWorkspace` removal
  - Files: `src/main/app-state.ts`
  - Test criteria: AppState compiles, no unused code, `openProject` still works

- [x] **Step 7: Write integration tests**
  - Create `src/main/operations/create-workspace.integration.test.ts`
  - Follow the test plan (9 test cases)
  - Use behavioral mocks per the Boundary Mock Requirements table
  - Test full dispatch pipeline: intent → hooks → event → result
  - Files: `src/main/operations/create-workspace.integration.test.ts`
  - Test criteria: All 9 tests pass, <50ms per test

- [x] **Step 8: Validate and fix**
  - Run `pnpm validate:fix`
  - Fix any lint, type, or test issues
  - Ensure existing tests still pass (especially workspace-related tests)
  - Files: Various
  - Test criteria: Full validation passes

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docs/ARCHITECTURE.md` | Add create-workspace to the intent dispatcher operations list                                                            |
| `docs/API.md`          | Verify no changes needed (IPC contract unchanged); add domain event `workspace:created` to internal events if documented |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `workspace:create` dispatched through intent dispatcher
- [ ] All dead code removed: `CoreModule.workspaceCreate`, `AppState.addWorkspace`, unused imports
- [ ] No unused imports, methods, or types remain from the migration
- [ ] All 9 integration tests pass
- [ ] Existing tests pass (no regressions)
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] Manual testing checklist verified
