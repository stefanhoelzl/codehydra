---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-10
reviewers: [review-arch, review-quality, review-testing]
---

# APP_LIFECYCLE_INTENTS

## Overview

- **Problem**: The `startServices()` and `cleanup()` functions in `index.ts` are ~350-line imperative functions that construct services, start servers, wire callbacks, load state, and tear everything down. This makes it hard to test individual concerns, understand ordering dependencies, or extend the startup/shutdown with new modules. Meanwhile, the rest of the app (workspace CRUD, project open/close, agent status) already uses the intent dispatcher architecture with modular hooks.

- **Solution**: Migrate `startServices()` and `cleanup()` to two new intent-based operations (`app:start` and `app:shutdown`) using the existing dispatcher infrastructure. Service construction stays in `index.ts` (constructors/factories only, no I/O). The operations orchestrate hook-based startup and shutdown, with each module owning its service's start/stop logic.

- **Interfaces**: No new IPC channels, API interfaces, or boundary abstractions. Uses existing `IntentModule`, `Operation`, `Dispatcher` infrastructure.

- **Risks**:
  1. **Startup order regression** — Moving logic into hooks changes execution context. Mitigation: modules within the same hook MUST be independent (no data dependency between them).
  2. **Shutdown incompleteness** — Removing the `before-quit` synchronous best-effort dispose. Mitigation: `window-all-closed` awaits `cleanup()` before quitting. `before-quit` fires `cleanup()` as fire-and-forget (same as current behavior). Idempotency interceptor ensures only one execution runs.

- **Alternatives Considered**:
  - **Option B: Extract lifecycle modules to files** — Each module gets its own file (like `badge-module.ts`). Cleaner separation but larger scope. Rejected in favor of minimal change; can be done as follow-up.
  - **Option C: Full module extraction** — Extract ALL modules (lifecycle + per-workspace) to files. Even larger scope. Rejected for same reason.

## Architecture

No new components. Two new operations flow through the existing dispatcher:

```
index.ts
  │
  ├─ construct all services (constructors/factories only, no I/O)
  ├─ wire dispatcher (register operations + modules)
  │
  ├─ dispatch(app:start)
  │    └─ AppStartOperation
  │         ├─ hook "start"    → CodeServer, Agent, Badge, MCP,
  │         │                    Telemetry, AutoUpdater, IpcBridge modules
  │         └─ hook "activate" → Data, View modules
  │
  └─ dispatch(app:shutdown)
       └─ AppShutdownOperation
            └─ hook "stop"     → All modules dispose (independent)
```

### Module Responsibilities

| Module            | Owns                              | start hook                                                                                                                               | activate hook                                                       | stop hook                                                                                   |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| CodeServerModule  | PluginServer, CodeServerManager   | start PluginServer (graceful degradation), ensure dirs, start CodeServerManager (with plugin port if available), update ViewManager port | —                                                                   | stop CodeServerManager, close PluginServer                                                  |
| AgentModule       | AgentStatusManager, ServerManager | wire status→dispatcher                                                                                                                   | —                                                                   | dispose ServerManager, unsubscribe, dispose AgentStatusManager                              |
| BadgeModule       | BadgeManager                      | create BadgeManager                                                                                                                      | —                                                                   | dispose BadgeManager                                                                        |
| McpModule         | McpServerManager                  | start server, wire onFirstRequest/onWorkspaceReady callbacks, configure ServerManager with MCP port, inject into AppState                | —                                                                   | dispose server, cleanup onFirstRequest callback, cleanup onWorkspaceReady callback          |
| TelemetryModule   | (TelemetryService ref)            | capture `app_launched`                                                                                                                   | —                                                                   | flush & shutdown                                                                            |
| AutoUpdaterModule | AutoUpdater                       | start, wire update-available→title                                                                                                       | —                                                                   | dispose                                                                                     |
| IpcEventBridge    | (API event wiring)                | wire API events to IPC (`wireApiEvents()`), wire Plugin→API (`wirePluginApi()`)                                                          | —                                                                   | cleanup API event wiring                                                                    |
| DataModule        | (AppState, ProjectStore refs)     | —                                                                                                                                        | load persisted projects                                             | —                                                                                           |
| ViewModule        | (ViewManager ref)                 | —                                                                                                                                        | wire loading-state→IPC callback, set first workspace active + title | destroy views, cleanup loading-state callback, dispose ViewLayer, WindowLayer, SessionLayer |

### Hook Dependency Rationale

**Why 2 start hooks:**

- `start` hook: all servers start (CodeServer starts PluginServer internally first, then code-server; MCP starts independently) and services wire up. These produce ports and state needed by `activate`.
- `activate` hook: load persisted projects (needs CodeServer port for workspace URLs, MCP port for agent connections), set first workspace active (needs projects loaded).
- Within each hook, modules are independent — no data dependency between them. (Error propagation still applies: if a module throws, subsequent modules in the same hook are skipped per the abort-on-failure contract.)

**Why 1 shutdown hook:**

- All dispose actions are independent. No module's shutdown depends on another.

### Error Handling

- **Start:** Abort on failure. Any module error in a hook stops the operation and propagates to the renderer (which shows the error screen with retry/quit). Services that are currently optional (PluginServer, MCP) must wrap their hook logic in try/catch if they should degrade gracefully rather than abort startup. CodeServerModule handles PluginServer internally with graceful degradation (PluginServer failure → code-server starts without plugin port).
- **Shutdown:** Best-effort. Each module's `stop` hook handler wraps its own logic in try/catch and logs errors (following the existing pattern from `agentModule` and `keepFilesModule` in `bootstrap.ts`). This ensures all modules get a chance to dispose even if earlier ones fail.

### Shutdown Entry Points

Current dual-path (`before-quit` synchronous best-effort + `window-all-closed` async cleanup) replaced with single intent dispatch:

```
window-all-closed → cleanup() → await dispatch(app:shutdown) → app.quit()
before-quit       → void cleanup()  (fire-and-forget, same as current behavior)
```

`cleanup()` becomes a thin wrapper that dispatches `app:shutdown`. Idempotency is handled by a shutdown idempotency interceptor inline in `bootstrap.ts`. Since `app:shutdown` has no completion event (the process exits), the interceptor uses a simple boolean flag rather than Set-based key tracking.

Note: `before-quit` is synchronous in Electron — it cannot await async operations. The current code already uses `void cleanup()` in `before-quit`. The intent-based approach preserves this: `before-quit` fires cleanup as fire-and-forget, `window-all-closed` awaits it. The idempotency interceptor ensures only one execution proceeds.

### Construction Phase

Before the `app:start` intent is dispatched, `index.ts` constructs all services. This is purely calling constructors/factories — **no I/O, no async**.

**Pre-intent construction order:**

1. NetworkLayer, ProcessRunner (already exist from bootstrap)
2. PluginServer (constructor only — `start()` moves to CodeServerModule's `start` hook)
3. CodeServerManager (constructor only — `ensureRunning()` moves to CodeServerModule's `start` hook)
4. ProjectStore, GitClient, GitWorktreeProvider, WorkspaceFileService
5. AppState (with ProjectStore, ViewManager, etc.)
6. AgentStatusManager, ServerManager (Claude/OpenCode)
7. BadgeManager
8. AutoUpdater (constructor only — `start()` moves to AutoUpdaterModule's `start` hook)
9. McpServerManager (constructor only — `start()` moves to McpModule's `start` hook)
10. Inject services into AppState (setAgentStatusManager, setServerManager)
11. Wire dispatcher: register operations, wire all modules
12. `bootstrapResult.startServices()` → CoreModule + dispatcher wiring

Then `dispatch(app:start)` runs the hook-based startup.

### Start Hook Context

The `start` hook uses a shared `AppStartHookContext`:

```typescript
interface AppStartHookContext extends HookContext {
  // Set by CodeServerModule — consumed by activate hook modules
  codeServerPort?: number;
  // Set by McpModule — consumed by activate hook modules
  mcpPort?: number;
}
```

### Existing Modules Extended

These existing inline modules in `wireDispatcher()` gain new hooks:

| Module                                           | Existing hooks                                                                      | New hooks                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `agentModule` (create workspace "setup")         | workspace:create setup, workspace:delete shutdown, get-status/session/restart hooks | app:start `start`, app:shutdown `stop` |
| `codeServerModule` (create workspace "finalize") | workspace:create finalize, workspace:delete delete                                  | app:start `start`, app:shutdown `stop` |
| `badgeModule` (`createBadgeModule()`)            | agent:status-updated event, workspace:deleted event                                 | app:start `start`, app:shutdown `stop` |
| `ipcEventBridge` (`createIpcEventBridge()`)      | domain event → IPC forwarding                                                       | app:start `start`, app:shutdown `stop` |

New standalone lifecycle modules (inline in wireDispatcher):

- `mcpModule`, `telemetryModule`, `autoUpdaterModule`, `dataModule`, `viewModule`

## Testing Strategy

### Integration Tests

Tests split across three files for clarity and performance.

**`app-start.integration.test.ts`:**

| #   | Test Case                                 | Entry Point                      | Boundary Mocks                          | Behavior Verified                                                                                                |
| --- | ----------------------------------------- | -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | start hook runs before activate hook      | `dispatcher.dispatch(app:start)` | All service mocks with state tracking   | activate hook modules observe state set by start hook (e.g., DataModule sees codeServerPort in context)          |
| 2   | start abort on CodeServer failure         | `dispatcher.dispatch(app:start)` | CodeServerManager.ensureRunning rejects | Error propagates to caller, activate hook never runs, no projects loaded                                         |
| 3   | start abort on MCP failure (non-optional) | `dispatcher.dispatch(app:start)` | McpServerManager.start rejects          | Error propagates, remaining start modules skipped                                                                |
| 4   | activate hook failure propagates          | `dispatcher.dispatch(app:start)` | AppState.loadPersistedProjects rejects  | Error propagates, no active workspace set                                                                        |
| 5   | PluginServer graceful degradation         | `dispatcher.dispatch(app:start)` | PluginServer.start rejects              | CodeServerModule catches PluginServer error internally, code-server starts without plugin port, startup succeeds |

**`app-shutdown.integration.test.ts`:**

| #   | Test Case                                           | Entry Point                         | Boundary Mocks                                           | Behavior Verified                                                                                           |
| --- | --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 6   | shutdown disposes all services                      | `dispatcher.dispatch(app:shutdown)` | All service mocks with disposal state                    | Each service's internal state reflects stopped/disposed (e.g., server.running=false, mcp.connections=0)     |
| 7   | shutdown continues when ServerManager.dispose fails | `dispatcher.dispatch(app:shutdown)` | ServerManager.dispose rejects                            | MCP server still disposed, PluginServer still closed, TelemetryService still flushed, views still destroyed |
| 8   | shutdown continues when multiple modules fail       | `dispatcher.dispatch(app:shutdown)` | ServerManager.dispose and PluginServer.close both reject | All other modules still dispose, operation completes successfully                                           |
| 9   | shutdown idempotency: second dispatch is no-op      | `dispatch(app:shutdown)` × 2        | All service mocks                                        | Second dispatch cancelled by interceptor, services disposed only once                                       |

**Regression (in existing test files or a shared file):**

| #   | Test Case                                              | Entry Point                             | Boundary Mocks | Behavior Verified                                                                                                                                |
| --- | ------------------------------------------------------ | --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10  | workspace:create still works with extended agentModule | `dispatcher.dispatch(workspace:create)` | Existing mocks | agentModule's workspace:create setup hook still starts per-workspace server, codeServerModule's finalize hook still creates .code-workspace file |
| 11  | workspace:delete still works with extended modules     | `dispatcher.dispatch(workspace:delete)` | Existing mocks | deleteAgentModule's shutdown hook stops server, badgeModule's workspace:deleted event handler still evicts from map                              |

### Manual Testing Checklist

- [ ] `pnpm dev` — app starts normally, all services functional
- [ ] Create workspace, switch workspace, delete workspace — all still work
- [ ] Close window — app shuts down cleanly, no orphan processes
- [ ] Force quit (kill -9) — no corruption (state is file-based)
- [ ] Startup with missing binaries — error screen shows, retry works

## Implementation Steps

- [x] **Step 1: Create AppStartOperation and AppShutdownOperation**
  - New files: `src/main/operations/app-start.ts`, `src/main/operations/app-shutdown.ts`
  - Define intent types, hook contexts (`AppStartHookContext`, `AppShutdownHookContext`), operation classes
  - AppStartOperation: runs "start" hook, checks error, runs "activate" hook. Aborts on error in either hook.
  - AppShutdownOperation: runs "stop" hook. Ignores `ctx.error` (best-effort — modules catch their own errors).
  - Add shutdown idempotency interceptor inline in `bootstrap.ts` (simple boolean flag, blocks duplicate `app:shutdown` intents)
  - Test files: `src/main/operations/app-start.integration.test.ts`, `src/main/operations/app-shutdown.integration.test.ts`

- [x] **Step 2: Create lifecycle intent modules in wireDispatcher()**
  - File: `src/main/bootstrap.ts` (extend `wireDispatcher()`)
  - Add inline modules: `codeServerLifecycleModule`, `agentLifecycleModule`, `badgeLifecycleModule`, `mcpLifecycleModule`, `telemetryLifecycleModule`, `autoUpdaterLifecycleModule`, `ipcBridgeLifecycleModule`, `dataLifecycleModule`, `viewLifecycleModule`
  - Each module contributes hooks to the new operations
  - Shutdown hook handlers: each wraps its logic in try/catch (following existing `agentModule`/`keepFilesModule` pattern)
  - Wire modules via existing `wireModules()` call
  - Group lifecycle service references into a `LifecycleServiceRefs` sub-interface within `BootstrapDeps` to avoid growing the flat property list
  - Test: verify each module's hook handler produces correct observable state

- [x] **Step 3: Refactor startServices() to construct + dispatch**
  - File: `src/main/index.ts`
  - Split `startServices()` into: construction phase (sync/factory calls only) → `dispatch(app:start)`
  - Construction: PluginServer, CodeServerManager, McpServerManager constructed but NOT started (start moves to hooks)
  - Move all startup I/O logic out of `startServices()` — it now lives in module hooks
  - `startServices()` becomes: construct services, wire dispatcher, dispatch intent

- [x] **Step 4: Refactor cleanup() to dispatch app:shutdown**
  - File: `src/main/index.ts`
  - Replace imperative `cleanup()` with: dispatch `app:shutdown`, await completion
  - Remove `before-quit` synchronous best-effort dispose path
  - `window-all-closed`: `await cleanup()` then `app.quit()`
  - `before-quit`: `void cleanup()` (fire-and-forget)
  - Idempotency interceptor (from Step 1) ensures only one execution proceeds

- [x] **Step 5: Update documentation**
  - `docs/ARCHITECTURE.md`:
    - Add `app:start` and `app:shutdown` to intent dispatcher operations table
    - Update startup flow diagram to reflect intent-based startup
    - Update "Key Design Decisions" section (two-phase handler registration now includes intent dispatch)
    - Update "Service Startup" section to describe the hook-based startup
  - `docs/SERVICES.md`: Review and update "Instantiation Order" section if it references `startServices()` internals
  - `CLAUDE.md`: Update Intent Dispatcher section to mention lifecycle operations and that modules contribute hooks for both per-workspace and lifecycle operations

- [x] **Step 6: Validate**
  - Run `pnpm validate:fix`
  - Manual testing per checklist

## Dependencies

None.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add app:start/shutdown to operations table; update startup flow diagram, "Key Design Decisions", and "Service Startup" sections |
| `docs/SERVICES.md`     | Review/update "Instantiation Order" section                                                                                     |
| `CLAUDE.md`            | Update Intent Dispatcher section: mention app:start/shutdown as lifecycle operations                                            |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `startServices()` dispatches `app:start` intent instead of inline logic
- [ ] `cleanup()` dispatches `app:shutdown` intent instead of inline logic
- [ ] `before-quit` handler simplified to single `void cleanup()` call
- [ ] Construction phase is purely synchronous (no I/O)
- [ ] All existing workspace/project operations unaffected (no regression)
- [ ] New operation integration tests pass
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] Manual testing passed
