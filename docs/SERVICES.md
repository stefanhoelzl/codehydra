# CodeHydra Service Layer

This document describes the service layer implementation patterns, platform abstractions, and external system access rules.

## Table of Contents

- [Overview](#overview)
- [External System Access Rules](#external-system-access-rules)
- [Platform Abstractions](#platform-abstractions)
  - [FileSystemLayer](#filesystemlayer)
  - [NetworkLayer](#networklayer)
  - [ProcessRunner](#processrunner)
  - [Path Class](#path-class)
  - [BuildInfo and PathProvider](#buildinfo-and-pathprovider)
- [Shell and Platform Layers](#shell-and-platform-layers)
- [Service Patterns](#service-patterns)
  - [Dependency Injection](#dependency-injection)
  - [WorkspaceLockHandler](#workspacelockhandler)
  - [PowerShell Script Assets](#powershell-script-assets)
- [Configuration and Binary Resolution](#configuration-and-binary-resolution)
- [Mock Factories Reference](#mock-factories-reference)

---

## Overview

Services are pure Node.js modules with no Electron dependencies, making them testable without Electron runtime. All external system access goes through abstraction interfaces defined in `src/services/platform/`.

```
Electron Main Process
      ↓ imports
App Services (pure Node.js)
      ↓ no Electron deps

Services are unit-testable without Electron runtime.
```

This architecture enables:

1. **Unit testing**: Services receive mock implementations via constructor injection
2. **Boundary testing**: Real implementations are tested against actual external systems in `*.boundary.test.ts` files
3. **Consistent error handling**: All abstractions use `ServiceError` hierarchy
4. **Single responsibility**: Each interface handles one external concern

---

## External System Access Rules

**CRITICAL**: All external system access MUST go through abstraction interfaces. Direct library/module usage is forbidden in service code.

| External System    | Interface              | Implementation                | Forbidden Direct Access     |
| ------------------ | ---------------------- | ----------------------------- | --------------------------- |
| Filesystem         | `FileSystemLayer`      | `DefaultFileSystemLayer`      | `node:fs/promises` directly |
| HTTP requests      | `HttpClient`           | `DefaultNetworkLayer`         | `fetch()` directly          |
| Port operations    | `PortManager`          | `DefaultNetworkLayer`         | `net` module directly       |
| Process spawning   | `ProcessRunner`        | `ExecaProcessRunner`          | `execa` directly            |
| Build info         | `BuildInfo`            | `ElectronBuildInfo`           | `app.isPackaged` directly   |
| Platform info      | `PlatformInfo`         | `NodePlatformInfo`            | `process.platform` directly |
| Path resolution    | `PathProvider`         | `DefaultPathProvider`         | Hardcoded paths             |
| Path normalization | `Path` (class)         | Self-normalizing object       | Manual string manipulation  |
| Blocking processes | `WorkspaceLockHandler` | `WindowsWorkspaceLockHandler` | Direct PowerShell calls     |

**Why this matters:**

1. **Testability**: Unit tests inject mocks; no real I/O in unit tests
2. **Boundary testing**: Real implementations tested in `*.boundary.test.ts`
3. **Consistency**: Unified error handling (e.g., `FileSystemError`, `ServiceError`)
4. **Maintainability**: Single point of change for external dependencies

**Exception - Pure Libraries:**

The `ignore` package (used by KeepFilesService) is acceptable for direct usage because it's a pure pattern-matching library with no I/O or side effects. It only performs string operations on patterns and paths.

**Implementation pattern:**

```typescript
// CORRECT: Inject interface via constructor
class MyService {
  constructor(
    private readonly fs: FileSystemLayer,
    private readonly http: HttpClient
  ) {}

  async doWork() {
    const data = await this.fs.readFile("/path");
    const response = await this.http.fetch("http://api/endpoint");
  }
}

// WRONG: Direct imports
import * as fs from "node:fs/promises";
class MyService {
  async doWork() {
    const data = await fs.readFile("/path", "utf-8"); // ❌ Not testable
  }
}
```

---

## Platform Abstractions

### FileSystemLayer

`FileSystemLayer` provides a testable abstraction over `node:fs/promises`. Services that need filesystem access receive `FileSystemLayer` via constructor injection.

```typescript
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

All methods throw `FileSystemError` (extends `ServiceError`) with mapped error codes:

| Code        | Description                         |
| ----------- | ----------------------------------- |
| `ENOENT`    | File/directory not found            |
| `EACCES`    | Permission denied                   |
| `EEXIST`    | File/directory already exists       |
| `ENOTDIR`   | Not a directory                     |
| `EISDIR`    | Is a directory (when file expected) |
| `ENOTEMPTY` | Directory not empty                 |
| `UNKNOWN`   | Other errors (check `originalCode`) |

**Testing with Behavioral Mocks:**

```typescript
import { createFileSystemMock, file, directory, symlink } from "../platform/filesystem.state-mock";

// Create mock with initial filesystem state
const mock = createFileSystemMock({
  entries: {
    "/projects": directory(),
    "/projects/config.json": file('{"key": "value"}'),
    "/projects/bin/run.sh": file("#!/bin/bash", { executable: true }),
    "/projects/current": symlink("/projects/v1"),
  },
});

// Simulate error on specific entry
const mockWithError = createFileSystemMock({
  entries: {
    "/protected.txt": file("secret", { error: "EACCES" }),
  },
});

// Inject into service
const service = new ProjectStore(projectsDir, mock);

// Assert filesystem state after operations
await service.saveConfig({ debug: true });
expect(mock).toHaveFile("/projects/config.json");
expect(mock).toHaveFileContaining("/projects/config.json", "debug");

// Access state directly via $ property
expect(mock.$.entries.size).toBe(4);

// Use snapshot for unchanged assertions
const snapshot = mock.$.snapshot();
await expect(mock.readFile("/missing")).rejects.toThrow();
expect(mock).toBeUnchanged(snapshot);
```

**Boundary test file:** `filesystem.boundary.test.ts`

### NetworkLayer

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

| Interface     | Methods               | Purpose                       | Used By                                                    |
| ------------- | --------------------- | ----------------------------- | ---------------------------------------------------------- |
| `HttpClient`  | `fetch(url, options)` | HTTP GET with timeout support | CodeServerManager, OpenCodeServerManager                   |
| `PortManager` | `findFreePort()`      | Find available ports          | CodeServerManager, OpenCodeServerManager, McpServerManager |

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
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer);
```

**Testing with Mock Utilities:**

```typescript
import { createMockHttpClient } from "../platform/network.test-utils";
import { createPortManagerMock } from "../platform/port-manager.state-mock";

const mockHttpClient = createMockHttpClient({
  response: new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
});

const portManager = createPortManagerMock([9999]);

const service = new SomeService(mockHttpClient, portManager);
```

**waitForPort() Utility:**

For boundary tests that need to wait for a server to start:

```typescript
import { waitForPort, CI_TIMEOUT_MS } from "../platform/network.test-utils";

// Start a server process
const proc = await startServer();

// Wait for it to be ready (uses longer timeout in CI)
const timeout = process.env.CI ? CI_TIMEOUT_MS : 5000;
await waitForPort(8080, timeout);

// Now safe to connect
```

**Boundary test file:** `network.boundary.test.ts`

### ProcessRunner

`ProcessRunner` provides a unified interface for spawning processes:

```typescript
// ProcessRunner returns a SpawnedProcess handle synchronously
const proc = runner.run("code-server", ["--port", "8080"], { cwd: "/app", env: cleanEnv });
console.log(`PID: ${proc.pid}`);

// Wait for completion (never throws for exit status)
const result = await proc.wait();
if (result.exitCode !== 0) {
  console.error(result.stderr);
}
```

**SpawnedProcess Handle:**

| Property/Method  | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `pid`            | Process ID (undefined if spawn failed)                           |
| `kill(signal?)`  | Send signal (default: SIGTERM). Returns true if sent.            |
| `wait(timeout?)` | Wait for exit. Returns `ProcessResult` with exitCode/signal/etc. |

**Graceful Shutdown with Timeout Escalation:**

```typescript
// Send SIGTERM and wait up to 5s
proc.kill("SIGTERM");
const result = await proc.wait(5000);

// If still running after timeout, escalate to SIGKILL
if (result.running) {
  proc.kill("SIGKILL");
  await proc.wait();
}
```

**ProcessResult Fields:**

| Field      | Type             | Description                                         |
| ---------- | ---------------- | --------------------------------------------------- |
| `exitCode` | `number \| null` | Exit code (null if killed/timeout/spawn error)      |
| `signal`   | `string?`        | Signal name if killed (e.g., "SIGTERM")             |
| `running`  | `boolean?`       | True if still running after wait(timeout)           |
| `stdout`   | `string`         | Captured stdout                                     |
| `stderr`   | `string`         | Captured stderr (includes spawn errors like ENOENT) |

**Platform-specific kill behavior:**

- **Windows**: Always uses `taskkill /t /f` (immediate forceful termination) because WM_CLOSE cannot signal console processes and CTRL_C_EVENT cannot be sent to detached processes
- **Unix**: Uses two-phase SIGTERM → SIGKILL with configurable timeouts

**Kill Timeouts:**

```typescript
// Default timeouts (1 second each)
import { PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS } from "./process";

// Use with the new kill() API
const result = await proc.kill(
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS, // 1000ms for SIGTERM
  PROCESS_KILL_FORCE_TIMEOUT_MS // 1000ms for SIGKILL
);

if (!result.success) {
  console.error("Process did not terminate");
}
```

**Testing with Mocks:**

```typescript
import { createMockProcessRunner, createMockSpawnedProcess } from "../platform/process.test-utils";

// Create mock with controllable behavior
const mockProc = createMockSpawnedProcess({
  pid: 12345,
  waitResult: { exitCode: 0, stdout: "output", stderr: "" },
});
const runner = createMockProcessRunner(mockProc);

// Inject into service
const service = new SomeService(runner);
```

**Boundary test file:** `process.boundary.test.ts`

### Path Class

The `Path` class normalizes filesystem paths to a canonical internal format:

- **POSIX separators**: Always forward slashes (`/`)
- **Absolute only**: Throws on relative paths
- **Case normalization**: Lowercase on Windows
- **Clean format**: No trailing slashes, resolved `..` segments

```typescript
import { Path } from "../services/platform/path";

const p = new Path("C:\\Users\\Name");
p.toString(); // "c:/users/name" (Windows)
p.toNative(); // "c:\users\name" (for OS APIs)
p.equals("C:/users/name"); // true (case-insensitive on Windows)
```

**When to Use Each Method:**

| Method        | Use Case                                         |
| ------------- | ------------------------------------------------ |
| `toString()`  | Map keys, comparisons, JSON serialization        |
| `toNative()`  | (Internal use by FileSystemLayer, ProcessRunner) |
| `equals()`    | Path comparison (handles different formats)      |
| `isChildOf()` | Containment checks (not `startsWith()`)          |

**IPC Boundary Handling:**

```
Renderer (strings) ──IPC──► Main Process IPC Handlers ──► Services (Path objects)
                              │
                              ├─ INCOMING: new Path(payload.path)
                              └─ OUTGOING: path.toString() (automatic via toJSON)
```

- **Shared types in `src/shared/`**: Use `string` for paths (IPC compatibility)
- **Internal services**: Use `Path` objects for all path handling
- **Renderer**: Receives pre-normalized strings; safe to compare with `===`

**Common Patterns:**

```typescript
// Creating Path from external input
const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
const projectPath = new Path(result.filePaths[0]);

// Using paths in Maps
const views = new Map<string, WebContentsView>();
views.set(path.toString(), view);
views.get(path.toString());

// Path comparison
if (workspacePath.equals(projectRoot)) { ... }

// Containment checks
if (workspacePath.isChildOf(projectRoot)) { ... }
```

**Testing with Paths:**

```typescript
// Verify a path was stored correctly
const stored = service.getPath();
expect(stored.toString()).toBe("/normalized/path");

// Compare path equality
expect(path1.equals(path2)).toBe(true);

// Mock PathProvider returns Path objects
const mockPathProvider = createMockPathProvider({
  vscodeDir: new Path("/test/vscode"),
  projectsDir: new Path("/test/projects"),
});
```

### BuildInfo and PathProvider

The application uses dependency injection to abstract build mode detection and path resolution.

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
3. In `startServices()` (construction phase):
   - Construct all remaining services (CodeServerManager, AppState, agent services, etc.)
   - No I/O -- constructors/factories only
4. In `startServices()` (dispatch phase):
   - Wire intent dispatcher, get API, then dispatch `app:start`
   - Lifecycle modules handle all I/O (starting servers, loading data, wiring callbacks)

**Testing with PathProvider:**

```typescript
const mockPathProvider = createMockPathProvider({
  vscodeDir: "/test/vscode",
});
const service = new VscodeSetupService(mockRunner, mockPathProvider, mockFs);
```

---

## Shell and Platform Layers

Electron APIs are abstracted behind testable interfaces in two domains:

| Domain   | Location             | Purpose                       | Examples                                   |
| -------- | -------------------- | ----------------------------- | ------------------------------------------ |
| Platform | `services/platform/` | OS/runtime abstractions       | `IpcLayer`, `DialogLayer`, `ImageLayer`    |
| Shell    | `services/shell/`    | Visual container abstractions | `WindowLayer`, `ViewLayer`, `SessionLayer` |

**Dependency Rule**: Shell layers may depend on Platform layers, but not vice versa.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Main Process Components                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │ WindowManager   │  │  ViewManager    │  │    BadgeManager             │  │
│  │ ShortcutCtrl    │  │                 │  │                             │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────┬───────────────┘  │
│           │                    │                         │                  │
└───────────┼────────────────────┼─────────────────────────┼──────────────────┘
            │                    │                         │
┌───────────▼────────────────────▼─────────────────────────▼──────────────────┐
│                          Abstraction Layers                                 │
│  ┌─────────────────────────────────┐  ┌───────────────────────────────────┐ │
│  │          Shell Layers           │  │         Platform Layers           │ │
│  │         (services/shell/)       │  │       (services/platform/)        │ │
│  │  WindowLayer ───► ImageLayer ───┼──┼─► ImageLayer                      │ │
│  │       │                         │  │   IpcLayer                        │ │
│  │       ▼                         │  │   DialogLayer                     │ │
│  │  ViewLayer ───► SessionLayer    │  │   AppLayer                        │ │
│  │                                 │  │   MenuLayer                       │ │
│  └─────────────────────────────────┘  └───────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
            │                    │                         │
┌───────────▼────────────────────▼─────────────────────────▼──────────────────┐
│                            Electron APIs                                    │
│  BaseWindow    WebContentsView    session    ipcMain    dialog    app       │
│  nativeImage   Menu                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Layer Dependency Rules:**

| Rule                | Description                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Shell → Platform    | Shell layers may depend on Platform layers (e.g., WindowLayer uses ImageLayer for overlay icons) |
| Platform → Platform | Platform layers are independent (no dependencies on each other)                                  |
| Shell → Shell       | Shell layers may depend on each other (e.g., ViewLayer uses SessionLayer)                        |
| Platform ↛ Shell    | Platform layers may NOT depend on Shell layers                                                   |

**Handle-Based Design:**

Layers return opaque handles instead of raw Electron objects:

| Layer          | Returns         | Instead of        |
| -------------- | --------------- | ----------------- |
| `WindowLayer`  | `WindowHandle`  | `BaseWindow`      |
| `ViewLayer`    | `ViewHandle`    | `WebContentsView` |
| `SessionLayer` | `SessionHandle` | `Session`         |
| `ImageLayer`   | `ImageHandle`   | `NativeImage`     |

This pattern:

- Prevents Electron types from leaking into manager code
- Enables behavioral mocks that just return `{ id: "test-1", __brand: "ViewHandle" }`
- Centralizes all Electron access in layer implementations

**Example:**

```typescript
// Interface returns handles, not Electron objects
interface ViewLayer {
  createView(options: ViewOptions): ViewHandle; // Returns handle
  loadURL(handle: ViewHandle, url: string): Promise<void>;
  destroy(handle: ViewHandle): void;
}

// Branded type prevents accidental mixing
interface ViewHandle {
  readonly id: string;
  readonly __brand: "ViewHandle";
}
```

**Behavioral Mocks for Layers:**

```typescript
import { createViewLayerMock } from "../shell/view.state-mock";

// Create mock with state access via $ property
const mock = createViewLayerMock();

// All ViewLayer methods work with in-memory state
const handle = mock.createView({ backgroundColor: "#1e1e1e" });
await mock.loadURL(handle, "http://127.0.0.1:8080");

// State access via $ property
const snapshot = mock.$.snapshot();

// Trigger simulated events
mock.$.triggerDidFinishLoad(handle);
mock.$.triggerWillNavigate(handle, "http://example.com");

// Custom matchers for assertions
expect(mock).toHaveView(handle.id);
expect(mock).toHaveView(handle.id, {
  url: "http://127.0.0.1:8080",
  attachedTo: null,
  backgroundColor: "#1e1e1e",
});
```

**Error Handling:**

Each domain has its own error class with typed codes:

```typescript
// Platform errors
throw new PlatformError("IPC_HANDLER_EXISTS", `Handler already exists for channel: ${channel}`);

// Shell errors include handle context
throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
```

**Error codes:**

| Domain   | Error Codes                                                                 |
| -------- | --------------------------------------------------------------------------- |
| Platform | `IPC_HANDLER_EXISTS`, `IPC_HANDLER_NOT_FOUND`, `DIALOG_CANCELLED`, etc.     |
| Shell    | `WINDOW_NOT_FOUND`, `VIEW_NOT_FOUND`, `VIEW_DESTROYED`, `SESSION_NOT_FOUND` |

**Boundary Tests:**

Each layer has boundary tests that verify behavior against real Electron APIs:

| Layer          | Boundary Test              |
| -------------- | -------------------------- |
| `IpcLayer`     | `ipc.boundary.test.ts`     |
| `DialogLayer`  | `dialog.boundary.test.ts`  |
| `ImageLayer`   | `image.boundary.test.ts`   |
| `AppLayer`     | `app.boundary.test.ts`     |
| `MenuLayer`    | `menu.boundary.test.ts`    |
| `WindowLayer`  | `window.boundary.test.ts`  |
| `ViewLayer`    | `view.boundary.test.ts`    |
| `SessionLayer` | `session.boundary.test.ts` |

---

## Service Patterns

### Dependency Injection

Services use constructor DI for testability (NOT singletons):

```typescript
// Service with injected dependencies
class DiscoveryService {
  constructor(
    private readonly portManager: PortManager,
    private readonly instanceProbe: InstanceProbe
  ) {}
}

// Services owned and wired in main process
// Example from bootstrap() and startServices():
const networkLayer = new DefaultNetworkLayer();
const processRunner = new ExecaProcessRunner();
const binaryDownloadService = new DefaultBinaryDownloadService(...);
vscodeSetupService = new VscodeSetupService(processRunner, pathProvider, fsLayer, platformInfo, binaryDownloadService);
codeServerManager = new CodeServerManager(config, processRunner, networkLayer, networkLayer);
```

### WorkspaceLockHandler

`WorkspaceLockHandler` detects and manages processes that block file operations (Windows-only). It uses a three-operation model:

| Method            | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `detect(path)`    | Detect processes with handles on files under path     |
| `killProcesses()` | Kill all detected processes via taskkill              |
| `closeHandles()`  | Close file handles (requires UAC elevation on Win 10) |

```typescript
// Factory creates platform-specific implementation
const workspaceLockHandler = createWorkspaceLockHandler(
  processRunner,
  platformInfo,
  pathProvider,
  logger
);

// Windows: Uses Restart Manager API via PowerShell script
// Other platforms: Returns undefined (detection steps skipped)
```

**Three-Operation Workflow:**

```
detect(path)         →  Returns DetectionResult with processes array
    │
    ├─ killProcesses()   →  Terminates all detected processes
    │
    └─ closeHandles()    →  Closes file handles (may require elevation)
```

**Usage in Deletion Flow:**

```typescript
// In CoreModule.executeDeletion()
if (unblock === "kill") {
  await workspaceLockHandler.killProcesses();
} else if (unblock === "close") {
  await workspaceLockHandler.closeHandles();
}

// Proactive detection runs after cleanup, before workspace removal
const detected = await workspaceLockHandler.detect(workspacePath);
if (detected.length > 0) {
  emitProgress({ step: "detecting-blockers", blockingProcesses: detected, hasErrors: true });
}
```

**BlockingProcess Type:**

```typescript
interface BlockingProcess {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly files: readonly string[]; // Locked files (relative to detected path)
  readonly cwd: string | null; // Process working directory
}
```

**Testing with Mocks:**

```typescript
import { createMockWorkspaceLockHandler } from "../platform/workspace-lock-handler.test-utils";

// Return specific blocking processes
const mockHandler = createMockWorkspaceLockHandler({
  initialProcesses: [
    {
      pid: 1234,
      name: "node.exe",
      commandLine: "node server.js",
      files: ["index.js"],
      cwd: "/app",
    },
  ],
});

// Inject into CoreModule
const module = new CoreModule(api, { ...deps, workspaceLockHandler: mockHandler });
```

**Boundary test file:** `workspace-lock-handler.boundary.test.ts`

### PowerShell Script Assets

For Windows-specific functionality requiring .NET/COM APIs, use PowerShell scripts bundled as assets:

**Asset Location:**

```
resources/scripts/          → Source scripts
out/main/assets/scripts/    → Bundled (via vite-plugin-static-copy)
```

**Script Structure (parameter-based modes):**

```powershell
# blocking-processes.ps1
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("Detect", "CloseHandles")]
    [string]$Action,

    [Parameter(Mandatory=$true)]
    [string]$Path
)

# Output JSON to stdout for parsing
$result = @{ processes = @(); ... }
$result | ConvertTo-Json -Depth 10
```

**Service Integration:**

```typescript
// Get script path from PathProvider
const scriptPath = this.pathProvider.scriptsDir.join("blocking-processes.ps1");

// Run with ProcessRunner
const proc = this.runner.run("powershell", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  scriptPath.toNative(),
  "-Action",
  "Detect",
  "-Path",
  targetPath.toNative(),
]);

const result = await proc.wait();
const data = JSON.parse(result.stdout);
```

**Self-Elevation Pattern:**

For operations requiring admin privileges, scripts can self-elevate:

```powershell
# Check if elevated
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    # Re-launch elevated, capture output via temp file
    $tempFile = [System.IO.Path]::GetTempFileName()
    Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-Action", $Action, "-Path", $Path,
        "-OutputFile", $tempFile
    )
    Get-Content $tempFile
    Remove-Item $tempFile
    exit
}
```

**JSON Output Schema:**

Scripts should return structured JSON for parsing:

```json
{
  "processes": [
    {
      "pid": 1234,
      "name": "node.exe",
      "commandLine": "node server.js",
      "files": ["index.js", "lib/util.js"],
      "cwd": "C:\\projects\\app"
    }
  ],
  "error": null
}
```

---

## Configuration and Binary Resolution

### ConfigService

`ConfigService` manages user preferences and version configuration stored in `config.json`:

```typescript
// Load config (creates defaults if missing)
const config = await configService.load();
// Returns: { agent: "claude" | "opencode" | null, versions: { ... } }

// Update agent selection
await configService.update({ agent: "claude" });

// Config is validated on load - invalid JSON returns defaults with warning
```

**Key behaviors:**

- `load()` creates file with defaults if missing
- `update()` merges changes with existing config
- Invalid JSON is handled gracefully (returns defaults, logs warning)
- Uses `FileSystemLayer` for I/O (per External System Access Rules)

**Config file location:** `{dataRootDir}/config.json`

**Testing with FileSystemMock:**

```typescript
const mock = createFileSystemMock({
  entries: {
    "/data/config.json": file('{"agent": "claude"}'),
  },
});
const service = new ConfigService(new Path("/data/config.json"), mock, logger);
const config = await service.load();
expect(config.agent).toBe("claude");
```

### BinaryResolutionService

`BinaryResolutionService` determines binary availability using a priority-based resolution:

```typescript
// Resolution priority for agents (versions.{agent} = null):
// 1. System binary (via which/where)
// 2. Downloaded binary (any version in bundles dir)
// 3. Mark for download

const result = await resolutionService.resolve("claude");
// Returns: { available: true, path: "/usr/local/bin/claude", source: "system" }
//     or: { available: true, path: "/bundles/claude/1.0.58/claude", source: "downloaded", version: "1.0.58" }
//     or: { available: false, needsDownload: true }
```

**Resolution logic by version config:**

| `versions.{binary}` | Resolution Order                             |
| ------------------- | -------------------------------------------- |
| `null`              | System binary → Latest downloaded → Download |
| `"1.0.58"` (pinned) | Exact version in bundles → Download          |

**System binary detection:**

```typescript
// Uses ProcessRunner to invoke which/where
const proc = runner.run(platform === "win32" ? "where" : "which", [binaryName]);
const result = await proc.wait();
if (result.exitCode === 0) {
  return result.stdout.trim().split("\n")[0]; // First line for Windows
}
return null;
```

**Version directory scanning:**

```typescript
// Find latest downloaded version using locale-aware comparison
const versions = await fs.readdir(bundlesBaseDir);
versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
return versions[0]; // Highest version
```

---

## Mock Factories Reference

All paths below are relative to `src/services/`.

### Platform Layer Mocks

| Interface              | Mock Factory                       | Location                                          |
| ---------------------- | ---------------------------------- | ------------------------------------------------- |
| `ArchiveExtractor`     | `createArchiveExtractorMock()`     | `binary-download/archive-extractor.state-mock.ts` |
| `FileSystemLayer`      | `createFileSystemMock()`           | `platform/filesystem.state-mock.ts`               |
| `HttpClient`           | `createMockHttpClient()`           | `platform/network.test-utils.ts`                  |
| `PortManager`          | `createPortManagerMock()`          | `platform/port-manager.state-mock.ts`             |
| `ProcessRunner`        | `createMockProcessRunner()`        | `platform/process.test-utils.ts`                  |
| `PathProvider`         | `createMockPathProvider()`         | `platform/path-provider.test-utils.ts`            |
| `WorkspaceLockHandler` | `createMockWorkspaceLockHandler()` | `platform/workspace-lock-handler.test-utils.ts`   |

### Shell Layer Mocks

| Interface             | Mock Factory                      | Location                        |
| --------------------- | --------------------------------- | ------------------------------- |
| `IpcLayer`            | `createBehavioralIpcLayer()`      | `platform/ipc.test-utils.ts`    |
| `DialogLayer`         | `createBehavioralDialogLayer()`   | `platform/dialog.test-utils.ts` |
| `ImageLayer`          | `createImageLayerMock()`          | `platform/image.state-mock.ts`  |
| `AppLayer`            | `createAppLayerMock()`            | `platform/app.state-mock.ts`    |
| `MenuLayer`           | `createBehavioralMenuLayer()`     | `platform/menu.test-utils.ts`   |
| `WindowLayer`         | `createWindowLayerMock()`         | `shell/window.state-mock.ts`    |
| `WindowLayerInternal` | `createWindowLayerInternalMock()` | `shell/window.state-mock.ts`    |
| `ViewLayer`           | `createViewLayerMock()`           | `shell/view.state-mock.ts`      |
| `SessionLayer`        | `createSessionLayerMock()`        | `shell/session.state-mock.ts`   |

### Domain Mocks

| Interface    | Mock Factory            | Location                    |
| ------------ | ----------------------- | --------------------------- |
| `IGitClient` | `createMockGitClient()` | `git/git-client.state-mock` |

**Git client mock example:**

```typescript
import { createMockGitClient } from "./git/git-client.state-mock";

const mock = createMockGitClient({
  repositories: {
    "/project": {
      branches: ["main", "feature-x"],
      remoteBranches: ["origin/main"],
      remotes: ["origin"],
      worktrees: [
        { name: "feature-x", path: "/workspaces/feature-x", branch: "feature-x", isDirty: true },
      ],
      branchConfigs: { "feature-x": { "codehydra.base": "main" } },
      mainIsDirty: false,
      currentBranch: "main",
    },
  },
});

// Mutations update state
await mock.createBranch(new Path("/project"), "feature-y", "main");
expect(mock).toHaveBranch("/project", "feature-y");

// Custom matchers
expect(mock).toHaveWorktree("/project", "/workspaces/feature-x");
expect(mock).toHaveBranchConfig("/project", "feature-x", "codehydra.base", "main");
```
