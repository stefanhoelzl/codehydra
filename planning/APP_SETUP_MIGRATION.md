---
status: APPROVED
last_updated: 2026-02-10
reviewers: [review-arch, review-quality, review-testing, review-ui]
---

# APP_SETUP_MIGRATION

## Overview

- **Problem**: The current startup flow is renderer-driven: the renderer calls `getState()`, `setAgent()`, `setup()`, and `startServices()` to orchestrate application startup. This inverts control (renderer orchestrates, main process reacts) and keeps setup logic in a monolithic `LifecycleModule` outside the intent architecture.

- **Solution**: Migrate to a single `app:start` intent that orchestrates the entire startup flow. The main process dispatches once; `app:start` shows the starting screen, checks if setup is needed, and conditionally dispatches `app:setup` as a blocking sub-operation. After setup (if any), `app:start` continues with wire, start, and activate hooks. The renderer becomes a passive hook contributor that shows UI when requested and returns user input.

- **Interfaces**:
  - New IPC event: `lifecycle:show-starting` (main → renderer) - shows "CodeHydra is starting..." screen
  - New IPC event: `lifecycle:show-setup` (main → renderer) - shows setup screen with progress
  - New IPC event: `lifecycle:show-agent-selection` (main → renderer), payload: `{ agents: ConfigAgentType[] }`
  - New IPC event: `lifecycle:agent-selected` (renderer → main), payload: `{ agent: ConfigAgentType }`
  - New IPC event: `lifecycle:show-main-view` (main → renderer)
  - New entries in `ApiIpcChannels` enum and payload types in `src/shared/`
  - Removed IPC channels (Step 12): `api:lifecycle:get-state`, `api:lifecycle:set-agent`, `api:lifecycle:setup`, `api:lifecycle:start-services`
  - Split `VscodeSetup` service into: `CodeServerManager` (extended), `AgentBinaryManager`, `ExtensionManager`

- **Risks**:
  - Early dispatcher creation timing - mitigated by creating dispatcher in `initializeBootstrap()` before UI loads; dispatcher only needs registry and logger at creation time, hook modules wired incrementally
  - Renderer hook blocking - mitigated by Promise-based wait with 60s timeout and error UI on timeout
  - Service split complexity - mitigated by incremental extraction with tests

- **Error Recovery**:
  - Hook failures throw errors that bubble up to the dispatcher
  - SetupOperation catches errors and emits `lifecycle:setup-error` IPC event with error details
  - Renderer displays error UI with retry button
  - Retry dispatches `app:start` again from the beginning
  - Individual download failures (network, disk) are caught and wrapped in domain-specific errors

- **Alternatives Considered**:
  - **Multiple intents (app:get-state, app:select-agent, app:setup)**: Rejected - requires renderer to orchestrate multiple dispatches
  - **Keep VscodeSetup as single service**: Rejected - violates single responsibility; CodeServerManager should own code-server lifecycle
  - **Separate dispatcher for setup phase**: Rejected - unnecessary complexity; early dispatcher creation solves the timing issue
  - **Collapse to 3 hook points**: Considered (preflight, select-agent, install) but current 5 hooks provide clearer separation for testing and debugging
  - **app:setup as entry point (initial approach)**: Rejected - caused UI flash issues where setup screen appeared briefly even when no setup was needed; `app:start` as entry point allows showing starting screen first

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         APPLICATION STARTUP                                  │
│                                                                              │
│  index.ts                                                                    │
│  ────────                                                                    │
│  app.whenReady() → dispatcher.dispatch({ type: 'app:start' })               │
│                              │                                               │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        app:start Intent                              │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  Hook: show-ui                                                       │    │
│  │  └── UIModule → send lifecycle:show-starting IPC                    │    │
│  │      (Renderer shows "CodeHydra is starting..." screen)             │    │
│  │                                                                      │    │
│  │  Hook: check                                                         │    │
│  │  ├── ConfigModule → load config, check agent selection              │    │
│  │  ├── BinaryPreflightModule → code-server + agent preflight          │    │
│  │  ├── ExtensionPreflightModule → extension preflight                 │    │
│  │  └── NeedsSetupModule → compute needsSetup flag                     │    │
│  │  (modules run sequentially, order not guaranteed within hook)       │    │
│  │                                                                      │    │
│  │  IF ctx.needsSetup:                                                  │    │
│  │  └── dispatch('app:setup', { payload from check }) ─────────────┐   │    │
│  │                                                                  │   │    │
│  │  ┌───────────────────────────────────────────────────────────────┘   │    │
│  │  │                                                                   │    │
│  │  │  ┌────────────────────────────────────────────────────────────┐   │    │
│  │  │  │                    app:setup Intent                         │   │    │
│  │  │  ├────────────────────────────────────────────────────────────┤   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  Hook: show-ui                                              │   │    │
│  │  │  │  └── UIModule → send lifecycle:show-setup IPC              │   │    │
│  │  │  │      (Renderer shows setup screen with progress)           │   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  Hook: agent-selection (if ctx.needsAgentSelection)        │   │    │
│  │  │  │  └── RendererModule → send IPC, wait for user selection    │   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  Hook: save-agent (if ctx.selectedAgent)                   │   │    │
│  │  │  │  └── ConfigModule → persist agent to config file           │   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  Hook: binary (if ctx.needsBinaryDownload)                 │   │    │
│  │  │  │  ├── CodeServerManager → download + emit progress          │   │    │
│  │  │  │  └── AgentBinaryManager → download + emit progress         │   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  Hook: extensions (if ctx.needsExtensions)                 │   │    │
│  │  │  │  └── ExtensionManager → install + emit progress            │   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  Hook: hide-ui                                              │   │    │
│  │  │  │  └── UIModule → send lifecycle:show-starting IPC           │   │    │
│  │  │  │      (Renderer returns to starting screen)                 │   │    │
│  │  │  │                                                             │   │    │
│  │  │  │  RETURN to app:start (no dispatch)                         │   │    │
│  │  │  │                                                             │   │    │
│  │  │  └────────────────────────────────────────────────────────────┘   │    │
│  │  │                                                                   │    │
│  │  └───────────────────────────────────────────────────────────────────┘    │
│  │                                                                      │    │
│  │  Hook: wire                                                          │    │
│  │  └── WireModule → wire IPC handlers, set up API bridges             │    │
│  │                                                                      │    │
│  │  Hook: start                                                         │    │
│  │  ├── CodeServerModule → ensureRunning()                             │    │
│  │  ├── McpServerModule → start()                                      │    │
│  │  ├── AgentLifecycle → wire status                                   │    │
│  │  └── ... other existing modules                                     │    │
│  │                                                                      │    │
│  │  Hook: activate                                                      │    │
│  │  ├── DataModule → load persisted projects                           │    │
│  │  ├── ViewModule → set active workspace                              │    │
│  │  └── RendererModule → send lifecycle:show-main-view IPC            │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Renderer IPC Flow (Passive Pattern)

```
Main Process                              Renderer
────────────                              ────────
dispatch('app:start')                     appMode = { type: 'initializing' }
    │                                     (blank screen)
    ▼
[show-ui hook]
ipc.send('lifecycle:show-starting')  ───────────►  appMode = { type: 'loading' }
    │                                              "CodeHydra is starting..."
    ▼
[check hook completes]
ctx.needsSetup = true
    │
    ▼
dispatch('app:setup')
    │
    ▼
[show-ui hook]
ipc.send('lifecycle:show-setup')  ───────────────► appMode = { type: 'setup' }
    │                                              (setup screen with progress)
    ▼
[agent-selection hook] (if needed)
ipc.send('lifecycle:show-agent-selection')  ─────► appMode = { type: 'agent-selection' }
                                                   User sees agent dialog
                                                        │
                                                        ▼
                                                   User clicks agent
                                                        │
ipc.on('lifecycle:agent-selected') ◄──────────── ipc.send('lifecycle:agent-selected')
Promise resolves with agent                        appMode = { type: 'setup' }
    │
    ▼
[save-agent hook]
[binary hook + progress events]  ────────────────► setupProgress updates
[extensions hook + progress events]  ────────────► setupProgress updates
    │
    ▼
[hide-ui hook]
ipc.send('lifecycle:show-starting')  ───────────►  appMode = { type: 'loading' }
    │                                              "CodeHydra is starting..."
    ▼
RETURN to app:start
    │
    ▼
[wire hook]
[start hook]
[activate hook]
ipc.send('lifecycle:show-main-view')  ───────────► appMode = { type: 'ready' }
                                                   User sees main view
```

### Service Split

```
BEFORE:                              AFTER:
────────                             ──────

VscodeSetup                          CodeServerManager (extended)
├── preflight()                      ├── preflight() ─────────────┐
│   ├── check code-server            │   └── check code-server    │
│   ├── check agent binary           ├── downloadBinary() ────────┼── uses BinaryDownloadService
│   └── check extensions             ├── ensureRunning()          │
├── setup()                          └── stop()                   │
│   ├── download code-server                                      │
│   ├── download agent               AgentBinaryManager ──────────┤
│   ├── install extensions           ├── preflight() ─────────────┤
│   └── configure                    └── downloadBinary() ────────┼── uses BinaryDownloadService
└── (deleted after migration)                                     │
                                     ExtensionManager ────────────┘
CodeServerManager                    ├── preflight()
├── ensureRunning()                  └── install()
└── stop()

Note: AgentBinaryManager and CodeServerManager.downloadBinary() delegate to
BinaryDownloadService for the actual download logic. They provide manager-specific
configuration (URLs, paths, version info) and progress callbacks.
```

### Intent Chain

```
app:start → conditionally dispatches → app:setup   (blocking sub-operation)
workspace:create → dispatches → workspace:switch
workspace:delete → dispatches → workspace:switch

Causation tracking: app:setup receives causationId from app:start for debugging
app:setup returns to app:start after completion (no dispatch, just Promise resolution)
```

### Early Dispatcher Creation

```
BEFORE:                              AFTER:
────────                             ──────

initializeBootstrap()                initializeBootstrap()
├── Create registry                  ├── Create registry
├── Create LifecycleModule           ├── Create dispatcher (needs: registry, logger only)
└── Return                           ├── Wire AppStartOperation (app:start hooks for show-ui, check)
                                     ├── Wire SetupOperation (app:setup hooks)
startServices()                      ├── Create LifecycleModule (IPC bridge only)
├── Create dispatcher                └── Return
├── Wire all operations
└── ...                              startServices()
                                     ├── Wire remaining app:start hooks (wire, start, activate)
                                     ├── Wire remaining operations (workspace:*, etc.)
                                     └── ... (services that depend on full initialization)
```

## Testing Strategy

### Integration Tests

Test behavior through high-level entry points with behavioral mocks. Use `path.join()` and `path.normalize()` for cross-platform path handling in tests.

| #   | Test Case                                             | Entry Point                      | Boundary Mocks                     | Behavior Verified                                                          |
| --- | ----------------------------------------------------- | -------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| 1   | Startup completes when no setup needed                | `dispatcher.dispatch(app:start)` | ConfigService, FileSystem          | Shows starting screen, skips setup, shows main view                        |
| 2   | Shows starting screen immediately                     | `dispatcher.dispatch(app:start)` | IpcLayer                           | Emits `lifecycle:show-starting` IPC first                                  |
| 3   | Shows agent selection when no agent                   | `dispatcher.dispatch(app:start)` | ConfigService (no agent), IpcLayer | Emits `lifecycle:show-setup` then `lifecycle:show-agent-selection`         |
| 4   | Agent selection saved after user responds             | `dispatcher.dispatch(app:start)` | ConfigService, IpcLayer            | Config file contains selected agent after IPC response                     |
| 5   | Downloads binaries when missing                       | `dispatcher.dispatch(app:start)` | FileSystem, HttpClient             | Binary files exist after setup                                             |
| 6   | Installs extensions when missing                      | `dispatcher.dispatch(app:start)` | FileSystem, ProcessRunner          | Extensions installed                                                       |
| 7   | Returns to starting screen after setup                | `dispatcher.dispatch(app:start)` | IpcLayer                           | Emits `lifecycle:show-starting` after setup completes                      |
| 8   | Emits progress events during download                 | `dispatcher.dispatch(app:start)` | HttpClient, IpcLayer               | Progress IPC events emitted for each step (code-server, agent, extensions) |
| 9   | CodeServerManager.preflight detects missing binary    | `CodeServerManager.preflight()`  | FileSystem                         | Returns needsDownload: true                                                |
| 10  | AgentBinaryManager.preflight detects missing binary   | `AgentBinaryManager.preflight()` | FileSystem                         | Returns needsDownload: true                                                |
| 11  | ExtensionManager.preflight detects missing extensions | `ExtensionManager.preflight()`   | FileSystem                         | Returns missing extension list                                             |
| 12  | Main view shown after app starts                      | `dispatcher.dispatch(app:start)` | IpcLayer                           | Emits `lifecycle:show-main-view` IPC                                       |
| 13  | app:setup includes causation reference                | `dispatcher.dispatch(app:start)` | All                                | app:setup event has causationId matching app:start intentId                |
| 14  | Setup times out if renderer never responds            | `dispatcher.dispatch(app:start)` | IpcLayer (no response)             | Throws timeout error after 60s, emits error IPC                            |
| 15  | Download failure emits error event                    | `dispatcher.dispatch(app:start)` | HttpClient (network error)         | Emits `lifecycle:setup-error` with error details                           |
| 16  | Preflight detects outdated binaries                   | `CodeServerManager.preflight()`  | FileSystem (old version)           | Returns needsDownload: true                                                |
| 17  | Agent-selection hook skipped when agent configured    | `dispatcher.dispatch(app:start)` | ConfigService (has agent)          | No `lifecycle:show-agent-selection` emitted                                |
| 18  | Binary hook skipped when binaries present             | `dispatcher.dispatch(app:start)` | FileSystem (binaries exist)        | No download attempted                                                      |

### Focused Tests (pure utility functions)

| #   | Test Case                       | Function           | Input/Output |
| --- | ------------------------------- | ------------------ | ------------ |
| 1   | Maps setup step to progress row | `mapStepToRowId()` | step → rowId |

### Manual Testing Checklist

- [ ] Fresh install: starting screen → setup (agent selection) → setup (progress) → starting screen → main view
- [ ] Agent already selected, setup needed: starting screen → setup (progress) → starting screen → main view
- [ ] Agent selected, no setup needed: starting screen → main view (no setup flash)
- [ ] Switch agent in settings: triggers re-setup if needed
- [ ] Setup failure (network timeout): error displayed, can retry
- [ ] Setup failure (disk full): error displayed, can retry
- [ ] Setup failure (corrupt download): error displayed, can retry
- [ ] Progress bar updates during binary download
- [ ] Progress bar updates during extension install
- [ ] Verify on Windows: paths with spaces handled correctly
- [ ] Verify on Linux: permissions correct on downloaded binaries

## Implementation Steps

- [x] **Step 1: Create early dispatcher infrastructure**
  - Move dispatcher creation from `startServices()` to `initializeBootstrap()`
  - Dispatcher requires only registry and logger at creation time
  - Create `SetupOperation` with hook points: `check`, `agent-selection`, `save-agent`, `binary`, `extensions`
  - Wire SetupOperation immediately; other operations wired later in `startServices()`
  - Update `BootstrapDeps` to pass dispatcher earlier
  - Add `SetupError` class extending `ServiceError` for setup-specific failures
  - Files: `src/main/bootstrap.ts`, `src/main/operations/setup.ts`, `src/services/errors.ts`
  - Test: Dispatcher available before UI loads

- [x] **Step 2: Extract AgentBinaryManager from VscodeSetup**
  - Create `AgentBinaryManager` with `preflight()` and `downloadBinary()`
  - Move agent binary download logic from `VscodeSetup`
  - Delegate to `BinaryDownloadService` for actual download
  - Inject progress callback for IPC events
  - Add `AgentBinaryError` class extending `ServiceError`
  - Files: `src/services/binary-download/agent-binary-manager.ts`
  - Test: AgentBinaryManager.preflight() detects missing binaries

- [x] **Step 3: Extract ExtensionManager from VscodeSetup**
  - Create `ExtensionManager` with `preflight()` and `install()`
  - Move extension installation logic from `VscodeSetup`
  - Confirm no Electron dependencies (pure Node.js for services layer)
  - Inject progress callback for IPC events
  - Add `ExtensionError` class extending `ServiceError`
  - Files: `src/services/vscode-setup/extension-manager.ts`
  - Test: ExtensionManager.preflight() detects missing extensions

- [x] **Step 4: Extend CodeServerManager with setup methods**
  - Add `preflight()` method to check binary presence
  - Add `downloadBinary()` method for code-server download
  - Delegate to `BinaryDownloadService` for actual download
  - Inject progress callback for IPC events
  - Files: `src/services/code-server/code-server-manager.ts`
  - Test: CodeServerManager.preflight() detects missing binary

- [x] **Step 5: Create setup hook modules**
  - Create `ConfigCheckModule` for `check` hook (load config, check agent)
  - Create `BinaryPreflightModule` for `check` hook (all managers contribute preflight)
  - Create `ConfigSaveModule` for `save-agent` hook
  - Create `BinaryDownloadModule` for `binary` hook
  - Create `ExtensionInstallModule` for `extensions` hook
  - Note: Modules within `check` hook run sequentially but order not guaranteed
  - Files: `src/main/modules/setup/` directory
  - Test: Each module contributes to correct hook point

- [x] **Step 6: Create RendererModule for UI hooks**
  - Create `RendererSetupModule` for `agent-selection` hook
  - Implement Promise-based IPC wait with 60s timeout
  - On timeout, throw `SetupError` with timeout message
  - Add to `app:start.activate` hook for showing main view
  - Add new IPC channel entries to `ApiIpcChannels` enum
  - Add payload types: `ShowAgentSelectionPayload`, `AgentSelectedPayload`
  - Files: `src/main/modules/renderer-setup.ts`, `src/shared/ipc.ts`
  - Test: Module times out correctly, returns user selection on success

- [x] **Step 7: Update renderer to be passive**
  - Remove orchestration logic from `App.svelte`
  - Add IPC listeners for all lifecycle events:
    - `lifecycle:show-starting` → `appMode = { type: 'loading' }` (starting screen)
    - `lifecycle:show-setup` → `appMode = { type: 'setup' }` (setup screen)
    - `lifecycle:show-agent-selection` → `appMode = { type: 'agent-selection' }`
    - `lifecycle:show-main-view` → `appMode = { type: 'ready' }`
  - Send `lifecycle:agent-selected` when user picks agent
  - Keep existing `lifecycle:setup-progress` event handling unchanged
  - Use existing `$effect` cleanup pattern for IPC subscriptions
  - Files: `src/renderer/App.svelte`, `src/preload/index.ts`
  - Test: Renderer responds to IPC events correctly
  - Note: AgentSelectionDialog uses native `<button>` (pre-existing deviation, out of scope)

- [x] **Step 8: Wire AppStartOperation to dispatch app:setup**
  - Add intent dispatch: after check hook, dispatch `app:setup` if needsSetup
  - Pass payload with check results (needsAgentSelection, needsBinaryDownload, etc.)
  - app:setup returns after completion (no dispatch, Promise resolution)
  - Add error handler that emits `lifecycle:setup-error` IPC on failure
  - Files: `src/main/operations/app-start.ts`, `src/main/operations/setup.ts`
  - Test: app:setup runs as blocking sub-operation when setup needed

- [x] **Step 9: Update index.ts entry point**
  - Replace `getState()`/`setup()`/`startServices()` orchestration
  - Single `dispatcher.dispatch({ type: 'app:start' })` call
  - Files: `src/main/index.ts`
  - Test: Application starts correctly with single dispatch

- [x] **Step 10: Delete LifecycleModule setup methods**
  - Remove `getState()`, `setAgent()`, `setup()` methods
  - Keep `quit()` method (still needed)
  - Remove `startServices()` wrapper (replaced by app:start)
  - Files: `src/main/modules/lifecycle/index.ts`
  - Test: No dead code, quit still works

- [x] **Step 11: Delete VscodeSetup service**
  - Remove `VscodeSetup` class after all logic extracted
  - Update imports in any remaining references
  - Files: `src/services/vscode-setup/` directory
  - Test: No import errors, pnpm validate:fix passes
  - Note: VscodeSetupService temporarily kept for setupBinDirectory() only; full removal planned

- [x] **Step 12: Clean up deprecated IPC channels**
  - Remove IPC handlers: `api:lifecycle:get-state`, `api:lifecycle:set-agent`, `api:lifecycle:setup`, `api:lifecycle:start-services`
  - Remove preload API methods: `lifecycle.getState()`, `lifecycle.setAgent()`, `lifecycle.setup()`, `lifecycle.startServices()`
  - Remove `ApiIpcChannels` enum entries for removed channels
  - Update `ICodeHydraApi` interface in `src/shared/api/interfaces.ts`
  - Remove renderer API calls (already replaced by passive IPC listeners in Step 7)
  - Files: `src/main/modules/lifecycle/index.ts`, `src/preload/index.ts`, `src/shared/ipc.ts`, `src/shared/api/interfaces.ts`, `src/renderer/lib/api/`
  - Test: No dead code warnings, pnpm validate:fix passes

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                                    | Changes Required                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`                  | Update startup flow diagram, document app:start → app:setup intent chain     |
| `docs/API.md`                           | Remove deprecated lifecycle methods from Private API section                 |
| `planning/INTENT_BASED_ARCHITECTURE.md` | Add app:start and app:setup to intent catalog, update migration status       |
| `CLAUDE.md`                             | Update Intent Dispatcher section with app:start as entry point and app:setup |

### New Documentation Required

| File   | Purpose                             |
| ------ | ----------------------------------- |
| (none) | Covered by updates to existing docs |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] Manual testing checklist complete
- [ ] Single `dispatch('app:start')` starts entire application
- [ ] Starting screen shows first, no flash of setup screen when setup not needed
- [ ] Renderer is passive (receives instructions, sends input)
- [ ] VscodeSetup deleted, logic split into managers
- [ ] LifecycleModule reduced to `quit()` only
- [ ] Deprecated IPC channels removed (no dead code)
- [ ] Error recovery tested (retry after failure works)
