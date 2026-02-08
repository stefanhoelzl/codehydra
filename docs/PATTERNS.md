# CodeHydra Implementation Patterns

## Table of Contents

- [IPC Patterns](#ipc-patterns)
- [VSCode Elements Patterns](#vscode-elements-patterns)
- [UI Patterns](#ui-patterns)
- [CSS Theming Patterns](#css-theming-patterns)
- [Renderer Setup Functions](#renderer-setup-functions)
- [Service Layer Patterns](#service-layer-patterns) - See [SERVICES.md](SERVICES.md)
- [Path Handling Patterns](#path-handling-patterns)
- [OpenCode Integration](#opencode-integration) - See [AGENTS.md](AGENTS.md)
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

**Intent Dispatcher Bridge:**

Some methods (e.g., `workspaces.create`, `workspaces.remove`) are handled by the intent dispatcher rather than directly by CoreModule. Bridge handlers in `wireDispatcher()` map IPC payloads to intents and dispatch them:

```typescript
registry.register(
  "workspaces.remove",
  async (payload: WorkspaceRemovePayload) => {
    const intent: DeleteWorkspaceIntent = { type: INTENT_DELETE_WORKSPACE, payload: { ... } };
    void dispatcher.dispatch(intent); // Fire-and-forget
    return { started: true };
  },
  { ipc: ApiIpcChannels.WORKSPACE_REMOVE }
);
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

Service layer patterns including platform abstractions (FileSystemLayer, NetworkLayer, ProcessRunner), external system access rules, mock factories, and shell/platform layers are documented in [SERVICES.md](SERVICES.md).

---

<!-- Service layer content moved to SERVICES.md -->

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

// WRONG: String startsWith (fails for prefix ambiguity)
if (workspacePath.toString().startsWith(projectRoot.toString())) { ... } // ❌
```

**Testing with paths:**

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

## OpenCode Integration

OpenCode integration patterns for agent status tracking, server lifecycle management, and SDK usage. For detailed agent system documentation, see [AGENTS.md](AGENTS.md).

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
