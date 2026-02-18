---
status: REVIEW_PENDING
last_updated: 2026-02-18
reviewers: []
---

# AGENT_MODULE

## Context

Phase 7 of the intent architecture cleanup (see `planning/INTENT_ARCHITECTURE_CLEANUP.md`). Phases 1-6 are complete. AppState now contains **only** agent-related state — all project/workspace, code-server, and MCP concerns have already been extracted. This is the right time to consolidate the 9 inline agent modules from bootstrap.ts and the remaining AppState logic into a single `AgentModule`.

Phase 8 (ViewModule) runs in parallel. We coordinate by leaving view-related code (e.g., `viewManager.setWorkspaceLoaded`) inline in bootstrap.ts for Phase 8 to absorb.

## Overview

- **Problem**: Agent lifecycle logic is scattered across `AppState` (5 fields + `handleServerStarted` + `waitForProvider`) and 9 inline modules in `bootstrap.ts`, making the agent subsystem hard to understand and maintain.
- **Solution**: Create `AgentModule` — a single factory function returning `IntentModule` that combines all agent concerns. Follows the `CodeServerModule` pattern (eager + lazy deps, internal closure state).
- **Interfaces**: No new interfaces. No IPC changes.
- **Risks**: (1) Parallel Phase 8 edits to bootstrap.ts could conflict — mitigated by only removing agent modules, leaving view modules untouched. (2) onWorkspaceReady split into two callback registrations — mitigated by the fact both server managers support multiple callbacks via `Set<Callback>`.
- **Alternatives Considered**: (a) Class-based module — rejected, factory function is the established pattern. (b) Keep separate small modules in files — rejected, roadmap specifies combining. (c) Keep `viewManager.setWorkspaceLoaded` in AgentModule temporarily — rejected in favor of clean separation (user-approved decision).

## Architecture

```
BEFORE:                                        AFTER:

AppState                                       AgentModule (src/main/modules/agent-module.ts)
├─ agentStatusManager                          ├─ handleServerStarted()  [from AppState]
├─ serverManager                               ├─ waitForProvider()      [from AppState]
├─ handleServerStarted()                       ├─ serverStartedPromises  [from AppState]
├─ waitForProvider()                           ├─ server callback wiring [from AppState.setServerManager]
├─ serverStartedPromises                       │
└─ agentType                                   ├─ app:start / check-config   [configCheckModule]
                                               ├─ app:start / check-deps     [agentBinaryPreflightModule]
bootstrap.ts inline modules:                   ├─ app:start / start          [agentLifecycleModule]
├─ configCheckModule                           ├─ app:start / activate        [agentLifecycleModule]
├─ agentBinaryPreflightModule                  ├─ app:setup / agent-selection [rendererSetupModule]
├─ rendererSetupModule                         ├─ app:setup / save-agent      [configSaveModule]
├─ configSaveModule                            ├─ app:setup / binary          [agentBinaryDownloadModule]
├─ agentBinaryDownloadModule                   ├─ open-workspace / setup      [agentModule]
├─ agentStatusModule                           ├─ delete-workspace / shutdown [deleteAgentModule]
├─ agentModule                                 ├─ get-workspace-status / get  [agentStatusModule]
├─ deleteAgentModule                           ├─ get-agent-session / get     [agentStatusModule]
└─ agentLifecycleModule                        ├─ restart-agent / restart     [agentStatusModule]
                                               └─ app:shutdown / stop         [agentLifecycleModule]

                                               Remains inline (for Phase 8):
                                               └─ wrapperReadyViewModule: onWorkspaceReady → viewManager.setWorkspaceLoaded
```

### Dependency Structure

```typescript
// Eager: available at creation time (initializeBootstrap scope)
interface AgentModuleDeps {
  readonly configService: Pick<ConfigService, "load" | "setAgent">;
  readonly getAgentBinaryManager: (type: ConfigAgentType) => AgentBinaryManager;
  readonly ipcLayer: Pick<IpcLayer, "on" | "removeListener">;
  readonly getUIWebContentsFn: () => WebContents | null;
  readonly reportProgress: SetupProgressReporter;
  readonly logger: Logger;

  // Lazy: resolved after startServices
  readonly getLifecycleDeps: () => AgentLifecycleDeps;
}

interface AgentLifecycleDeps {
  readonly agentStatusManager: AgentStatusManager;
  readonly serverManager: AgentServerManager;
  readonly selectedAgentType: AgentType;
  readonly loggingService: LoggingService;
  readonly dispatcher: Dispatcher;
  readonly resolveWorkspace: (path: string) => { projectId: ProjectId } | undefined;
  readonly extractWorkspaceName: (path: string) => WorkspaceName;
  readonly killTerminalsCallback: KillTerminalsCallback | undefined;
}
```

### onWorkspaceReady Split

The `agentLifecycleModule.activate` hook currently wires a single `onWorkspaceReady` callback doing both view and agent work. We split into two independent registrations:

1. **AgentModule** (activate hook): registers `onWorkspaceReady` for `agentStatusManager.markActive()` (OpenCode only)
2. **Inline wrapperReadyViewModule** (remains in bootstrap.ts): registers `onWorkspaceReady` for `viewManager.setWorkspaceLoaded()` (both agent types)

Both server managers use `Set<Callback>` internally, so multiple registrations are supported. Each module manages its own cleanup function.

## Testing Strategy

### Integration Tests

Test through Dispatcher → Operation → Hook handler pipeline, following `code-server-module.integration.test.ts` pattern (minimal test operations, `vi.fn()` mocks).

| #   | Test Case                                           | Hook Point                | Boundary Mocks                                    | Behavior Verified                                    |
| --- | --------------------------------------------------- | ------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| 1   | check-config loads config                           | app:start/check-config    | configService.load                                | Returns configuredAgent from config                  |
| 2   | check-deps detects missing agent binary             | app:start/check-deps      | getAgentBinaryManager, preflight                  | Returns missingBinaries when needs download          |
| 3   | check-deps skips when no agent configured           | app:start/check-deps      | —                                                 | Returns empty missingBinaries                        |
| 4   | agent-selection shows UI and returns choice         | setup/agent-selection     | ipcLayer, getUIWebContentsFn                      | Sends IPC, waits for response, returns selectedAgent |
| 5   | save-agent persists selection                       | setup/save-agent          | configService.setAgent                            | Calls setAgent, throws SetupError on failure         |
| 6   | binary download when missing                        | setup/binary              | getAgentBinaryManager, downloadBinary             | Downloads, reports progress, handles error           |
| 7   | binary skip when not missing                        | setup/binary              | —                                                 | Reports done immediately                             |
| 8   | start hook wires status→dispatcher                  | app:start/start           | agentStatusManager.onStatusChanged                | Subscribes, dispatches agent:update-status intents   |
| 9   | activate hook registers markActive (OpenCode)       | app:start/activate        | serverManager.onWorkspaceReady                    | Registers callback that calls markActive             |
| 10  | activate hook sets MCP config                       | app:start/activate        | serverManager.setMcpConfig                        | Calls setMcpConfig with mcpPort from context         |
| 11  | activate hook skips markActive (Claude)             | app:start/activate        | —                                                 | No onWorkspaceReady for markActive                   |
| 12  | workspace setup starts server + gets env vars       | open-workspace/setup      | serverManager, agentStatusManager                 | Starts server, waits for provider, returns envVars   |
| 13  | workspace setup sets initial prompt                 | open-workspace/setup      | serverManager.setInitialPrompt                    | Normalizes and sets prompt                           |
| 14  | workspace setup adds bridge port (OpenCode)         | open-workspace/setup      | serverManager.getBridgePort                       | envVars contains CODEHYDRA_BRIDGE_PORT               |
| 15  | delete shutdown stops server                        | delete-workspace/shutdown | serverManager.stopServer                          | Stops server, clears TUI tracking                    |
| 16  | delete shutdown force mode continues on error       | delete-workspace/shutdown | serverManager.stopServer (fails)                  | Returns error but doesn't throw                      |
| 17  | delete shutdown kills terminals                     | delete-workspace/shutdown | killTerminalsCallback                             | Calls callback, best-effort                          |
| 18  | get workspace status returns agent status           | get-workspace-status/get  | agentStatusManager.getStatus                      | Returns agentStatus                                  |
| 19  | get agent session returns session                   | get-agent-session/get     | agentStatusManager.getSession                     | Returns session or null                              |
| 20  | restart agent calls restartServer                   | restart-agent/restart     | serverManager.restartServer                       | Returns port on success, throws on failure           |
| 21  | stop hook disposes services                         | app:shutdown/stop         | serverManager.dispose, agentStatusManager.dispose | Disposes both, cleans up callbacks                   |
| 22  | handleServerStarted creates provider (first start)  | internal                  | createAgentProvider, provider.connect             | Creates, connects, registers provider                |
| 23  | handleServerStarted reconnects (restart)            | internal                  | agentStatusManager.reconnectWorkspace             | Reconnects existing provider                         |
| 24  | handleServerStarted sends initial prompt (OpenCode) | internal                  | provider.createSession, sendPrompt                | Creates session and sends prompt                     |

### Manual Testing Checklist

- [ ] `pnpm dev` — app starts, agent connects, status updates in sidebar
- [ ] Create workspace — agent starts, env vars populated
- [ ] Delete workspace — agent stops gracefully
- [ ] First-run setup — agent selection UI appears, binary downloads, config saves
- [ ] Restart agent (via MCP tool) — reconnects, preserves session

## Implementation Steps

- [ ] **Step 1: Create `agent-module.ts` with eager deps (setup hooks)**
  - Create `src/main/modules/agent-module.ts`
  - Define `AgentModuleDeps` and `AgentLifecycleDeps` interfaces
  - Implement `createAgentModule()` factory function
  - Move setup hooks: `check-config`, `check-deps`, `agent-selection`, `save-agent`, `binary`
  - Move from bootstrap.ts: `configCheckModule`, `agentBinaryPreflightModule`, `rendererSetupModule`, `configSaveModule`, `agentBinaryDownloadModule`
  - Files: `src/main/modules/agent-module.ts` (new), `src/main/bootstrap.ts` (remove inline modules)
  - Test: Setup hook handlers work with vi.fn() mocks

- [ ] **Step 2: Move handleServerStarted + waitForProvider into module closure**
  - Move from `AppState`: `handleServerStarted()`, `waitForProvider()`, `serverStartedPromises` map, server callback wiring (`onServerStarted`/`onServerStopped`)
  - These become internal functions/state in the `createAgentModule` closure
  - `wireServerCallbacks()` called from the `start` hook after lazy deps are resolved
  - Files: `src/main/modules/agent-module.ts`, `src/main/app-state.ts` (remove methods)
  - Test: handleServerStarted creates provider on first start, reconnects on restart, sends initial prompt for OpenCode

- [ ] **Step 3: Add lifecycle hooks (start, activate, stop)**
  - Move `agentLifecycleModule` logic into AgentModule
  - `start` hook: wire `agentStatusManager.onStatusChanged` → dispatcher
  - `activate` hook: register `onWorkspaceReady` for `markActive` (OpenCode only), call `setMcpConfig`
  - `stop` hook: cleanup callbacks, dispose serverManager, dispose agentStatusManager
  - Files: `src/main/modules/agent-module.ts`, `src/main/bootstrap.ts` (remove agentLifecycleModule)
  - Test: Status changes dispatch intents, markActive called for OpenCode only, MCP config set, shutdown cleans up

- [ ] **Step 4: Add per-workspace hooks (setup, shutdown) and status hooks**
  - Move `agentModule` (open-workspace/setup): startServer, waitForProvider, setInitialPrompt, getEnvironmentVariables, add bridge port
  - Move `deleteAgentModule` (delete-workspace/shutdown): killTerminals, stopServer, clearTuiTracking
  - Move `agentStatusModule`: get-workspace-status/get, get-agent-session/get, restart-agent/restart
  - Files: `src/main/modules/agent-module.ts`, `src/main/bootstrap.ts` (remove modules)
  - Test: Workspace setup starts server and returns env vars, delete stops server, status queries return data

- [ ] **Step 5: Create inline wrapperReadyViewModule in bootstrap.ts**
  - Extract `viewManager.setWorkspaceLoaded` callback from agentLifecycleModule into a new inline module
  - Registers `onWorkspaceReady` for both Claude and OpenCode
  - Manages its own cleanup on `app:shutdown/stop`
  - This module stays inline for Phase 8 (ViewModule) to absorb
  - Files: `src/main/bootstrap.ts`
  - Test: Covered by existing operation integration tests (view loading still works)

- [ ] **Step 6: Wire AgentModule in initializeBootstrap + update index.ts**
  - Wire `createAgentModule(deps)` in `initializeBootstrap()` alongside CodeServerModule
  - Remove agent modules from `wireDispatcher()` wireModules call (line ~1917)
  - Remove agent-specific fields from `LifecycleServiceRefs`: `agentStatusManager`, `serverManager`, `selectedAgentType`, `waitForProvider`
  - Remove AppState creation and service injection from `index.ts`
  - Stub AppState to an empty class (deletion deferred to Phase 9 to avoid touching test files that import the type)
  - Files: `src/main/bootstrap.ts`, `src/main/index.ts`, `src/main/app-state.ts`
  - Test: `pnpm validate:fix` passes

- [ ] **Step 7: Write integration tests**
  - Create `src/main/modules/agent-module.integration.test.ts`
  - Follow `code-server-module.integration.test.ts` pattern: minimal test operations, vi.fn() mocks
  - Cover all 24 test cases from testing strategy table
  - Files: `src/main/modules/agent-module.integration.test.ts` (new)
  - Test: All tests pass, each < 50ms

- [ ] **Step 8: Update documentation and roadmap**
  - Update `docs/AGENTS.md`: mention AgentModule as the consolidated owner of agent lifecycle
  - Update `planning/INTENT_ARCHITECTURE_CLEANUP.md`: mark Phase 7 steps as complete
  - Files: `docs/AGENTS.md`, `planning/INTENT_ARCHITECTURE_CLEANUP.md`
  - Test: Documentation is accurate

## Dependencies

None. No new packages required.

## Documentation Updates

### Files to Update

| File                                      | Changes Required                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `docs/AGENTS.md`                          | Add section about AgentModule as consolidated lifecycle owner; update architecture diagram to show module instead of AppState |
| `planning/INTENT_ARCHITECTURE_CLEANUP.md` | Mark Phase 7 steps 7a, 7b as complete; note 7c (workspace:mcp-attached) was resolved in Phase 6                               |

## Definition of Done

- [ ] All 8 implementation steps complete
- [ ] `AgentModule` consolidates all 9 inline agent modules + AppState agent logic
- [ ] `AppState` reduced to empty stub (no agent state)
- [ ] `onWorkspaceReady` split: markActive in AgentModule, setWorkspaceLoaded inline for Phase 8
- [ ] `LifecycleServiceRefs` no longer has agent-specific fields
- [ ] `pnpm validate:fix` passes
- [ ] All 24 integration test cases pass
- [ ] Documentation updated
- [ ] No regressions in existing operation integration tests
