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

| Concept         | Description                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project         | Git repository path (container, not viewable) - the main git directory                                                                                                                                    |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory                                                                                                                                           |
| WebContentsView | Electron view for embedding (not iframe)                                                                                                                                                                  |
| Shortcut Mode   | Keyboard-driven navigation activated by Alt+X. All key detection in main process (ShortcutController). Actions: ↑↓ navigate, 1-0 jump, Enter new, Delete remove, O open project. Escape exits (renderer). |
| VS Code Setup   | First-run setup that installs extensions and config; runs once before code-server starts; marker at `<app-data>/vscode/.setup-completed`                                                                  |
| .keepfiles      | Config file in project root listing files to copy to new workspaces. Uses gitignore syntax with **inverted semantics** - listed patterns are COPIED (not ignored). Supports negation with `!` prefix.     |

## View Detachment Pattern

For GPU optimization, workspace views use **detachment** instead of zero-bounds hiding:

| State    | contentView | URL Loaded | GPU Usage | Session Partition                          |
| -------- | ----------- | ---------- | --------- | ------------------------------------------ |
| Created  | Detached    | No         | None      | `persist:<projectDirName>/<workspaceName>` |
| Active   | Attached    | Yes        | Active    | (same)                                     |
| Inactive | Detached    | Yes        | None      | (same)                                     |

**Key behaviors:**

- Views start **detached** (not in contentView) with **URL not loaded** (lazy loading)
- On first activation: URL is loaded, view is attached to contentView
- On subsequent activations: view is attached (URL already loaded)
- On deactivation: view is detached (removed from contentView)
- **Attach-before-detach**: New view is attached BEFORE old view is detached for visual continuity
- **Session isolation**: Each workspace has its own Electron partition for isolated localStorage/cookies

**On destruction:**

1. Navigate to `about:blank` (releases page resources)
2. Clear partition storage via `session.clearStorageData()`
3. Close the WebContentsView

**Rationale**: With >5 workspaces, zero-bounds hiding still consumed GPU resources. Detaching views entirely eliminates GPU usage for inactive workspaces.

## GPU Troubleshooting

### Environment Variables

| Variable                   | Values                | Description                    |
| -------------------------- | --------------------- | ------------------------------ |
| `CODEHYDRA_ELECTRON_FLAGS` | Space-separated flags | Electron command-line switches |

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

1. **Disable GPU** (most common fix):

   ```bash
   CODEHYDRA_ELECTRON_FLAGS="--disable-gpu" npm run dev
   ```

2. **For WebGL-specific crashes**:
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

1. `lifecycle.getState()` is called in App.svelte's `onMount` - determines which mode to show ("ready" or "setup")
2. If "setup": `lifecycle.setup()` is called, which returns success/failure via Promise
3. Setup progress events are received via `on("setup:progress", handler)`
4. `listProjects()`, workspace status fetches are called in MainView.svelte's `onMount` - only when setup is complete
5. Domain event subscriptions (project/workspace/agent) happen in MainView.svelte
6. Global event subscriptions (shortcuts, setup progress) stay in App.svelte

This prevents "handler not registered" errors during setup mode, when normal IPC handlers aren't available.

### Main Process Startup Architecture

The main process uses two-phase startup:

| Function          | Responsibility                                                      |
| ----------------- | ------------------------------------------------------------------- |
| `bootstrap()`     | Infrastructure only: window, views, **lifecycle handlers**, load UI |
| `startServices()` | All app services: code-server, AppState, OpenCode, normal handlers  |

```
bootstrap()
    ├─ Create vscodeSetupService
    ├─ Create LifecycleApi (standalone)
    ├─ Register lifecycle handlers (api:lifecycle:*)
    └─ Load UI
              │
              v
    UI loads -> lifecycle.getState() called
                               │
               ┌───────────────┴───────────────┐
               │ "ready"                       │ "setup"
               v                               v
        startServices()                 lifecycle.setup()
               │                               │
               │                        (runs setup, emits progress)
               │                               │
               │                        setup success → startServices()
               │                               │
               v                               v
        App ready                       App ready
```

**Key Points:**

- `LifecycleApi` is created in `bootstrap()` and registers `api:lifecycle:*` handlers immediately
- `CodeHydraApiImpl` (created in `startServices()`) receives and reuses the same `LifecycleApi` instance
- `lifecycle.setup()` returns a Promise with success/failure result (no separate complete/error events)
- Normal API handlers (`api:project:*`, `api:workspace:*`, etc.) are registered in `startServices()`

## IPC Patterns

### Fire-and-Forget IPC

For UI state changes that cannot fail (like z-order swapping), use the `void` operator to call IPC without awaiting:

```typescript
void api.ui.setMode("dialog"); // Intentionally not awaited
```

This pattern is used when:

1. The operation cannot meaningfully fail
2. Immediate UI response is more important than confirmation
3. The renderer should not block on the main process

### API Layer Pattern

IPC handlers are thin adapters over `ICodeHydraApi`. All business logic lives in the API implementation:

```typescript
// IPC handler (thin adapter) - src/main/ipc/api-handlers.ts
ipcMain.handle("api:project:open", async (_event, { path }: { path: string }) => {
  // 1. Validate input
  if (!path || typeof path !== "string") {
    throw new ValidationError([{ path: ["path"], message: "Path required" }]);
  }
  if (!pathModule.isAbsolute(path)) {
    throw new ValidationError([{ path: ["path"], message: "Path must be absolute" }]);
  }
  // 2. Delegate to API
  return await api.projects.open(path);
});
```

The API implementation (`CodeHydraApiImpl`) wraps services and handles event emission:

```typescript
// API implementation - src/main/api/codehydra-api.ts
class CodeHydraApiImpl implements ICodeHydraApi {
  async open(absolutePath: string): Promise<Project> {
    // Delegate to service
    const project = await this.appState.openProject(absolutePath);

    // Generate ID for external consumers
    const projectId = generateProjectId(absolutePath);

    // Emit event
    this.emit("project:opened", { project: { ...project, id: projectId } });

    return { ...project, id: projectId };
  }
}
```

### ID Generation Pattern

Projects and workspaces use branded types (`ProjectId`, `WorkspaceName`) with deterministic ID generation:

```typescript
// Generate project ID from path
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

### ID Resolution Pattern

Resolution is done by simple iteration (sufficient for <10 projects):

```typescript
function resolveProject(projectId: ProjectId): string | undefined {
  const projects = appState.getAllProjects();
  for (const project of projects) {
    if (generateProjectId(project.path) === projectId) {
      return project.path;
    }
  }
  return undefined;
}
```

**Why iteration, not a Map?**

- CodeHydra is designed for <10 concurrent projects
- Iteration over 10 items is ~microseconds
- Map would require keeping ID↔path in sync (complexity not worth it)

### v2 API Usage

The renderer uses `api.v2.*` for all operations after setup:

```typescript
// Open project
const project = await api.v2.projects.open("/path/to/repo");
console.log(project.id); // "my-repo-a1b2c3d4"

// Create workspace
const workspace = await api.v2.workspaces.create(project.id, "feature-x", "main");

// Switch workspace
await api.v2.ui.switchWorkspace(project.id, workspace.name);

// Subscribe to events
const unsubscribe = api.v2.on("workspace:switched", (event) => {
  console.log(`Switched to ${event.workspaceName} in ${event.projectId}`);
});
```

## VSCode Elements Patterns

### Component Usage

All UI components MUST use `@vscode-elements/elements` instead of native HTML where a vscode-element equivalent exists:

| Native HTML               | Use Instead              | When to Keep Native                                     |
| ------------------------- | ------------------------ | ------------------------------------------------------- |
| `<button>`                | `<vscode-button>`        | Never - always use vscode-button                        |
| `<input type="text">`     | `<vscode-textfield>`     | Complex custom controls (e.g., combobox with filtering) |
| `<input type="checkbox">` | `<vscode-checkbox>`      | Never - always use vscode-checkbox                      |
| `<select>`                | `<vscode-single-select>` | Custom dropdowns with filtering/grouping                |
| `<textarea>`              | `<vscode-textarea>`      | Never - always use vscode-textarea                      |
| Custom spinner            | `<vscode-progress-ring>` | Never - always use progress-ring                        |
| Custom progress bar       | `<vscode-progress-bar>`  | Complex custom visualizations                           |
| CSS border separator      | `<vscode-divider>`       | When semantic divider not appropriate                   |
| Button groups             | `<vscode-toolbar>`       | Non-linear layouts or hover-reveal conflicts            |
| Indicator/label           | `<vscode-badge>`         | Complex styled indicators                               |

### Event Handling in Svelte

VSCode-elements support both standard DOM events and custom `vsc-*` events. Standard DOM events are simpler and recommended:

```svelte
<!-- Standard DOM events (recommended) -->
<vscode-button onclick={handleClick}>Click me</vscode-button>
<vscode-textfield value={myValue} oninput={(e) => (myValue = e.target.value)} />
<vscode-checkbox checked={isChecked} onchange={(e) => (isChecked = e.target.checked)} />

<!-- Custom vsc-* events (also available, use on: syntax) -->
<vscode-textfield value={myValue} on:vsc-input={(e) => (myValue = e.target.value)} />
<vscode-checkbox checked={isChecked} on:vsc-change={(e) => (isChecked = e.detail.checked)} />
```

**Note**: Standard events (`onclick`, `oninput`, `onchange`) bubble through web components and work reliably. Custom `vsc-*` events require Svelte's `on:` syntax.

### Property Binding

Web components don't support Svelte's `bind:value`. Use explicit property + event:

```svelte
<!-- WRONG: bind:value doesn't work with web components -->
<vscode-textfield bind:value={name} />

<!-- CORRECT: Set property and listen to event -->
<vscode-textfield value={name} oninput={(e) => (name = e.target.value)} />
```

### Focus Management

The dialog focus trap (`src/renderer/lib/utils/focus-trap.ts`) includes vscode-elements in its focusable selector. Tab navigation works automatically for:

- `vscode-button`
- `vscode-checkbox`
- `vscode-textfield`
- `vscode-textarea`
- `vscode-single-select`

For custom focus handling (e.g., focusing a specific element when dialog opens):

```svelte
<script>
  let textfieldRef: HTMLElement;

  $effect(() => {
    if (open && textfieldRef) {
      textfieldRef.focus();
    }
  });
</script>

<vscode-textfield bind:this={textfieldRef} value={name} oninput={...} />
```

### Exceptions

The following components intentionally use native HTML:

1. **BranchDropdown**: Uses native `<input>` + custom dropdown for filtering and grouped options (Local/Remote branches). `vscode-single-select` doesn't support these features.

### Known Limitations

1. **vscode-badge**: No built-in dimmed state. Use custom CSS: `.badge-dimmed { opacity: 0.4; }`
2. **vscode-toolbar**: May conflict with hover-reveal patterns. Test and use custom grouping if needed.
3. **vscode-button a11y warnings**: Svelte's a11y checks don't recognize `<vscode-button>` as interactive, producing false-positive warnings for `a11y_click_events_have_key_events` and `a11y_no_static_element_interactions`. These are safe to suppress with `svelte-ignore` comments, but require explicit user approval per project rules.

### Importing

vscode-elements are imported once via a setup module:

```typescript
// src/renderer/lib/vscode-elements-setup.ts
import "@vscode-elements/elements/dist/bundled.js";

// src/renderer/main.ts
import "./lib/vscode-elements-setup.ts";
```

Components are then available globally as custom elements.

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

### FilterableDropdown Shared Component

`FilterableDropdown` is a reusable combobox component with filtering, keyboard navigation, and custom rendering support.

**Features:**

- Native `<input type="text">` for filtering (documented exception - `<vscode-textfield>` doesn't support combobox pattern)
- Debounced filtering (200ms default)
- Keyboard navigation (↑↓ navigate, Enter select, Escape close, Tab select + move focus)
- Fixed positioning to escape container overflow
- ARIA combobox accessibility pattern
- Snippet slot for custom option rendering

**displayText/filterText Separation:**

The component uses two separate text values internally:

- `displayText`: What's shown in the input (selected value OR user's typed text)
- `filterText`: What controls filtering (only user's typed text, empty = show all options)

Why this matters: When a value is pre-selected (e.g., `value="Apple"`), the input displays "Apple" but filtering uses empty string. This ensures opening the dropdown shows all options, not just ones matching the pre-selected value. Once the user types, their input controls both display and filtering.

**Props:**

```typescript
interface FilterableDropdownProps {
  options: DropdownOption[];
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  filterOption: (option: DropdownOption, filterLowercase: string) => boolean;
  id?: string;
  debounceMs?: number;
  optionSnippet?: Snippet<[option: DropdownOption, highlighted: boolean]>;
}

type DropdownOption = {
  type: "option" | "header";
  label: string;
  value: string;
};
```

**Wrapper Component Pattern:**

Domain-specific dropdowns (BranchDropdown, ProjectDropdown) wrap FilterableDropdown to handle data fetching and transformation:

```svelte
<!-- BranchDropdown.svelte - wraps FilterableDropdown -->
<script>
  // 1. Fetch data (async loading, error handling)
  // 2. Transform to DropdownOption[] (add headers, normalize values)
  // 3. Provide custom filterOption function
  // 4. Optionally provide custom optionSnippet for rendering
</script>

<FilterableDropdown
  options={transformedOptions}
  {value}
  {onSelect}
  filterOption={filterBranch}
  optionSnippet={branchOptionSnippet}
/>
```

**Header Options (for grouping):**

Headers are non-selectable options used for visual grouping:

```typescript
const options: DropdownOption[] = [
  { type: "header", label: "Local Branches", value: "__header_local__" },
  { type: "option", label: "main", value: "main" },
  { type: "header", label: "Remote Branches", value: "__header_remote__" },
  { type: "option", label: "origin/main", value: "origin/main" },
];
```

- Headers are skipped during keyboard navigation
- Headers should be rendered differently (non-interactive styling) via `optionSnippet`

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

`NetworkLayer` provides unified interfaces for localhost network operations, split by Interface Segregation Principle:

| Interface     | Methods                                 | Used By                              |
| ------------- | --------------------------------------- | ------------------------------------ |
| `HttpClient`  | `fetch(url, options)`                   | HttpInstanceProbe, CodeServerManager |
| `PortManager` | `findFreePort()`, `getListeningPorts()` | CodeServerManager, DiscoveryService  |

```typescript
// DefaultNetworkLayer implements both interfaces
const networkLayer = new DefaultNetworkLayer();

// Inject only the interface(s) each consumer needs
const instanceProbe = new HttpInstanceProbe(networkLayer); // HttpClient
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer); // HttpClient + PortManager
```

**Testing with Mock Clients:**

```typescript
import { createMockHttpClient, createMockPortManager } from "../platform/network.test-utils";

// Create mock with controllable behavior
const mockHttpClient = createMockHttpClient({
  response: new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
});

// Inject into service
const service = new SomeService(mockHttpClient);
```

**waitForPort() Utility:**

For boundary tests that need to wait for a server to start, use `waitForPort()`:

```typescript
import { waitForPort, CI_TIMEOUT_MS } from "../platform/network.test-utils";

// Start a server process
const proc = await startServer();

// Wait for it to be ready (uses longer timeout in CI)
const timeout = process.env.CI ? CI_TIMEOUT_MS : 5000;
await waitForPort(8080, timeout);

// Now safe to connect
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
| `copyTree`  | Copy file or directory recursively (skips symlinks) |

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

### External System Access Rules

**CRITICAL**: All external system access MUST go through abstraction interfaces. Direct library/module usage is forbidden in service code.

| External System  | Required Interface          | Forbidden Direct Access     |
| ---------------- | --------------------------- | --------------------------- |
| Filesystem       | `FileSystemLayer`           | `node:fs/promises` directly |
| HTTP requests    | `HttpClient`                | `fetch()` directly          |
| Port operations  | `PortManager`               | `net` module directly       |
| Process spawning | `ProcessRunner`             | `execa` directly            |
| OpenCode API     | `OpenCodeClient` (uses SDK) | Direct HTTP/SSE calls       |
| Git operations   | `GitClient`                 | `simple-git` directly       |

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

**Test utils location:**

| Interface         | Mock Factory                  | Location                               |
| ----------------- | ----------------------------- | -------------------------------------- |
| `FileSystemLayer` | `createMockFileSystemLayer()` | `platform/filesystem.test-utils.ts`    |
| `HttpClient`      | `createMockHttpClient()`      | `platform/network.test-utils.ts`       |
| `PortManager`     | `createMockPortManager()`     | `platform/network.test-utils.ts`       |
| `ProcessRunner`   | `createMockProcessRunner()`   | `platform/process.test-utils.ts`       |
| `PathProvider`    | `createMockPathProvider()`    | `platform/path-provider.test-utils.ts` |

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

  // connect() is now async with timeout support
  async connect(timeoutMs = 5000): Promise<void> {
    const events = await this.sdk.event.subscribe();
    // Process events in background
    this.processEvents(events.stream);
  }
}
```

**Testing with SDK Mocks:**

```typescript
import { createMockSdkClient, createMockSdkFactory } from "./sdk-test-utils";

const mockSdk = createMockSdkClient({
  sessions: [{ id: "ses-1", directory: "/test", ... }],
  sessionStatuses: { "ses-1": { type: "idle" } },
});
const factory = createMockSdkFactory(mockSdk);
const client = new OpenCodeClient(8080, factory);
```

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

## CRITICAL: API/IPC Interface Changes

**NEVER modify without explicit user approval:**

- IPC channel names or signatures (e.g., `api:project:*`, `api:workspace:*`)
- API interface definitions (`ICodeHydraApi`, `ElectronApi`, etc.)
- Preload script exposed APIs (`window.api`)
- Event names or payload structures
- Shared types in `src/shared/`

**Why this matters:**

API/IPC interfaces are contracts between processes. Changes can break:

1. **Main ↔ Renderer communication**: Mismatched channel names cause silent failures
2. **Type safety**: Interface changes require updates in multiple locations
3. **Backwards compatibility**: Existing code depends on current signatures

**Process if change needed:**

1. Explain the interface change and its impact
2. List all affected files/locations
3. Wait for explicit user approval
4. Update all locations atomically (main, preload, renderer, shared types)

## CRITICAL: New Boundary Interfaces

**NEVER add without explicit user approval:**

- New abstraction interfaces for external systems (e.g., `*Layer`, `*Client`, `*Provider`)
- New boundary types (interfaces that abstract over I/O, network, filesystem, processes)
- Adding entries to the "External System Access Rules" table

**Why this matters:**

Boundary interfaces are architectural decisions with long-term implications:

1. **Maintenance burden**: Each interface requires mock factories, test utilities, and documentation
2. **Consistency**: New boundaries should follow established patterns (`FileSystemLayer`, `HttpClient`, etc.)
3. **Necessity check**: Not all external access needs abstraction (e.g., pure libraries like `ignore`)

**Process if new boundary needed:**

1. Explain what external system access requires abstraction
2. Justify why existing interfaces don't cover the use case
3. Wait for explicit user approval
4. Follow established patterns (interface + default implementation + mock factory + boundary tests)

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
