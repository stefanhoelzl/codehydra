# CodeHydra Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CodeHydra Application                             │
├──────────────────────────────────────────────────────────────────────────┤
│  Main Process (Electron)                                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────────────┐│
│  │Window Manager │  │ View Manager  │  │ App Services                  ││
│  │ BaseWindow    │  │WebContentsView│  │ ├─ Git Worktree Provider      ││
│  │ resize/bounds │  │ create/destroy│  │ ├─ Code-Server Manager        ││
│  │               │  │ bounds/z-order│  │ ├─ Project Store              ││
│  └───────────────┘  └───────────────┘  │ └─ OpenCode Discovery         ││
│                                        └───────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────┤
│  UI Layer (WebContentsView with transparent background)                  │
│  Bounds change based on state: sidebar-only OR full-window              │
├──────────────────────────────────────────────────────────────────────────┤
│  Workspace Views (code-server WebContentsViews)                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                        │
│  │ Workspace 1 │ │ Workspace 2 │ │ Workspace 3 │                        │
│  │ (visible)   │ │ (hidden)    │ │ (hidden)    │                        │
│  └─────────────┘ └─────────────┘ └─────────────┘                        │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Project vs Workspace

| Concept   | What it is                        | Viewable          | Actions              |
| --------- | --------------------------------- | ----------------- | -------------------- |
| Project   | Git repository (main directory)   | No                | Close, Add workspace |
| Workspace | Git worktree (NOT main directory) | Yes (code-server) | Select, Remove       |

**Key behavior:**

- Main git directory is the PROJECT (container, not a workspace)
- Only git worktrees are WORKSPACES (viewable in code-server)
- Fresh clone with no worktrees = 0 workspaces → create dialog auto-opens

### Worktree Discovery Logic

| Location                   | Type                                | Discovered as Workspace?    |
| -------------------------- | ----------------------------------- | --------------------------- |
| Main git directory         | Original clone                      | ❌ NO - this is the PROJECT |
| Manually created worktrees | User-created via `git worktree add` | ✅ YES                      |
| App-managed worktrees      | App-created in managed location     | ✅ YES                      |

Example - user opens `~/projects/myrepo`:

```
~/projects/myrepo/                              → PROJECT (not a workspace)
~/projects/myrepo-feature/                      → WORKSPACE (manual worktree)
~/.local/share/codehydra/.../workspaces/feat/   → WORKSPACE (app worktree)
```

### Worktree Storage (Platform-Specific)

New worktrees are created only in the managed location:

| Platform    | Path                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| Linux       | `~/.local/share/codehydra/projects/<name>-<hash>/workspaces/`                |
| macOS       | `~/Library/Application Support/codehydra/projects/<name>-<hash>/workspaces/` |
| Windows     | `%APPDATA%\codehydra\projects\<name>-<hash>\workspaces\`                     |
| Development | `./app-data/projects/<name>-<hash>/workspaces/`                              |

Discovery finds worktrees in ANY location; creation only in managed location.

## WebContentsView Architecture

### View Management

- **Create**: When workspace added, create WebContentsView (detached, URL not loaded)
- **Activate (first)**: Load URL, attach to contentView, set bounds
- **Activate (subsequent)**: Attach to contentView, set bounds (URL already loaded)
- **Hide**: Detach from contentView (not attached, no bounds needed)
- **Destroy**: When workspace removed, destroy WebContentsView
- **Z-order**: Controlled by `contentView.addChildView(view)` (last added = front)

### View Lifecycle

```
[not created] ──createWorkspaceView()──► [created/detached]
                                               │
                                               │ URL not loaded, not in contentView
                                               │
                                       setActiveWorkspace() [first time]
                                               │
                                               ▼
                                      ┌────────────────────┐
                                      │  [active/attached] │
                                      │  URL loaded        │
                                      │  bounds: content   │
                                      │  unthrottled       │
                                      └────────┬───────────┘
                                               │
                                       setActiveWorkspace(other/null)
                                               │
                                               ▼
                                      ┌────────────────────┐
                                      │  [detached]        │
                                      │  URL loaded        │◄───────┐
                                      │  not in contentView│        │
                                      │  throttled (async) │        │
                                      └────────┬───────────┘        │
                                               │                    │
                        ┌──────────────────────┼────────────────────┘
                        │                      │
              setActiveWorkspace()    destroyWorkspaceView()
                        │                      │
                        │                      ▼
                        └──────────────► [destroyed]
```

- **Detached views** retain their VS Code state (no reload when shown again)
- **Detachment** (vs zero-bounds) reduces GPU usage when many workspaces are open
- **Lazy URL loading** defers resource usage until workspace is first activated
- **Throttling** (optional) further reduces GPU memory via `CODEHYDRA_WORKSPACE_THROTTLING`

### Throttling State Machine

When `CODEHYDRA_WORKSPACE_THROTTLING` is set to `basic` or `full`:

```
           ┌──────────────────────────────────────────────────────────┐
           │                                                           │
   ACTIVE ──(detach)──► DETACHED ──(throttle async)──► THROTTLED      │
     ▲                                                      │          │
     │                                                      │          │
     └────────(unthrottle async)──────(attach)──────────────┘          │
                                                                       │
           Note: Throttling happens AFTER detachment (fire-and-forget) │
           Note: Unthrottling happens AFTER attachment (fire-and-forget)
           └───────────────────────────────────────────────────────────┘
```

**Throttle Levels:**

| Level   | Actions                                                         |
| ------- | --------------------------------------------------------------- |
| `off`   | No throttling (default)                                         |
| `basic` | `setBackgroundThrottling(true)` + `visibilitychange` dispatch   |
| `full`  | Basic + WebGL context loss (`WEBGL_lose_context.loseContext()`) |

**Race Condition Prevention:**

Each view tracks in-flight throttle operations via `AbortController`. When a new operation starts, any previous operation for the same view is cancelled. This prevents race conditions during rapid workspace switching.

### UI Layer State Machine

The application uses a **detachment-based visibility approach**:

- **UI layer**: Always attached with full-window bounds. Visibility controlled by z-order.
- **Workspace views**: Only active view is attached with content bounds. Inactive views are detached from contentView entirely (not attached, no bounds, no GPU usage).

| State   | UI Z-Order                  | Focus    | Description                  |
| ------- | --------------------------- | -------- | ---------------------------- |
| Normal  | Behind workspace views      | VS Code  | User working in editor       |
| Overlay | In front of workspace views | UI layer | Shortcut mode or dialog open |

**State transitions:**

- Normal → Overlay: User activates shortcut mode (Alt+X) or opens dialog
- Overlay → Normal: User releases Alt, presses Escape, closes dialog, or window loses focus

**Implementation:**

- UI transparency: `setBackgroundColor('#00000000')`
- Z-order front: `contentView.addChildView(view)` (no index = add to end = top)
- Z-order back: `contentView.addChildView(view, 0)` (index 0 = bottom)

## Component Architecture

### Main Process Components

| Component       | Responsibility                                              |
| --------------- | ----------------------------------------------------------- |
| Window Manager  | BaseWindow lifecycle, resize handling, minimum size         |
| View Manager    | WebContentsView create/destroy, bounds calculation, z-order |
| IPC Handlers    | Bridge between renderer and services                        |
| Preload Scripts | Secure IPC exposure, keyboard capture                       |

### Preload Scripts

| Script           | Used By  | Purpose                                            |
| ---------------- | -------- | -------------------------------------------------- |
| preload/index.ts | UI layer | Expose IPC API for sidebar, dialogs, shortcut mode |

**Note**: Workspace views intentionally have NO preload script. Keyboard capture is handled via main-process `before-input-event` for simplicity and security.

### App Services (pure Node.js, no Electron deps)

Services are pure Node.js for testability without Electron:

| Service                  | Responsibility                                                  | Status      |
| ------------------------ | --------------------------------------------------------------- | ----------- |
| Git Worktree Provider    | Discover worktrees (not main dir), create, remove               | Implemented |
| Code-Server Manager      | Start/stop code-server, port management                         | Implemented |
| Project Store            | Persist open projects across sessions                           | Implemented |
| OpenCode Discovery       | Find running OpenCode instances                                 | Implemented |
| OpenCode Status Provider | SSE connections, status aggregation                             | Implemented |
| VS Code Setup Service    | First-run extension and config installation                     | Implemented |
| NetworkLayer             | HTTP, SSE, port operations (HttpClient, SseClient, PortManager) | Implemented |

### NetworkLayer Pattern

NetworkLayer provides unified interfaces for all localhost network operations, designed following the Interface Segregation Principle. Consumers depend only on the specific interface(s) they need.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Focused Interfaces                               │
│  ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────────┐  │
│  │    HttpClient     │ │     SseClient     │ │     PortManager       │  │
│  │  fetch(url, opts) │ │ createSseConn()   │ │  findFreePort()       │  │
│  │                   │ │                   │ │  getListeningPorts()  │  │
│  └───────────────────┘ └───────────────────┘ └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       DefaultNetworkLayer                                │
│            implements HttpClient, SseClient, PortManager                 │
│                                                                          │
│  Single class that implements all interfaces for convenience.            │
│  Consumers inject only the interface(s) they need.                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Interface Responsibilities:**

| Interface     | Methods                                 | Purpose                         | Used By                                          |
| ------------- | --------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `HttpClient`  | `fetch(url, options)`                   | HTTP GET with timeout support   | OpenCodeClient, InstanceProbe, CodeServerManager |
| `SseClient`   | `createSseConnection(url, options)`     | SSE with auto-reconnection      | OpenCodeClient                                   |
| `PortManager` | `findFreePort()`, `getListeningPorts()` | Port discovery and availability | CodeServerManager, DiscoveryService              |

**Dependency Injection:**

```typescript
// DefaultNetworkLayer implements all three interfaces
const networkLayer = new DefaultNetworkLayer();

// Inject only the interface(s) each consumer needs
const instanceProbe = new HttpInstanceProbe(networkLayer); // HttpClient only
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer); // HttpClient + PortManager
const openCodeClient = new OpenCodeClient(port, networkLayer, networkLayer); // HttpClient + SseClient
```

**SSE Auto-Reconnection:**

The SseClient provides automatic reconnection with exponential backoff:

- Initial delay: 1 second
- Backoff: doubles each retry (1s → 2s → 4s → 8s → ...)
- Maximum delay: 30 seconds
- Resets to 1s after successful connection

```typescript
const conn = sseClient.createSseConnection("http://localhost:8080/events");

conn.onMessage((data) => {
  // Raw string data - consumer handles JSON parsing
  const parsed = JSON.parse(data);
});

conn.onStateChange((connected) => {
  if (connected) {
    // Application-specific: re-sync state after reconnect
    void this.syncStatus();
  }
});

// Cleanup
conn.disconnect();
```

**Testing with Mock Utilities:**

The module provides factory functions for creating mock implementations:

| Factory                     | Returns         | Purpose                             |
| --------------------------- | --------------- | ----------------------------------- |
| `createMockHttpClient()`    | `HttpClient`    | Mock HTTP responses or errors       |
| `createMockSseClient()`     | `SseClient`     | Mock SSE connection behavior        |
| `createMockPortManager()`   | `PortManager`   | Mock port availability and scanning |
| `createMockSseConnection()` | `SseConnection` | Controllable SSE connection handle  |

```typescript
import { createMockHttpClient, createMockPortManager } from "../platform/network.test-utils";

const mockHttpClient = createMockHttpClient({
  response: new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
});

const mockPortManager = createMockPortManager({
  findFreePort: { port: 9999 },
  getListeningPorts: { ports: [{ port: 8080, pid: 1234 }] },
});

const service = new SomeService(mockHttpClient, mockPortManager);
```

```
Electron Main Process
      ↓ imports
App Services (pure Node.js)
      ↓ no Electron deps

Services are unit-testable without Electron runtime.
```

### Build Mode and Path Abstraction

The application uses dependency injection to abstract build mode detection and path resolution, enabling testability and separation between Electron main process and pure Node.js services.

**Interfaces (defined in `src/services/platform/`):**

| Interface         | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `BuildInfo`       | Build mode detection (`isDevelopment`)     |
| `PlatformInfo`    | Platform detection (`platform`, `homeDir`) |
| `PathProvider`    | Application path resolution                |
| `FileSystemLayer` | Filesystem operations (read, write, mkdir) |

**Implementations:**

| Class                    | Location        | Description                                  |
| ------------------------ | --------------- | -------------------------------------------- |
| `ElectronBuildInfo`      | `src/main/`     | Uses `app.isPackaged`                        |
| `NodePlatformInfo`       | `src/main/`     | Uses `process.platform`, `os.homedir()`      |
| `DefaultPathProvider`    | `src/services/` | Computes paths from BuildInfo + PlatformInfo |
| `DefaultFileSystemLayer` | `src/services/` | Wraps `node:fs/promises` with error mapping  |

**Instantiation Order (in `src/main/index.ts`):**

1. Module level (before `app.whenReady()`):
   - Create `ElectronBuildInfo`, `NodePlatformInfo`, `DefaultPathProvider`, `DefaultFileSystemLayer`
   - Call `redirectElectronDataPaths(pathProvider)` - requires paths early
2. In `bootstrap()`:
   - Pass `pathProvider` and `fileSystemLayer` to services via constructor DI

### FileSystemLayer

`FileSystemLayer` provides a testable abstraction over `node:fs/promises`. Services that need filesystem access receive `FileSystemLayer` via constructor injection, enabling unit testing with mocks instead of real filesystem operations.

```typescript
// Interface methods
interface FileSystemLayer {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<readonly DirEntry[]>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
}
```

**Error Handling:**

All methods throw `FileSystemError` (extends `ServiceError`) with mapped error codes (ENOENT, EACCES, EEXIST, etc.). Unknown error codes are mapped to `UNKNOWN` with the original code preserved in `originalCode`.

**Usage Pattern:**

- Unit tests: Use `createMockFileSystemLayer()` from `filesystem.test-utils.ts`
- Integration tests: Use `DefaultFileSystemLayer()` for real filesystem operations
- Boundary tests: `filesystem.boundary.test.ts` tests `DefaultFileSystemLayer` against real filesystem

### Frontend Components (Svelte 5)

| Component             | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| App                   | Mode router between setup and normal app modes       |
| MainView              | Normal app mode container, IPC initialization        |
| Sidebar               | Project list, workspace list, action buttons         |
| EmptyState            | Displayed when no projects are open                  |
| Dialog                | Base dialog component with focus trap, accessibility |
| CreateWorkspaceDialog | New workspace form with validation, branch selection |
| RemoveWorkspaceDialog | Confirmation with uncommitted changes warning        |
| BranchDropdown        | Searchable combobox for branch selection             |
| ShortcutOverlay       | Keyboard shortcut hints (shown during shortcut mode) |
| SetupScreen           | Setup progress display with indeterminate bar        |
| SetupComplete         | Brief success message after setup completes          |
| SetupError            | Error display with Retry and Quit buttons            |
| Stores                | projects, dialogs, shortcuts, setup (Svelte 5 runes) |

### Renderer Startup Flow

The renderer uses a two-phase initialization to handle the setup/normal app mode split:

```
App.svelte (mode router)
│
├── onMount: await api.setupReady()
│   └── Returns { ready: boolean }
│
├── ready: false (setup needed)
│   ├── SetupScreen.svelte (progress bar, subscribes to setup:progress)
│   ├── SetupComplete.svelte (brief success, emits oncomplete after 1.5s)
│   └── SetupError.svelte (Retry/Quit buttons)
│
└── ready: true (setup complete)
    └── MainView.svelte
        │
        └── onMount:
            ├── listProjects()
            ├── getAllAgentStatuses()
            └── Domain event subscriptions (project/workspace/agent)
```

**Key Design Decisions:**

1. **App.svelte owns global events**: Shortcut events and setup events work across modes
2. **MainView.svelte owns domain events**: IPC calls only happen when setup is complete
3. **Two-phase handler registration**: Main process registers `setup:ready` early; normal handlers after setup
4. **IPC initialization timing**: `listProjects()` and `getAllAgentStatuses()` are called in MainView.onMount, not App.onMount

See [VS Code Setup](#vs-code-setup) for the main process side of this flow.

### Dialog Overlay Mode

When a modal dialog or shortcut mode is active, the UI layer's z-order is changed to overlay workspace views:

```
NORMAL STATE (no dialog, no shortcut mode):
┌─────────────────────────────────────────────────────────────────────┐
│ children[0]: UI Layer        │ children[N]: Workspace Views        │
│ z-order: BEHIND              │ z-order: ON TOP                     │
│                              │                                     │
│ Sidebar receives events      │ Workspace receives events           │
└──────────────────────────────┴─────────────────────────────────────┘

DIALOG/SHORTCUT STATE:
┌─────────────────────────────────────────────────────────────────────┐
│ children[0..N-1]: Workspace Views (z-order: BEHIND)                 │
├─────────────────────────────────────────────────────────────────────┤
│ children[N]: UI Layer (z-order: ON TOP)                             │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │                  Dialog or Shortcut Overlay                     │ │
│ │              (receives all keyboard/mouse events)               │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

This is triggered by:

- **Dialogs**: A reactive `$effect` in App.svelte watches `dialogState` and calls `api.setDialogMode(isOpen)`
- **Shortcut mode**: `ShortcutController` calls `setDialogMode(true)` when Alt+X detected

The main process ViewManager handles the z-order swap using `contentView.addChildView()` reordering.

## Theming System

CodeHydra uses a CSS custom properties system for theming, with support for both VS Code integration and standalone operation.

### CSS Variable Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CSS THEMING ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  variables.css                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  :root {                                                          │  │
│  │    --ch-foreground: var(--vscode-foreground, #cccccc);            │  │
│  │    --ch-agent-idle: var(--ch-success); /* Reference semantic */   │  │
│  │  }                                                                │  │
│  │  @media (prefers-color-scheme: light) { ... light fallbacks ... } │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│  Components use --ch-* variables exclusively                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  .indicator--idle { background: var(--ch-agent-idle); }           │  │
│  │  .dialog-overlay { background: var(--ch-overlay-bg); }            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Variable Categories

| Category    | Variables                                                     | Purpose                  |
| ----------- | ------------------------------------------------------------- | ------------------------ |
| Core        | `--ch-foreground`, `--ch-background`                          | Base text and background |
| Border      | `--ch-border`, `--ch-input-border`, `--ch-input-hover-border` | Borders and dividers     |
| Interactive | `--ch-button-bg`, `--ch-button-fg`, `--ch-button-hover-bg`    | Buttons, inputs, forms   |
| Focus       | `--ch-focus-border`                                           | Focus indicators         |
| Semantic    | `--ch-success`, `--ch-danger`, `--ch-warning`                 | Status colors            |
| Agent       | `--ch-agent-idle`, `--ch-agent-busy`                          | Agent status (semantic)  |
| Overlay     | `--ch-overlay-bg`, `--ch-shadow-color`, `--ch-shadow`         | Modals, tooltips         |
| Layout      | `--ch-sidebar-width`, `--ch-dialog-max-width`                 | Sizing (theme-agnostic)  |

### VS Code Variable Fallback Pattern

Variables use `var(--vscode-*, fallback)` for dual-mode operation:

```css
--ch-foreground: var(--vscode-foreground, #cccccc);
```

- **In code-server context**: VS Code injects `--vscode-*` variables, which take precedence
- **In standalone mode**: Fallback values are used, controlled by `prefers-color-scheme`

### Light/Dark Theme Switching

Light and dark themes only change fallback values via `@media` query:

```css
:root {
  --ch-foreground: var(--vscode-foreground, #cccccc); /* Dark fallback */
}

@media (prefers-color-scheme: light) {
  :root {
    --ch-foreground: var(--vscode-foreground, #3c3c3c); /* Light fallback */
  }
}
```

This approach means:

- VS Code theme takes precedence when running in code-server
- System preference controls standalone appearance
- No JavaScript needed for theme switching
- Layout variables (widths, spacing) are NOT in the media query

## OpenCode Integration

The OpenCode integration provides real-time agent status monitoring for AI agents running in each workspace.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│                                                                  │
│  DiscoveryService ──► PortScanner + ProcessTree + InstanceProbe │
│         │                                                        │
│         │ discovers ports for workspaces                         │
│         ▼                                                        │
│  AgentStatusManager ◄── OpenCodeClient (SSE events)             │
│         │                                                        │
│         │ callback on status change                              │
│         ▼                                                        │
│  IPC Handlers ──► agent:status-changed event                    │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
═══════════════════════════╪══════════════════════════════════════
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    RENDERER PROCESS                              │
│                          │                                       │
│  api.onAgentStatusChanged() ──► agentStatusStore                │
│                                       │                          │
│                                       │ reactive binding         │
│                                       ▼                          │
│  Sidebar.svelte ◄── AgentStatusIndicator (visual indicator)     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Services (src/services/opencode/)

| Service              | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `DiscoveryService`   | Discovers OpenCode instances via port scanning            |
| `OpenCodeClient`     | Connects to OpenCode HTTP/SSE API, handles reconnection   |
| `AgentStatusManager` | Aggregates status across workspaces, emits status changes |

Supporting modules:

| Module          | Responsibility                                          |
| --------------- | ------------------------------------------------------- |
| `PortScanner`   | Scans for listening ports with PID info (node-netstat)  |
| `ProcessTree`   | Gets descendant PIDs of code-server process (pidtree)   |
| `InstanceProbe` | Probes ports to identify OpenCode instances (localhost) |

### Discovery Flow

1. **PID Change Event**: `CodeServerManager.onPidChanged()` notifies `DiscoveryService`
2. **Port Scan**: Main process polls `DiscoveryService.scan()` every 1s
3. **Process Filtering**: Only scans ports owned by code-server descendants
4. **Instance Probe**: HTTP request to `/path` endpoint identifies OpenCode instances
5. **Caching**: Non-OpenCode ports cached (5 min TTL) to avoid re-probing

### Status Update Flow

1. **SSE Connection**: `OpenCodeClient` connects to `/event` endpoint
2. **Event Parsing**: OpenCode sends **unnamed SSE events** (no `event:` prefix in the stream) with the event type embedded in the JSON payload:
   ```
   data: {"type":"session.status","properties":{"sessionID":"...","status":{"type":"busy"}}}
   ```
   The `onmessage` handler receives all events and dispatches by type:
   - `session.status` → status changes (idle/busy/retry, where retry maps to busy)
   - `session.created` → new root session tracking
   - `session.idle` → explicit idle notification
   - `session.deleted` → session cleanup and removal from tracking
   - `permission.updated` / `permission.replied` → permission state tracking
3. **Permission Tracking**: `OpenCodeProvider` tracks pending permissions per session
4. **Aggregation**: `AgentStatusManager` counts idle/busy sessions per workspace
5. **Callback**: Status change triggers callback (NOT direct IPC)
6. **IPC Emit**: Handler subscribes to callback, emits `agent:status-changed`
7. **Store Update**: Renderer receives event, updates `agentStatusStore`
8. **UI Update**: `AgentStatusIndicator` component reflects new state

### Permission State Override

Sessions waiting for user permission are displayed as "idle" (green indicator) rather than "busy":

```
┌─────────────────────────────────────────────────────────────────┐
│                      OpenCodeProvider                            │
│                                                                  │
│  sessionStatuses: Map<sessionId, SessionStatus>                  │
│  pendingPermissions: Map<sessionId, Set<permissionId>>          │
│                                                                  │
│  getAdjustedCounts():                                           │
│    for each session:                                            │
│      if pendingPermissions.has(sessionId) → count as idle       │
│      else if status.type === "idle" → count as idle             │
│      else if status.type === "busy" → count as busy             │
└─────────────────────────────────────────────────────────────────┘
```

**Event handling:**

- `permission.updated`: Adds permission to `pendingPermissions` Set
- `permission.replied`: Removes permission from `pendingPermissions` Set
- `session.deleted`: Clears pending permissions for that session
- SSE disconnect: Clears all pending permissions (reconnection safety)

### IPC Channels

| Channel                  | Type    | Payload                             | Description                       |
| ------------------------ | ------- | ----------------------------------- | --------------------------------- |
| `agent:status-changed`   | Event   | `{ workspacePath, status, counts }` | Status update for workspace       |
| `agent:get-status`       | Command | `{ workspacePath: string }`         | Get status for specific workspace |
| `agent:get-all-statuses` | Command | `void`                              | Get all workspace statuses        |
| `agent:refresh`          | Command | `void`                              | Trigger immediate scan            |

### Error Handling

- **Connection Failures**: Exponential backoff reconnection (1s, 2s, 4s... max 30s)
- **Port Reuse**: PID comparison detects when different process reuses a port
- **Concurrent Scans**: Mutex flag prevents overlapping scan operations
- **Resource Cleanup**: `IDisposable` pattern ensures proper cleanup on shutdown

## External URL Handling

All URLs opened from code-server → external system browser:

- Implemented via `setWindowOpenHandler` returning `{ action: 'deny' }`
- Platform-specific: `xdg-open` (Linux), `open` (macOS), `start` (Windows)

## VS Code Setup

### First-Run Behavior

On first launch (or when setup version changes), the application runs a blocking setup process:

```
app.whenReady()
       │
       ▼
  isSetupComplete()?  ──YES──►  Normal startup (skip to code-server)
       │ NO
       ▼
  cleanVscodeDir()     # Remove any partial state
       │
       ▼
  Show SetupScreen     # Blocking UI with progress bar
       │
       ▼
  Run setup steps:
  1. installCustomExtensions()   # codehydra extension
  2. installMarketplaceExtensions() # OpenCode extension
  3. writeConfigFiles()          # settings.json, keybindings.json
  4. writeCompletionMarker()     # .setup-completed
       │
       ▼
  On success: Show "Setup complete!" (1.5s) → Continue to normal startup
  On failure: Show error with Retry/Quit buttons
```

### Directory Structure

```
<app-data>/
├── vscode/
│   ├── .setup-completed           # JSON: { version: 1, completedAt: "ISO" }
│   ├── extensions/
│   │   ├── codehydra.vscode-0.0.1-universal/
│   │   │   ├── package.json
│   │   │   └── extension.js       # Auto-opens OpenCode terminal
│   │   └── sst-dev.opencode-X.X.X-<platform>/
│   └── user-data/
│       └── User/
│           ├── settings.json      # Dark theme, no telemetry, hidden menu
│           └── keybindings.json   # Empty array
├── runtime/                       # code-server runtime files
└── projects/                      # Git worktrees
```

### Setup Versioning

The `.setup-completed` marker contains a version number. When `CURRENT_SETUP_VERSION` is incremented (in `src/services/vscode-setup/types.ts`), existing installs will re-run setup on next launch, ensuring all users get updated extensions or config.

### Codehydra Extension

The custom codehydra extension runs on VS Code startup to:

1. Close sidebars to maximize editor space
2. Open OpenCode terminal automatically
3. Clean up empty editor groups

This provides an optimized layout for AI agent workflows.

## Keyboard Capture System

CodeHydra uses a two-phase keyboard capture system to enable shortcuts inside VS Code views.

### Phase 1: Activation Detection (Main Process)

The `ShortcutController` uses Electron's `before-input-event` API to intercept keyboard events
before they reach VS Code. It detects the Alt+X activation sequence:

- Alt keydown → Enter ALT_WAITING state, prevent event
- X keydown (while ALT_WAITING) → Activate shortcut mode, focus UI layer
- Non-X keydown (while ALT_WAITING) → Let through to VS Code with altKey modifier
- Alt keyup → Always suppressed (VS Code never sees Alt-only events)

### Phase 2: Action Handling (UI Layer)

Once activated, the UI layer has focus and handles keys directly via DOM events:

- Action keys (0-9, arrows, Enter, Delete) → Execute workspace actions
- Alt keyup → Exit shortcut mode, return focus to VS Code
- Window blur → Exit shortcut mode (handles Alt+Tab)

### Key Files

| File                                          | Purpose                            |
| --------------------------------------------- | ---------------------------------- |
| `src/main/shortcut-controller.ts`             | Activation detection state machine |
| `src/renderer/lib/stores/shortcuts.svelte.ts` | UI layer state and handlers        |

### ShortcutController State Machine

```
                              ┌──────────┐
              ┌───────────────│  NORMAL  │◄────────────────────────────────┐
              │               └────┬─────┘                                 │
              │                    │                                       │
              │ Alt up             │ Alt down                              │
              │ (suppress)         │ (preventDefault)                      │
              │                    ▼                                       │
              │            ┌─────────────┐                                 │
              │            │ ALT_WAITING │                                 │
              │            └──────┬──────┘                                 │
              │                   │                                        │
              │     ┌─────────────┼─────────────┐                          │
              │     │             │             │                          │
              │  Alt up      non-X key       X down                        │
              │  (suppress)  (let through)      │                          │
              │     │             │             ▼                          │
              │     │             │      • preventDefault                  │
              │     │             │      • setDialogMode(true)             │
              │     │             │      • focusUI()                       │
              │     │             │      • Emit ENABLE to UI               │
              │     │             │             │                          │
              └─────┴─────────────┴─────────────┘                          │
                                                                           │
              Main process returns to NORMAL immediately ──────────────────┘
```

**Note**: Alt keyup is ALWAYS suppressed (in both states) so VS Code never sees Alt-only key events.

### Race Condition Handling

There is a race condition where the user can release Alt faster than focus switches to the UI layer:

1. User presses Alt+X → ShortcutController activates mode, calls `focusUI()`
2. User releases Alt VERY QUICKLY (before focus actually switches)
3. Workspace view still has focus, catches the Alt keyup via `before-input-event`
4. **Problem**: UI layer never sees Alt keyup, thinks shortcut mode is still active

**Solution**: Main process tracks `shortcutModeActive` flag. On Alt keyup, if the flag was true:

- Reset flag to false
- Send `shortcut:disable` event to UI
- UI receives event and resets its state

This ensures the UI never gets stuck in shortcut mode.

## Data Flow

### Opening a Project

```
User: Click "Open Project"
  → System folder picker
  → Validate: is git repository?
      → If NO: show error "Not a git repository", return to picker
      → If YES: continue
  → Git Worktree Provider: discover worktrees (NOT main directory)
  → Project Store: save project
  → If 0 worktrees: auto-open create dialog
  → If 1+ worktrees: activate first workspace
```

### Switching Workspaces

```
User: Click workspace (or keyboard shortcut)
  → IPC: switch-workspace
  → View Manager: attach target view (addChildView) - FIRST for visual continuity
  → View Manager: set target bounds to content area
  → View Manager: detach previous view (removeChildView) - AFTER attach
  → Store: update activeWorkspace
  → Focus: code-server view
```

### Creating a Workspace

```
User: Click [+], fill dialog, click OK
  → Validate name (frontend)
      → If invalid: show error, stay in dialog
      → If valid: continue
  → IPC: create-workspace
  → Git Worktree Provider: create in managed location
      → If git error: return error, show in dialog
      → If success: continue
  → Code-Server Manager: get URL
  → View Manager: create WebContentsView
  → Store: add workspace, set active
```

### Closing a Project

```
User: Click [×] on project row
  → Store: remove project from list
  → View Manager: destroy all workspace views for project
  → If active workspace was in project:
      → Switch to first workspace of another project
      → If no other projects: show empty state
  → Project Store: update persisted list
  (NO files or git data deleted)
```

## IPC Contract

All IPC channels are defined in `src/shared/ipc.ts` with TypeScript types for compile-time safety.

### Commands (renderer → main)

| Channel                     | Payload                             | Response            | Description                       |
| --------------------------- | ----------------------------------- | ------------------- | --------------------------------- |
| `project:open`              | `{ path: string }`                  | `Project`           | Open project, discover workspaces |
| `project:close`             | `{ path: string }`                  | `void`              | Close project, destroy views      |
| `project:list`              | `void`                              | `Project[]`         | List all open projects            |
| `project:select-folder`     | `void`                              | `string \| null`    | Show folder picker dialog         |
| `workspace:create`          | `{ projectPath, name, baseBranch }` | `Workspace`         | Create workspace, create view     |
| `workspace:remove`          | `{ workspacePath, deleteBranch }`   | `RemovalResult`     | Remove workspace, destroy view    |
| `workspace:switch`          | `{ workspacePath }`                 | `void`              | Switch active workspace           |
| `workspace:list-bases`      | `{ projectPath }`                   | `BaseInfo[]`        | List available branches           |
| `workspace:update-bases`    | `{ projectPath }`                   | `UpdateBasesResult` | Fetch from remotes                |
| `workspace:is-dirty`        | `{ workspacePath }`                 | `boolean`           | Check for uncommitted changes     |
| `ui:set-dialog-mode`        | `{ isOpen: boolean }`               | `void`              | Swap UI layer z-order             |
| `ui:focus-active-workspace` | `void`                              | `void`              | Return focus to VS Code           |

### Events (main → renderer)

| Channel              | Payload                                          | Description                               |
| -------------------- | ------------------------------------------------ | ----------------------------------------- |
| `project:opened`     | `{ project: Project }`                           | Project was opened                        |
| `project:closed`     | `{ path: string }`                               | Project was closed                        |
| `workspace:created`  | `{ projectPath: string, workspace: Workspace }`  | Workspace was created                     |
| `workspace:removed`  | `{ projectPath: string, workspacePath: string }` | Workspace was removed                     |
| `workspace:switched` | `{ workspacePath: string }`                      | Active workspace changed                  |
| `shortcut:enable`    | `void`                                           | Shortcut mode activated                   |
| `shortcut:disable`   | `void`                                           | Shortcut mode deactivated (race recovery) |

**Note**: `shortcut:enable` and `shortcut:disable` are defined as channel constants but are not typed in the `IpcEvents` interface (they use simple void payloads).

### IPC Data Flow

```
┌─────────────┐  IPC invoke   ┌─────────────┐  direct call  ┌─────────────┐
│  Renderer   │ ────────────► │    Main     │ ────────────► │  Services   │
│  (Svelte)   │               │  (handlers) │               │  (Node.js)  │
│             │ ◄──────────── │             │ ◄──────────── │             │
└─────────────┘  IPC response/ └─────────────┘  return value/ └─────────────┘
                    events                      throw error
```
