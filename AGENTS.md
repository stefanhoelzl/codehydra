# CodeHydra - AI Agent Instructions

## CRITICAL RULES

These rules MUST be followed at all times. Violations require explicit user approval.

### No Ignore Comments

**NEVER add without explicit user approval:**

- `// @ts-ignore`, `// @ts-expect-error`
- `// eslint-disable`, `// eslint-disable-next-line`
- `any` type assertions
- Modifications to `.eslintignore`, `.prettierignore`

**Process if exception needed:**

1. Explain why the exception is necessary
2. Wait for explicit user approval
3. Only then add with explanatory comment

### API/IPC Interface Changes

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

### New Boundary Interfaces

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

### External System Access Rules

All external system access MUST go through abstraction interfaces. Direct library/module usage is forbidden in service code.

| External System  | Required Interface          | Forbidden Direct Access     |
| ---------------- | --------------------------- | --------------------------- |
| Filesystem       | `FileSystemLayer`           | `node:fs/promises` directly |
| HTTP requests    | `HttpClient`                | `fetch()` directly          |
| Port operations  | `PortManager`               | `net` module directly       |
| Process spawning | `ProcessRunner`             | `execa` directly            |
| OpenCode API     | `OpenCodeClient` (uses SDK) | Direct HTTP/SSE calls       |
| Git operations   | `GitClient`                 | `simple-git` directly       |

**Full details**: See [Service Layer Patterns](docs/PATTERNS.md#service-layer-patterns) for implementation examples and mock factories.

---

## Quick Start

### Tech Stack

| Layer           | Technology                               |
| --------------- | ---------------------------------------- |
| Desktop         | Electron (BaseWindow + WebContentsViews) |
| Frontend        | Svelte 5 + TypeScript + @vscode-elements |
| Backend         | Node.js services                         |
| Testing         | Vitest                                   |
| Build           | Vite                                     |
| Package Manager | npm                                      |

### Essential Commands

| Command                | Purpose                           |
| ---------------------- | --------------------------------- |
| `npm run dev`          | Start development mode            |
| `npm run validate:fix` | Fix lint/format issues, run tests |
| `npm test`             | Run all tests                     |
| `npm run build`        | Build for production              |

### Key Documents

| Document         | Location                       | Purpose                                          |
| ---------------- | ------------------------------ | ------------------------------------------------ |
| Patterns         | docs/PATTERNS.md               | Implementation patterns with code examples       |
| Architecture     | docs/ARCHITECTURE.md           | System design, component relationships           |
| API Reference    | docs/API.md                    | Private/Public API for internal and external use |
| UI Specification | docs/USER_INTERFACE.md         | User flows, mockups, keyboard shortcuts          |
| Testing Strategy | docs/TESTING.md                | Test types, conventions, commands                |
| Migration Plan   | planning/ELECTRON_MIGRATION.md | Phase details, implementation workflow           |

**Important**: Files in `planning/` are **historical records** that reflect the state at the time of planning/implementation. They may not reflect the current application state. To understand current state, read source code and `docs/` files. Read `planning/` files for design decision context and rationale.

---

## Project Overview

- Multi-workspace IDE for parallel AI agent development
- Each workspace = git worktree in isolated WebContentsView with VS Code (code-server)
- Real-time OpenCode agent status monitoring

## Key Concepts

| Concept         | Description                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project         | Git repository path (container, not viewable) - the main git directory                                                                                                                                                         |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory                                                                                                                                                                |
| WebContentsView | Electron view for embedding (not iframe)                                                                                                                                                                                       |
| Shortcut Mode   | Keyboard-driven navigation activated by Alt+X. All key detection in main process (ShortcutController). Actions: ↑↓ navigate, 1-0 jump, Enter new, Delete remove, O open project. Escape exits (renderer).                      |
| VS Code Setup   | First-run setup that installs extensions and config; uses preflight checks on every startup to detect missing/outdated components; marker at `<app-data>/.setup-completed`. See [VS Code Assets](#vs-code-assets) for details. |
| .keepfiles      | Config file in project root listing files to copy to new workspaces. Uses gitignore syntax with **inverted semantics** - listed patterns are COPIED (not ignored). Supports negation with `!` prefix.                          |
| App Icon Badge  | Shows visual status indicator on app icon. Red circle: all workspaces working. Half green/half red: mixed (some ready, some working). No badge: all ready. Platform: macOS dock, Windows taskbar, Linux Unity.                 |
| MCP Server      | Model Context Protocol server exposing workspace API to AI agents. Auto-configured via `OPENCODE_CONFIG` env var when spawning OpenCode. Enables agents to read/write workspace metadata and delete workspaces.                |

## VS Code Assets

VS Code setup assets (settings, keybindings, extensions) are stored as dedicated files instead of inline code.

### Asset Files

| File                                                   | Purpose                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `src/services/vscode-setup/assets/settings.json`       | VS Code settings (theme, telemetry, workspace trust, etc.) |
| `src/services/vscode-setup/assets/keybindings.json`    | Custom keybindings (Alt+T for panel toggle)                |
| `src/services/vscode-setup/assets/extensions.json`     | Extension manifest (marketplace + bundled vsix)            |
| `src/services/vscode-setup/assets/codehydra-sidekick/` | Custom extension source (packaged to .vsix at build)       |

### extensions.json Format

The extensions.json file uses a structured format for preflight version checking:

```json
{
  "marketplace": ["sst-dev.opencode"],
  "bundled": [
    {
      "id": "codehydra.codehydra",
      "version": "0.0.1",
      "vsix": "codehydra.vscode-0.0.1.vsix"
    }
  ]
}
```

**Important**: When updating bundled extensions:

1. Update the `version` field to match the new extension version
2. Update the `vsix` field to match the new vsix filename
3. The preflight phase will detect version mismatches and only reinstall outdated extensions

### Build Process

1. **Extension packaging**: `npm run build:extension` uses `@vscode/vsce` to package `codehydra-sidekick/` into `sidekick-0.0.1.vsix`
2. **Asset bundling**: `vite-plugin-static-copy` copies all assets to `out/main/assets/` during build
3. **Full build**: `npm run build` runs both steps sequentially

### Runtime Flow

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

## Binary Distribution

CodeHydra downloads code-server and opencode binaries from GitHub releases. This happens automatically during:

1. **Development (`npm install`)**: Downloads to `./app-data/` via postinstall script
2. **Production (app setup)**: Downloads to user's app-data directory during first-run setup

### Binary Storage Layout

```
<app-data>/
├── bin/                              # Wrapper scripts
│   ├── code[.cmd]                    # VS Code CLI
│   └── opencode[.cmd]                # OpenCode CLI
├── code-server/
│   └── <version>/                    # e.g., 4.106.3/
│       ├── bin/code-server[.cmd]     # Actual binary
│       ├── lib/                      # VS Code distribution
│       └── out/                      # Entry point
└── opencode/
    └── <version>/                    # e.g., 0.1.47/
        └── opencode[.exe]            # Actual binary
```

### Version Updates

Binary versions are defined in `src/services/binary-download/versions.ts`:

- `CODE_SERVER_VERSION` - code-server release version
- `OPENCODE_VERSION` - opencode release version

When these are updated, `npm install` will download new versions. Production installations re-download on next app launch (setup version is incremented).

## CLI Wrapper Scripts

During VS Code setup, CLI wrapper scripts are generated in `<app-data>/bin/`:

| Script                      | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `code` / `code.cmd`         | VS Code CLI (code-server's remote-cli)                                         |
| `opencode` / `opencode.cmd` | Node.js wrapper that parses ports.json and attaches to managed OpenCode server |

**opencode wrapper architecture:**

```
opencode (shell) → opencode.cjs (Node.js) → opencode binary
                        │
                        ├─ Detects git root via `git rev-parse`
                        ├─ Reads ports.json to find workspace port
                        └─ Runs `opencode attach http://127.0.0.1:<port>`
```

- Uses bundled Node.js from code-server (`<app-data>/code-server/<version>/lib/node`)
- **No standalone mode**: Only works in managed CodeHydra workspaces (returns error if workspace not found in ports.json)
- Thin shell wrappers (`opencode` / `opencode.cmd`) delegate all logic to the cross-platform `opencode.cjs` script

These scripts are available in the integrated terminal because:

1. `<app-data>/bin/` is prepended to `PATH` when spawning code-server
2. `EDITOR` and `GIT_SEQUENCE_EDITOR` are set to `<binDir>/code --wait --reuse-window`

**Git Integration**: With EDITOR configured, git operations open in code-server:

- `git commit` - Opens commit message editor
- `git rebase -i` - Opens interactive rebase editor
- Any tool respecting `$EDITOR`

## code-server Windows Builds

code-server doesn't publish Windows binaries. CodeHydra automatically builds and publishes Windows versions via GitHub Actions.

### Release Naming Convention

| Item           | Format                                | Example                             |
| -------------- | ------------------------------------- | ----------------------------------- |
| Git tag        | `code-server-windows-v{version}`      | `code-server-windows-v4.106.3`      |
| Release title  | `code-server {version} for Windows`   | `code-server 4.106.3 for Windows`   |
| Asset filename | `code-server-{version}-win32-x64.zip` | `code-server-4.106.3-win32-x64.zip` |

### Automation

- **Daily check**: `check-code-server-releases.yaml` runs at 6 AM UTC
- **Build trigger**: Automatically triggers builds for missing versions (>= 4.106.3)
- **Releases**: Published to GitHub Releases in this repository

### Package Layout

Matches official Linux/macOS releases:

```
code-server-{version}-win32-x64/
├── bin/
│   └── code-server.cmd       # Windows launcher script
├── lib/
│   ├── node.exe              # Bundled Node.js (downloaded for Windows)
│   └── vscode/               # VS Code distribution
├── out/
│   └── node/
│       └── entry.js          # Main entry point
├── package.json
├── LICENSE                   # MIT license from code-server
└── ThirdPartyNotices.txt     # Third-party licenses
```

### Manual Triggering

Both workflows support manual dispatch:

```bash
# Build a specific version (dry run for testing)
gh workflow run build-code-server-windows.yaml -f version="4.106.3" -f dry_run=true

# Check for missing versions (dry run)
gh workflow run check-code-server-releases.yaml -f dry_run=true
```

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

| Variable                   | Values                          | Description                                 |
| -------------------------- | ------------------------------- | ------------------------------------------- |
| `CODEHYDRA_ELECTRON_FLAGS` | Space-separated flags           | Electron command-line switches              |
| `CODEHYDRA_LOGLEVEL`       | silly\|debug\|info\|warn\|error | Override default log level                  |
| `CODEHYDRA_PRINT_LOGS`     | any non-empty value             | Print logs to stdout/stderr                 |
| `CODEHYDRA_LOGGER`         | comma-separated names           | Filter logs by logger (e.g., `git,process`) |

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

## Log Files

When investigating issues, check the application logs in `<app-data>/logs/`:

| Platform    | Log Directory                                   |
| ----------- | ----------------------------------------------- |
| Development | `./app-data/logs/`                              |
| Linux       | `~/.local/share/codehydra/logs/`                |
| macOS       | `~/Library/Application Support/Codehydra/logs/` |
| Windows     | `%APPDATA%\Codehydra\logs\`                     |

### Log File Format

Each application session creates a new log file: `YYYY-MM-DDTHH-MM-SS-<uuid>.log`

Log entries follow this format:

```
[2025-12-16 10:30:00.123] [info] [process] Spawned command=code-server pid=12345
 │                        │      │         └─ message with context (key=value pairs)
 │                        │      └─ logger name (scope)
 │                        └─ level (silly|debug|info|warn|error)
 └─ timestamp
```

### Logger Names

| Logger              | Module                  |
| ------------------- | ----------------------- |
| `[process]`         | Process spawning        |
| `[network]`         | HTTP requests, ports    |
| `[fs]`              | Filesystem operations   |
| `[git]`             | Git operations          |
| `[opencode]`        | OpenCode SDK            |
| `[opencode-server]` | OpenCode server manager |
| `[code-server]`     | code-server process     |
| `[pidtree]`         | Process tree lookups    |
| `[keepfiles]`       | .keepfiles copying      |
| `[api]`             | IPC handlers            |
| `[window]`          | WindowManager           |
| `[view]`            | ViewManager             |
| `[badge]`           | BadgeManager            |
| `[mcp]`             | MCP server              |
| `[app]`             | Application lifecycle   |
| `[ui]`              | Renderer UI components  |

### Debugging with Logs

```bash
# Enable verbose logging to console
CODEHYDRA_LOGLEVEL=debug CODEHYDRA_PRINT_LOGS=1 npm run dev

# Filter to specific loggers only
CODEHYDRA_LOGGER=git,process npm run dev

# View recent log file
tail -f ./app-data/logs/*.log
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

IPC handlers are thin adapters over `ICodeHydraApi`. Key patterns:

- **Fire-and-forget**: Use `void api.call()` for non-blocking UI state changes
- **API Layer**: All business logic in API implementation, IPC handlers only validate and delegate
- **ID Generation**: Deterministic `<name>-<hash8>` format for projects and workspaces
- **v2 API Usage**: Renderer uses `api.v2.*` for all operations after setup

**Full details**: See [IPC Patterns](docs/PATTERNS.md#ipc-patterns) for code examples.

## VSCode Elements Patterns

All UI components MUST use `@vscode-elements/elements` where equivalents exist:

- Use `<vscode-button>`, `<vscode-textfield>`, `<vscode-checkbox>` instead of native HTML
- Property binding: use `value={x} oninput={...}` (not `bind:value`)
- Focus trap includes vscode-elements in focusable selector
- **Exception**: BranchDropdown uses native input for filtering/grouping

**Full details**: See [VSCode Elements Patterns](docs/PATTERNS.md#vscode-elements-patterns) for component mapping and event handling.

## UI Patterns

Custom UI components follow these patterns:

- **Dropdown selection**: Use `onmousedown` with `preventDefault()` to prevent blur-before-click
- **Fixed positioning**: Use `position: fixed` for dropdowns in overflow containers
- **FilterableDropdown**: Shared combobox with filtering, keyboard navigation, ARIA support

**Full details**: See [UI Patterns](docs/PATTERNS.md#ui-patterns) for implementation examples.

## CSS Theming Patterns

Theming uses CSS custom properties with VS Code integration:

- **Variable prefix**: All variables use `--ch-` prefix (e.g., `--ch-foreground`)
- **VS Code fallback**: `var(--vscode-foreground, #cccccc)` pattern for dual-mode operation
- **Semantic colors**: Use `--ch-success`, `--ch-danger`, `--ch-warning` for status
- **Screen reader**: Use `.ch-visually-hidden` class (not component-local `.sr-only`)

**Full details**: See [CSS Theming Patterns](docs/PATTERNS.md#css-theming-patterns) for variable categories.

## OpenCode Integration

Real-time agent status monitoring for AI agents in workspaces:

- **Agent Status Store**: Svelte 5 runes-based reactive state for status/counts
- **SDK Integration**: Uses `@opencode-ai/sdk` with factory injection for testability
- **Callback Pattern**: Services emit via callbacks; IPC wiring at boundary

**Full details**: See [OpenCode Integration](docs/PATTERNS.md#opencode-integration) for store implementation.

## Plugin Interface

VS Code extension communication via Socket.IO:

- **Architecture**: PluginServer (main) ↔ codehydra extension (Socket.IO client)
- **Connection**: Extension reads `CODEHYDRA_PLUGIN_PORT` env var on activation
- **Startup commands**: Auto-configures workspace layout (close sidebars, open terminal)

**Full details**: See [Plugin Interface](docs/PATTERNS.md#plugin-interface) for protocol and commands.

### Plugin API (for Third-Party Extensions)

Third-party VS Code extensions can call CodeHydra API methods through the codehydra extension's exports.

**Accessing the API:**

```javascript
const ext = vscode.extensions.getExtension("codehydra.sidekick");
const api = ext?.exports?.codehydra;
if (!api) {
  throw new Error("codehydra extension not available");
}

// Wait for connection to CodeHydra
await api.whenReady();

// Now you can use the workspace API
const status = await api.workspace.getStatus();
const metadata = await api.workspace.getMetadata();
await api.workspace.setMetadata("my-key", "my-value");
```

**Available Methods:**

| Method                             | Returns                          | Description                                    |
| ---------------------------------- | -------------------------------- | ---------------------------------------------- |
| `whenReady()`                      | `Promise<void>`                  | Resolves when connected to CodeHydra           |
| `workspace.getStatus()`            | `Promise<WorkspaceStatus>`       | Get current workspace status                   |
| `workspace.getMetadata()`          | `Promise<Record<string,string>>` | Get all workspace metadata                     |
| `workspace.setMetadata(key,value)` | `Promise<void>`                  | Set metadata (null value deletes key)          |
| `workspace.getOpencodePort()`      | `Promise<number \| null>`        | Get OpenCode server port (null if not running) |

**Type Declarations:**

For TypeScript support, copy the type declarations from:
`src/services/vscode-setup/assets/codehydra-sidekick/api.d.ts`

**Error Handling:**

All methods return rejected Promises on failure (not thrown exceptions). The rejection reason is a string error message.

```javascript
try {
  await api.workspace.setMetadata("key", "value");
} catch (error) {
  console.error("Failed to set metadata:", error);
}
```

**Timeout:** All API calls have a 10-second timeout.

## Development Workflow

- **Features**: Efficient coverage - implement with tests, batch validate at end
- **Bug fixes (cleanup phase)**: Fix issue, ensure test coverage exists
- Scripts: `npm run dev`, `npm run build`, `npm test`, `npm run lint`
- Use `npm install <package>` for dependencies (never edit package.json manually)

### Windows Development Requirements

Building on Windows requires Visual Studio Build Tools for native module compilation:

1. **Install Visual Studio Build Tools** with "Desktop development with C++" workload
2. Or install via `npm install --global windows-build-tools` (elevated prompt)

This is required for the `@vscode/windows-process-tree` native module. If build tools are missing, `npm install` will fail with compilation errors.

**Note**: GitHub Actions Windows runners have build tools pre-installed. End users receive pre-compiled binaries via electron-builder packaging.

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

| Code Change                                   | Required Tests           |
| --------------------------------------------- | ------------------------ |
| New module/function                           | Unit tests               |
| Module interactions                           | Integration tests        |
| External interface (Git, HTTP, fs, processes) | Boundary tests           |
| Bug fix                                       | Test that covers the fix |

### Efficient Coverage Workflow

For features and new code:

1. **IMPLEMENT**: Write implementation and tests together (no test runs per step)
2. **VALIDATE**: Run `npm run validate:fix` after all steps complete
3. **FIX**: Address any failures

For bug fixes during cleanup:

1. **FIX**: Apply the fix
2. **COVER**: Ensure a test covers the fixed behavior (add if missing)
3. **VALIDATE**: Run `npm run validate:fix`

### Test Commands

| Command                 | Use Case                              |
| ----------------------- | ------------------------------------- |
| `npm test`              | Run all tests                         |
| `npm run test:unit`     | Quick feedback during development     |
| `npm run test:boundary` | When developing external interfaces   |
| `npm run validate`      | Pre-commit check (unit + integration) |

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
