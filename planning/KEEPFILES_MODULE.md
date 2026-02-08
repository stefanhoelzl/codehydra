---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-08
reviewers: [review-arch, review-quality, review-testing]
---

# KEEPFILES_MODULE

## Overview

- **Problem**: Keepfiles copying is embedded inside `GitWorktreeProvider.createWorkspace()` (service layer). This couples the worktree provider to an app-level concern, hides the keepfiles step from the intent dispatcher, and makes it impossible to intercept or independently test keepfiles behavior at the orchestration level. Additionally, `IKeepFilesService.copyToWorkspace()` accepts raw `string` parameters instead of `Path` objects, violating the CLAUDE.md rule that services receive `Path` objects.

- **Solution**: Extract keepfiles into its own `KeepFilesModule` (IntentModule) that registers a handler on the existing `"setup"` hook point in the `CreateWorkspaceOperation`, alongside `AgentModule`. Remove keepfiles handling from `GitWorktreeProvider` and `AppState.openProject()`. Migrate `IKeepFilesService` to accept `Path` parameters.

- **Interfaces**: Removes `keepFilesService` from `GitWorktreeProviderOptions` (approved). Since `keepFilesService` is the only field, the entire `GitWorktreeProviderOptions` interface is removed along with the `options` parameter from all methods that accept it. Changes `IKeepFilesService.copyToWorkspace()` signature from `(string, string)` to `(Path, Path)`. No new abstraction interfaces.

- **Risks**:
  1. Error handling: The `"setup"` hook is already best-effort — the operation resets `hookCtx.error` after it runs. KeepFilesModule wraps its body in try/catch internally (same pattern as AgentModule) so a keepfiles error doesn't prevent AgentModule from running.
  2. Dead code: `GitWorktreeProviderOptions`, `keepFilesService` wiring in `AppState.openProject()`, and related test fixtures all become dead code and must be removed.

- **Alternatives Considered**:
  - **New "prepare" hook point** — Rejected: adds a hook point for a single handler; keepfiles is logically a setup task that runs after worktree creation.
  - **Second handler on "create" hook** — Rejected: relies on registration order within a hook point.

## Architecture

```
CreateWorkspaceOperation.execute()
  │
  ├── Hook "create"
  │     └── WorktreeModule: creates git worktree
  │         → sets workspacePath, branch, metadata, projectPath
  │
  ├── [validate: workspacePath, branch, metadata, projectPath]
  │
  ├── Hook "setup" (best-effort, error reset after)
  │     ├── KeepFilesModule: copies .keepfiles to workspace ← NEW
  │     │     reads: ctx.workspacePath, ctx.projectPath
  │     │     converts to Path before calling service
  │     │     (try/catch internal, errors logged via wireDispatcher's logger)
  │     └── AgentModule: starts agent, gets env vars
  │           (try/catch internal, errors logged)
  │
  ├── Hook "finalize"
  │     └── CodeServerModule: creates .code-workspace file
  │
  └── Emit workspace:created event
```

### Intent Payload

Same as existing — no changes to `CreateWorkspacePayload` or `CreateWorkspaceIntent`.

### Data Flow

KeepFilesModule reads from `CreateWorkspaceHookContext`:

- `ctx.workspacePath` (string, set by WorktreeModule on "create" hook, validated before "setup" runs — guaranteed non-undefined)
- `ctx.projectPath` (string, set by WorktreeModule on "create" hook, validated before "setup" runs — guaranteed non-undefined)

The handler converts these to `Path` objects before calling `keepFilesService.copyToWorkspace(new Path(projectPath), new Path(workspacePath))`. This is the IPC→service boundary conversion per CLAUDE.md rules.

KeepFilesModule does NOT write to the hook context — it's a fire-and-forget side effect.

Both KeepFilesModule and AgentModule are independent: neither reads the other's output, and both wrap their bodies in try/catch so one failing doesn't prevent the other from running.

### Dependency: KeepFilesService

`KeepFilesService` is stateless (needs `FileSystemLayer` + `Logger`). A single instance can serve all projects.

- Created in `src/main/index.ts` where `fileSystemLayer` and `loggingService` are in scope
- Passed to `wireDispatcher()` via a `keepFilesServiceFn` factory on `BootstrapDeps` (same deferred pattern as `globalWorktreeProviderFn`)
- Logger name: `"keepfiles"` (preserved from current `AppState.openProject()` usage)

### IKeepFilesService Path Migration

The `IKeepFilesService` interface is updated to accept `Path` objects:

```typescript
// Before
copyToWorkspace(projectRoot: string, targetPath: string): Promise<CopyResult>;

// After
copyToWorkspace(projectRoot: Path, targetPath: Path): Promise<CopyResult>;
```

The `KeepFilesService` implementation converts to strings at entry using `.toString()` for internal `node:path` operations. This keeps the change minimal — only the public interface and call sites change, not the internal logic.

## Testing Strategy

### Integration Tests

Modify existing `create-workspace.integration.test.ts` to add a `KeepFilesModule` to the test setup. Add `keepFilesService` as a configurable option on `TestSetupOptions` (like `serverManager`).

| #   | Test Case                                              | Entry Point                         | Boundary Mocks                                        | Behavior Verified                                                                                                                  |
| --- | ------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 10  | Keepfiles copies files after worktree creation         | `dispatcher.dispatch(createIntent)` | Behavioral IKeepFilesService mock                     | Mock state contains copy record `{from: PROJECT_ROOT, to: WORKSPACE_PATH}`                                                         |
| 11  | Keepfiles failure does not fail workspace creation     | `dispatcher.dispatch(createIntent)` | Behavioral IKeepFilesService mock (throws)            | Workspace returned successfully, event emitted, distinct from existing #5 which tests a generic throwing handler without try/catch |
| 12  | No keepfiles side effects when worktree creation fails | `dispatcher.dispatch(createIntent)` | Behavioral IKeepFilesService mock, throwOnCreate=true | Mock state has no copy records (empty)                                                                                             |

Note: Existing test #5 ("best-effort setup failure still produces workspace") tests the generic hook runner error handling (a handler that throws without internal try/catch). New test #11 tests the actual KeepFilesModule's internal try/catch behavior. Both are valuable: #5 verifies the operation's error reset, #11 verifies the module's error containment.

### Boundary Mock Requirements

| Mock                | Type            | Behavior                                                                                                                                                                   |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IKeepFilesService` | Behavioral mock | Tracks copy operations in `copies: Array<{from: Path, to: Path}>`. `copyToWorkspace(projectRoot, targetPath)` appends to `copies` array on success. Configurable to throw. |

### Manual Testing Checklist

- [ ] Create a workspace in a project with `.keepfiles` — verify files are copied
- [ ] Create a workspace in a project without `.keepfiles` — verify no errors
- [ ] Run `pnpm validate:fix` — all tests pass

## Implementation Steps

- [x] **Step 1: Migrate IKeepFilesService to accept Path**
  - In `src/services/keepfiles/types.ts`: change `copyToWorkspace(projectRoot: string, targetPath: string)` to `copyToWorkspace(projectRoot: Path, targetPath: Path)`. Add `Path` import.
  - In `src/services/keepfiles/keepfiles-service.ts`: update `copyToWorkspace` signature to accept `Path`. At method entry, convert to strings: `const projectRootStr = projectRoot.toString(); const targetPathStr = targetPath.toString();`. Replace all internal usages of the parameters with the string variables. Remove `import * as path from "node:path"` and use `Path` for `configPath` construction, OR keep `node:path` for internal operations and just convert at entry (simpler — keep `node:path` for internal `path.join`, `path.normalize`, `path.sep` operations since these are pure string utilities, not I/O).
  - In `src/services/keepfiles/index.ts`: add `Path` re-export if needed for consumers.
  - Files: `src/services/keepfiles/types.ts`, `src/services/keepfiles/keepfiles-service.ts`, `src/services/keepfiles/index.ts`
  - Test criteria: TypeScript compiles, existing keepfiles tests updated and passing

- [x] **Step 2: Update keepfiles service tests for Path**
  - In `src/services/keepfiles/keepfiles-service.test.ts`: update all `copyToWorkspace()` calls to pass `new Path(...)` instead of raw strings.
  - In `src/services/keepfiles/keepfiles-service.boundary.test.ts`: update all `copyToWorkspace()` calls to pass `new Path(...)` instead of raw strings.
  - Files: `src/services/keepfiles/keepfiles-service.test.ts`, `src/services/keepfiles/keepfiles-service.boundary.test.ts`
  - Test criteria: All keepfiles service tests pass with `Path` parameters

- [x] **Step 3: Add KeepFilesModule in bootstrap.ts and wire KeepFilesService**
  - Add `keepFilesServiceFn: () => IKeepFilesService` to `BootstrapDeps` interface
  - In `wireDispatcher()`, add `keepFilesService: IKeepFilesService` as the last parameter
  - Create `KeepFilesModule` (IntentModule) that registers a handler on `CREATE_WORKSPACE_OPERATION_ID` → `"setup"` hook
  - Handler reads `ctx.workspacePath!` and `ctx.projectPath!` (guaranteed by prior validation), converts to `Path` objects, calls `keepFilesService.copyToWorkspace(new Path(projectPath), new Path(workspacePath))` wrapped in try/catch
  - In the catch block, log via `logger.error("Keepfiles copy failed for workspace (non-fatal)", ...)` (same pattern as AgentModule)
  - Wire the module in `wireModules()` call before `agentModule`
  - At the `startServices()` call site, call `deps.keepFilesServiceFn()` and pass to `wireDispatcher()`
  - In `src/main/index.ts`, add `keepFilesServiceFn` to the `BootstrapDeps` object: `keepFilesServiceFn: () => new KeepFilesService(fileSystemLayer, loggingService.createLogger("keepfiles"))`
  - Files: `src/main/bootstrap.ts`, `src/main/index.ts`
  - Test criteria: KeepFilesModule is wired, existing tests still pass

- [x] **Step 4: Remove keepfiles from GitWorktreeProvider**
  - Remove `GitWorktreeProviderOptions` interface entirely (it only has `keepFilesService`)
  - Remove `keepFilesService` from `ProjectRegistration` interface
  - Update `ProjectRegistration` JSDoc to remove keepfiles mention
  - Remove `options` parameter from `registerProject()` method and its callers
  - Remove `options` parameter from static `create()` factory method
  - Remove keepfiles copying block from `createWorkspace()` method (lines 529-541)
  - Remove `IKeepFilesService` import
  - Remove TODO comment (line 531)
  - Files: `src/services/git/git-worktree-provider.ts`
  - Test criteria: Provider tests still pass, provider no longer references keepfiles

- [x] **Step 5: Remove keepfiles wiring from AppState.openProject() and update ProjectScopedWorkspaceProvider**
  - Remove `KeepFilesService` creation in `openProject()`
  - Remove `{ keepFilesService }` option objects from `ProjectScopedWorkspaceProvider` and `createGitWorktreeProvider` calls
  - Remove `KeepFilesService` import from `app-state.ts`
  - In `ProjectScopedWorkspaceProvider`: remove `options` parameter from constructor, remove `GitWorktreeProviderOptions` import
  - In `src/services/index.ts`: remove `GitWorktreeProviderOptions` export, remove `options` parameter from `createGitWorktreeProvider()` factory function
  - Files: `src/main/app-state.ts`, `src/services/git/project-scoped-provider.ts`, `src/services/index.ts`
  - Test criteria: AppState tests still pass

- [x] **Step 6: Update all affected test files**
  - **`src/main/operations/create-workspace.integration.test.ts`**:
    - Add behavioral `IKeepFilesService` mock to `createTestSetup()` (add `keepFilesService` to `TestSetupOptions`)
    - Add KeepFilesModule to modules array (registers on "setup" hook with try/catch)
    - Add test #10: Keepfiles copies files with correct paths (assert on mock `copies` state)
    - Add test #11: Keepfiles failure does not fail workspace creation (assert workspace returned, event emitted)
    - Add test #12: No keepfiles side effects when worktree creation fails (assert mock `copies` is empty)
    - Update test header comment: rename existing #5 description from "KeepFiles failure produces workspace normally" to "Best-effort setup hook failure still produces workspace"
  - **`src/services/git/git-worktree-provider.test.ts`**:
    - Remove keepfiles test suite (lines ~2565-2715)
    - Remove keepFilesService mock setup and `GitWorktreeProviderOptions` references
    - Update any `create()` / `registerProject()` calls that pass options
  - **`src/services/git/git-worktree-provider.integration.test.ts`**:
    - Remove keepfiles integration test suite (lines ~335-411)
    - Remove keepFilesService mock references
    - Update any test setup that passes `{ keepFilesService }` options
  - **`src/main/app-state.test.ts`**:
    - Remove `keepFilesService` expectations (lines ~196, ~771)
    - Update any assertions about `ProjectScopedWorkspaceProvider` or `createGitWorktreeProvider` call signatures
  - **`src/main/bootstrap.test.ts`** and **`src/main/bootstrap.integration.test.ts`**:
    - Add `keepFilesServiceFn` to mock `BootstrapDeps` objects
  - Files: All test files listed above
  - Test criteria: All tests pass, no keepfiles references remain in provider/app-state tests

- [x] **Step 7: Update documentation**
  - Update `docs/ARCHITECTURE.md` intent dispatcher table: add KeepFilesModule as setup hook handler for create-workspace
  - Update JSDoc in `create-workspace.ts`: remove "(includes keepfiles copying)" from "create" hook description, add "KeepFilesModule (keepfiles copying)" to "setup" hook description alongside AgentModule
  - Files: `docs/ARCHITECTURE.md`, `src/main/operations/create-workspace.ts`
  - Test criteria: `pnpm validate:fix` passes

## Dependencies

None. No new packages required.

## Documentation Updates

### Files to Update

| File                                      | Changes Required                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`                    | Update intent dispatcher table: add KeepFilesModule as setup hook handler for create-workspace                          |
| `src/main/operations/create-workspace.ts` | Update JSDoc: remove "(includes keepfiles copying)" from "create" hook, add KeepFilesModule to "setup" hook description |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
