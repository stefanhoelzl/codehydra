---
status: COMPLETED
last_updated: 2025-12-09
review_round: 2
reviewers:
  - review-ui
  - review-typescript
  - review-electron
  - review-arch
  - review-senior
  - review-testing
  - review-docs
---

# VSCODE_SETUP

## Overview

- **Problem**: code-server starts with no extensions and default settings. Users need the OpenCode extension and proper defaults for the best experience.
- **Solution**: First-run setup that installs extensions and writes config files, with a blocking setup screen showing an indeterminate progress bar.
- **Scope**: Development only (code-server from devDependencies via `npm run dev`). Production packaging will use bundled code-server and is outside this plan's scope.

- **Execution Flow**: Setup runs ONCE on application first launch, BEFORE code-server starts. If `.setup-completed` marker doesn't exist (or version mismatch), block UI with setup screen until complete.

- **Risks**:
  | Risk | Mitigation |
  |------|------------|
  | Network failure during extension install | Show error with Retry + Quit buttons, retry on button click or next launch |
  | code-server CLI not found | Verify binary exists before setup, fail fast with clear error via `dialog.showErrorBox()` |
  | Partial setup (crash mid-setup) | No `.setup-completed` marker = full retry; each step is idempotent |
  | Permission errors (EACCES) | Catch and show user-friendly error message |
  | Disk full (ENOSPC) | Catch and show user-friendly error message |

- **Alternatives Considered**:
  | Alternative | Why Rejected |
  |-------------|--------------|
  | Bundle extensions in repo | Adds large binaries to git, version management issues |
  | Setup in background | User might interact with unconfigured code-server |
  | Use .setup-failed marker | Simpler to just check for .setup-completed presence |
  | Separate setup window | More complex; reusing main window with different content is simpler |

## Architecture

### Main Process Startup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MAIN PROCESS STARTUP                            │
│                                                                              │
│  app.whenReady()                                                             │
│       │                                                                      │
│       ▼                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Create VscodeSetupService                                            │  │
│  │  Create WindowManager + ViewManager                                   │  │
│  │  Register ALL handlers (including setup:ready - ALWAYS)               │  │
│  │  Load UI (index.html)                                                 │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│                     (Renderer takes over - see below)                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Renderer Startup Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RENDERER STARTUP                                │
│                                                                              │
│  App.svelte mounts                                                           │
│       │                                                                      │
│       ▼                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  onMount: await api.setupReady()                                      │  │
│  │  Returns: { ready: boolean }                                          │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│                        ┌───────────┴───────────┐                             │
│                        │ ready: true           │ ready: false                │
│                        ▼                       ▼                             │
│  ┌─────────────────────────────┐   ┌─────────────────────────────────────┐  │
│  │ normalAppMode = true        │   │ normalAppMode = false               │  │
│  │ MainView.svelte mounts      │   │ SetupScreen.svelte shows            │  │
│  │                             │   │                                      │  │
│  │ onMount:                    │   │ Main process runs setup:            │  │
│  │ - listProjects()            │   │ - cleanVscodeDir()                  │  │
│  │ - getAllAgentStatuses()     │   │ - setup(onProgress)                 │  │
│  │ - event subscriptions       │   │ - emits progress → renderer         │  │
│  │ - setDialogMode() sync      │   │                                      │  │
│  │                             │   │ On success:                         │  │
│  │ Renders:                    │   │ - emits setup:complete              │  │
│  │ - Sidebar                   │   │ - SetupComplete shows (1.5s)        │  │
│  │ - Dialogs                   │   │ - normalAppMode = true              │  │
│  │ - ShortcutOverlay           │   │ - MainView mounts (same as left)    │  │
│  │                             │   │                                      │  │
│  │ Code-server starts          │   │ On error:                           │  │
│  └─────────────────────────────┘   │ - emits setup:error                 │  │
│                                    │ - SetupError shows [Retry] [Quit]   │  │
│                                    └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Setup Flow (when ready: false)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SETUP FLOW                                      │
│                                                                              │
│  setup:ready handler returns { ready: false }                                │
│       │                                                                      │
│       ▼                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  VscodeSetupService.cleanVscodeDir()                                  │  │
│  │  Remove <app-data>/vscode/ entirely (clean slate)                     │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  VscodeSetupService.setup(onProgress)                                 │  │
│  │                                                                        │  │
│  │  1. installCustomExtensions()      → emit progress                    │  │
│  │  2. installMarketplaceExtensions() → emit progress                    │  │
│  │  3. writeConfigFiles()             → emit progress                    │  │
│  │  4. writeCompletionMarker()        → emit progress                    │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│                        ┌───────────┴───────────┐                             │
│                        │ SUCCESS               │ ERROR                       │
│                        ▼                       ▼                             │
│  ┌─────────────────────────────┐   ┌─────────────────────────────────────┐  │
│  │ emit setup:complete         │   │ emit setup:error                    │  │
│  │ SetupComplete shows (1.5s)  │   │ SetupError shows                    │  │
│  │ normalAppMode = true        │   │ [Retry] → setup:retry → restart     │  │
│  │ MainView mounts             │   │ [Quit] → setup:quit → app.quit()    │  │
│  │ Code-server starts          │   │                                      │  │
│  └─────────────────────────────┘   └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Service Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         src/services/vscode-setup/                           │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  VscodeSetupService implements IVscodeSetup                           │  │
│  │  ─────────────────────────────────────────────────────────────────    │  │
│  │  Constructor DI:                                                      │  │
│  │  - processRunner: ProcessRunner (from platform/process.ts)            │  │
│  │  - codeServerBinaryPath: string                                       │  │
│  │                                                                       │  │
│  │  Methods:                                                             │  │
│  │  - isSetupComplete(): Promise<boolean>                                │  │
│  │  - setup(onProgress?: ProgressCallback): Promise<SetupResult>         │  │
│  │  - cleanVscodeDir(): Promise<void>                                    │  │
│  │                                                                       │  │
│  │  Private methods (SRP):                                               │  │
│  │  - installCustomExtensions(): Promise<void>                           │  │
│  │  - installMarketplaceExtensions(): Promise<void>                      │  │
│  │  - writeConfigFiles(): Promise<void>                                  │  │
│  │  - writeCompletionMarker(): Promise<void>                             │  │
│  │  - readMarker(): Promise<SetupMarker | null>                          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Types (types.ts)                                                     │  │
│  │  ─────────────────────────────────────────────────────────────────    │  │
│  │  interface IVscodeSetup { ... }                                       │  │
│  │  type SetupResult = { success: true } | { success: false; error }     │  │
│  │  type SetupError = { type: 'network' | 'binary-not-found' | ... }     │  │
│  │  type SetupStep = 'extensions' | 'config' | 'finalize'                │  │
│  │  type SetupProgress = { step: SetupStep; message: string }            │  │
│  │  type ProgressCallback = (progress: SetupProgress) => void            │  │
│  │  interface SetupMarker { version: number; completedAt: string }       │  │
│  │  const CURRENT_SETUP_VERSION = 1                                      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
<app-data>/                              # ~/.local/share/codehydra/ (prod)
│                                        # ./app-data/ (dev)
├── vscode/
│   ├── .setup-completed                 # JSON: { version: 1, completedAt: "ISO" }
│   ├── extensions/
│   │   ├── codehydra.vscode-0.0.1-universal/
│   │   │   ├── package.json
│   │   │   └── extension.js
│   │   └── sst-dev.opencode-X.X.X-<platform>/
│   └── user-data/
│       └── User/
│           ├── settings.json
│           └── keybindings.json
├── runtime/                             # (existing)
└── projects/                            # (existing)
```

## UI Design

### Setup Screen (SetupScreen.svelte)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                                                                 │
│                    <h1>Setting up VSCode...</h1>                │
│                                                                 │
│                    <p>Installing extensions...</p>              │
│                         (current step message)                  │
│                                                                 │
│              ┌─────────────────────────────────┐                │
│              │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│                │
│              │  role="progressbar"             │                │
│              │  aria-busy="true"               │                │
│              │  aria-label="Setting up VSCode" │                │
│              │  aria-live="polite"             │                │
│              └─────────────────────────────────┘                │
│                   (indeterminate animation)                     │
│                   (respects prefers-reduced-motion)             │
│                                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Success Screen (brief, 1.5s)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                                                                 │
│                         ✓ Setup complete!                       │
│                                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Error Screen

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                      <h1>Setup Failed</h1>                      │
│                         role="alert"                            │
│                                                                 │
│     <p>Failed to install VSCode extensions.</p>                 │
│     <p>Please check your internet connection.</p>               │
│                                                                 │
│     <p class="error-details">Error: <message></p>               │
│                                                                 │
│              ┌────────────┐    ┌────────────┐                   │
│              │   Retry    │    │    Quit    │                   │
│              └────────────┘    └────────────┘                   │
│                (focused)                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Accessibility Requirements

- `role="progressbar"` with `aria-busy="true"` on progress bar
- `aria-label` with current step for screen readers
- `aria-live="polite"` for progress updates
- `role="alert"` on error container
- Auto-focus Retry button when error appears
- Support Escape key to show quit confirmation
- `@media (prefers-reduced-motion: reduce)` disables animation

## Configuration Files

### .setup-completed (JSON marker with version)

```json
{
  "version": 1,
  "completedAt": "2025-12-09T10:30:00.000Z"
}
```

### settings.json

```json
{
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark+",
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  "window.menuBarVisibility": "hidden"
}
```

Note: `telemetry.telemetryLevel` is disabled for privacy in an AI agent context.

### keybindings.json

```json
[]
```

### codehydra extension - package.json

```json
{
  "name": "codehydra",
  "displayName": "Codehydra",
  "description": "Codehydra integration for VS Code",
  "version": "0.0.1",
  "publisher": "codehydra",
  "engines": {
    "vscode": "^1.74.0"
  },
  "activationEvents": ["onStartupFinished"],
  "main": "./extension.js",
  "contributes": {}
}
```

### codehydra extension - extension.js

```javascript
const vscode = require("vscode");

async function activate(context) {
  // Wait briefly for VS Code UI to stabilize
  setTimeout(async () => {
    try {
      // Hide sidebars to maximize editor space
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      // Open OpenCode terminal automatically for AI workflow
      await vscode.commands.executeCommand("opencode.openTerminal");
      // Clean up empty editor groups created by terminal opening
      await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
    } catch (err) {
      console.error("codehydra extension error:", err);
    }
  }, 100);
}

function deactivate() {}

module.exports = { activate, deactivate };
```

## Implementation Steps

### Phase 1: Types and Error Handling

- [x] **Step 1.1: Add VscodeSetupError to errors.ts**
  - TDD: Write failing test for VscodeSetupError serialization/deserialization
  - Add `VscodeSetupError extends ServiceError` with `type = "vscode-setup"`
  - Update `SerializedError.type` union
  - Update `ServiceError.fromJSON()` deserialization
  - Files: `src/services/errors.ts`, `src/services/errors.test.ts`
  - Test: Verify error serializes/deserializes correctly

- [x] **Step 1.2: Create vscode-setup types**
  - Define `IVscodeSetup` interface
  - Define `SetupResult` discriminated union (success/failure)
  - Define `SetupError` discriminated union (network/binary-not-found/permission/disk-full)
  - Define `SetupProgress`, `SetupStep`, `ProgressCallback`
  - Define `SetupMarker` interface with version and timestamp
  - Define `CURRENT_SETUP_VERSION = 1`
  - Files: `src/services/vscode-setup/types.ts`
  - Test: Type compilation passes

- [x] **Step 1.3: Add IPC types for setup**
  - Add `setup:ready` channel (renderer → main, returns `SetupReadyResponse`)
  - Add `SetupReadyResponse` type: `{ ready: boolean }` (ready=true means setup complete)
  - Add `setup:progress` channel (main → renderer, `SetupProgress` payload)
  - Add `setup:complete` channel (main → renderer)
  - Add `setup:error` channel (main → renderer, `{ message: string; code: string }`)
  - Add `setup:retry` channel (renderer → main)
  - Add `setup:quit` channel (renderer → main)
  - Files: `src/shared/ipc.ts`
  - Test: Type compilation passes

### Phase 2: Path Functions

- [x] **Step 2.1: Add vscode path functions to paths.ts**
  - TDD: Write failing tests for each path function (dev vs prod, all platforms)
  - Add `getVscodeDir(): string` → `<app-data>/vscode/`
  - Add `getVscodeExtensionsDir(): string` → `<app-data>/vscode/extensions/`
  - Add `getVscodeUserDataDir(): string` → `<app-data>/vscode/user-data/`
  - Add `getVscodeSetupMarkerPath(): string` → `<app-data>/vscode/.setup-completed`
  - Use `path.join()` consistently for cross-platform paths
  - Add JSDoc with return type guarantees
  - Files: `src/services/platform/paths.ts`, `src/services/platform/paths.test.ts`
  - Test: Use `test.each()` for platform variations

- [x] **Step 2.2: Update CodeServerConfig to use new paths**
  - Change `extensionsDir` to use `getVscodeExtensionsDir()`
  - Change `userDataDir` to use `getVscodeUserDataDir()`
  - Files: `src/main/index.ts`
  - Test: Verify code-server config uses vscode/ subdirectory

### Phase 3: Service Layer

- [x] **Step 3.1: Create VscodeSetupService skeleton**
  - TDD: Write failing tests for `isSetupComplete()` (marker exists with correct version)
  - Create `IVscodeSetup` interface
  - Implement constructor with DI: `processRunner: ProcessRunner`, `codeServerBinaryPath: string`
  - Mark all dependencies as `private readonly`
  - Implement `isSetupComplete()` - reads marker JSON, checks version
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`, `src/services/vscode-setup/vscode-setup-service.test.ts`
  - Test: Marker exists/missing, version match/mismatch

- [x] **Step 3.2: Implement cleanVscodeDir**
  - TDD: Write failing tests for cleanup (directory exists, missing, permission error)
  - Implement `cleanVscodeDir(): Promise<void>` using `fs.rm()` with `{ recursive: true, force: true }`
  - Handle ENOENT gracefully (no-op)
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test: Directory removed, missing directory no-op, EACCES throws

- [x] **Step 3.3: Implement installCustomExtensions**
  - TDD: Write failing tests for file creation with correct content
  - Create `extensions/codehydra.vscode-0.0.1-universal/` directory
  - Write `package.json` and `extension.js` files (content from Configuration Files section)
  - Make idempotent (check if files exist before writing)
  - Emit progress via callback: `{ step: 'extensions', message: 'Installing codehydra extension...' }`
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test: Files created with correct content, idempotent on re-run

- [x] **Step 3.4: Implement installMarketplaceExtensions**
  - TDD: Write failing tests with mocked processRunner
  - Use injected `processRunner` (NOT direct execa) following existing patterns
  - Run: `<codeServerBinary> --install-extension sst-dev.opencode --extensions-dir <path>`
  - Capture stdout/stderr for error reporting
  - Handle non-zero exit codes with appropriate SetupError type
  - Emit progress: `{ step: 'extensions', message: 'Installing OpenCode extension...' }`
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test: Success path, non-zero exit, timeout

- [x] **Step 3.5: Implement writeConfigFiles**
  - TDD: Write failing tests for config file creation
  - Create `user-data/User/` directory
  - Write `settings.json` with typed defaults (define `VscodeSettings` interface)
  - Write `keybindings.json` (empty array)
  - Make idempotent (skip if files exist)
  - Emit progress: `{ step: 'config', message: 'Writing configuration...' }`
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test: Files created with correct JSON, idempotent

- [x] **Step 3.6: Implement writeCompletionMarker**
  - TDD: Write failing tests for marker creation
  - Write JSON marker: `{ version: CURRENT_SETUP_VERSION, completedAt: new Date().toISOString() }`
  - Emit progress: `{ step: 'finalize', message: 'Finalizing setup...' }`
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test: Marker file contains correct JSON

- [x] **Step 3.7: Implement setup orchestrator method**
  - TDD: Write failing tests for full setup flow
  - Implement `setup(onProgress?: ProgressCallback): Promise<SetupResult>`
  - Call private methods in order with progress callbacks
  - Return `{ success: true }` on completion
  - Return `{ success: false, error: SetupError }` on failure
  - Clean up partial state on failure (remove marker if written)
  - Add JSDoc documenting preconditions/postconditions
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test: Success flow, failure cleanup, progress callback invocations

- [x] **Step 3.8: Add service exports**
  - Export from `src/services/vscode-setup/index.ts`
  - Export from `src/services/index.ts`
  - Files: `src/services/vscode-setup/index.ts`, `src/services/index.ts`
  - Test: Import works from consuming code

### Phase 4: Setup UI Components

- [x] **Step 4.1: Create SetupScreen.svelte component**
  - Centered layout with semantic HTML (`<h1>`, `<p>`)
  - Indeterminate progress bar with full ARIA attributes
  - CSS animation with `prefers-reduced-motion` support
  - Import and use existing CSS variables from `variables.css`
  - Reactive `currentStep` prop for progress message updates
  - Files: `src/renderer/lib/components/SetupScreen.svelte`, `src/renderer/lib/components/SetupScreen.test.ts`
  - Test: Renders with correct ARIA attributes, step message updates

- [x] **Step 4.2: Create SetupError.svelte component**
  - Error message display with `role="alert"`
  - Retry and Quit buttons (Retry auto-focused)
  - Escape key handling for quit confirmation
  - Emit events: `on:retry`, `on:quit`
  - Files: `src/renderer/lib/components/SetupError.svelte`, `src/renderer/lib/components/SetupError.test.ts`
  - Test: Renders error message, button click events, focus management

- [x] **Step 4.3: Create SetupComplete.svelte component**
  - Simple success message with checkmark
  - Auto-transition after 1.5 seconds (emit `on:complete`)
  - Files: `src/renderer/lib/components/SetupComplete.svelte`
  - Test: Emits complete event after delay

- [x] **Step 4.4: Create setup state management**
  - Setup state: `'loading' | 'progress' | 'complete' | 'error'`
  - Current step message for progress display
  - Error message for error display
  - Export update functions for IPC handlers
  - Files: `src/renderer/lib/stores/setup.svelte.ts`, `src/renderer/lib/stores/setup.test.ts`
  - Test: State transitions work correctly

- [x] **Step 4.5: Update App.svelte for setup flow**
  - Check for setup mode on mount (via IPC or initial state)
  - Render SetupScreen/SetupError/SetupComplete based on state
  - Send `setup:ready` IPC when setup screen mounts
  - Handle `setup:progress`, `setup:complete`, `setup:error` IPC events
  - Transition to normal app after setup complete
  - Files: `src/renderer/App.svelte`, `src/renderer/App.test.ts`
  - Test: Correct component renders for each state

### Phase 5: IPC and Main Process Integration

- [x] **Step 5.1: Add setup IPC handlers**
  - `setup:ready` - main starts setup when received
  - `setup:retry` - main re-runs setup
  - `setup:quit` - calls `app.quit()`
  - Files: `src/main/ipc/setup-handlers.ts`, `src/main/ipc/setup-handlers.test.ts`
  - Test: Each handler invokes correct behavior

- [x] **Step 5.2: Add setup preload API**
  - Reuse main preload script (no separate setup preload)
  - Add `onSetupProgress`, `onSetupComplete`, `onSetupError` event subscriptions
  - Add `setupReady()`, `setupRetry()`, `setupQuit()` methods
  - Files: `src/preload/index.ts`, `src/shared/electron-api.d.ts`
  - Test: Type compilation passes

- [x] **Step 5.3: Create setup flow orchestrator in main**
  - Check `isSetupComplete()` BEFORE creating code-server config
  - If not complete:
    1. Call `cleanVscodeDir()`
    2. Create WindowManager + ViewManager
    3. Load UI (App.svelte will show SetupScreen)
    4. Wait for `setup:ready` IPC
    5. Run `setup(onProgress)` with progress forwarded via IPC
    6. On success: emit `setup:complete`, wait 1.5s, continue to normal startup
    7. On error: emit `setup:error`, wait for retry or quit
  - If complete: skip to normal startup
  - For early errors (before renderer ready): use `dialog.showErrorBox()` and quit
  - Files: `src/main/index.ts`
  - Test: Integration test for full flow

- [x] **Step 5.4: Register setup handlers**
  - Register setup IPC handlers in handler registration
  - Files: `src/main/ipc/index.ts`
  - Test: Handlers registered and callable

### Phase 7: Fix IPC Initialization (Refactoring)

**Problem**: App.svelte calls normal IPC methods (`listProjects`, `setDialogMode`, `getAllAgentStatuses`) immediately on mount, but during setup mode only setup handlers are registered. This causes "No handler registered" errors.

**Solution**:

1. `setupReady()` returns `{ ready: boolean }` - main ALWAYS registers this handler early
2. App.svelte calls `setupReady()` in `onMount` and routes based on response
3. New `MainView.svelte` component owns normal app IPC initialization in its `onMount`
4. IPC calls only happen when the appropriate component mounts
5. Cleanup operations stay OUTSIDE the IPC handler (handler only returns status)

#### Renderer Component Architecture

```
App.svelte (router - calls setupReady() in onMount)
│
│  /**
│   * App.svelte is the router between setup mode and normal app mode.
│   * It owns global UI chrome events (shortcuts, window events).
│   * MainView.svelte owns normal app state and domain events.
│   */
│
├── determining = true (initial state, shows nothing or minimal loader)
│   └── await setupReady() in onMount
│
├── ready = false (setup needed)
│   ├── SetupScreen.svelte      → subscribes to setup:progress
│   ├── SetupComplete.svelte    → timer, emits oncomplete
│   └── SetupError.svelte       → retry/quit buttons
│
└── ready = true (setup complete)
    └── MainView.svelte (NEW)   → IPC init in onMount
        │   Renders: <main aria-label="Application workspace">
        ├── Sidebar.svelte
        ├── CreateWorkspaceDialog.svelte
        ├── RemoveWorkspaceDialog.svelte
        └── ShortcutOverlay.svelte

Accessibility: aria-live="polite" region announces mode transitions
```

#### Sequence Diagram

```
┌──────────┐          ┌──────────┐          ┌──────────────────┐
│ Renderer │          │   Main   │          │ VscodeSetupSvc   │
└────┬─────┘          └────┬─────┘          └────────┬─────────┘
     │                     │                         │
     │  (App.svelte mounts)│                         │
     │  onMount: setupReady()                        │
     │─────────────────────>                         │
     │                     │  isSetupComplete()      │
     │                     │─────────────────────────>
     │                     │                         │
     │                     │  returns true/false     │
     │                     │<─────────────────────────
     │                     │                         │
     │  { ready: boolean } │                         │
     │<─────────────────────                         │
     │                     │                         │
     │  [if ready: true]   │                         │
     │  MainView mounts    │                         │
     │  onMount: listProjects()                      │
     │─────────────────────>                         │
     │                     │                         │
     │  [if ready: false]  │                         │
     │  SetupScreen shows  │                         │
     │                     │  cleanVscodeDir()       │
     │                     │─────────────────────────>
     │                     │  setup(onProgress)      │
     │                     │─────────────────────────>
     │  setup:progress     │                         │
     │<─────────────────────                         │
     │  setup:complete     │                         │
     │<─────────────────────                         │
     │                     │                         │
     │  normalAppMode=true │                         │
     │  MainView mounts    │                         │
     │  onMount: listProjects()                      │
     │─────────────────────>                         │
└────┴─────────────────────┴─────────────────────────┴──────────┘
```

#### Key Design Decisions

1. **Two-Phase Startup**: `bootstrap()` sets up infrastructure (window, views, setup handlers, loads UI). `startServices()` starts all app services (code-server, AppState, OpenCode, handlers). This eliminates duplication and creates a single path for service initialization.

2. **Handler Registration**: `setup:ready` is registered in `bootstrap()`, BEFORE loading UI. Normal handlers are registered in `startServices()` only after setup completes.

3. **Cleanup Outside Handler**: The `setup:ready` handler only checks `isSetupComplete()` and returns `{ ready: boolean }`. It does NOT perform cleanup. Cleanup (`cleanVscodeDir()`) happens after the handler returns, triggered by the setup flow.

4. **Race Condition Prevention**: Setup flow emits `setup:complete` only AFTER `startServices()` finishes registering normal handlers. This ensures MainView's `onMount` IPC calls won't fail.

5. **Global vs Domain Events**: Shortcut events stay in App.svelte (work across modes). Project/workspace/agent events move to MainView (only relevant when app is ready).

#### Main Process Architecture

```
bootstrap()                              ← Called once on app start
├── Create VscodeSetupService
├── Create WindowManager
├── Create ViewManager(port=0)           ← Always start with port 0
├── Register setup handlers (setup:ready, setup:retry, setup:quit)
├── Load UI (renderer/index.html)
└── Done (NO app services yet)

// Renderer calls setupReady()
// Main checks isSetupComplete()
// If false: runs setup process, waits for completion
// Then ALWAYS calls startServices()

startServices()                          ← Single place for all app services
├── Create CodeServerManager
├── Start code-server
├── viewManager.updateCodeServerPort(port)
├── Create ProjectStore + AppState
├── Create OpenCode services (DiscoveryService, AgentStatusManager)
├── Wire up code-server PID → DiscoveryService
├── Start scan interval
├── Register normal IPC handlers
├── Load persisted projects
├── Set first workspace active
└── Emit setup:complete (if coming from setup flow)
```

- [x] **Step 7.1: Add SetupReadyResponse type and update IpcCommands**
  - TDD: Write failing test for type compilation
  - Add `export interface SetupReadyResponse { readonly ready: boolean }` to `src/shared/ipc.ts`
  - Update `IpcCommands['setup:ready']` from `{ payload: void; response: void }` to `{ payload: void; response: SetupReadyResponse }`
  - Add JSDoc: "Check if VS Code setup is complete. Returns ready=true if setup done, ready=false if setup needed."
  - Files: `src/shared/ipc.ts`, `src/shared/ipc.test.ts`
  - Test: Type compilation passes, IPC contract updated

- [x] **Step 7.2: Refactor main process to bootstrap() + startServices()**
  - TDD: Write failing tests FIRST for the new architecture
  - **Rename and refactor functions**:
    - `initialize()` → `bootstrap()` (infrastructure only)
    - `continueAfterSetup()` → `startServices()` (all app services)
  - **`bootstrap()` responsibilities** (called once on app start):

    ```typescript
    async function bootstrap(): Promise<void> {
      Menu.setApplicationMenu(null);

      // Create setup service (needed for setup:ready handler)
      const processRunner = new ExecaProcessRunner();
      vscodeSetupService = new VscodeSetupService(processRunner, "code-server");

      // Create window infrastructure
      windowManager = WindowManager.create();
      viewManager = ViewManager.create(windowManager, {
        uiPreloadPath: nodePath.join(__dirname, "../preload/index.cjs"),
        codeServerPort: 0, // Always 0 - updated later by startServices()
      });

      // Register setup handlers ONLY (normal handlers in startServices)
      registerSetupReadyHandler();
      registerSetupRetryAndQuitHandlers();

      // Load UI - renderer will call setupReady() and route accordingly
      const uiView = viewManager.getUIView();
      await uiView.webContents.loadFile(nodePath.join(__dirname, "../renderer/index.html"));

      if (!app.isPackaged) {
        uiView.webContents.openDevTools({ mode: "detach" });
      }
    }
    ```

  - **`startServices()` responsibilities** (called after setup ready/complete):

    ```typescript
    async function startServices(): Promise<void> {
      if (!windowManager || !viewManager) return;

      // Start code-server
      const config = createCodeServerConfig();
      await Promise.all([
        mkdir(config.runtimeDir, { recursive: true }),
        mkdir(config.extensionsDir, { recursive: true }),
        mkdir(config.userDataDir, { recursive: true }),
      ]);

      codeServerManager = new CodeServerManager(config);
      try {
        await codeServerManager.ensureRunning();
      } catch (error) {
        dialog.showErrorBox("Code Server Error", `Failed to start: ${error}`);
      }

      const port = codeServerManager?.port() ?? 0;
      viewManager.updateCodeServerPort(port);

      // Create all app services
      const projectStore = new ProjectStore(getDataProjectsDir());
      appState = new AppState(projectStore, viewManager, port);

      // Initialize OpenCode services
      const portScanner = new SiPortScanner();
      const processTree = new PidtreeProvider();
      const instanceProbe = new HttpInstanceProbe();
      discoveryService = new DiscoveryService({ portScanner, processTree, instanceProbe });
      agentStatusManager = new AgentStatusManager(discoveryService);

      appState.setDiscoveryService(discoveryService);
      appState.setAgentStatusManager(agentStatusManager);

      // Wire up code-server PID changes
      if (codeServerManager) {
        codeServerManager.onPidChanged((pid) => discoveryService?.setCodeServerPid(pid));
        const currentPid = codeServerManager.pid();
        if (currentPid !== null) discoveryService.setCodeServerPid(currentPid);
      }

      // Start scan interval
      scanInterval = setInterval(() => discoveryService?.scan(), 1000);

      // Register normal IPC handlers
      registerAllHandlers(appState, viewManager);

      // Load projects and set active
      await appState.loadPersistedProjects();
      const projects = appState.getAllProjects();
      if (projects.length > 0 && projects[0]?.workspaces[0]) {
        viewManager.setActiveWorkspace(projects[0].workspaces[0].path);
      }
    }
    ```

  - **Update setup flow** to call `startServices()`:
    - When `setupReady()` returns `{ ready: true }`: call `startServices()` immediately
    - When setup completes: call `startServices()` then emit `setup:complete`
  - **Remove duplicate code**: Delete the ~85 lines of duplicated service initialization from old `initialize()`
  - Files: `src/main/index.ts`
  - **Test scenarios** (TDD - write BEFORE implementation):
    - `bootstrap-creates-window-and-views`: Window and ViewManager created
    - `bootstrap-registers-only-setup-handlers`: Normal handlers NOT registered
    - `bootstrap-loads-ui`: HTML file loaded
    - `startServices-starts-code-server`: CodeServerManager created and running
    - `startServices-creates-all-app-services`: AppState, OpenCode services created
    - `startServices-registers-normal-handlers`: registerAllHandlers called
    - `startServices-updates-viewmanager-port`: Port updated from 0 to actual

- [x] **Step 7.3: Add concurrent execution guard to setup:ready handler**
  - TDD: Write failing tests FIRST for all scenarios below
  - **Modify existing** `createSetupReadyHandler(setupService)` in `setup-handlers.ts`
  - Handler checks `isSetupComplete()` and returns `{ ready: boolean }`
  - Handler does NOT call `cleanVscodeDir()` - only returns status
  - **CRITICAL: Add concurrent execution guard** to prevent multiple setup processes:
    ```typescript
    let isSetupRunning = false;
    // In handler: if (!isComplete && !isSetupRunning) { isSetupRunning = true; ... }
    // After setup completes/fails: isSetupRunning = false;
    ```
  - Handler remains registered after setup (returns `{ ready: true }` on subsequent calls)
  - Add JSDoc documenting timing requirement and guard flag purpose
  - Files: `src/main/ipc/setup-handlers.ts`, `src/main/ipc/setup-handlers.test.ts`
  - **Test scenarios** (TDD - write BEFORE implementation):
    - `handler-returns-ready-true-when-complete`: Marker exists with correct version
    - `handler-returns-ready-false-when-missing`: Marker missing
    - `handler-does-not-call-cleanVscodeDir`: Verify mock not called
    - `handler-prevents-concurrent-setup`: Guard flag blocks second call
    - `rapid-calls-trigger-single-setup`: Multiple calls don't spawn multiple processes
    - `handler-error-returns-meaningful-message`: When isSetupComplete() throws

- [x] **Step 7.4: Add path validation and fix timing**
  - TDD: Write failing tests FIRST for timing scenarios
  - **Add path validation** to `cleanVscodeDir()`:
    ```typescript
    const vscodeDir = getVscodeDir();
    const appDataRoot = getDataRootDir();
    if (!vscodeDir.startsWith(appDataRoot)) {
      throw new VscodeSetupError("path-validation", "Invalid vscode directory path");
    }
    ```
  - **CRITICAL: Fix timing** - emit `setup:complete` ONLY AFTER `startServices()` finishes:
    ```typescript
    async function handleSetupComplete(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await startServices(); // Wait for services to start
      emitSetupComplete(); // Emit AFTER services are ready
    }
    ```
  - Files: `src/main/index.ts`, `src/services/vscode-setup/vscode-setup-service.ts`
  - **Test scenarios** (TDD - write BEFORE implementation):
    - `setup-complete-emitted-after-services-started`: Timing test
    - `cleanVscodeDir-validates-path`: Throws on invalid path
    - `no-handler-not-found-errors-during-setup`: Race condition fixed

- [x] **Step 7.5: Fix preload and API type mismatches**
  - TDD: Write failing tests FIRST
  - **Fix type mismatch** (not "new return type" - fixing existing bug):
    - `electron-api.d.ts` line 201: Change `Promise<void>` to `Promise<SetupReadyResponse>`
    - `preload/index.ts` line 181: Ensure return value is captured and returned
  - Update `src/renderer/lib/api/index.ts` exports
  - Files: `src/preload/index.ts`, `src/shared/electron-api.d.ts`, `src/renderer/lib/api/index.ts`
  - **Test scenarios** (TDD):
    - `setupReady-returns-typed-response`: Returns `{ ready: boolean }`
    - `setupReady-marshalls-true-correctly`: Test true case
    - `setupReady-marshalls-false-correctly`: Test false case
    - Type compilation passes

- [x] **Step 7.6: Create MainView.svelte component**
  - TDD: Write failing tests FIRST for all scenarios below
  - **Semantic HTML**: Render content inside App.svelte's `<main>` (see Step 7.7)
  - `onMount`: calls `listProjects()`, `getAllAgentStatuses()` with error handling
  - `onMount`: subscribes to project/workspace/agent events
  - **Helper function** `setupDomainEvents()` in `$lib/utils/domain-events.ts`:
    ```typescript
    type CleanupFunction = () => void;
    export function setupDomainEvents(api: ElectronAPI, stores: DomainStores): CleanupFunction {
      const unsubscribes: CleanupFunction[] = [];
      unsubscribes.push(api.onProjectOpened((e) => stores.addProject(e.project)));
      // ... more subscriptions
      return () => unsubscribes.forEach((fn) => fn());
    }
    ```
  - `$effect`: syncs `setDialogMode()` based on dialog state (MOVED from App.svelte)
  - **Focus management**: On mount, focus first focusable element (e.g., "Open Project" button)
  - Returns cleanup function to unsubscribe events
  - Renders: Sidebar, CreateWorkspaceDialog, RemoveWorkspaceDialog, ShortcutOverlay
  - Files: `src/renderer/lib/components/MainView.svelte`, `src/renderer/lib/components/MainView.test.ts`, `src/renderer/lib/utils/domain-events.ts`
  - **Test scenarios** (TDD - write BEFORE implementation):
    - `ipc-methods-called-on-mount`: listProjects, getAllAgentStatuses called
    - `handles-ipc-call-failures-gracefully`: When listProjects() rejects
    - `event-subscriptions-established`: Verify subscriptions created
    - `cleanup-prevents-state-updates-after-unmount`: Unsubscribe timing
    - `focus-set-on-mount`: First focusable element receives focus
    - `does-not-call-setup-methods`: MainView doesn't call setupReady, setupRetry, setupQuit

- [x] **Step 7.7: Refactor App.svelte as mode router**
  - TDD: Write failing tests FIRST for all scenarios below
  - **State management** using discriminated union (clearer than boolean flags):
    ```typescript
    type AppMode =
      | { type: "initializing" }
      | { type: "setup"; setupState: SetupState }
      | { type: "ready" };
    let appMode = $state<AppMode>({ type: "initializing" });
    ```
  - **Semantic HTML**: App.svelte owns `<main>` with dynamic aria-label:
    ```svelte
    <main aria-label={appMode.type === 'ready' ? 'Application workspace' : 'Setup wizard'}>
    ```
  - **onMount with error handling**:
    ```typescript
    onMount(async () => {
      try {
        const { ready } = await api.setupReady();
        appMode = ready ? { type: 'ready' } : { type: 'setup', setupState: ... };
      } catch (error) {
        console.error('Setup ready check failed:', error);
        appMode = { type: 'ready' }; // Fallback to normal mode
      }
    });
    ```
  - **Initializing state UI**: Reuse SetupScreen with generic message:
    ```svelte
    {#if appMode.type === 'initializing'}
      <SetupScreen currentStep="Loading..." />
    ```
  - **aria-live announcements**: Specify timing and content:
    ```svelte
    <div class="sr-only" aria-live="polite" aria-atomic="true">
      {#if announceMessage}{announceMessage}{/if}
    </div>
    ```
    Set `announceMessage = "Setup complete. Application ready."` when transitioning to ready, clear after 1s timeout.
  - **Transition animation** (respect reduced motion):
    ```svelte
    {:else if appMode.type === 'ready'}
      <div transition:fade={{ duration: 200 }}>
        <MainView />
      </div>
    ```
  - Keep shortcut event subscriptions (global - work in both modes)
  - Keep setup event subscriptions (`onSetupProgress`, `onSetupComplete`, `onSetupError`)
  - Remove `setDialogMode()` effect (moved to MainView)
  - Add comment block documenting component ownership model
  - Files: `src/renderer/App.svelte`, `src/renderer/App.test.ts`
  - **Test scenarios** (TDD - write BEFORE implementation):
    - `routes-to-mainview-when-ready-true`: Immediate main view when setup complete
    - `routes-to-setupscreen-when-ready-false`: Setup screen when setup needed
    - `shows-loading-during-initializing`: SetupScreen with "Loading..." shown
    - `does-not-call-listProjects-during-setup`: listProjects NOT called when ready=false
    - `app-shows-error-on-setupReady-failure`: Falls back to ready mode on IPC error
    - `transitions-after-setup-complete-event`: setup→ready transition
    - `aria-live-announces-mode-transition`: Announcement fired on ready

- [x] **Step 7.8: Add test fixtures to test-fixtures.ts**
  - Add to `src/renderer/lib/test-fixtures.ts` (following existing patterns):
    ```typescript
    export function mockSetupReadyResponse(ready: boolean) {
      return vi.mocked(api.setupReady).mockResolvedValue({ ready });
    }
    export function mockSetupProgressEvent(step: string, message: string): SetupProgress {
      return { step, message };
    }
    ```
  - Add integration test scenarios to `src/renderer/lib/integration.test.ts`:
    - `complete-event-triggers-mainview-mount-and-initialization`: Full transition flow
    - `handlers-registered-before-setupReady-returns`: Race condition verification
  - Files: `src/renderer/lib/test-fixtures.ts`, `src/renderer/lib/integration.test.ts`
  - Test: All fixtures work correctly

- [x] **Step 7.9: Update documentation comprehensively**
  - Update `docs/ARCHITECTURE.md`:
    - Add MainView.svelte to "Frontend Components (Svelte 5)" table:
      `| MainView | Normal app mode container, IPC initialization, domain event handling |`
    - Verify SetupScreen, SetupComplete, SetupError are in the table (add if missing)
    - **Create new section** "Renderer Startup Flow" after Component Architecture:
      - Include ASCII tree diagram showing App.svelte → MainView.svelte hierarchy
      - Document two-phase startup: `bootstrap()` then `startServices()`
      - Document IPC initialization timing (MainView.onMount, not App.onMount)
    - Add cross-reference to "VS Code Setup" section
  - Update `AGENTS.md` "Renderer Architecture" section:
    - Document App/MainView split pattern
    - Document IPC initialization timing rules
    - Document `bootstrap()` + `startServices()` architecture
  - Files: `docs/ARCHITECTURE.md`, `AGENTS.md`
  - Test: Documentation accurate and complete

- [x] **Step 7.10: Run full validation and manual testing**
  - Run `npm run validate:fix`
  - **Automated integration tests** (from manual checklist where possible):
    - Network failure during setup → error screen
    - Retry button triggers re-attempt
  - **Manual testing checklist**:
    - Fresh start (no app-data): setup screen appears with progress bar
    - Second start: setup screen skipped, app loads immediately
    - Setup retry after error works
    - Focus is correct after setup→app transition
    - Screen reader announces "Setup complete. Application ready."
    - Reduced motion: no transition animation
  - Files: All
  - Test: All checks pass, manual testing passes

### Phase 6: Cleanup and Documentation

- [x] **Step 6.1: Create test utilities**
  - Create `src/services/vscode-setup/test-utils.ts`
  - Add `createMockSetupState()`, `verifySetupCompleted()`, `createPartialSetupState()`
  - Add `getCodeServerTestPath()` to locate dev dependency binary
  - Files: `src/services/vscode-setup/test-utils.ts`
  - Test: Utilities work in tests

- [x] **Step 6.2: Add integration tests**
  - Full setup flow with real fs in temp directory
  - Extension install with real code-server (mark as network-dependent)
  - Partial failure cleanup
  - Files: `src/services/vscode-setup/vscode-setup-service.integration.test.ts`
  - Test: All scenarios pass

- [x] **Step 6.3: Update AGENTS.md**
  - Add "VS Code Setup" section under "Key Concepts"
  - Document first-run setup behavior
  - Document `.setup-completed` marker location and versioning
  - Document configuration file paths
  - Document codehydra extension purpose
  - Files: `AGENTS.md`
  - Test: Documentation accurate

- [x] **Step 6.4: Update docs/ARCHITECTURE.md**
  - Add VscodeSetupService to App Services section
  - Document when/how setup runs in startup sequence
  - Document directory structure (`<app-data>/vscode/`)
  - Files: `docs/ARCHITECTURE.md`
  - Test: Documentation accurate

- [x] **Step 6.5: Update docs/USER_INTERFACE.md**
  - Add "VS Code Setup Flow" section
  - Document setup screen appearance
  - Document first launch behavior
  - Files: `docs/USER_INTERFACE.md`
  - Test: Documentation accurate

- [x] **Step 6.6: Run full validation**
  - Run `npm run validate:fix`
  - Fix any linting/type errors
  - Files: All
  - Test: All checks pass

## Testing Strategy

### TDD Workflow

Each implementation step follows:

1. **RED**: Write failing test(s) for the behavior
2. **GREEN**: Implement minimum code to pass
3. **REFACTOR**: Clean up while keeping tests green

### Mocking Strategy

| Component            | Mocked     | Real              |
| -------------------- | ---------- | ----------------- |
| fs.promises          | Unit tests | Integration tests |
| ProcessRunner        | Unit tests | Integration tests |
| path module          | Never      | Always            |
| JSON stringify/parse | Never      | Always            |
| IPC channels         | Unit tests | Integration tests |

### Unit Tests (vitest)

| Test Case                                                            | Description                     | File                           |
| -------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| **Error Types**                                                      |                                 |                                |
| VscodeSetupError serializes correctly                                | Round-trip test                 | `errors.test.ts`               |
| VscodeSetupError deserializes correctly                              | fromJSON test                   | `errors.test.ts`               |
| **Path Functions**                                                   |                                 |                                |
| getVscodeDir returns correct path (dev)                              | NODE_ENV check                  | `paths.test.ts`                |
| getVscodeDir returns correct path (prod Linux)                       | Platform check                  | `paths.test.ts`                |
| getVscodeDir returns correct path (prod macOS)                       | Platform check                  | `paths.test.ts`                |
| getVscodeDir returns correct path (prod Windows)                     | Platform check                  | `paths.test.ts`                |
| getVscodeExtensionsDir nested under vscode/                          | Path structure                  | `paths.test.ts`                |
| getVscodeUserDataDir nested under vscode/                            | Path structure                  | `paths.test.ts`                |
| getVscodeSetupMarkerPath is .setup-completed                         | Path structure                  | `paths.test.ts`                |
| **VscodeSetupService**                                               |                                 |                                |
| isSetupComplete returns true when marker exists with correct version | Mock fs.readFile                | `vscode-setup-service.test.ts` |
| isSetupComplete returns false when marker missing                    | Mock fs.readFile ENOENT         | `vscode-setup-service.test.ts` |
| isSetupComplete returns false when version mismatch                  | Mock old version                | `vscode-setup-service.test.ts` |
| cleanVscodeDir removes directory                                     | Mock fs.rm                      | `vscode-setup-service.test.ts` |
| cleanVscodeDir handles missing directory                             | No error on ENOENT              | `vscode-setup-service.test.ts` |
| cleanVscodeDir throws on permission error                            | EACCES                          | `vscode-setup-service.test.ts` |
| setup creates custom extension files                                 | Verify file contents            | `vscode-setup-service.test.ts` |
| setup installs marketplace extension                                 | Mock processRunner, verify args | `vscode-setup-service.test.ts` |
| setup writes config files                                            | Verify JSON contents            | `vscode-setup-service.test.ts` |
| setup creates versioned marker on success                            | Verify JSON marker              | `vscode-setup-service.test.ts` |
| setup returns error on extension install failure                     | Mock non-zero exit              | `vscode-setup-service.test.ts` |
| setup returns error on binary not found                              | Mock ENOENT                     | `vscode-setup-service.test.ts` |
| setup returns error on permission denied                             | Mock EACCES                     | `vscode-setup-service.test.ts` |
| setup returns error on disk full                                     | Mock ENOSPC                     | `vscode-setup-service.test.ts` |
| setup invokes progress callback with updates                         | Verify callback calls           | `vscode-setup-service.test.ts` |
| setup is idempotent (re-run safe)                                    | Extension exists check          | `vscode-setup-service.test.ts` |
| setup cleans up partial state on failure                             | Verify cleanup                  | `vscode-setup-service.test.ts` |
| **IPC Handlers**                                                     |                                 |                                |
| setup:ready triggers setup start                                     | Verify service called           | `setup-handlers.test.ts`       |
| setup:retry re-runs setup                                            | Verify service called           | `setup-handlers.test.ts`       |
| setup:quit calls app.quit()                                          | Verify quit called              | `setup-handlers.test.ts`       |
| **Phase 7: IPC Initialization Fix**                                  |                                 |                                |
| handler-returns-ready-true-when-complete                             | Marker exists with version      | `setup-handlers.test.ts`       |
| handler-returns-ready-false-when-missing                             | Marker missing                  | `setup-handlers.test.ts`       |
| handler-prevents-concurrent-setup                                    | Guard flag blocks second call   | `setup-handlers.test.ts`       |
| rapid-calls-trigger-single-setup                                     | No multiple processes           | `setup-handlers.test.ts`       |
| cleanVscodeDir-validates-path                                        | Throws on invalid path          | `vscode-setup-service.test.ts` |
| setupReady-returns-typed-response                                    | Returns { ready: boolean }      | `preload/index.test.ts`        |
| MainView ipc-methods-called-on-mount                                 | listProjects called             | `MainView.test.ts`             |
| MainView handles-ipc-call-failures-gracefully                        | Error handling                  | `MainView.test.ts`             |
| MainView cleanup-prevents-state-updates-after-unmount                | Unsubscribe timing              | `MainView.test.ts`             |
| MainView focus-set-on-mount                                          | Focus management                | `MainView.test.ts`             |
| App routes-to-mainview-when-ready-true                               | Immediate main view             | `App.test.ts`                  |
| App routes-to-setupscreen-when-ready-false                           | Setup screen shown              | `App.test.ts`                  |
| App shows-loading-during-initializing                                | Loading state UI                | `App.test.ts`                  |
| App does-not-call-listProjects-during-setup                          | No premature IPC                | `App.test.ts`                  |
| App app-shows-error-on-setupReady-failure                            | Fallback behavior               | `App.test.ts`                  |
| App aria-live-announces-mode-transition                              | Accessibility                   | `App.test.ts`                  |
| **UI Components**                                                    |                                 |                                |
| SetupScreen has correct ARIA attributes                              | role, aria-busy, aria-label     | `SetupScreen.test.ts`          |
| SetupScreen updates step message                                     | Prop change                     | `SetupScreen.test.ts`          |
| SetupScreen respects reduced motion                                  | CSS media query                 | `SetupScreen.test.ts`          |
| SetupError focuses Retry button                                      | Auto-focus                      | `SetupError.test.ts`           |
| SetupError emits retry event                                         | Button click                    | `SetupError.test.ts`           |
| SetupError emits quit event                                          | Button click                    | `SetupError.test.ts`           |
| SetupError displays error message                                    | Prop rendering                  | `SetupError.test.ts`           |

### Integration Tests

| Test Case                                        | Description                 | File                                       |
| ------------------------------------------------ | --------------------------- | ------------------------------------------ |
| Full setup flow creates all files                | Real fs in temp dir         | `vscode-setup-service.integration.test.ts` |
| Extension install with real code-server          | Requires network, skipCI    | `vscode-setup-service.integration.test.ts` |
| Partial failure cleans up correctly              | Simulate mid-setup crash    | `vscode-setup-service.integration.test.ts` |
| Version mismatch triggers re-setup               | Write old version marker    | `vscode-setup-service.integration.test.ts` |
| Setup completes within 30s                       | Performance guard           | `vscode-setup-service.integration.test.ts` |
| **Phase 7: Race Condition Tests**                |                             |                                            |
| handlers-registered-before-setupReady-returns    | Race condition verification | `integration.test.ts`                      |
| setup-complete-emitted-after-handlers-registered | Timing verification         | `handlers.integration.test.ts`             |
| complete-event-triggers-mainview-mount-and-init  | Full transition flow        | `integration.test.ts`                      |
| no-handler-not-found-errors-during-setup         | Error monitoring            | `handlers.integration.test.ts`             |

### Manual Testing Checklist

- [ ] Fresh start (no app-data): setup screen appears with progress bar
- [ ] Progress messages update during setup ("Installing extensions..." etc.)
- [ ] Setup completes: "Setup complete!" shown briefly, then main app loads
- [ ] Second start: setup screen skipped, app loads immediately
- [ ] Delete .setup-completed: setup runs again on next start
- [ ] Modify .setup-completed version to 0: setup runs again (migration)
- [ ] Network disconnected during setup: error screen with Retry + Quit buttons
- [ ] Click Retry: setup re-attempts
- [ ] Click Quit: app exits
- [ ] Press Escape on error screen: quit confirmation appears
- [ ] After quit, reconnect network, restart: setup completes
- [ ] code-server loads with correct extensions (opencode visible in extensions list)
- [ ] code-server loads with correct settings (dark theme, no startup editor)
- [ ] OpenCode terminal auto-opens after ~100ms in each workspace
- [ ] Screen reader announces setup progress
- [ ] Screen reader announces error with Retry focused
- [ ] Enable reduced motion in OS: progress bar shows static state

## Dependencies

| Package | Purpose                               | Approved |
| ------- | ------------------------------------- | -------- |
| (none)  | Uses existing fs, platform/process.ts | N/A      |

**No new dependencies required.** Uses existing `ProcessRunner` from `platform/process.ts`.

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`              | Add "VS Code Setup" to Key Concepts: first-run behavior, marker versioning, config paths, codehydra extension purpose       |
| `docs/ARCHITECTURE.md`   | Add VscodeSetupService to App Services, document startup sequence with setup check, document `<app-data>/vscode/` structure |
| `docs/USER_INTERFACE.md` | Add "VS Code Setup Flow" section: setup screen appearance, progress states, error handling, first launch behavior           |

### New Documentation Required

| File   | Purpose                      |
| ------ | ---------------------------- |
| (none) | All updates to existing docs |

## Definition of Done

- [ ] All implementation steps complete (TDD: failing tests first)
- [ ] `npm run validate:fix` passes
- [ ] All unit tests pass
- [ ] All integration tests pass (network-dependent marked skipCI)
- [ ] Manual testing checklist complete
- [ ] Accessibility tested (screen reader, keyboard, reduced motion)
- [ ] Documentation updated (AGENTS.md, ARCHITECTURE.md, USER_INTERFACE.md)
- [ ] Changes committed
