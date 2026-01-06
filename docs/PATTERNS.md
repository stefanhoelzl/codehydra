# CodeHydra Implementation Patterns

## Table of Contents

- [IPC Patterns](#ipc-patterns)
- [VSCode Elements Patterns](#vscode-elements-patterns)
- [UI Patterns](#ui-patterns)
- [CSS Theming Patterns](#css-theming-patterns)
- [Renderer Setup Functions](#renderer-setup-functions)
- [Service Layer Patterns](#service-layer-patterns)
  - [WorkspaceLockHandler Pattern](#workspacelockhandler-pattern)
  - [PowerShell Script Asset Pattern](#powershell-script-asset-pattern)
- [Path Handling Patterns](#path-handling-patterns)
- [OpenCode Integration](#opencode-integration)
- [Plugin Interface](#plugin-interface)

---

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

### Module Registration Pattern

The API uses a registry pattern where modules self-register their methods and IPC handlers.

**Architecture:**

```
ApiRegistry (created in bootstrap)
    │
    ├── LifecycleModule (created in bootstrap)
    │   └── registers: lifecycle.getState, lifecycle.setup, lifecycle.quit
    │
    ├── CoreModule (created in startServices)
    │   └── registers: projects.*, workspaces.*
    │
    └── UiModule (created in startServices)
        └── registers: ui.*
```

**Module Registration:**

```typescript
// src/main/modules/core/index.ts
export class CoreModule implements IApiModule {
  constructor(
    private readonly api: IApiRegistry,
    private readonly deps: CoreModuleDeps
  ) {
    this.registerMethods();
  }

  private registerMethods(): void {
    // Register method with automatic IPC handler
    this.api.register("projects.open", this.projectOpen.bind(this), {
      ipc: ApiIpcChannels.PROJECT_OPEN,
    });
    // ... more registrations
  }

  private async projectOpen(payload: ProjectOpenPayload): Promise<Project> {
    const internalProject = await this.deps.appState.openProject(payload.path);
    const apiProject = this.toApiProject(internalProject);

    // Emit event through registry
    this.api.emit("project:opened", { project: apiProject });

    return apiProject;
  }
}
```

**Key Points:**

- IPC handlers are auto-generated when `ipc` option is provided to `register()`
- All methods use payload objects (e.g., `{ path: string }`) not positional args
- `getInterface()` returns `ICodeHydraApi` for external consumers (converts payload → positional)
- Events are emitted through the registry with type-safe payloads

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

### API Usage

The renderer uses `api.*` for all operations after setup:

```typescript
// Open project
const project = await api.projects.open("/path/to/repo");
console.log(project.id); // "my-repo-a1b2c3d4"

// Create workspace
const workspace = await api.workspaces.create(project.id, "feature-x", "main");

// Switch workspace
await api.ui.switchWorkspace(project.id, workspace.name);

// Subscribe to events
const unsubscribe = api.on("workspace:switched", (event) => {
  console.log(`Switched to ${event.workspaceName} in ${event.projectId}`);
});
```

---

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
| Custom icon spans         | `<Icon name="..."/>`     | Never - always use Icon component                       |

**Icon Component:**

The `Icon` component wraps `<vscode-icon>` and provides consistent icon rendering across the application. Never use Unicode characters (✓, ×, ⚠) or HTML entities (`&times;`, `&#10003;`) for icons.

```svelte
<script>
  import Icon from "./Icon.svelte";
</script>

<!-- Decorative icon -->
<Icon name="check" />

<!-- Action icon (button-like) -->
<Icon name="close" action label="Close" />

<!-- Custom size -->
<Icon name="warning" size={24} />
```

See [AGENTS.md Icon Usage](../AGENTS.md#icon-usage) for full documentation.

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

---

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

---

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

---

## Renderer Setup Functions

Complex `onMount` logic can be extracted into focused **setup functions** that return cleanup callbacks. This improves testability and single responsibility.

### When to Extract

- `onMount` exceeds ~100 lines
- Multiple unrelated concerns in one `onMount`
- Logic needs to be tested in isolation
- Similar setup logic could be reused

### Pattern

```typescript
// lib/utils/setup-feature.ts

// Type-safe API interface (constrained to needed events)
export interface FeatureApi {
  on(event: "feature:event", handler: (data: Data) => void): () => void;
}

// Default API - lazy loaded to avoid circular dependencies
let defaultApi: FeatureApi | undefined;

function getDefaultApi(): FeatureApi {
  if (!defaultApi) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("$lib/api");
    defaultApi = { on: api.on };
  }
  return defaultApi;
}

export function setupFeature(apiImpl: FeatureApi = getDefaultApi()): () => void {
  const unsubscribe = apiImpl.on("feature:event", (data) => {
    updateStore(data);
  });
  return unsubscribe; // cleanup callback
}
```

```svelte
<!-- Component.svelte -->
<script>
  import { onMount } from "svelte";
  import { setupFeature } from "$lib/utils/setup-feature";
  import { setupOtherFeature } from "$lib/utils/setup-other-feature";

  onMount(() => {
    const cleanup1 = setupFeature();
    const cleanup2 = setupOtherFeature();

    return () => {
      cleanup1();
      cleanup2();
    };
  });
</script>
```

### Testing Setup Functions

Use **behavioral mocks** that verify state changes, not call tracking:

```typescript
// Create behavioral mock with in-memory state
import * as store from "$lib/stores/feature.svelte.js";

function createMockApi() {
  let handler: ((data: Data) => void) | undefined;
  let unsubscribed = false;

  const api: FeatureApi = {
    on: (_event, h) => {
      handler = h;
      return () => {
        handler = undefined;
        unsubscribed = true;
      };
    },
  };

  return {
    api,
    emit: (data: Data) => handler?.(data),
    unsubscribeCalled: () => unsubscribed,
  };
}

// Test actual behavior
it("updates store when event is emitted", () => {
  const { api, emit } = createMockApi();

  setupFeature(api);
  emit(testData);

  expect(store.getState()).toEqual(expectedState);
});

// Test cleanup stops updates
it("cleanup stops updates", () => {
  const { api, emit, unsubscribeCalled } = createMockApi();

  const cleanup = setupFeature(api);
  cleanup();

  expect(unsubscribeCalled()).toBe(true);
  emit(otherData);
  expect(store.getState()).toBeUndefined(); // unchanged after cleanup
});
```

### Naming Convention

- Use `setup*` prefix (e.g., `setupDomainEvents`, `setupDeletionProgress`)
- For one-time async initialization, use `initialize*` (e.g., `initializeApp`)
- Always return `() => void` cleanup callback for consistent composition

### Files

| File                             | Purpose                                             |
| -------------------------------- | --------------------------------------------------- |
| `setup-deletion-progress.ts`     | Workspace deletion progress event subscription      |
| `setup-domain-event-bindings.ts` | Domain events wired to stores (wraps domain-events) |
| `initialize-app.ts`              | App initialization (projects, statuses, focus)      |
| `domain-events.ts`               | Core domain event subscription helper               |

---

## Service Layer Patterns

### Service Dependency Injection Pattern

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

### NetworkLayer Pattern

`NetworkLayer` provides unified interfaces for localhost network operations, split by Interface Segregation Principle:

| Interface     | Methods               | Used By                                                    |
| ------------- | --------------------- | ---------------------------------------------------------- |
| `HttpClient`  | `fetch(url, options)` | HttpInstanceProbe, CodeServerManager                       |
| `PortManager` | `findFreePort()`      | CodeServerManager, OpenCodeServerManager, McpServerManager |

```typescript
// DefaultNetworkLayer implements both interfaces
const networkLayer = new DefaultNetworkLayer();

// Inject only the interface(s) each consumer needs
const instanceProbe = new HttpInstanceProbe(networkLayer); // HttpClient
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer); // HttpClient + PortManager
```

**Testing with Mock Clients:**

```typescript
import { createMockHttpClient, createPortManagerMock } from "../platform/network.test-utils";

// Create mock with controllable behavior
const mockHttpClient = createMockHttpClient({
  response: new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
});

// Create port manager mock that returns sequential ports
const portManager = createPortManagerMock([8080, 8081]);

// Inject into service
const service = new SomeService(mockHttpClient, portManager);
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
const vscodeSetupService = new VscodeSetupService(
  processRunner,
  pathProvider,
  fsLayer,
  platformInfo,
  binaryDownloadService
);

// Tests use mock factories
const mockPathProvider = createMockPathProvider({
  vscodeDir: "/test/vscode",
});
const service = new VscodeSetupService(mockRunner, mockPathProvider, mockFs);
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
  fileSystemLayer,
  platformInfo,
  binaryDownloadService
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

All paths below are relative to `src/services/`.

| Interface              | Mock Factory                       | Location                                          |
| ---------------------- | ---------------------------------- | ------------------------------------------------- |
| `ArchiveExtractor`     | `createArchiveExtractorMock()`     | `binary-download/archive-extractor.state-mock.ts` |
| `FileSystemLayer`      | `createFileSystemMock()`           | `platform/filesystem.state-mock.ts`               |
| `HttpClient`           | `createMockHttpClient()`           | `platform/network.test-utils.ts`                  |
| `PortManager`          | `createPortManagerMock()`          | `platform/port-manager.state-mock.ts`             |
| `ProcessRunner`        | `createMockProcessRunner()`        | `platform/process.test-utils.ts`                  |
| `PathProvider`         | `createMockPathProvider()`         | `platform/path-provider.test-utils.ts`            |
| `WorkspaceLockHandler` | `createMockWorkspaceLockHandler()` | `platform/workspace-lock-handler.test-utils.ts`   |
| `IGitClient`           | `createMockGitClient()`            | `git/git-client.state-mock.ts`                    |

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

### Shell and Platform Layer Patterns

Electron APIs are abstracted behind testable interfaces in two domains:

| Domain   | Location             | Purpose                       | Examples                                   |
| -------- | -------------------- | ----------------------------- | ------------------------------------------ |
| Platform | `services/platform/` | OS/runtime abstractions       | `IpcLayer`, `DialogLayer`, `ImageLayer`    |
| Shell    | `services/shell/`    | Visual container abstractions | `WindowLayer`, `ViewLayer`, `SessionLayer` |

**Dependency Rule**: Shell layers may depend on Platform layers, but not vice versa.

#### Constructor Dependency Injection

Managers receive layers via constructor parameters, not global imports:

```typescript
// CORRECT: Inject layers via constructor
class ViewManager {
  constructor(
    private readonly viewLayer: ViewLayer,
    private readonly sessionLayer: SessionLayer,
    private readonly windowLayer: WindowLayer,
    private readonly logger: Logger
  ) {}
}

// WRONG: Import Electron directly
import { WebContentsView } from "electron"; // ❌
```

#### Handle-Based Interface Design

Layers use opaque handles to prevent leaking Electron types:

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

**Benefits:**

- Managers never see `WebContentsView`, `BaseWindow`, etc.
- Mocks just return `{ id: "test-1", __brand: "ViewHandle" }`
- All Electron access is centralized in layer implementations
- Type safety: can't pass `WindowHandle` where `ViewHandle` expected

#### Behavioral Mocks for Layers

Layer mocks maintain in-memory state with custom matchers for assertions:

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
```

**Custom matchers for assertions:**

```typescript
// Check view exists
expect(mock).toHaveView(handle.id);

// Check view properties
expect(mock).toHaveView(handle.id, {
  url: "http://127.0.0.1:8080",
  attachedTo: null,
  backgroundColor: "#1e1e1e",
});

// Check exact set of views
expect(mock).toHaveViews([handle.id]);

// Use .not for negations
expect(mock).not.toHaveView("view-999");

// Snapshot comparison
const before = mock.$.snapshot();
mock.createView({});
expect(mock).not.toBeUnchanged(before);
```

**Usage in tests:**

```typescript
import { createViewLayerMock } from "../shell/view.state-mock";

const viewLayer = createViewLayerMock();
const viewManager = new ViewManager(viewLayer, sessionLayer, windowLayer, logger);

// Act
await viewManager.createWorkspaceView("/path/to/workspace", "http://127.0.0.1:8080");

// Assert via custom matchers (preferred)
expect(viewLayer).toHaveViews(["view-1"]);
expect(viewLayer).toHaveView("view-1", { url: "http://127.0.0.1:8080" });
```

#### Error Handling Pattern

Each domain has its own error class with typed codes:

```typescript
// Platform errors
import { PlatformError } from "./errors";

class DefaultIpcLayer implements IpcLayer {
  handle(channel, handler) {
    if (this.registeredChannels.has(channel)) {
      throw new PlatformError(
        "IPC_HANDLER_EXISTS",
        `Handler already exists for channel: ${channel}`
      );
    }
    // ...
  }
}

// Shell errors include handle context
import { ShellError } from "./errors";

class DefaultViewLayer implements ViewLayer {
  private getView(handle: ViewHandle): WebContentsView {
    const view = this.views.get(handle.id);
    if (!view) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    return view;
  }
}
```

**Error codes:**

| Domain   | Error Codes                                                                 |
| -------- | --------------------------------------------------------------------------- |
| Platform | `IPC_HANDLER_EXISTS`, `IPC_HANDLER_NOT_FOUND`, `DIALOG_CANCELLED`, etc.     |
| Shell    | `WINDOW_NOT_FOUND`, `VIEW_NOT_FOUND`, `VIEW_DESTROYED`, `SESSION_NOT_FOUND` |

#### Test Utils Location

All paths below are relative to `src/services/`.

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

### WorkspaceLockHandler Pattern

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

### PowerShell Script Asset Pattern

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

## Path Handling Patterns

CodeHydra uses the `Path` class for all internal path handling to ensure cross-platform consistency.

### Path Class Overview

The `Path` class normalizes paths to a canonical internal format:

- **POSIX separators**: Always forward slashes (`/`)
- **Absolute paths required**: Throws error on relative paths
- **Case normalization**: Lowercase on Windows (case-insensitive filesystem)
- **Clean format**: No trailing slashes, no `..` or `.` segments

```typescript
import { Path } from "../services/platform/path";

// Create normalized path
const p = new Path("C:\\Users\\Name\\Project");
p.toString(); // "c:/users/name/project" (Windows)
p.toString(); // "/home/user/project" (Unix)

// Join paths
const sub = new Path(p, "src", "index.ts");
sub.toString(); // "c:/users/name/project/src/index.ts"

// Convert relative paths (explicit only)
const abs = new Path(Path.cwd(), "./relative/path");
```

### When to Use Each Method

| Method        | Use Case                                         |
| ------------- | ------------------------------------------------ |
| `toString()`  | Map keys, comparisons, JSON serialization        |
| `toNative()`  | (Internal use by FileSystemLayer, ProcessRunner) |
| `equals()`    | Path comparison (handles different formats)      |
| `isChildOf()` | Containment checks (not `startsWith()`)          |

### IPC Boundary Handling

IPC boundaries handle the Path↔string conversion:

```
Renderer (strings) ──IPC──► Main Process IPC Handlers ──► Services (Path objects)
                              │
                              ├─ INCOMING: new Path(payload.path)
                              └─ OUTGOING: path.toString() (automatic via toJSON)
```

- **Shared types in `src/shared/`**: Use `string` for paths (IPC compatibility)
- **Internal services**: Use `Path` objects for all path handling
- **Renderer**: Receives pre-normalized strings; safe to compare with `===`

### Common Patterns

**Creating Path from external input:**

```typescript
// File dialog result
const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
const projectPath = new Path(result.filePaths[0]);

// Git output (already POSIX format on all platforms)
const worktrees = await gitClient.listWorktrees(projectRoot);
// worktree.path is already a Path object

// Config file (may contain old native paths)
const config = JSON.parse(content);
const projectPath = new Path(config.path); // Auto-normalizes
```

**Using paths in Maps:**

```typescript
// CORRECT: Use toString() as key
const views = new Map<string, WebContentsView>();
views.set(path.toString(), view);
views.get(path.toString());

// WRONG: Using Path object as key (reference equality)
const views = new Map<Path, View>(); // ❌
```

**Path comparison:**

```typescript
// CORRECT: Use equals() for cross-format comparison
if (workspacePath.equals(projectRoot)) { ... }
if (workspace.path.equals(inputPath)) { ... }

// WRONG: Direct comparison (may fail on Windows)
if (workspacePath === otherPath) { ... } // ❌ May fail for "C:\foo" vs "C:/foo"
```

**Containment checks:**

```typescript
// CORRECT: Use isChildOf() for proper containment
if (workspacePath.isChildOf(projectRoot)) { ... }

// WRONG: startsWith() has false positives
if (path.startsWith(parent)) { ... } // ❌ "/foo-bar".startsWith("/foo") = true
```

### Testing with Paths

Paths in tests should use `Path.toString()` for comparisons:

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

---

## Agent Integration

This section covers patterns for integrating AI agent backends (currently OpenCode, extensible to other agents).

### Agent Factory Pattern

Use factory functions to create agent components without tight coupling:

```typescript
import {
  getAgentSetupInfo,
  createAgentServerManager,
  createAgentProvider,
  type AgentType,
} from "../agents";

// Type-safe creation with exhaustive switch
function createAgentComponents(type: AgentType, deps: Deps) {
  const setupInfo = getAgentSetupInfo(type, setupDeps);
  const serverManager = createAgentServerManager(type, serverDeps);
  return { setupInfo, serverManager };
}
```

### Extending for New Agent Types

To add a new agent type (e.g., "claude"):

1. Add type to `AgentType` union in `src/agents/types.ts`:

   ```typescript
   export type AgentType = "opencode" | "claude";
   ```

2. Create implementation directory `src/agents/claude/`:

   ```
   src/agents/claude/
     setup-info.ts     # ClaudeSetupInfo implementing AgentSetupInfo
     server-manager.ts # ClaudeServerManager implementing AgentServerManager
     provider.ts       # ClaudeProvider implementing AgentProvider
   ```

3. Add case to factory functions in `src/agents/index.ts`:
   ```typescript
   export function createAgentServerManager(type: AgentType, deps: ServerManagerDeps) {
     switch (type) {
       case "opencode":
         return new OpenCodeServerManager(...);
       case "claude":
         return new ClaudeServerManager(...);
     }
   }
   ```

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

---

## Plugin Interface

CodeHydra and VS Code extensions communicate via Socket.IO WebSocket connection.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  CodeHydra (Electron Main Process)                  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    PluginServer (Socket.IO)                   │  │
│  │                         :dynamic port                         │  │
│  │                                                               │  │
│  │   connections: Map<normalizedWorkspacePath, Socket>           │  │
│  │                                                               │  │
│  │   Server → Client:                                            │  │
│  │   ───► "command" (request, ack) → client returns result      │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│            CodeServerManager spawns with:                           │
│            CODEHYDRA_PLUGIN_PORT=<port>                             │
└──────────────────────────────┼───────────────────────────────────────┘
                               │ localhost:port (WebSocket)
                               ▼
                    ┌─────────────────┐
                    │  codehydra-     │
                    │  sidekick       │
                    │  extension      │
                    │  (Socket.IO     │
                    │   client)       │
                    └─────────────────┘
```

### Connection Lifecycle

1. **PluginServer starts** on dynamic port in main process
2. **code-server spawns** with `CODEHYDRA_PLUGIN_PORT` env var
3. **Extension activates** and reads env var
4. **Extension connects** with `auth: { workspacePath }` (path.normalize'd)
5. **Server validates** auth and stores connection by normalized path
6. **Commands sent** with acknowledgment callbacks (10s timeout)

### Startup Commands

When an extension connects to PluginServer, CodeHydra automatically sends startup commands to configure the workspace layout:

| Command                                      | Purpose                                    |
| -------------------------------------------- | ------------------------------------------ |
| `workbench.action.closeSidebar`              | Hide left sidebar to maximize editor space |
| `workbench.action.closeAuxiliaryBar`         | Hide right sidebar (auxiliary bar)         |
| `opencode.openTerminal`                      | Open OpenCode terminal for AI workflow     |
| `workbench.action.unlockEditorGroup`         | Unlock editor group for tab reuse          |
| `workbench.action.closeEditorsInOtherGroups` | Clean up empty editor groups               |

Commands are sent sequentially after a brief delay (100ms) for UI stabilization. Failures are non-fatal and logged as warnings with `[plugin]` logger.

### Environment Variable

| Variable                | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `CODEHYDRA_PLUGIN_PORT` | Port for VS Code extension to connect to |

Set automatically by CodeServerManager when spawning code-server. If not set, extension skips connection (graceful degradation).

### Message Protocol

**Server → Client Events:**

| Event      | Payload             | Ack Type                | Description                                       |
| ---------- | ------------------- | ----------------------- | ------------------------------------------------- |
| `config`   | `{ isDevelopment }` | (none)                  | Configuration sent after connection               |
| `command`  | `CommandRequest`    | `PluginResult<unknown>` | Execute VS Code command                           |
| `shutdown` | (none)              | `PluginResult<void>`    | Terminate extension host (for workspace deletion) |

**Command request structure:**

```typescript
interface CommandRequest {
  readonly command: string; // VS Code command ID
  readonly args?: readonly unknown[]; // Optional arguments
}
```

**Acknowledgment result:**

```typescript
type PluginResult<T> = { success: true; data: T } | { success: false; error: string };
```

### Extension Host Shutdown

The `shutdown` event is sent during workspace deletion to terminate the extension host process and release file handles (critical on Windows where file locks prevent deletion).

**Shutdown Flow:**

1. CodeHydra emits `shutdown` event
2. Extension kills all terminals:
   - Gets all terminals and disposes each one
   - Waits for `onDidCloseTerminal` events for each terminal
   - If any terminals don't close within 5s, proceeds anyway
3. Extension removes workspace folders (releases file watchers)
4. Extension sends ack
5. Extension calls `process.exit(0)` via `setImmediate`
6. CodeHydra waits for socket disconnect (not just ack) as confirmation
7. If no disconnect within 5s, proceeds with deletion anyway (best-effort)

### Logging

Logger name: `[plugin]`

Events logged:

- Server start/stop (port)
- Client connect/disconnect (workspace path, reason)
- Command execution (command, success/error)
