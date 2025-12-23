# CodeHydra Architecture

## Quick Navigation

| Section                                           | Description                        |
| ------------------------------------------------- | ---------------------------------- |
| [System Overview](#system-overview)               | High-level architecture            |
| [Core Concepts](#core-concepts)                   | Project, Workspace, Views          |
| [Component Architecture](#component-architecture) | Main components and their roles    |
| [API Layer](#api-layer-architecture)              | ICodeHydraApi design and contracts |
| [Theming System](#theming-system)                 | CSS variables and VS Code theming  |
| [Logging](#logging-system)                        | Log levels, files, and debugging   |

For implementation patterns with code examples, see [docs/PATTERNS.md](PATTERNS.md).

---

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
│  └───────────────┘  └───────────────┘  │ └─ OpenCode Server Manager    ││
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

| Component       | Responsibility                                                      |
| --------------- | ------------------------------------------------------------------- |
| Window Manager  | BaseWindow lifecycle, resize handling, minimum size, overlay icons  |
| View Manager    | WebContentsView create/destroy, bounds calculation, z-order         |
| Badge Manager   | App icon badge showing count of idle workspaces (platform-specific) |
| IPC Handlers    | Bridge between renderer and services                                |
| Preload Scripts | Secure IPC exposure, keyboard capture                               |

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
| OpenCode Server Manager  | Spawn/manage one `opencode serve` per workspace                 | Implemented |
| OpenCode Status Provider | SSE connections, status aggregation                             | Implemented |
| VS Code Setup Service    | First-run extension and config installation                     | Implemented |
| KeepFiles Service        | Copy gitignored files from project root to new workspaces       | Implemented |
| NetworkLayer             | HTTP, SSE, port operations (HttpClient, SseClient, PortManager) | Implemented |
| PluginServer             | Socket.IO server for VS Code extension communication            | Implemented |

### Workspace Cleanup

The Git Worktree Provider includes resilient deletion and orphaned workspace cleanup:

**Workspace Deletion Sequence**: When a workspace is deleted, three operations run in sequence:

1. **Kill terminals** (best-effort): Sends `workbench.action.terminal.killAll` via PluginServer to terminate running terminal processes. This must happen while the VS Code extension is still connected. If the workspace is not connected or the command times out (5s), the step is marked as done and deletion continues.

2. **Close VS Code view**: Navigates to `about:blank`, clears session storage, and destroys the WebContentsView.

3. **Remove worktree**: Executes `git worktree remove --force` to remove the git worktree.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Workspace Deletion Flow                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  remove() ──► switchToNextWorkspace() ──► executeDeletion()        │
│                     │                           │                   │
│                     ▼                           ▼                   │
│              View detached          ┌───────────────────────┐       │
│              (still exists)         │ Op 1: kill-terminals  │       │
│                     │               │ "Terminating processes"│       │
│                     │               │ (PluginServer command) │       │
│                     │               └───────────┬───────────┘       │
│                     │                           │                   │
│                     │               ┌───────────────────────┐       │
│                     │               │ Op 2: cleanup-vscode  │       │
│                     │               │ "Closing VS Code view"│       │
│                     │               │ (ViewManager destroy)  │       │
│                     │               └───────────┬───────────┘       │
│                     │                           │                   │
│                     │               ┌───────────────────────┐       │
│                     │               │ Op 3: cleanup-workspace│      │
│                     │               │ "Removing workspace"  │       │
│                     │               │ (git worktree remove)  │       │
│                     │               └───────────────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Resilient Deletion**: When `git worktree remove --force` fails but the worktree was successfully unregistered (e.g., due to locked files in code-server), the deletion is considered successful. The orphaned directory will be cleaned up on next startup.

**Startup Cleanup**: On project open, `cleanupOrphanedWorkspaces()` runs non-blocking to remove directories in the workspaces folder that are not registered with git. This handles cases where previous deletions partially failed.

**Security Measures**:

- Skips symlinks (prevents symlink attacks targeting system directories)
- Validates paths stay within workspacesDir (prevents path traversal)
- Re-checks worktree registration before each deletion (TOCTOU protection)
- Concurrency guard prevents multiple cleanups running simultaneously

### Workspace Session Isolation

Each workspace uses a dedicated Electron session partition to isolate localStorage, cookies, and cache:

**Partition Naming Convention:**

```
persist:<project-dir-name>/<workspace-name>

Example:
  Project: /home/user/repos/my-app
  Workspace: feature-auth
  Partition: persist:my-app-a1b2c3d4/feature-auth
```

The `persist:` prefix ensures VS Code state survives app restarts. The project directory name includes a hash for uniqueness (via `projectDirName()` from `src/services/platform/paths.ts`).

**View Destruction Cleanup:**

When a workspace is deleted, the ViewManager performs these cleanup steps:

1. **Navigate to about:blank**: Releases any resources held by the loaded page
2. **Clear partition storage**: Calls `session.fromPartition(name).clearStorageData()`
3. **Close view**: Destroys the WebContentsView

```typescript
// Cleanup sequence in ViewManager.destroyWorkspaceView()
await view.webContents.loadURL("about:blank"); // Wait with timeout
const sess = session.fromPartition(partitionName);
await sess.clearStorageData(); // Best-effort, errors logged
view.webContents.close();
```

**Benefits:**

- Workspaces have isolated localStorage (no data leakage between workspaces)
- VS Code extensions can store workspace-specific state
- Clean resource release prevents memory leaks

**Note:** The `about:blank` navigation uses a timeout to prevent hanging if the view is unresponsive.

### Git Configuration Storage (Workspace Metadata)

CodeHydra stores workspace metadata in git config using the `branch.<name>.codehydra.<key>` pattern:

| Config Key                      | Purpose                                | Example                                   |
| ------------------------------- | -------------------------------------- | ----------------------------------------- |
| `branch.<name>.codehydra.base`  | Base branch workspace was created from | `branch.feature-x.codehydra.base = main`  |
| `branch.<name>.codehydra.note`  | User notes for the workspace           | `branch.feature-x.codehydra.note = WIP`   |
| `branch.<name>.codehydra.model` | AI model preference                    | `branch.feature-x.codehydra.model = gpt4` |

**Storage location**: Repository's `.git/config` file

**Why git config?**

- Portable: survives app reinstall, stored with the repository
- Standard mechanism: git provides CLI and library support
- Per-branch: each workspace/branch has isolated config

**Caveats**:

- Lost if branch is renamed (same as `branch.<name>.remote`)
- Not a standard git key, but git allows arbitrary branch config

#### Metadata Key Restrictions

Metadata keys are validated with `/^[A-Za-z][A-Za-z0-9-]*$/` and:

- Maximum length: 64 characters
- Cannot end with a hyphen

**Valid keys**: `base`, `note`, `model-name`, `AI-model`
**Invalid keys**: `_private` (leading underscore), `my_key` (underscore), `123note` (starts with digit), `note-` (trailing hyphen)

#### Base Branch Fallback Logic

The `base` key has special fallback logic for backwards compatibility. This fallback is applied ONLY to the `base` key, not other metadata:

```
metadata.base = config.base ?? branch ?? name
```

- First: git config value `codehydra.base` (if set)
- Second: current branch name (if not detached HEAD)
- Third: workspace directory name (fallback for detached HEAD)

Other metadata keys return their exact config value or `undefined` if not set.

### Platform Abstractions Overview

All external system access goes through abstraction interfaces defined in `src/services/platform/`. This architecture enables:

1. **Unit testing**: Services receive mock implementations via constructor injection
2. **Boundary testing**: Real implementations are tested against actual external systems in `*.boundary.test.ts` files
3. **Consistent error handling**: All abstractions use `ServiceError` hierarchy
4. **Single responsibility**: Each interface handles one external concern

**CRITICAL RULE**: Services MUST use these interfaces, NOT direct library imports.

| External System  | Interface             | Implementation                | Test Mock Factory             |
| ---------------- | --------------------- | ----------------------------- | ----------------------------- |
| Filesystem       | `FileSystemLayer`     | `DefaultFileSystemLayer`      | `createMockFileSystemLayer()` |
| HTTP requests    | `HttpClient`          | `DefaultNetworkLayer`         | `createMockHttpClient()`      |
| Port operations  | `PortManager`         | `DefaultNetworkLayer`         | `createMockPortManager()`     |
| Process spawning | `ProcessRunner`       | `ExecaProcessRunner`          | `createMockProcessRunner()`   |
| Process tree     | `ProcessTreeProvider` | Platform-specific (see below) | Manual mock in tests          |
| Build info       | `BuildInfo`           | `ElectronBuildInfo`           | `createMockBuildInfo()`       |
| Platform info    | `PlatformInfo`        | `NodePlatformInfo`            | `createMockPlatformInfo()`    |
| Path resolution  | `PathProvider`        | `DefaultPathProvider`         | `createMockPathProvider()`    |

**Boundary test files:**

| Abstraction                  | Boundary Test                   |
| ---------------------------- | ------------------------------- |
| `FileSystemLayer`            | `filesystem.boundary.test.ts`   |
| `HttpClient` + `PortManager` | `network.boundary.test.ts`      |
| `ProcessRunner`              | `process.boundary.test.ts`      |
| `ProcessTreeProvider`        | `process-tree.boundary.test.ts` |

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
│                  implements HttpClient, PortManager                      │
│                                                                          │
│  Single class that implements both interfaces for convenience.           │
│  Consumers inject only the interface(s) they need.                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Interface Responsibilities:**

| Interface     | Methods                                 | Purpose                         | Used By                                  |
| ------------- | --------------------------------------- | ------------------------------- | ---------------------------------------- |
| `HttpClient`  | `fetch(url, options)`                   | HTTP GET with timeout support   | CodeServerManager, OpenCodeServerManager |
| `PortManager` | `findFreePort()`, `getListeningPorts()` | Port discovery and availability | CodeServerManager, OpenCodeServerManager |

**Dependency Injection:**

```typescript
// DefaultNetworkLayer implements both interfaces
const networkLayer = new DefaultNetworkLayer();

// Inject only the interface(s) each consumer needs
const serverManager = new OpenCodeServerManager(
  runner,
  networkLayer,
  fsLayer,
  networkLayer,
  pathProvider,
  logger
);
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer); // HttpClient + PortManager
```

**Testing with Mock Utilities:**

The module provides factory functions for creating mock implementations:

| Factory                   | Returns       | Purpose                             |
| ------------------------- | ------------- | ----------------------------------- |
| `createMockHttpClient()`  | `HttpClient`  | Mock HTTP responses or errors       |
| `createMockPortManager()` | `PortManager` | Mock port availability and scanning |

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

### ProcessTreeProvider Pattern

`ProcessTreeProvider` is an interface for getting descendant PIDs of a process. It can be used to identify child processes spawned by a parent process.

**Platform-specific implementations:**

| Platform     | Implementation               | Library                        | Notes                                      |
| ------------ | ---------------------------- | ------------------------------ | ------------------------------------------ |
| Linux/macOS  | `PidtreeProvider`            | `pidtree`                      | Uses `/proc` filesystem or `pgrep`         |
| Windows      | `WindowsProcessTreeProvider` | `@vscode/windows-process-tree` | Native module, requires VS Build Tools     |
| Windows (fb) | `PidtreeProvider`            | `pidtree`                      | Fallback if native module fails; uses wmic |

**Factory function:**

```typescript
import { createProcessTreeProvider } from "./process-tree";

// Automatically selects the appropriate implementation
const provider = createProcessTreeProvider(logger);

// Or use async version for verified native module loading on Windows
const provider = await createProcessTreeProviderAsync(logger);
```

The factory function handles platform detection and fallback:

1. On Windows: Tries `WindowsProcessTreeProvider` first
2. If native module fails to load: Falls back to `PidtreeProvider`
3. On Linux/macOS: Uses `PidtreeProvider` directly

**Windows native module notes:**

- `@vscode/windows-process-tree` is an optional dependency (not required on non-Windows)
- Windows development requires Visual Studio Build Tools with "Desktop development with C++" workload
- The native module uses Windows APIs directly (~20ms per query, same as pidtree)
- Microsoft removed `wmic.exe` from Windows 11 24H2+, making the native module necessary

**Testing:**

```typescript
// Unit tests use manual mocks
const mockProcessTree: ProcessTreeProvider = {
  getDescendantPids: vi.fn().mockResolvedValue(new Set([1234, 5678])),
};

// Pass to any service that needs process tree information
const service = new SomeService(mockProcessTree);
```

### OpenCode SDK Integration

`OpenCodeClient` uses the official `@opencode-ai/sdk` for HTTP and SSE operations:

```typescript
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

// SDK client is injected via factory for testability
export type SdkClientFactory = (baseUrl: string) => OpencodeClient;

export class OpenCodeClient implements IDisposable {
  constructor(port: number, sdkFactory: SdkClientFactory = defaultFactory) {
    this.baseUrl = `http://localhost:${port}`;
    this.sdk = sdkFactory(this.baseUrl);
  }

  // connect() is async with timeout support
  async connect(timeoutMs = 5000): Promise<void> {
    const events = await this.sdk.event.subscribe();
    this.processEvents(events.stream);
  }
}
```

**Testing OpenCodeClient:**

```typescript
import { createMockSdkClient, createMockSdkFactory, createTestSession } from "./sdk-test-utils";

const mockSdk = createMockSdkClient({
  sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
  sessionStatuses: { "ses-1": { type: "idle" } },
});
const factory = createMockSdkFactory(mockSdk);
const client = new OpenCodeClient(8080, factory);
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
  copyTree(src: string, dest: string): Promise<CopyTreeResult>;
}

interface CopyTreeResult {
  copiedCount: number; // Number of files copied
  skippedSymlinks: readonly string[]; // Paths of symlinks skipped (security)
}
```

**copyTree Behavior:**

- Copies files and directories recursively from `src` to `dest`
- Uses `fs.copyFile()` internally for correct binary file handling
- Skips symlinks (security measure - prevents symlink attacks)
- Overwrites existing destination files
- Creates parent directories as needed
- Throws `FileSystemError` with `ENOENT` if source doesn't exist

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
| CloseProjectDialog    | Confirmation when closing project with workspaces    |
| BranchDropdown        | Searchable combobox for branch selection             |
| ShortcutOverlay       | Keyboard shortcut hints (shown during shortcut mode) |
| SetupScreen           | Setup progress display with indeterminate bar        |
| SetupComplete         | Brief success message after setup completes          |
| SetupError            | Error display with Retry and Quit buttons            |
| Stores                | projects, dialogs, shortcuts, setup (Svelte 5 runes) |

## API Layer Architecture

The application uses a unified API layer (`ICodeHydraApi`) that abstracts all CodeHydra operations. This enables multiple consumers (UI, future MCP Server, CLI) without duplicating business logic.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Consumers                                     │
├─────────────────────┬─────────────────────┬─────────────────────────────┤
│   UI (Renderer)     │   MCP Server        │   Future CLI                │
│   FULL API          │   CORE API          │   CORE API                  │
└──────────┬──────────┴──────────┬──────────┴──────────┬──────────────────┘
           │                     │                     │
           ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         IPC Adapter Layer                                │
│  (Thin adapters: validate input → call API → serialize response)        │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ICodeHydraApi                                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐        │
│  │ IProjectApi │ │IWorkspaceApi│ │   IUiApi    │ │ILifecycleApi│        │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘        │
│                           + on(event, handler)                           │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 CodeHydraApiImpl (src/main/api/)                         │
│  - Lives in main process (requires Electron for IUiApi)                 │
│  - Wraps services (AppState, WorkspaceProvider, ViewManager, etc.)      │
│  - Resolves IDs by iterating open projects (<10, no map needed)         │
│  - Emits events via callback subscriptions (no intermediate EventEmitter)│
│  - Implements IDisposable for cleanup                                   │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Services                                       │
│  AppState, GitWorktreeProvider, AgentStatusManager, ViewManager, etc.   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Layer Ownership

| Component          | Owns                                             | Does NOT Own                           |
| ------------------ | ------------------------------------------------ | -------------------------------------- |
| `AppState`         | Project/workspace state, provider registry       | Event emission, ID generation          |
| `CodeHydraApiImpl` | ID↔path resolution, event emission, API contract | Business logic (delegates to services) |
| `IPC Handlers`     | Input validation, IPC serialization              | Business logic, state                  |

### API Interfaces

The API is split into focused sub-interfaces following Interface Segregation Principle:

| Interface       | Methods                                      | Purpose                |
| --------------- | -------------------------------------------- | ---------------------- |
| `IProjectApi`   | `open`, `close`, `list`, `get`, `fetchBases` | Project management     |
| `IWorkspaceApi` | `create`, `remove`, `get`, `getStatus`       | Workspace operations   |
| `IUiApi`        | `selectFolder`, `switchWorkspace`, `setMode` | UI-specific operations |
| `ILifecycleApi` | `getState`, `setup`, `quit`                  | Application lifecycle  |

Non-UI consumers (MCP Server, CLI) use `ICoreApi` which excludes `IUiApi` and `ILifecycleApi`.

### Branded ID Types

The API uses branded types (`ProjectId`, `WorkspaceName`) for type safety:

```typescript
// Branded type prevents accidental string/ID confusion
declare const ProjectIdBrand: unique symbol;
export type ProjectId = string & { readonly [ProjectIdBrand]: true };

// Generated from path using deterministic algorithm
function generateProjectId(absolutePath: string): ProjectId {
  const normalizedPath = path.normalize(absolutePath);
  const basename = path.basename(normalizedPath);
  const safeName = basename.replace(/[^a-zA-Z0-9]/g, "-") || "root";
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
  return `${safeName}-${hash}` as ProjectId;
}
```

**ID Format**: `<name>-<8-char-hash>` (e.g., `my-app-a1b2c3d4`)

**Test Vectors**:

| Input Path                    | Generated ID            |
| ----------------------------- | ----------------------- |
| `/home/user/projects/my-app`  | `my-app-<hash8>`        |
| `/home/user/projects/my-app/` | `my-app-<hash8>` (same) |
| `/home/user/Projects/My App`  | `My-App-<hash8>`        |

### Event Flow

IPC handlers subscribe to API events and emit to the renderer:

```
API event emission                    IPC handler subscription
      │                                      │
      │  api.on('workspace:switched')        │
      ├─────────────────────────────────────►│
      │                                      │  webContents.send('api:workspace:switched')
      │                                      ├─────────────────────────────────────────────►
      │                                      │                                            UI
```

### API Events

| Event                        | Payload                                                    | Description                                 |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `project:opened`             | `{ project: Project }`                                     | Project was opened                          |
| `project:closed`             | `{ projectId: ProjectId }`                                 | Project was closed                          |
| `project:bases-updated`      | `{ projectId, bases }`                                     | Branch list refreshed                       |
| `workspace:created`          | `{ projectId, workspace }`                                 | Workspace was created                       |
| `workspace:removed`          | `WorkspaceRef`                                             | Workspace was removed                       |
| `workspace:switched`         | `WorkspaceRef \| null`                                     | Active workspace changed                    |
| `workspace:status-changed`   | `WorkspaceRef & { status }`                                | Dirty/agent status changed                  |
| `workspace:metadata-changed` | `{ projectId, workspaceName, key, value: string \| null }` | Metadata key set or deleted                 |
| `ui:mode-changed`            | `{ mode, previousMode }`                                   | UI mode changed (shortcut/dialog/workspace) |
| `shortcut:key`               | `ShortcutKey`                                              | Shortcut action key pressed                 |
| `setup:progress`             | `{ step, message }`                                        | Setup progress update                       |

### IPC Channel Naming

The v2 API uses `api:` prefixed IPC channels:

| API Method                | IPC Channel            |
| ------------------------- | ---------------------- |
| `v2.projects.open(path)`  | `api:project:open`     |
| `v2.projects.close(id)`   | `api:project:close`    |
| `v2.projects.list()`      | `api:project:list`     |
| `v2.workspaces.create()`  | `api:workspace:create` |
| `v2.ui.switchWorkspace()` | `api:workspace:switch` |
| Event subscription        | `api:<event-name>`     |

### Renderer Startup Flow

The renderer uses a two-phase initialization to handle the setup/normal app mode split:

```
App.svelte (mode router)
│
├── onMount: const state = await api.lifecycle.getState()
│   └── Returns "ready" | "setup"
│
├── state === "setup" (setup needed)
│   ├── Calls api.lifecycle.setup() → returns Promise<SetupResult>
│   ├── Subscribes to api.on("setup:progress") for progress updates
│   ├── SetupScreen.svelte (progress bar, shows progress messages)
│   ├── SetupComplete.svelte (brief success, emits oncomplete after 1.5s)
│   └── SetupError.svelte (Retry calls lifecycle.setup(), Quit calls lifecycle.quit())
│
└── state === "ready" (setup complete)
    └── MainView.svelte
        │
        └── onMount:
            ├── listProjects()
            ├── Workspace status fetches
            └── Domain event subscriptions (project/workspace/agent)
```

**Key Design Decisions:**

1. **App.svelte owns global events**: Shortcut events and setup progress events work across modes
2. **MainView.svelte owns domain events**: IPC calls only happen when setup is complete
3. **Two-phase handler registration**: Main process registers lifecycle handlers (`api:lifecycle:*`) in `bootstrap()`, normal handlers in `startServices()`
4. **Promise-based setup**: `lifecycle.setup()` returns success/failure via Promise, no separate complete/error events
5. **IPC initialization timing**: `listProjects()` and workspace status fetches are called in MainView.onMount, not App.onMount

See [VS Code Setup](#vs-code-setup) for the main process side of this flow.

### UI Mode System

The application uses a unified UI mode system with four modes:

| Mode        | UI Z-Order | Focus          | Description                              |
| ----------- | ---------- | -------------- | ---------------------------------------- |
| `workspace` | Behind     | Workspace view | Normal editing mode                      |
| `shortcut`  | On top     | UI layer       | Shortcut overlay visible                 |
| `dialog`    | On top     | Dialog (no-op) | Modal dialog open (blocks Alt+X)         |
| `hover`     | On top     | No change      | Sidebar expanded on hover (allows Alt+X) |

```
WORKSPACE MODE (normal):
┌─────────────────────────────────────────────────────────────────────┐
│ children[0]: UI Layer        │ children[N]: Workspace Views        │
│ z-order: BEHIND              │ z-order: ON TOP                     │
│ Sidebar visible              │ VS Code receives keyboard input     │
└──────────────────────────────┴─────────────────────────────────────┘

SHORTCUT/DIALOG MODE (overlay):
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

**Mode Transitions:**

| Trigger              | Mode Change          |
| -------------------- | -------------------- |
| Alt+X pressed        | workspace → shortcut |
| Alt+X pressed        | hover → shortcut     |
| Alt released         | shortcut → workspace |
| Escape pressed       | shortcut → workspace |
| Dialog opens         | any → dialog         |
| Dialog closes        | dialog → workspace   |
| Sidebar hover starts | workspace → hover    |
| Sidebar hover stops  | hover → workspace    |
| Dialog opens (hover) | hover → dialog       |

**Alt+X Blocking:**

Alt+X is blocked when `mode === "dialog"` but allowed for all other modes including `"hover"`. This allows:

- Activating shortcut mode while hovering over the expanded sidebar
- Blocking shortcut mode when a modal dialog is open (focus trap is active)

**API:** `api.ui.setMode(mode)` - unified method that handles z-order and focus:

- `setMode("workspace")`: UI behind workspaces, focus active workspace
- `setMode("shortcut")`: UI on top, focus UI layer
- `setMode("dialog")`: UI on top, no focus change (dialog manages its own)
- `setMode("hover")`: UI on top, no focus change (sidebar hover)

Mode transitions are idempotent - calling `setMode()` with the current mode is a no-op.

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

## Logging System

The logging system provides comprehensive logging across both main and renderer processes using electron-log.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LOGGING ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  MAIN PROCESS                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     LoggingService (interface)                           ││
│  │  - createLogger(name: LoggerName): Logger                               ││
│  │  - initialize(): void  (enables renderer logging via IPC)               ││
│  │                              │                                           ││
│  │                              ▼                                           ││
│  │              ElectronLogService (boundary impl)                          ││
│  │  - Wraps electron-log/main                                              ││
│  │  - Configures file path: <app-data>/logs/<datetime>-<uuid>.log          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  RENDERER PROCESS (via IPC)                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  createLogger('ui') → Logger that calls window.api.log.*                ││
│  │                              │                                           ││
│  │                              │ IPC to main                               ││
│  │                              ▼                                           ││
│  │              LoggingService.createLogger(name).method(msg, context)     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuration

| Variable               | Values                   | Description                                           |
| ---------------------- | ------------------------ | ----------------------------------------------------- |
| `CODEHYDRA_LOGLEVEL`   | debug\|info\|warn\|error | Override default log level                            |
| `CODEHYDRA_PRINT_LOGS` | any non-empty value      | Print logs to stdout/stderr                           |
| `CODEHYDRA_LOGGER`     | comma-separated names    | Only log from specified loggers (e.g., `git,process`) |

**Default Levels**:

- Development (isDevelopment=true): DEBUG
- Production (isDevelopment=false): WARN

### Logger Names/Scopes

| Logger          | Module                 | Description                      |
| --------------- | ---------------------- | -------------------------------- |
| `[badge]`       | BadgeManager           | App icon badge updates           |
| `[process]`     | LoggingProcessRunner   | Spawned processes, stdout/stderr |
| `[network]`     | DefaultNetworkLayer    | HTTP fetch, port operations      |
| `[fs]`          | DefaultFileSystemLayer | File read/write operations       |
| `[git]`         | SimpleGitClient        | Git commands                     |
| `[opencode]`    | OpenCodeClient         | OpenCode SSE connections         |
| `[code-server]` | CodeServerManager      | code-server lifecycle            |
| `[pidtree]`     | PidtreeProvider        | Process tree lookups             |
| `[keepfiles]`   | KeepFilesService       | .keepfiles copy operations       |
| `[api]`         | IPC Handlers           | API request/response timing      |
| `[window]`      | WindowManager          | Window create/resize/close       |
| `[view]`        | ViewManager            | View lifecycle, mode changes     |
| `[app]`         | Application Lifecycle  | Bootstrap, startup, shutdown     |
| `[ui]`          | Renderer Components    | Dialog events, user actions      |

### Log File Location

| Environment | Path                                                           |
| ----------- | -------------------------------------------------------------- |
| Development | `./app-data/logs/2025-12-16T10-30-00-abc123.log`               |
| Linux       | `~/.local/share/codehydra/logs/2025-12-16T10-30-00-abc123.log` |
| macOS       | `~/Library/Application Support/Codehydra/logs/...`             |
| Windows     | `%APPDATA%\Codehydra\logs\...`                                 |

### Usage in Services

Services receive a Logger via constructor injection (required parameter):

```typescript
class CodeServerManager {
  constructor(
    config: CodeServerConfig,
    processRunner: ProcessRunner,
    httpClient: HttpClient,
    portManager: PortManager,
    logger: Logger // Required
  ) {
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.logger.info("Starting code-server");
    // ...
    this.logger.info("Started", { port, pid });
  }
}
```

### Usage in Renderer

Renderer components use `createLogger` from `$lib/logging`:

```svelte
<script lang="ts">
  import { createLogger } from "$lib/logging";

  const logger = createLogger("ui");

  function handleDialogOpen() {
    logger.debug("Dialog opened", { type: "create-workspace" });
  }

  function handleSubmit() {
    try {
      // ...
      logger.debug("Dialog submitted", { type: "create-workspace" });
    } catch (error) {
      logger.warn("UI error", { component: "Dialog", error: error.message });
    }
  }
</script>
```

**Svelte 5 Guidance**: Call logger methods in event handlers and lifecycle hooks (`onMount`, `onDestroy`), NOT inside `$effect()` or `$derived()` runes.

## OpenCode Integration

The OpenCode integration provides real-time agent status monitoring for AI agents running in each workspace.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│                                                                  │
│  OpenCodeServerManager ──► spawns opencode serve per workspace  │
│         │                      writes to ports.json              │
│         │ onServerStarted(path, port)                            │
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

| Service                 | Responsibility                                                  |
| ----------------------- | --------------------------------------------------------------- |
| `OpenCodeServerManager` | Spawns/manages one `opencode serve` per workspace, writes ports |
| `OpenCodeClient`        | Connects to OpenCode HTTP/SSE API, handles reconnection         |
| `AgentStatusManager`    | Aggregates status across workspaces, emits status changes       |

### Managed Server Flow

1. **Workspace Add**: `AppState.addWorkspace()` calls `serverManager.startServer(path)`
2. **Port Allocation**: `PortManager.findFreePort()` allocates a port
3. **Server Spawn**: `opencode serve --port N --dir path` spawns in background
4. **Health Check**: HTTP probe to `/app` confirms server is ready
5. **Ports File Update**: Entry written to `<app-data>/opencode/ports.json`
6. **Callback**: `onServerStarted(path, port)` wired to `agentStatusManager.initWorkspace()`

### Ports File Format

The `<app-data>/opencode/ports.json` file maps workspace paths to ports:

```json
{
  "workspaces": {
    "/home/user/project/.worktrees/feature-a": { "port": 14001 },
    "/home/user/project/.worktrees/feature-b": { "port": 14002 }
  }
}
```

The wrapper script (`<app-data>/bin/opencode`) reads this file to redirect `opencode` invocations to `opencode attach http://127.0.0.1:$PORT` when in a managed workspace.

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

## Plugin Interface

CodeHydra and VS Code extensions communicate via Socket.IO WebSocket connection. The protocol supports bidirectional communication:

- **Server → Client**: CodeHydra sends VS Code commands to extensions
- **Client → Server**: Extensions call CodeHydra API methods

### Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      CodeHydra (Electron Main)                            │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  PluginServer                                                       │  │
│  │                                                                     │  │
│  │  connections: Map<workspacePath, Socket>                            │  │
│  │                                                                     │  │
│  │  Server → Client:                                                   │  │
│  │  ───► "command" (execute VS Code commands)                          │  │
│  │                                                                     │  │
│  │  Client → Server:                                                   │  │
│  │  ◄─── "api:workspace:getStatus" → PluginResult<WorkspaceStatus>     │  │
│  │  ◄─── "api:workspace:getMetadata" → PluginResult<Record<...>>       │  │
│  │  ◄─── "api:workspace:setMetadata" → PluginResult<void>              │  │
│  │                                                                     │  │
│  │  API handlers registered via onApiCall() callback pattern           │  │
│  │  (PluginServer remains agnostic to API layer)                       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                           ▲                               │
│                                           │ wirePluginApi() registers     │
│                                           │ handlers in startServices()   │
│  ┌────────────────────────────────────────┴────────────────────────────┐  │
│  │  wirePluginApi() - src/main/index.ts                                │  │
│  │                                                                     │  │
│  │  Workspace path resolution:                                         │  │
│  │  1. appState.findProjectForWorkspace(workspacePath)                 │  │
│  │  2. generateProjectId(project.path)                                 │  │
│  │  3. path.basename(workspacePath) as WorkspaceName                   │  │
│  │  4. If not found → return { success: false, error: "..." }          │  │
│  │                                                                     │  │
│  │  Delegates to ICodeHydraApi after resolution                        │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
                    │ WebSocket (localhost only)
                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    codehydra extension (code-server)                      │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  extension.js                                                       │  │
│  │                                                                     │  │
│  │  // Socket.IO client                                                │  │
│  │  socket.on("command", handler)           // inbound: execute cmd    │  │
│  │  socket.emit("api:workspace:...", ack)   // outbound: API calls     │  │
│  │                                                                     │  │
│  │  // Connection state management                                     │  │
│  │  let connected = false;                                             │  │
│  │  let pendingReady = [];  // queue for whenReady()                   │  │
│  │                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  exports.codehydra = {                                              │  │
│  │    whenReady(): Promise<void>             // resolves when connected│  │
│  │    workspace: {                                                     │  │
│  │      getStatus(): Promise<WorkspaceStatus>                          │  │
│  │      getMetadata(): Promise<Record<string, string>>                 │  │
│  │      setMetadata(key, value): Promise<void>                         │  │
│  │    }                                                                │  │
│  │  }                                                                  │  │
│  │                                                                     │  │
│  │  Error handling: Returns rejected Promise with clear message        │  │
│  │  (matches PluginResult pattern - no throwing)                       │  │
│  │                                                                     │  │
│  │  Timeout: 10s (matches COMMAND_TIMEOUT_MS)                          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
                    │
                    │ vscode.extensions.getExtension()
                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    Third-party extension                                  │
│                                                                           │
│  const ext = vscode.extensions.getExtension('codehydra.sidekick');        │
│  const api = ext?.exports?.codehydra;                                     │
│  if (!api) throw new Error('codehydra extension not available');          │
│                                                                           │
│  await api.whenReady();  // wait for connection                           │
│  const status = await api.workspace.getStatus();                          │
│  const metadata = await api.workspace.getMetadata();                      │
│  await api.workspace.setMetadata('note', 'Working on feature X');         │
└───────────────────────────────────────────────────────────────────────────┘
```

### Protocol Messages

**Server → Client (Commands):**

| Event     | Payload          | Response                | Description             |
| --------- | ---------------- | ----------------------- | ----------------------- |
| `command` | `CommandRequest` | `PluginResult<unknown>` | Execute VS Code command |

**Client → Server (API Calls):**

| Event                       | Payload              | Response                              | Description                      |
| --------------------------- | -------------------- | ------------------------------------- | -------------------------------- |
| `api:workspace:getStatus`   | (none)               | `PluginResult<WorkspaceStatus>`       | Get workspace dirty/agent status |
| `api:workspace:getMetadata` | (none)               | `PluginResult<Record<string,string>>` | Get all workspace metadata       |
| `api:workspace:setMetadata` | `SetMetadataRequest` | `PluginResult<void>`                  | Set or delete metadata key       |

**Types:**

```typescript
interface CommandRequest {
  readonly command: string;
  readonly args?: readonly unknown[];
}

interface SetMetadataRequest {
  readonly key: string; // Must match /^[A-Za-z][A-Za-z0-9-]*$/
  readonly value: string | null; // null deletes the key
}

type PluginResult<T> = { success: true; data: T } | { success: false; error: string };
```

### Connection Lifecycle

1. **PluginServer starts** on dynamic port in main process
2. **code-server spawns** with `CODEHYDRA_PLUGIN_PORT` env var
3. **Extension activates** and reads env var
4. **Extension connects** with `auth: { workspacePath }` (normalized path)
5. **Server validates** auth and stores connection by normalized path
6. **Bidirectional communication** begins with acknowledgment callbacks

### API Wiring

The `wirePluginApi()` function in `src/main/index.ts` connects PluginServer to the CodeHydra API:

```typescript
function wirePluginApi(pluginServer: PluginServer, api: ICodeHydraApi, appState: AppState): void {
  pluginServer.onApiCall({
    getStatus: async (workspacePath) => {
      // 1. Resolve workspace path to projectId + workspaceName
      // 2. Call api.workspaces.getStatus(projectId, workspaceName)
      // 3. Return PluginResult
    },
    getMetadata: async (workspacePath) => {
      /* similar */
    },
    setMetadata: async (workspacePath, key, value) => {
      /* similar */
    },
  });
}
```

### Error Handling

- **Unknown workspace**: Returns `{ success: false, error: "Workspace not found" }`
- **Invalid metadata key**: Returns `{ success: false, error: "Invalid key format" }`
- **API exceptions**: Caught and mapped to `{ success: false, error: message }`
- **Timeout**: 10 seconds per request (client-side)

### Type Declarations for Third-Party Extensions

TypeScript declarations for the API are in:
`src/services/vscode-setup/assets/codehydra-sidekick/api.d.ts`

Third-party extension developers should copy this file into their project for type safety.

## External URL Handling

All URLs opened from code-server → external system browser:

- Implemented via `setWindowOpenHandler` returning `{ action: 'deny' }`
- Platform-specific: `xdg-open` (Linux), `open` (macOS), `start` (Windows)

## Binary Distribution

CodeHydra downloads code-server and opencode binaries from GitHub releases instead of bundling them or relying on devDependencies.

### Download Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Binary Download Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  npm install                          App Setup (Production)                │
│       │                                      │                              │
│       v                                      v                              │
│  ┌─────────────────┐                 ┌─────────────────┐                    │
│  │ postinstall     │                 │ VscodeSetup     │                    │
│  │ script (tsx)    │                 │ Service         │                    │
│  └────────┬────────┘                 └────────┬────────┘                    │
│           │                                   │                             │
│           └───────────────┬───────────────────┘                             │
│                           │                                                 │
│                           v                                                 │
│              ┌────────────────────────┐                                     │
│              │ BinaryDownloadService  │  (shared download logic)            │
│              │  - isInstalled()       │                                     │
│              │  - download()          │                                     │
│              │  - getBinaryPath()     │                                     │
│              │  - createWrapperScripts()                                    │
│              └───────────┬────────────┘                                     │
│                          │                                                  │
│           ┌──────────────┼──────────────┐                                   │
│           │              │              │                                   │
│           v              v              v                                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                            │
│  │ HttpClient  │ │ FileSystem  │ │ Archive     │                            │
│  │ (fetch)     │ │ Layer       │ │ Extractor   │                            │
│  └─────────────┘ └─────────────┘ └─────────────┘                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Version Management

Binary versions are defined in `src/services/binary-download/versions.ts`:

- `CODE_SERVER_VERSION` - e.g., "4.106.3"
- `OPENCODE_VERSION` - e.g., "0.1.47"

**Development**: `npm install` runs the postinstall script which downloads binaries to `./app-data/`.

**Production**: The VscodeSetupService downloads binaries to the user's app-data directory during first-run setup. If `CURRENT_SETUP_VERSION` is incremented (which happens when versions change), existing installations re-run setup on next launch.

### Platform-Specific Assets

| Platform      | code-server Source           | opencode Source       |
| ------------- | ---------------------------- | --------------------- |
| macOS (x64)   | coder/code-server (tar.gz)   | sst/opencode (tar.gz) |
| macOS (arm64) | coder/code-server (tar.gz)   | sst/opencode (tar.gz) |
| Linux (x64)   | coder/code-server (tar.gz)   | sst/opencode (tar.gz) |
| Linux (arm64) | coder/code-server (tar.gz)   | sst/opencode (tar.gz) |
| Windows (x64) | stefanhoelzl/codehydra (zip) | sst/opencode (tar.gz) |

**Windows Note**: code-server doesn't publish Windows binaries, so CodeHydra builds and publishes them via GitHub Actions (see `.github/workflows/build-code-server-windows.yaml`).

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
   validateAssets()     # Check settings.json, keybindings.json, extensions.json exist
       │
       ▼
   Run setup steps:
   1. downloadBinaries()      # Download code-server + opencode from GitHub releases
   2. installExtensions()     # bundled .vsix + marketplace extensions
   3. setupBinDirectory()     # Create CLI wrapper scripts in bin/
   4. writeCompletionMarker() # .setup-completed
       │
       ▼
  On success: Show "Setup complete!" (1.5s) → Continue to normal startup
  On failure: Show error with Retry/Quit buttons
```

### Asset Files

VS Code setup assets are stored as dedicated files (not inline code):

```
src/services/vscode-setup/assets/
├── settings.json              # VS Code settings (theme, telemetry, etc.)
├── keybindings.json           # Custom keybindings (Alt+T for panel toggle)
├── extensions.json            # Extension manifest (marketplace + bundled)
└── codehydra-sidekick/        # Custom extension source
    ├── package.json
    └── extension.js
```

### Build Process

1. `npm run build:extension` - packages `codehydra-sidekick/` into `sidekick-0.0.1.vsix`
2. `vite-plugin-static-copy` - copies all assets to `out/main/assets/` during build
3. `npm run build` - runs both steps sequentially

### Runtime Asset Resolution

```
out/main/assets/ (ASAR in prod)
    │
    ├─► settings.json ──► <app-data>/vscode/user-data/User/settings.json
    ├─► keybindings.json ──► <app-data>/vscode/user-data/User/keybindings.json
    └─► *.vsix ──► <app-data>/vscode/ ──► code-server --install-extension
```

- `PathProvider.vscodeAssetsDir` resolves to `<appPath>/out/main/assets/`
- Node.js `fs` module reads transparently from ASAR in production
- Files are copied to app-data before use (external processes can't read ASAR)

### Directory Structure

```
<app-data>/
├── bin/                           # CLI wrapper scripts (generated during setup)
│   ├── code (code.cmd)            # VS Code CLI wrapper
│   └── opencode (opencode.cmd)    # OpenCode wrapper (redirects to versioned binary)
├── code-server/
│   └── <version>/                 # e.g., 4.106.3/
│       ├── bin/code-server[.cmd]  # Actual code-server binary
│       ├── lib/                   # VS Code distribution
│       │   ├── node[.exe]         # Bundled Node.js (Windows only)
│       │   └── vscode/
│       └── out/node/entry.js      # Entry point
├── opencode/
│   └── <version>/                 # e.g., 0.1.47/
│       └── opencode[.exe]         # Actual opencode binary
├── vscode/
│   ├── .setup-completed           # JSON: { version: N, completedAt: "ISO" }
│   ├── codehydra-sidekick-0.0.1.vsix # Copied from assets for installation
│   ├── extensions/
│   │   ├── codehydra.sidekick-0.0.1/   # Installed by code-server
│   │   └── sst-dev.opencode-X.X.X/   # Installed by code-server
│   └── user-data/
│       └── User/
│           ├── settings.json      # Copied from assets
│           └── keybindings.json   # Copied from assets
├── runtime/                       # code-server runtime files
└── projects/                      # Git worktrees
```

### Setup Versioning

The `.setup-completed` marker contains a version number. When `CURRENT_SETUP_VERSION` is incremented (in `src/services/vscode-setup/types.ts`), existing installs will re-run setup on next launch, ensuring all users get updated extensions or config.

### Codehydra Extension

The custom codehydra extension (packaged as `.vsix` at build time) runs on VS Code startup to:

1. Close sidebars to maximize editor space
2. Open OpenCode terminal automatically
3. Clean up empty editor groups

This provides an optimized layout for AI agent workflows.

### CLI Wrapper Scripts

During VS Code setup, CLI wrapper scripts are generated in `<app-data>/bin/`. These scripts enable command-line tools to work in the integrated terminal.

**Generated Scripts:**

| Script                      | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `code` / `code.cmd`         | VS Code CLI (code-server's remote-cli)                      |
| `opencode` / `opencode.cmd` | Redirects to `<app-data>/opencode/<version>/opencode[.exe]` |

**Note**: code-server is launched directly via `PathProvider.codeServerBinaryPath` (absolute path), not via a wrapper script.

**Environment Configuration (in CodeServerManager):**

When spawning code-server, the manager modifies the environment:

1. **PATH prepend**: `<app-data>/bin/` is prepended to PATH
2. **EDITOR**: Set to `<binDir>/code --wait --reuse-window`
3. **GIT_SEQUENCE_EDITOR**: Set to same value as EDITOR

**Script Generation (in VscodeSetupService):**

```
setupBinDirectory()
    │
    ├── mkdir bin/
    ├── resolveTargetPaths() → { codeRemoteCli, codeServerBinary, opencodeBinary }
    ├── generateScripts(platformInfo, targetPaths) → GeneratedScript[]
    └── for each script:
        ├── writeFile(binDir + filename, content)
        └── if needsExecutable: makeExecutable(path) [Unix only]
```

**Git Integration:**

With EDITOR configured, git operations open in code-server:

- `git commit` - Opens commit message editor
- `git rebase -i` - Opens interactive rebase editor
- Any tool respecting `$EDITOR`

## Keyboard Capture System

CodeHydra uses a **unified main-process keyboard capture system** where all shortcut detection happens in the main process.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Main Process: ShortcutController                                        │
│  ├─ Registers before-input-event on ALL WebViews (workspace + UI)       │
│  ├─ Queries viewManager.getMode() for current state                     │
│  ├─ Alt+X when mode=workspace → setMode("shortcut")                     │
│  ├─ Action keys when mode=shortcut → emit shortcut:key event            │
│  └─ Alt release when mode=shortcut → setMode("workspace")               │
├─────────────────────────────────────────────────────────────────────────┤
│ Renderer: Receives events, executes actions                              │
│  ├─ ui:mode-changed → update shortcut overlay visibility                │
│  ├─ shortcut:key → execute workspace action (navigate, jump, dialog)    │
│  └─ Escape key → call api.ui.setMode("workspace")                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Detection Flow

| User Action            | Main Process                 | Renderer                  |
| ---------------------- | ---------------------------- | ------------------------- |
| Alt+X pressed          | setMode("shortcut")          | Show overlay              |
| Action key (↑↓0-9 etc) | Emit api:shortcut:key        | Execute action            |
| Escape pressed         | (passes through to renderer) | Call setMode("workspace") |
| Alt released           | setMode("workspace")         | Hide overlay              |

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
              │     │             │      • setMode("shortcut")             │
              │     │             │      • focusUI()                       │
              │     │             │             │                          │
              └─────┴─────────────┴─────────────┘                          │
                                                                           │
              Main process returns to NORMAL, UI has focus ────────────────┘
```

**While in shortcut mode**, action keys (↑↓Enter Delete O 0-9) are captured and emitted as `api:shortcut:key` events. Unknown keys pass through to the focused view.

### Key Files

| File                                          | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `src/main/shortcut-controller.ts`             | Main-process key detection and mode mgmt |
| `src/renderer/lib/stores/shortcuts.svelte.ts` | UI state (mode tracking)                 |
| `src/renderer/App.svelte`                     | Event subscriptions, action handlers     |

### Design Decisions

1. **Main process owns all detection**: Eliminates race conditions where renderer sees keys before focus switches
2. **ViewManager is single source of truth for mode**: ShortcutController queries `getMode()` instead of tracking its own state
3. **Escape handled in renderer**: Simplest key that doesn't require focus changes, just calls `setMode("workspace")`
4. **Mode transitions are idempotent**: Prevents spurious events during workspace switches

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

**Architecture Note**: IPC handlers are thin adapters over `ICodeHydraApi`. They only perform input validation and serialization - all business logic lives in the API implementation. See [API Layer Architecture](#api-layer-architecture) for details.

### Commands (renderer → main)

| Channel                           | Payload                             | Response            | Description                       |
| --------------------------------- | ----------------------------------- | ------------------- | --------------------------------- |
| `project:open`                    | `{ path: string }`                  | `Project`           | Open project, discover workspaces |
| `project:close`                   | `{ path: string }`                  | `void`              | Close project, destroy views      |
| `project:list`                    | `void`                              | `Project[]`         | List all open projects            |
| `project:select-folder`           | `void`                              | `string \| null`    | Show folder picker dialog         |
| `workspace:create`                | `{ projectPath, name, baseBranch }` | `Workspace`         | Create workspace, create view     |
| `workspace:remove`                | `{ workspacePath, deleteBranch }`   | `RemovalResult`     | Remove workspace, destroy view    |
| `workspace:switch`                | `{ workspacePath }`                 | `void`              | Switch active workspace           |
| `workspace:list-bases`            | `{ projectPath }`                   | `BaseInfo[]`        | List available branches           |
| `workspace:update-bases`          | `{ projectPath }`                   | `UpdateBasesResult` | Fetch from remotes                |
| `workspace:is-dirty`              | `{ workspacePath }`                 | `boolean`           | Check for uncommitted changes     |
| `api:workspace:get-opencode-port` | `{ projectId, workspaceName }`      | `number \| null`    | Get OpenCode server port          |
| `ui:set-dialog-mode`              | `{ isOpen: boolean }`               | `void`              | Swap UI layer z-order             |
| `ui:focus-active-workspace`       | `void`                              | `void`              | Return focus to VS Code           |

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
