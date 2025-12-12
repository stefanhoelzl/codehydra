# CodeHydra - AI Agent Instructions

## Project Overview

- Multi-workspace IDE for parallel AI agent development
- Each workspace = git worktree in isolated WebContentsView with VS Code (code-server)
- Real-time OpenCode agent status monitoring

## Tech Stack

| Layer           | Technology                               |
| --------------- | ---------------------------------------- |
| Desktop         | Electron (BaseWindow + WebContentsViews) |
| Frontend        | Svelte 5 + TypeScript + @vscode-elements |
| Backend         | Node.js services                         |
| Testing         | Vitest                                   |
| Build           | Vite                                     |
| Package Manager | npm                                      |

## Key Documents

| Document         | Location                       | Purpose                                 |
| ---------------- | ------------------------------ | --------------------------------------- |
| Migration Plan   | planning/ELECTRON_MIGRATION.md | Phase details, implementation workflow  |
| Architecture     | docs/ARCHITECTURE.md           | System design, component relationships  |
| UI Specification | docs/USER_INTERFACE.md         | User flows, mockups, keyboard shortcuts |
| Testing Strategy | docs/TESTING.md                | Test types, conventions, commands       |

**Important**: Files in `planning/` are **historical records** that reflect the state at the time of planning/implementation. They may not reflect the current application state. To understand current state, read source code and `docs/` files. Read `planning/` files for design decision context and rationale.

## Key Concepts

| Concept         | Description                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project         | Git repository path (container, not viewable) - the main git directory                                                                                |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory                                                                                       |
| WebContentsView | Electron view for embedding (not iframe)                                                                                                              |
| Shortcut Mode   | Keyboard-driven navigation activated by Alt+X, shows overlay with workspace actions (↑↓ navigate, 1-0 jump, Enter new, Delete remove, O open project) |
| VS Code Setup   | First-run setup that installs extensions and config; runs once before code-server starts; marker at `<app-data>/vscode/.setup-completed`              |

## View Detachment Pattern

For GPU optimization, workspace views use **detachment** instead of zero-bounds hiding:

| State    | contentView | URL Loaded | GPU Usage |
| -------- | ----------- | ---------- | --------- |
| Created  | Detached    | No         | None      |
| Active   | Attached    | Yes        | Active    |
| Inactive | Detached    | Yes        | None      |

**Key behaviors:**

- Views start **detached** (not in contentView) with **URL not loaded** (lazy loading)
- On first activation: URL is loaded, view is attached to contentView
- On subsequent activations: view is attached (URL already loaded)
- On deactivation: view is detached (removed from contentView), then throttled (if enabled)
- **Attach-before-detach**: New view is attached BEFORE old view is detached for visual continuity

**Rationale**: With >5 workspaces, zero-bounds hiding still consumed GPU resources. Detaching views entirely eliminates GPU usage for inactive workspaces.

## GPU Throttling

For additional GPU memory reduction, inactive views can be **throttled** via `CODEHYDRA_WORKSPACE_THROTTLING`:

| Level   | setBackgroundThrottling | visibilitychange | WebGL Context Loss | Use Case                        |
| ------- | ----------------------- | ---------------- | ------------------ | ------------------------------- |
| `off`   | No                      | No               | No                 | Default - stable systems        |
| `basic` | Yes                     | No               | No                 | Reduce timer/animation activity |
| `full`  | Yes                     | Yes              | Yes                | Maximum GPU memory reduction    |

**Environment variable**: `CODEHYDRA_WORKSPACE_THROTTLING=off|basic|full`

**Best-effort note**: `setBackgroundThrottling` primarily affects timers and `requestAnimationFrame` - it's best-effort for GPU memory reduction, not a guarantee. The WebGL context loss in `full` mode is what actually releases GPU memory.

**Timing**:

- **Throttle**: Fire-and-forget after detach (view already hidden)
- **Unthrottle**: Fire-and-forget after attach (restore in background)
- **Cancellation**: New throttle/unthrottle cancels in-flight operation via AbortController

## GPU Troubleshooting

### Environment Variables

| Variable                         | Values                 | Description                       |
| -------------------------------- | ---------------------- | --------------------------------- |
| `CODEHYDRA_WORKSPACE_THROTTLING` | `off`, `basic`, `full` | Throttle level for inactive views |
| `CODEHYDRA_ELECTRON_FLAGS`       | Space-separated flags  | Electron command-line switches    |

### Common Electron Flags for GPU Issues

```bash
# Disable all GPU acceleration (CPU rendering only)
CODEHYDRA_ELECTRON_FLAGS="--disable-gpu"

# Software WebGL (slower but stable)
CODEHYDRA_ELECTRON_FLAGS="--use-gl=swiftshader"

# Disable GPU compositing only
CODEHYDRA_ELECTRON_FLAGS="--disable-gpu-compositing"

# Multiple flags
CODEHYDRA_ELECTRON_FLAGS="--disable-gpu --disable-software-rasterizer"
```

**Note**: Quoted values are NOT supported. Use `--flag=value` not `--flag="value"`.

### Troubleshooting Steps

1. **Try throttling first** (least impact):

   ```bash
   CODEHYDRA_WORKSPACE_THROTTLING=full npm run dev
   ```

2. **If still crashing, disable GPU**:

   ```bash
   CODEHYDRA_ELECTRON_FLAGS="--disable-gpu" npm run dev
   ```

3. **For WebGL-specific crashes**:
   ```bash
   CODEHYDRA_ELECTRON_FLAGS="--use-gl=swiftshader" npm run dev
   ```

## Project Structure (after Phase 1)

```
src/
├── main/           # Electron main process
├── preload/        # Preload scripts
├── renderer/       # Svelte frontend
└── services/       # Node.js services (pure, no Electron deps)
```

## Renderer Architecture

### Directory Structure

```
src/renderer/
├── lib/
│   ├── api/          # Re-exports window.api for mockability
│   ├── components/   # Svelte 5 components
│   ├── stores/       # Svelte 5 runes-based stores (.svelte.ts)
│   ├── styles/       # Global CSS (variables.css, global.css)
│   └── utils/        # Utility functions (focus-trap, etc.)
├── App.svelte        # Main application component
└── main.ts           # Entry point
```

### Patterns

- **API imports**: Always import from `$lib/api`, never `window.api` directly
- **State management**: Use Svelte 5 runes (`$state`, `$derived`, `$effect`)
- **Testing**: Mock `$lib/api` in tests, not `window.api`
- **Note**: `window.electronAPI` was renamed to `window.api` in Phase 4

### App/MainView Split Pattern

The renderer has a two-component architecture for startup:

| Component       | Responsibility                                                       |
| --------------- | -------------------------------------------------------------------- |
| App.svelte      | Mode router: setup vs normal. Owns global events (shortcuts, setup). |
| MainView.svelte | Normal app container. Owns IPC initialization and domain events.     |

**IPC Initialization Timing Rules:**

1. `setupReady()` is called in App.svelte's `onMount` - determines which mode to show
2. `listProjects()`, `getAllAgentStatuses()` are called in MainView.svelte's `onMount` - only when setup is complete
3. Domain event subscriptions (project/workspace/agent) happen in MainView.svelte
4. Global event subscriptions (shortcuts, setup events) stay in App.svelte

This prevents "handler not registered" errors during setup mode, when normal IPC handlers aren't available.

### Main Process Startup Architecture

The main process uses two-phase startup:

| Function          | Responsibility                                                     |
| ----------------- | ------------------------------------------------------------------ |
| `bootstrap()`     | Infrastructure only: window, views, setup handlers, load UI        |
| `startServices()` | All app services: code-server, AppState, OpenCode, normal handlers |

```
bootstrap() -> UI loads -> setupReady() called
                               |
               +---------------+---------------+
               | ready: true                   | ready: false
               v                               v
        startServices()                 run setup process
               |                               |
               |                         startServices()
               |                               |
               |                         emit setup:complete
               v                               v
        App ready                       App ready
```

**Key Timing Guarantee**: The `setup:complete` event is emitted to the renderer only AFTER `startServices()` completes. This ensures that normal IPC handlers are registered before MainView mounts and tries to call them.

## IPC Patterns

### Fire-and-Forget IPC

For UI state changes that cannot fail (like z-order swapping), use the `void` operator to call IPC without awaiting:

```typescript
void api.setDialogMode(true); // Intentionally not awaited
```

This pattern is used when:

1. The operation cannot meaningfully fail
2. Immediate UI response is more important than confirmation
3. The renderer should not block on the main process

## UI Patterns

### Dropdown Selection with Mousedown

For custom dropdown components, use `onmousedown` with `preventDefault()` instead of `onclick` for option selection. This prevents the blur-before-click timing issue.

**Problem**: Browser event sequence for click is: `mousedown → blur → mouseup → click`. When clicking a dropdown option, the input loses focus during `mousedown`, causing the dropdown to close before `click` fires.

**Solution**: Handle selection in `mousedown` with `preventDefault()`:

```svelte
<li
  role="option"
  onmousedown={(e: MouseEvent) => {
    e.preventDefault(); // Prevents input blur
    selectOption(option.value);
  }}
>
  {option.label}
</li>
```

**Testing Note**: Use `fireEvent.mouseDown()` in tests, not `fireEvent.click()`, since the handler is on mousedown. Add a comment explaining this pattern in tests.

### Fixed Positioning for Dropdown Overflow

When dropdowns appear inside containers with `overflow: auto/hidden`, use `position: fixed` to escape clipping:

```typescript
// Calculate position from input element
const rect = inputRef.getBoundingClientRect();
dropdownPosition = {
  top: rect.bottom,
  left: rect.left,
  width: rect.width,
};

// Apply via inline styles with position: fixed in CSS
```

Remember to recalculate position on window resize when the dropdown is open.

## CSS Theming Patterns

### Variable Naming Convention

All theme variables use the `--ch-` prefix (CodeHydra) to avoid conflicts:

```css
/* Use --ch-* variables, never hardcoded colors */
.my-component {
  background: var(--ch-background);
  color: var(--ch-foreground);
  border: 1px solid var(--ch-border);
}
```

### VS Code Variable Fallback Pattern

Variables use `var(--vscode-*, fallback)` for dual-mode operation:

```css
--ch-foreground: var(--vscode-foreground, #cccccc);
/*                    └── VS Code injects   └── Standalone fallback */
```

- **In code-server context**: VS Code injects `--vscode-*` variables, which take precedence
- **In standalone mode**: Fallback values are used, controlled by `prefers-color-scheme`

### Light Theme Approach

Light/dark themes only change fallback values via `@media` query:

```css
:root {
  --ch-foreground: var(--vscode-foreground, #cccccc); /* Dark fallback */
}

@media (prefers-color-scheme: light) {
  :root {
    --ch-foreground: var(--vscode-foreground, #3c3c3c); /* Light fallback */
    /* Same VS Code variable, different fallback */
  }
}
```

### Semantic Color Variables

Use semantic variables for consistent theming:

| Category | Variables                                                     |
| -------- | ------------------------------------------------------------- |
| Core     | `--ch-foreground`, `--ch-background`                          |
| Border   | `--ch-border`, `--ch-input-border`, `--ch-input-hover-border` |
| Buttons  | `--ch-button-bg`, `--ch-button-fg`, `--ch-button-hover-bg`    |
| Semantic | `--ch-success`, `--ch-danger`, `--ch-warning`                 |
| Agent    | `--ch-agent-idle`, `--ch-agent-busy` (reference semantic)     |
| Overlay  | `--ch-overlay-bg`, `--ch-shadow-color`, `--ch-shadow`         |
| Focus    | `--ch-focus-border`                                           |

### Screen Reader Text

Use the global `.ch-visually-hidden` class for screen reader only text (NOT component-local `.sr-only`):

```svelte
<span class="ch-visually-hidden">Shortcut mode active.</span>
```

The class is defined in `src/renderer/lib/styles/global.css`.

## OpenCode Integration

### Agent Status Store (Svelte 5 Runes)

The agent status store uses Svelte 5's runes pattern for reactive state:

```typescript
// src/renderer/lib/stores/agent-status.svelte.ts
let statuses = $state(new Map<string, AggregatedAgentStatus>());
let counts = $state(new Map<string, AgentStatusCounts>());

// Access via exported objects with .value getter
export const agentStatusStore = {
  get statuses() {
    return statuses;
  },
  get counts() {
    return counts;
  },
};

// Update functions called by IPC listener in App.svelte
export function updateAgentStatus(
  workspacePath: string,
  status: AggregatedAgentStatus,
  newCounts: AgentStatusCounts
): void {
  statuses = new Map(statuses).set(workspacePath, status);
  counts = new Map(counts).set(workspacePath, newCounts);
}
```

### Service Dependency Injection Pattern

Services use constructor DI for testability (NOT singletons):

```typescript
// Service with injected dependencies
class DiscoveryService {
  constructor(
    private readonly portManager: PortManager,
    private readonly processTree: ProcessTreeProvider,
    private readonly instanceProbe: InstanceProbe
  ) {}
}

// Services owned and wired in main process
// Example from bootstrap() and startServices():
const networkLayer = new DefaultNetworkLayer();
const processRunner = new ExecaProcessRunner();
vscodeSetupService = new VscodeSetupService(processRunner, pathProvider, "code-server");
codeServerManager = new CodeServerManager(config, processRunner, networkLayer, networkLayer);
```

### NetworkLayer Pattern

`NetworkLayer` provides unified interfaces for all localhost network operations, split by Interface Segregation Principle:

| Interface     | Methods                                 | Used By                                              |
| ------------- | --------------------------------------- | ---------------------------------------------------- |
| `HttpClient`  | `fetch(url, options)`                   | OpenCodeClient, HttpInstanceProbe, CodeServerManager |
| `SseClient`   | `createSseConnection(url, options)`     | OpenCodeClient                                       |
| `PortManager` | `findFreePort()`, `getListeningPorts()` | CodeServerManager, DiscoveryService                  |

```typescript
// DefaultNetworkLayer implements all three interfaces
const networkLayer = new DefaultNetworkLayer();

// Inject only the interface(s) each consumer needs
const instanceProbe = new HttpInstanceProbe(networkLayer); // HttpClient
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer); // HttpClient + PortManager
```

**SSE Connection with Auto-Reconnection:**

```typescript
const conn = sseClient.createSseConnection("http://localhost:8080/events");

conn.onMessage((data) => {
  // Raw string data - consumer handles parsing
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

**Testing with Mock Clients:**

```typescript
import {
  createMockHttpClient,
  createMockSseClient,
  createMockPortManager,
} from "../platform/network.test-utils";

// Create mock with controllable behavior
const mockHttpClient = createMockHttpClient({
  response: new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
});

// Inject into service
const service = new SomeService(mockHttpClient);
```

**BuildInfo/PathProvider Pattern:**

```typescript
// Main process creates implementations at module level
const buildInfo = new ElectronBuildInfo();
const platformInfo = new NodePlatformInfo();
const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

// Services receive PathProvider via constructor
const vscodeSetupService = new VscodeSetupService(processRunner, pathProvider, "code-server");

// Tests use mock factories
const mockPathProvider = createMockPathProvider({
  vscodeDir: "/test/vscode",
});
const service = new VscodeSetupService(mockRunner, mockPathProvider, "code-server");
```

### ProcessRunner Pattern

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

### FileSystemLayer Pattern

`FileSystemLayer` provides a unified interface for filesystem operations:

| Method      | Description                                         |
| ----------- | --------------------------------------------------- |
| `readFile`  | Read file as UTF-8 string                           |
| `writeFile` | Write string content to file                        |
| `mkdir`     | Create directory (recursive by default)             |
| `readdir`   | List directory contents with entry type info        |
| `unlink`    | Delete a file                                       |
| `rm`        | Delete file or directory (supports force/recursive) |

```typescript
// DefaultFileSystemLayer wraps node:fs/promises
const fileSystemLayer = new DefaultFileSystemLayer();

// Inject into services that need filesystem access
const projectStore = new ProjectStore(projectsDir, fileSystemLayer);
const vscodeSetupService = new VscodeSetupService(
  runner,
  pathProvider,
  "code-server",
  fileSystemLayer
);
```

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

**Testing with Mocks:**

```typescript
import { createMockFileSystemLayer, createDirEntry } from "../platform/filesystem.test-utils";

// Basic mock - all operations succeed
const mockFs = createMockFileSystemLayer();

// Return specific file content
const mockFs = createMockFileSystemLayer({
  readFile: { content: '{"key": "value"}' },
});

// Simulate specific error
const mockFs = createMockFileSystemLayer({
  readFile: { error: new FileSystemError("ENOENT", "/path", "Not found") },
});

// Custom implementation for complex logic
const mockFs = createMockFileSystemLayer({
  readFile: {
    implementation: async (path) => {
      if (path === "/config.json") return "{}";
      throw new FileSystemError("ENOENT", path, "Not found");
    },
  },
  readdir: {
    entries: [
      createDirEntry("file.txt", { isFile: true }),
      createDirEntry("subdir", { isDirectory: true }),
    ],
  },
});

// Inject into service
const service = new ProjectStore(projectsDir, mockFs);
```

### SSE Connection Lifecycle

`OpenCodeClient` manages SSE connections with auto-reconnection:

```typescript
// Connection lifecycle
client.connect(); // Start SSE connection
client.disconnect(); // Stop and cleanup
client.dispose(); // Full cleanup, stops reconnection

// Exponential backoff: 1s, 2s, 4s, 8s... max 30s
// Resets to 1s on successful connection
// Stops reconnecting after dispose()
```

**SSE Wire Format:**

OpenCode sends **unnamed SSE events** with the event type embedded in the JSON payload:

```
data: {"type":"session.status","properties":{"sessionID":"ses-123","status":{"type":"busy"}}}
```

This differs from named SSE events which would use `event: session.status` prefix in the stream. Therefore, `OpenCodeClient` uses the `onmessage` handler (not `addEventListener`) to receive all events and dispatches based on the `type` field.

### Callback Pattern (NOT Direct IPC)

Services emit events via callbacks; IPC wiring happens at boundary:

```typescript
// In service (pure, testable)
agentStatusManager.onStatusChanged((path, status, counts) => {
  // Callback fired when status changes
});

// At IPC boundary (main/ipc/agent-handlers.ts)
agentStatusManager.onStatusChanged((path, status, counts) => {
  emitToRenderer("agent:status-changed", { workspacePath: path, status, counts });
});
```

## Development Workflow

- TDD: failing test → implement → refactor
- Scripts: `npm run dev`, `npm run build`, `npm test`, `npm run lint`
- Use `npm install <package>` for dependencies (never edit package.json manually)

## Git Worktree Merge Workflow

When merging a worktree branch into `main`:

1. **First rebase onto main** - ensure your branch is up-to-date with main
2. **Always use fast-forward merge** - never create merge commits
3. **Switch to the directory where `main` is checked out** (typically the root repo)
4. **Run the merge there**

```bash
# In the worktree directory, rebase onto main first
git rebase main

# Then switch to main checkout and merge
cd /path/to/main/checkout
git merge --ff-only <worktree-branch>
```

## Code Quality Standards

- TypeScript strict mode, no `any`, no implicit types
- ESLint warnings treated as errors
- Prettier enforced formatting
- All tests must pass

## Testing Requirements

See `docs/TESTING.md` for the complete testing strategy.

### Quick Reference

| Code Change                                   | Required Tests               |
| --------------------------------------------- | ---------------------------- |
| New module/function                           | Unit tests (TDD)             |
| Module interactions                           | Integration tests (TDD)      |
| External interface (Git, HTTP, fs, processes) | Boundary tests               |
| Bug fix                                       | Test that reproduces the bug |

### TDD Workflow

1. **RED**: Write failing test first
2. **GREEN**: Write minimal code to pass
3. **REFACTOR**: Clean up while keeping tests green

### Test Commands

| Command                 | Use Case                              |
| ----------------------- | ------------------------------------- |
| `npm test`              | Run all tests                         |
| `npm run test:unit`     | Quick feedback during TDD             |
| `npm run test:boundary` | When developing external interfaces   |
| `npm run validate`      | Pre-commit check (unit + integration) |

## CRITICAL: No Ignore Comments

**NEVER add without explicit user approval:**

- `// @ts-ignore`, `// @ts-expect-error`
- `// eslint-disable`, `// eslint-disable-next-line`
- `any` type assertions
- Modifications to `.eslintignore`, `.prettierignore`

**Process if exception needed:**

1. Explain why the exception is necessary
2. Wait for explicit user approval
3. Only then add with explanatory comment

## Validation Commands

| Check      | Command              | Requirement   |
| ---------- | -------------------- | ------------- |
| TypeScript | npm run check        | Zero errors   |
| ESLint     | npm run lint         | Zero errors   |
| Prettier   | npm run format:check | All formatted |
| Tests      | npm test             | All passing   |
| Build      | npm run build        | Completes     |

**Recommended**: Use `npm run validate:fix` to auto-fix formatting/linting issues before validation. This saves cycles on small errors.

Run all checks before marking any task complete.
