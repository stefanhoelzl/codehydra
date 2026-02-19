# Intent Module Refactoring - Analysis & Roadmap

> Living document. Each extraction step is planned and executed separately, updating the status here.

**References:**

- [docs/INTENT_BASED_ARCHITECTURE.md](../docs/INTENT_BASED_ARCHITECTURE.md) — Architecture concepts (operations, hooks, modules, providers, services)
- [docs/INTENT_BASED_TESTING.md](../docs/INTENT_BASED_TESTING.md) — Testing strategy for intent-based modules
- [docs/TESTING.md](../docs/TESTING.md) — General testing patterns (provider mocking, integration tests)

## Design Principles

1. **Provider** = shared dependency, no runtime state from module's perspective. Either stateless (pure functions, read-only views) or external (lifecycle managed outside module system).
2. **Service** = dependency with runtime state (in-memory maps, running processes). Exclusively owned by one module.
3. **Hook context** = per-subscriber, per-hook-point. Each subscriber receives its own context and returns a **hook result**. The **operation** is responsible for merging results from all subscribers of a hook point, then building the contexts for the next hook point. Modules within the same hook point are isolated from each other.
4. **Intents** = cross-operation communication. Dispatch an intent instead of calling another module's service.

### Hook execution model (target)

```
Operation.execute():
  // Hook point "create"
  for each subscriber of "create":
    result = subscriber.handle(subscriberContext)  // isolated context per subscriber
    collect(result)
  merged = merge(results)

  // Hook point "setup" — operation builds context from merged "create" results
  setupContext = buildSetupContext(merged)
  for each subscriber of "setup":
    result = subscriber.handle(setupContext)  // each gets a copy, not shared
    collect(result)
  ...
```

**Current violation**: All subscribers share a single mutable `HookContext` object. Modules read/write the same fields (e.g., `hookCtx.workspacePath` set by one module, read by another in the same hook point). The operation doesn't mediate — it just passes the context through.

---

## Extraction Roadmap

Ordered by dependency. Each step can be a separate plan.

### Phase 1: Hook context infrastructure

**Prerequisite for all other phases.** Fix the shared mutable `HookContext` to the target model: per-subscriber isolated contexts + operation-mediated merging between hook points.

| #   | Step                                                    | Status  | Notes                                                                                                                                                                                             |
| --- | ------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | Refactor `HookContext` to per-subscriber model          | pending | Each subscriber receives its own context copy and returns a typed result. Subscribers within the same hook point cannot see each other's writes.                                                  |
| 1b  | Update `Operation` to merge results between hook points | pending | Operation collects results from all subscribers of hook point A, merges them, and builds contexts for hook point B. The operation owns the data flow contract.                                    |
| 1c  | Migrate operations incrementally                        | pending | Each operation defines its own result types and merge logic. Start with simpler operations (`get-workspace-status`, `agent:update-status`) before tackling `workspace:create`/`workspace:delete`. |

Current violations to fix:

| Operation              | Hook point | Subscribers sharing state                                    | Fix                                                                                                                              |
| ---------------------- | ---------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `app:start`            | `check`    | configCheck, binaryPreflight, extensionPreflight, needsSetup | Each returns own result. Operation merges `needsAgentSelection`, `missingBinaries`, `needsExtensions` and computes `needsSetup`. |
| `get-workspace-status` | `get`      | GitWorktreeWorkspaceModule, agentStatusModule                | Each returns own piece (`isDirty`, `agentStatus`). Operation merges into final status.                                           |
| `workspace:create`     | `setup`    | keepFilesModule, agentModule                                 | Each returns own result. Both read `workspacePath` from context (built by operation from `create` results).                      |
| `workspace:delete`     | `shutdown` | deleteViewModule, deleteAgentModule                          | Each returns own result. Operation merges `shutdownResults`.                                                                     |
| `workspace:delete`     | `delete`   | deleteWorktreeModule, deleteCodeServerModule                 | Each returns own result. Operation merges `deleteResults`.                                                                       |
| `project:open`         | `open`     | projectResolver, projectDiscovery, projectRegistry           | Sequential dependency — needs separate hook points (`resolve`, `discover`, `register`).                                          |

### Phase 2: Hook-based project/workspace resolution

**Prerequisite for later phases.** Replace the centralized `AppState` project/workspace registry with a hook-based model where different module types contribute their own project/workspace implementations.

#### Design

Resolution is an operation with hooks. Modules register as handlers for the project/workspace types they manage:

- **LocalProjectModule** — handles local filesystem projects (open by path, validate git)
- **RemoteProjectModule** — handles git URL projects (clone, bare repos, remoteUrl tracking)
- **GitWorktreeWorkspaceModule** — handles git worktree workspaces (create/delete/discover worktrees, lock handling)

Resolution queries (e.g., "find workspace by projectId + workspaceName") become hook points where each module checks if it owns the requested resource. This makes it possible to add new project/workspace types (container-based, cloud, etc.) without modifying existing modules.

Each module maintains its own state about what it manages and responds to resolution hooks.

#### Absorbed modules

These modules are dissolved into the project/workspace modules — they don't exist as separate targets:

| Absorbed module                  | Current responsibility                                       | Target                                                                   |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **DataLifecycleModule**          | `projectStore.loadAllProjects()` on `app:start` → `activate` | Each project module restores its own projects on `app:start`             |
| **projectResolveModule** (close) | Resolves projectId → path, loads config                      | LocalProjectModule / RemoteProjectModule handle their own resolution     |
| **projectCloseManagerModule**    | Disposes workspace provider, deletes cloned dirs             | GitWorktreeWorkspaceModule (dispose), RemoteProjectModule (delete clone) |
| **projectCloseRegistryModule**   | Deregisters from AppState, removes from ProjectStore         | Each project module manages its own deregistration and persistence       |
| **projectResolverModule** (open) | Resolves path/URL, validates git, clones                     | LocalProjectModule (path), RemoteProjectModule (URL + clone)             |
| **projectRegistryModule**        | Registers project in AppState + ProjectStore                 | Each project module manages its own registration                         |
| **projectDiscoveryModule**       | Discovers existing workspaces                                | GitWorktreeWorkspaceModule (worktree discovery)                          |
| **worktreeModule**               | Creates git worktree on `workspace:create`                   | GitWorktreeWorkspaceModule                                               |
| **deleteWorktreeModule**         | Deletes git worktree on `workspace:delete`                   | GitWorktreeWorkspaceModule                                               |
| **deleteWindowsLockModule**      | Handles Windows lock files on delete                         | WindowsFileLockModule (own module)                                       |

ProjectStore is NOT a shared provider. Only LocalProjectModule and RemoteProjectModule access it — it's their file-based persistence implementation detail. Other modules query project data through resolution hooks, never through ProjectStore directly. A hypothetical S3ProjectModule would use its own S3 persistence, not ProjectStore.

#### Steps

| #   | Step                                       | Status  | Notes                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a  | Design resolution hook points              | pending | What queries need hook-based resolution? (resolve workspace, find project, list all projects, is project open, get workspace provider, get default base branch)                                                                                                                           |
| 2b  | Create **LocalProjectModule**              | pending | Hooks into `project:open` for local paths. Manages local project state + persistence. Hooks into `project:close` for deregistration. Hooks into `app:start` → `activate` to restore local projects.                                                                                       |
| 2c  | Create **RemoteProjectModule**             | pending | Hooks into `project:open` for git URLs. Manages clone lifecycle + remoteUrl tracking + persistence. Hooks into `project:close` for deregistration + clone deletion. Hooks into `app:start` → `activate` to restore remote projects.                                                       |
| 2d  | Create **GitWorktreeWorkspaceModule**      | pending | Hooks into `workspace:create`/`workspace:delete` for git worktree lifecycle. Combines: worktree creation + deletion + discovery + orphan cleanup + git status. Hooks into `project:close` for workspace provider disposal. Hooks into `get-workspace-status` → `get` to return `isDirty`. |
| 2d2 | Create **WindowsFileLockModule**           | pending | Hooks into `workspace:delete` to handle Windows file lock detection/removal. Providers: WorkspaceLockHandler. Separate from GitWorktreeWorkspaceModule because file locking is a platform concern, not a git concern.                                                                     |
| 2e  | Design project/workspace state ownership   | pending | Each module owns its own state (open projects, workspaces, branch cache). Resolution hooks query across modules. Replace `openProjects` map in AppState.                                                                                                                                  |
| 2f  | Migrate current modules off AppState reads | pending | Replace `appState.getProject()`, `appState.findProjectForWorkspace()`, etc. with resolution hooks.                                                                                                                                                                                        |

### Phase 3: Extract clean modules to files

These modules are already well-scoped with clean dependencies. Extraction is mechanical: move from inline in `bootstrap.ts` to `src/main/modules/<name>.ts`, no logic changes.

Now that Phase 2 is done, these modules use resolution hooks instead of AppState closures.

| #   | Module          | Status  | Notes                                                                                                          |
| --- | --------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| 3a  | MetadataModule  | pending | Providers: GitWorktreeProvider. Uses resolution hooks for workspace lookup.                                    |
| 3b  | KeepFilesModule | pending | Providers: IKeepFilesService, Logger                                                                           |
| 3c  | TelemetryModule | pending | Providers: PlatformInfo, BuildInfo, TelemetryService                                                           |
| 3d  | BadgeModule     | pending | Already in `src/main/modules/badge-module.ts`                                                                  |
| 3e  | IpcEventBridge  | pending | Already in `src/main/modules/ipc-event-bridge.ts`. Uses resolution hooks instead of WorkspaceResolver closure. |

### Phase 4: Combine related modules

| #   | Target Module         | Combines                                               | Status  | Notes                                                                                   |
| --- | --------------------- | ------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------- |
| 4a  | **WindowTitleModule** | switchTitleModule + title logic from autoUpdaterModule | pending | Both update window title. Needs `update:available` domain event from AutoUpdaterModule. |

#### Setup module distribution

There is no single SetupModule. Each domain module owns its own setup (preflight check + download/install):

| Current setup module                              | Target owner             | Reason                                                                           |
| ------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| configCheckModule (agent configured?)             | AgentModule              | Agent configuration is AgentModule's concern                                     |
| binaryPreflightModule (code-server)               | CodeServerModule         | Owns code-server binary lifecycle                                                |
| binaryPreflightModule (agent)                     | AgentModule              | Owns agent binary lifecycle                                                      |
| extensionPreflightModule + extensionInstallModule | CodeServerModule         | Extensions are VS Code/code-server extensions                                    |
| rendererSetupModule (agent selection UI)          | AgentModule              | Agent selection is AgentModule's concern                                         |
| configSaveModule (save agent selection)           | AgentModule              | Agent configuration persistence                                                  |
| binaryDownloadModule (code-server)                | CodeServerModule         | Owns code-server binary lifecycle                                                |
| binaryDownloadModule (agent)                      | AgentModule              | Owns agent binary lifecycle                                                      |
| needsSetupModule                                  | Operation aggregation    | Not a module — each module returns its own `needsSetup` result, operation merges |
| setupUIModule (show/hide setup screen)            | ViewModule               | UI concern                                                                       |
| setupErrorModule                                  | Operation error handling | Not a module                                                                     |
| retryModule                                       | Operation retry logic    | Not a module                                                                     |

Each module hooks into `app:start` → `check` to report what it needs, and into `app:setup` hook points to perform its own downloads/installs. The `app:start` operation merges check results and decides if setup is needed. Progress tracking is emitted per-module via domain events, consumed by ViewModule for the setup screen UI.

### Phase 5: CodeServerModule

Combine code-server lifecycle + per-workspace file operations + extension management. Absorb `getWorkspaceUrl()` from AppState.

| #   | Step                                     | Status  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5a  | Move `getWorkspaceUrl()` out of AppState | pending | Move to CodeServerModule. Needs `codeServerPort`, `wrapperPath`, `agentType`, `IWorkspaceFileService`.                                                                                                                                                                                                                                                                                                                                                                |
| 5b  | Create **CodeServerModule**              | pending | Combines: codeServerModule + deleteCodeServerModule + codeServerLifecycleModule + extensionPreflightModule + extensionInstallModule + code-server binaryPreflightModule + code-server binaryDownloadModule. Services: CodeServerManager + PluginServer + ExtensionManager. Writes `codeServerPort` to hook context during app:start. Hooks into `app:start` → `check` for binary/extension preflight. Hooks into `app:setup` for binary download + extension install. |

### Phase 6: McpModule

Combine MCP lifecycle + per-workspace cleanup. Introduces `workspace:mcp-attached` domain event.

| #   | Step                                  | Status  | Notes                                                                                                                                            |
| --- | ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6a  | Create `workspace:mcp-attached` event | pending | Replaces direct calls to `viewManager.setWorkspaceLoaded()` and `agentStatusManager.markActive()` from MCP first-request callback.               |
| 6b  | Create **McpModule**                  | pending | Combines: mcpLifecycleModule + MCP cleanup from deleteAgentModule. Service: McpServerManager. Writes `mcpPort` to hook context during app:start. |

### Phase 7: AgentModule

Largest combination. Absorbs `handleServerStarted()` logic, agent manager wiring from AppState, and agent setup (selection, config, binary download).

| #   | Step                                         | Status | Notes                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7a  | Move agent manager ownership out of AppState | done   | Moved `agentStatusManager`, `serverManager`, `serverStartedPromises`, `handleServerStarted()`, `waitForProvider()` into AgentModule closure state. AppState no longer used by index.ts (kept as stub for test compatibility, deletion deferred to Phase 9).                                                                         |
| 7b  | Create **AgentModule**                       | done   | Combines all 9 inline modules + AppState agent logic into `src/main/modules/agent-module.ts`. Factory function with eager + lazy deps following CodeServerModule pattern. `onWorkspaceReady` split: `markActive` in AgentModule (OpenCode only), `setWorkspaceLoaded` in inline `wrapperReadyViewModule` (both types, for Phase 8). |
| 7c  | Subscribe to `workspace:mcp-attached`        | n/a    | Resolved differently in Phase 6: MCP decoupled via bridge server. `markActive` wired directly in AgentModule's `activate` hook via `onWorkspaceReady` callback.                                                                                                                                                                     |

### Phase 8: ViewModule

Largest module by hook count. Needs all other modules extracted first (to validate the domain event interfaces).

| #   | Step                                  | Status  | Notes                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8a  | Create **ViewModule**                 | pending | Combines 9+ modules: viewModule + deleteViewModule + switchViewModule + projectViewModule + projectCloseViewModule + uiHookModule + viewLifecycleModule + showMainViewModule + appStartUIModule. Service: ViewManager (all mutations + reads). Emits `view:mode-changed`, `view:workspace-changed`, `view:loading-changed` domain events. |
| 8b  | Subscribe to `workspace:mcp-attached` | pending | Handle `setWorkspaceLoaded()` from McpModule's domain event.                                                                                                                                                                                                                                                                              |

### Phase 9: Cleanup

| #   | Step                                  | Status  | Notes                                                                               |
| --- | ------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| 9a  | Delete `AppState` class               | done    | All concerns extracted to project/workspace modules, AgentModule, CodeServerModule. |
| 9b  | Dissolve `LifecycleServiceRefs`       | pending | Each module declares specific deps. Remove the bag type.                            |
| 9c  | Simplify `wireDispatcher()` signature | pending | No longer needs 16+ params. Modules are self-contained.                             |

---

## Reference: AppState Decomposition

`AppState` (`src/main/app-state.ts`) is dissolved across Phases 2, 5, 6, 7:

| AppState concern                                            | Target                                                | Phase |
| ----------------------------------------------------------- | ----------------------------------------------------- | ----- |
| `openProjects` map                                          | Distributed: each project module owns its own state   | 2     |
| `lastBaseBranches` map                                      | Owned by project modules (per-project state)          | 2     |
| `registerProject/deregisterProject`                         | Hook-based: project modules manage own registration   | 2     |
| `registerWorkspace/unregisterWorkspace`                     | Hook-based: workspace modules manage own registration | 2     |
| `getProject/getAllProjects/findProjectForWorkspace`         | Resolution hooks (query across project modules)       | 2     |
| `isProjectOpen/getWorkspaceProvider`                        | Resolution hooks                                      | 2     |
| `getDefaultBaseBranch/setLastBaseBranch`                    | Per-project module state                              | 2     |
| `getProjectStore()`                                         | ProjectStore as provider to Local/RemoteProjectModule | 2     |
| `getWorkspaceUrl/updateCodeServerPort`                      | CodeServerModule                                      | 5     |
| `codeServerPort`, `wrapperPath`                             | CodeServerModule                                      | 5     |
| `mcpServerManager` + getter/setter                          | McpModule                                             | 6     |
| `agentStatusManager` + getter/setter                        | AgentModule                                           | 7     |
| `serverManager` + setter + `onServerStarted/Stopped` wiring | AgentModule                                           | 7     |
| `handleServerStarted()` logic                               | AgentModule                                           | 7     |
| `waitForProvider()` + `serverStartedPromises`               | AgentModule                                           | 7     |
| `agentType`                                                 | Config/provider                                       | 7     |
| `_viewManager`, `_pathProvider`, `_fileSystemLayer`         | Removed (unused)                                      | 9     |

## Reference: ViewManager Decomposition

`IViewManager` (`src/main/managers/view-manager.interface.ts`) stays as one implementation, exclusively owned by ViewModule (Phase 8):

**ViewModule (exclusive owner — reads + writes):**

- `createWorkspaceView()`, `destroyWorkspaceView()`, `preloadWorkspaceUrl()`
- `setActiveWorkspace()`, `setWorkspaceLoaded()`
- `setMode()`, `updateCodeServerPort()`, `updateBounds()`
- `getActiveWorkspacePath()`, `getMode()`, `getUIWebContents()`, `sendToUI()`, `isWorkspaceLoading()`, `getWorkspaceView()`
- Layer disposal (`viewLayer`, `windowLayer`, `sessionLayer`)

ViewModule exclusively owns ViewManager. Other modules receive view state changes via domain events (`view:mode-changed`, `view:workspace-changed`, `view:loading-changed`), not by querying a provider.

| Current module            | Current ViewManager call                             | Resolution                                                   |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| switchViewModule          | `setActiveWorkspace(path)`                           | Merged into ViewModule                                       |
| deleteViewModule          | `destroyWorkspaceView()`, `setActiveWorkspace(null)` | Merged into ViewModule                                       |
| projectCloseViewModule    | `setActiveWorkspace(null)`                           | Merged into ViewModule                                       |
| viewModule                | `createWorkspaceView()`, `preloadWorkspaceUrl()`     | Merged into ViewModule                                       |
| projectViewModule         | `preloadWorkspaceUrl()`                              | Merged into ViewModule                                       |
| codeServerLifecycleModule | `updateCodeServerPort()`                             | CodeServerModule writes port to context, ViewModule reads it |
| mcpLifecycleModule        | `setWorkspaceLoaded()`                               | ViewModule subscribes to `workspace:mcp-attached` event      |
| uiHookModule              | `setMode()`, `getMode()`, `getActiveWorkspacePath()` | Merged into ViewModule                                       |
| viewLifecycleModule       | `onLoadingChange()`, layer disposal                  | Merged into ViewModule                                       |
| showMainViewModule        | `sendToUI()`                                         | Merged into ViewModule                                       |

## Reference: Provider Definitions

| Provider                  | Source   | Used by                                    | Interface                 |
| ------------------------- | -------- | ------------------------------------------ | ------------------------- |
| **GitWorktreeProvider**   | Existing | GitWorktreeWorkspaceModule, MetadataModule | Git worktree operations   |
| **PathProvider**          | Existing | Multiple modules                           | Path resolution           |
| **GitClient**             | Existing | RemoteProjectModule                        | Git clone                 |
| **IKeepFilesService**     | Existing | KeepFilesModule                            | Keepfiles copying         |
| **IWorkspaceFileService** | Existing | CodeServerModule                           | Workspace file management |
| **WorkspaceLockHandler**  | Existing | WindowsFileLockModule                      | Windows lock detection    |
| **FileSystemLayer**       | Existing | Multiple modules                           | Filesystem operations     |
| **ConfigService**         | Existing | AgentModule                                | Config persistence        |
| **Logger**                | Existing | Multiple modules                           | Logging                   |
| **IpcLayer**              | Existing | IpcEventBridge                             | IPC event registration    |
| **BadgeManager**          | Existing | BadgeModule                                | Badge updates             |

**Removed**: `WorkspaceResolver` and `ProjectLookup` — replaced by hook-based resolution (Phase 2). Modules that need to resolve workspaces or query projects do so through resolution hooks on the dispatcher, where project/workspace modules respond with their own data. `ViewStateProvider` — ViewModule exclusively owns ViewManager; other modules receive view state via domain events. `ProjectStore` — internal implementation detail of LocalProjectModule and RemoteProjectModule, not a shared provider.

## Reference: New Domain Events

| Event                    | Phase | Emitted by                          | Consumed by                                               |
| ------------------------ | ----- | ----------------------------------- | --------------------------------------------------------- |
| `workspace:mcp-attached` | 6     | McpModule (onFirstRequest callback) | ViewModule (setWorkspaceLoaded), AgentModule (markActive) |
| `update:available`       | 4a    | AutoUpdaterModule                   | WindowTitleModule (update title)                          |
| `view:mode-changed`      | 8     | ViewModule                          | Modules needing mode awareness                            |
| `view:workspace-changed` | 8     | ViewModule                          | Modules needing active workspace awareness                |
| `view:loading-changed`   | 8     | ViewModule                          | Modules needing loading state awareness                   |

## Reference: Data Flow Between Hook Points

In the target model (after Phase 1), subscribers within the same hook point are isolated. Data flows **between** hook points via the operation, which merges results and builds the next context.

| Operation              | Hook point A → Hook point B         | Data flow (operation merges A results into B context)                                                                      |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspace:create`     | `create` → `setup`                  | `workspacePath`, `projectPath`, `branch`, `metadata`                                                                       |
| `workspace:create`     | `setup` → `finalize`                | `envVars` (from AgentModule result)                                                                                        |
| `workspace:delete`     | `shutdown` → `release`              | `shutdownResults` (next workspace, view destroyed, server stopped)                                                         |
| `workspace:delete`     | `release` → `delete`                | `releaseResults` (blockers detected/handled)                                                                               |
| `project:open`         | `resolve` → `discover` → `register` | `projectPath`, `provider` (from LocalProjectModule or RemoteProjectModule) → `workspaces` → `projectId`                    |
| `project:open`         | `resolve` (same hook point)         | LocalProjectModule + RemoteProjectModule each check if they handle the input. First-responder wins (other returns null).   |
| `project:close`        | `resolve` → `close`                 | `projectPath`, `workspaces`, `remoteUrl`                                                                                   |
| `app:start`            | `check` → `setup`                   | Each check subscriber returns own result. Operation merges into `needsSetup` decision.                                     |
| `app:start`            | `start` → `activate`                | `codeServerPort` (CodeServerModule), `mcpPort` (McpModule)                                                                 |
| `get-workspace-status` | `get` (same hook point)             | GitWorktreeWorkspaceModule returns `isDirty`, agentStatusModule returns `agentStatus`. Operation merges into final status. |

## Reference: Target Module Summary

| #   | Module                     | Service                                             | Combines                                                                                                                                                                       | Phase |
| --- | -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1   | LocalProjectModule         | local project state + ProjectStore                  | projectResolverModule (path) + projectRegistryModule (local) + projectCloseRegistryModule (local) + dataLifecycleModule (local)                                                | 2     |
| 2   | RemoteProjectModule        | remote project state + ProjectStore                 | projectResolverModule (URL) + cloneModule + remoteUrl tracking + projectCloseManagerModule (delete clone) + projectCloseRegistryModule (remote) + dataLifecycleModule (remote) | 2     |
| 3   | GitWorktreeWorkspaceModule | workspace state                                     | worktreeModule + deleteWorktreeModule + discovery + orphan cleanup + provider disposal + gitStatusModule                                                                       | 2     |
| 4   | WindowsFileLockModule      | —                                                   | deleteWindowsLockModule                                                                                                                                                        | 2     |
| 5   | MetadataModule             | —                                                   | unchanged                                                                                                                                                                      | 3     |
| 6   | KeepFilesModule            | —                                                   | unchanged                                                                                                                                                                      | 3     |
| 7   | TelemetryModule            | TelemetryService                                    | unchanged                                                                                                                                                                      | 3     |
| 8   | BadgeModule                | badge state                                         | unchanged                                                                                                                                                                      | 3     |
| 9   | IpcEventBridge             | bridge state                                        | unchanged                                                                                                                                                                      | 3     |
| 10  | WindowTitleModule          | title callback                                      | 2 modules                                                                                                                                                                      | 4     |
| 11  | CodeServerModule           | CodeServerManager + PluginServer + ExtensionManager | codeServerModule + deleteCodeServerModule + codeServerLifecycleModule + extensionPreflight/Install + code-server binaryPreflight/Download                                      | 5     |
| 12  | McpModule                  | McpServerManager                                    | 2 modules                                                                                                                                                                      | 6     |
| 13  | AgentModule                | AgentServerManager + AgentStatusManager             | agentModule + deleteAgentModule + agentStatusModule + agentLifecycleModule + configCheck + rendererSetup + configSave + agent binaryPreflight/Download                         | 7     |
| 14  | ViewModule                 | ViewManager                                         | 9+ modules (incl. projectCloseViewModule, appStartUIModule, setupUIModule)                                                                                                     | 8     |

## Resolved Decisions

1. **ViewModule size**: Single responsibility (all view state). No split.
2. **AgentModule complexity**: Keep `handleServerStarted()` in module. No separate factory.
3. **project:open hook ordering**: First-responder wins — modules return `null` if they can't handle the input, operation selects the responding module's result.
4. **Setup progress tracking**: Operation collects progress from hook results and emits events. ViewModule consumes these events for the setup screen UI.
5. **ApiRegistry**: Decide when needed.
6. **GitStatusModule merged into GitWorktreeWorkspaceModule**: `isDirty` is a property of a git worktree — the module that owns worktrees should know about their status.
7. **Idempotency interceptors removed**: Each module/operation handles its own duplicate-call guards. Operations fail with clear errors if called inappropriately. UI prevents double-dispatches. Silent deduplication masks bugs.
8. **ViewStateProvider removed**: ViewModule exclusively owns ViewManager (reads + writes). Other modules receive view state via domain events (`view:mode-changed`, `view:workspace-changed`, `view:loading-changed`), not by querying a provider.
