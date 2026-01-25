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
| Electron Window  | `WindowLayer`               | `BaseWindow` directly       |
| Electron View    | `ViewLayer`                 | `WebContentsView` directly  |
| Electron Session | `SessionLayer`              | `session` directly          |
| Electron IPC     | `IpcLayer`                  | `ipcMain` directly          |
| Electron Dialog  | `DialogLayer`               | `dialog` directly           |
| Electron Image   | `ImageLayer`                | `nativeImage` directly      |
| Electron App     | `AppLayer`                  | `app` directly              |
| Electron Menu    | `MenuLayer`                 | `Menu` directly             |

**Full details**: See [Service Layer Patterns](docs/PATTERNS.md#service-layer-patterns) for implementation examples and mock factories.

### Path Handling Requirements

**ALWAYS use the `Path` class for internal path handling.**

All internal path handling MUST use the `Path` class for cross-platform consistency:

```typescript
import { Path } from "../services/platform/path";

// CORRECT: Use Path for all path handling
const projectPath = new Path(inputPath);
const workspacePath = new Path(projectPath, "workspaces", name);
map.set(path.toString(), value);     // Use toString() for Map keys
if (path1.equals(path2)) { ... }     // Use equals() for comparison
if (child.isChildOf(parent)) { ... } // Use isChildOf() for containment

// WRONG: Ad-hoc normalization
path.replace(/\\/g, "/");            // ❌ Use Path instead
path.normalize(inputPath);           // ❌ Doesn't handle case sensitivity
path1 === path2;                     // ❌ Fails for "C:\foo" vs "C:/foo"
```

**Key rules:**

1. **Services receive `Path` objects** - all internal path handling uses `Path`
2. **IPC uses strings** - shared types in `src/shared/` use `string` for paths
3. **Conversion at IPC boundary** - `new Path(incoming)` and `path.toString()` for outgoing
4. **Renderer receives normalized strings** - safe for `===` comparison (already normalized by main process)

**Full details**: See [Path Handling Patterns](docs/PATTERNS.md#path-handling-patterns) for code examples.

### Use 127.0.0.1 Instead of localhost

**ALWAYS use `127.0.0.1` instead of `localhost` for local network connections.**

- Server bindings: `server.listen(port, "127.0.0.1")`
- URL construction: `http://127.0.0.1:${port}/...`
- Socket connections: `{ host: "127.0.0.1", port }`

**Why this matters:**

1. **IPv4/IPv6 mismatch**: Node.js may resolve `localhost` to `::1` (IPv6) while servers bind to `127.0.0.1` (IPv4), causing connection failures
2. **Windows DNS latency**: Resolving `localhost` on Windows can be slow, causing test timeouts
3. **Consistency**: Using explicit IP avoids platform-specific DNS behavior

### Ask When Uncertain

**NEVER make decisions based on assumptions without proof.**

When debugging or analyzing root causes:

1. If multiple plausible causes exist, ask the user before proceeding
2. If you cannot reproduce or verify the issue, explain what you found and ask for guidance
3. State your hypothesis clearly and ask for confirmation before making changes

This also applies to other situations where you're uncertain - ask rather than guess.

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
| Package Manager | pnpm                                     |

### Essential Commands

| Command             | Purpose                             |
| ------------------- | ----------------------------------- |
| `pnpm dev`          | Start development mode              |
| `pnpm validate:fix` | Fix lint/format issues, run tests   |
| `pnpm test`         | Run all tests                       |
| `pnpm build`        | Build for production                |
| `pnpm dist`         | Create distributable for current OS |
| `pnpm dist:linux`   | Create Linux AppImage               |
| `pnpm dist:win`     | Create Windows portable exe         |
| `pnpm site:dev`     | Start landing page dev server       |
| `pnpm site:build`   | Build landing page for production   |
| `pnpm site:preview` | Preview built landing page          |
| `pnpm site:check`   | Type-check landing page             |

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

## Public Documentation

### README.md

The repository README (`README.md`) is the primary entry point for GitHub visitors. It includes:

- Project description and features
- Quick start instructions
- Development commands
- Contributing guidelines

### Landing Page

The landing page at [codehydra.dev](https://codehydra.dev) is built with Vite + Svelte and deployed via GitHub Pages.

| Path                       | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `site/`                    | Landing page source                              |
| `site/src/components/`     | Svelte components (Header, Hero, Features, etc.) |
| `site/src/styles/site.css` | Self-contained CSS (no main app imports)         |
| `site/public/`             | Static assets (logo, CNAME)                      |

**Development:**

```bash
pnpm site:dev      # Start dev server at localhost:5173
pnpm site:build    # Build to site/dist/
pnpm site:check    # Type-check
```

The landing page is self-contained and does not import from the main app's source code.

## Key Concepts

| Concept         | Description                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project         | Git repository path (container, not viewable) - the main git directory                                                                                                                                                         |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory                                                                                                                                                                |
| WebContentsView | Electron view for embedding (not iframe)                                                                                                                                                                                       |
| Shortcut Mode   | Keyboard-driven navigation activated by Alt+X. All key detection in main process (ShortcutController). Actions: ↑↓ navigate, ←→ navigate idle, 1-0 jump, Enter new, Delete remove. Escape exits (renderer).                    |
| VS Code Setup   | First-run setup that installs extensions and config; uses preflight checks on every startup to detect missing/outdated components; marker at `<app-data>/.setup-completed`. See [VS Code Assets](#vs-code-assets) for details. |
| .keepfiles      | Config file in project root listing files to copy to new workspaces. Uses gitignore syntax with **inverted semantics** - listed patterns are COPIED (not ignored). Supports negation with `!` prefix.                          |
| App Icon Badge  | Shows visual status indicator on app icon. Red circle: all workspaces working. Half green/half red: mixed (some ready, some working). No badge: all ready. Platform: macOS dock, Windows taskbar, Linux Unity.                 |
| View Loading    | New workspaces show a loading overlay until first OpenCode client attaches (first MCP request received) or 10-second timeout. Prevents VS Code flickering during progressive load. View URL loads but stays detached.          |

## VS Code Assets

VS Code setup assets are stored as dedicated files instead of inline code.

### Asset Files

| File                       | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `extensions/external.json` | External extension IDs and versions (downloaded at build time) |
| `extensions/sidekick/`     | Custom extension source (packaged to .vsix at build)           |

**Note:** All extensions must use TypeScript (not JavaScript/JSDoc). There are no `settings.json` or `keybindings.json` asset files. VS Code settings with `window` or `resource` scope can be configured via the sidekick extension's `configurationDefaults` in `package.json`. Application-scope settings (like telemetry and workspace trust) cannot be set by extensions.

### Build Process

1. **Extension packaging**: `pnpm build:extensions` auto-discovers extension folders, packages them to `dist/extensions/`, downloads external extensions from VS Code Marketplace, and generates `manifest.json`
2. **Asset bundling**: `vite-plugin-static-copy` copies `dist/extensions/*` to `out/main/assets/` during build
3. **Full build**: `pnpm build` runs both steps sequentially

**Manifest format** (flat array - all extensions are pre-bundled):

```json
[
  { "id": "codehydra.sidekick", "version": "0.0.3", "vsix": "codehydra-sidekick-0.0.3.vsix" },
  { "id": "sst-dev.opencode", "version": "0.0.13", "vsix": "sst-dev-opencode-0.0.13.vsix" }
]
```

### Runtime Flow

```
out/main/assets/ (ASAR in prod)
    │
    └─► *.vsix (pre-bundled) ──► <app-data>/vscode/ ──► code-server --install-extension
```

- `PathProvider.vscodeAssetsDir` resolves to `<appPath>/out/main/assets/`
- Node.js `fs` module reads transparently from ASAR in production
- All extensions (local and external) are bundled at build time - no marketplace downloads at runtime
- Files are copied to app-data before use (external processes can't read ASAR)

## Release Workflow

| Component  | Release Version       | Dev Version                      |
| ---------- | --------------------- | -------------------------------- |
| App        | `YYYY.MM.DD`          | `{date}-dev.{hash}[-dirty]`      |
| Extensions | `{major}.{commits}.0` | `{major}.{commits}.0-dev.{hash}` |

App version via `__APP_VERSION__` (Vite define), logged on startup.

**Trigger**: Manual via GitHub Actions (with optional force flag)
**Artifacts**: Windows dir, Linux AppImage
**Full details**: See [Release Workflow](docs/RELEASE.md).

## Binary Distribution

CodeHydra downloads code-server and opencode binaries from GitHub releases. This happens automatically during:

1. **Development (`pnpm install`)**: Downloads to `./app-data/` via postinstall script
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

When these are updated, `pnpm install` will download new versions. Production installations re-download on next app launch (setup version is incremented).

## CLI Wrapper Scripts

During VS Code setup, CLI wrapper scripts are copied from bundled assets to `<app-data>/bin/`:

| Script                      | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `code` / `code.cmd`         | VS Code CLI (code-server's remote-cli)                      |
| `opencode` / `opencode.cmd` | Wrapper that reads env vars and attaches to OpenCode server |

**opencode wrapper architecture:**

```
opencode (shell) → opencode.cjs (Node.js) → opencode binary
                        ├─ Reads $CODEHYDRA_OPENCODE_PORT (set by sidekick extension)
                        ├─ Reads $CODEHYDRA_OPENCODE_SESSION_ID (set by sidekick extension)
                        ├─ Reads $CODEHYDRA_OPENCODE_DIR (set by CodeServerManager)
                        └─ Runs `opencode attach http://127.0.0.1:<port> --session <id>`
```

**Environment Variables (set by CodeServerManager when spawning code-server):**

| Variable                        | Set By             | Purpose                                       |
| ------------------------------- | ------------------ | --------------------------------------------- |
| `CODEHYDRA_CODE_SERVER_DIR`     | CodeServerManager  | Directory containing code-server installation |
| `CODEHYDRA_OPENCODE_DIR`        | CodeServerManager  | Directory containing opencode binary          |
| `CODEHYDRA_OPENCODE_PORT`       | sidekick extension | Port of running OpenCode server               |
| `CODEHYDRA_OPENCODE_SESSION_ID` | sidekick extension | Primary session ID for the workspace          |

- Uses bundled Node.js from code-server (`$CODEHYDRA_CODE_SERVER_DIR/lib/node`)
- **Only works in managed terminals**: The sidekick extension sets `CODEHYDRA_OPENCODE_PORT` and `CODEHYDRA_OPENCODE_SESSION_ID` for all new terminals
- Thin shell wrappers (`opencode` / `opencode.cmd`) delegate all logic to the cross-platform `opencode.cjs` script (compiled from TypeScript at build time)

**Session Restoration**: The wrapper reads the session ID from `CODEHYDRA_OPENCODE_SESSION_ID` (set by the sidekick extension on connect) and passes it to the `opencode attach` command with `--session <id>`. This eliminates SDK calls and provides instant session attachment.

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

- Views start **detached** (not in contentView) with **URL preloaded** in parallel during project open
- On first activation: view is attached to contentView (URL already loaded)
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
   CODEHYDRA_ELECTRON_FLAGS="--disable-gpu" pnpm dev
   ```

2. **For WebGL-specific crashes**:
   ```bash
   CODEHYDRA_ELECTRON_FLAGS="--use-gl=swiftshader" pnpm dev
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
| `[keepfiles]`       | .keepfiles copying      |
| `[api]`             | IPC handlers            |
| `[window]`          | WindowManager           |
| `[view]`            | ViewManager             |
| `[badge]`           | BadgeManager            |
| `[app]`             | Application lifecycle   |
| `[ui]`              | Renderer UI components  |

### Debugging with Logs

```bash
# Enable verbose logging to console
CODEHYDRA_LOGLEVEL=debug CODEHYDRA_PRINT_LOGS=1 pnpm dev

# Filter to specific loggers only
CODEHYDRA_LOGGER=git,process pnpm dev

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
    ├── platform/   # OS/runtime abstractions (Path, IPC, Dialog, Image, App, Menu)
    └── shell/      # Visual container abstractions (Window, View, Session)
```

### Service Layer Organization

| Directory           | Purpose                                      | Examples                                      |
| ------------------- | -------------------------------------------- | --------------------------------------------- |
| `services/platform` | OS/runtime abstractions (file, process, IPC) | `FileSystemLayer`, `IpcLayer`, `DialogLayer`  |
| `services/shell`    | Electron visual container abstractions       | `WindowLayer`, `ViewLayer`, `SessionLayer`    |
| `services/git`      | Git operations                               | `GitClient`, `SimpleGitClient`                |
| `services/opencode` | OpenCode integration                         | `OpenCodeClient`, `OpenCodeServerManager`     |
| `services/logging`  | Structured logging                           | `LoggingService`, `ElectronLogService`        |
| `services/*`        | Domain services                              | `CodeServerManager`, `KeepFilesService`, etc. |

**Dependency Rule**: Shell layers may depend on Platform layers, but not vice versa.

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

| Component       | Responsibility                                                                              |
| --------------- | ------------------------------------------------------------------------------------------- |
| App.svelte      | Mode router: setup vs normal. Owns global events (shortcuts, setup).                        |
| MainView.svelte | Normal app container. Composes setup functions for initialization, domain events, deletion. |

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

IPC handlers are auto-registered by the `ApiRegistry` when modules register their methods. Key patterns:

- **Module Registration**: Modules call `api.register(path, handler, { ipc: channel })` to register IPC handlers
- **Fire-and-forget**: Use `void api.call()` for non-blocking UI state changes
- **ID Generation**: Deterministic `<name>-<hash8>` format for projects and workspaces
- **API Usage**: Renderer uses `api.*` for all operations after setup

**Full details**: See [Module Registration Pattern](docs/PATTERNS.md#module-registration-pattern) for code examples.

## VSCode Elements Patterns

All UI components MUST use `@vscode-elements/elements` where equivalents exist:

- Use `<vscode-button>`, `<vscode-textfield>`, `<vscode-checkbox>` instead of native HTML
- Property binding: use `value={x} oninput={...}` (not `bind:value`)
- Focus trap includes vscode-elements in focusable selector
- **Exception**: BranchDropdown uses native input for filtering/grouping

**Full details**: See [VSCode Elements Patterns](docs/PATTERNS.md#vscode-elements-patterns) for component mapping and event handling.

## Icon Usage

Use the `Icon` component for all icons. Never use Unicode characters or HTML entities.

### Icon Component API

| Prop     | Type    | Default    | Description                               |
| -------- | ------- | ---------- | ----------------------------------------- |
| `name`   | string  | (required) | Codicon name                              |
| `size`   | number  | 16         | Size in pixels                            |
| `label`  | string  | undefined  | Screen reader label (makes icon semantic) |
| `action` | boolean | false      | Button-like behavior with hover/focus     |
| `spin`   | boolean | false      | Rotation animation                        |
| `class`  | string  | ""         | Additional CSS classes                    |

### Usage Patterns

```svelte
<!-- Decorative icon (hidden from screen readers) -->
<Icon name="check" />

<!-- Action icon (button-like, announced by screen readers) -->
<Icon name="close" action label="Close dialog" />

<!-- Icon inside native button (for complex click handling) -->
<button onclick={handleClick} aria-label="Add item">
  <Icon name="add" />
</button>

<!-- Colored icon (inherits currentColor) -->
<span class="success-text">
  <Icon name="check" /> Done
</span>
```

### Common Icons

| Icon | Name            | Usage                   |
| ---- | --------------- | ----------------------- |
| ✓    | `check`         | Success, done, complete |
| ✗    | `close`         | Error, remove, dismiss  |
| ⚠    | `warning`       | Warnings, alerts        |
| +    | `add`           | Add new item            |
| ›    | `chevron-right` | Expand indicator        |
| ○    | `circle-large`  | Pending, empty state    |

Full list: https://microsoft.github.io/vscode-codicons/dist/codicon.html

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
- **Startup commands**: Auto-configures workspace layout (close sidebars, open terminal, open dictation tab if configured)
- **Shutdown event**: Terminates extension host on workspace deletion (releases file handles on Windows)

**Server → Client Events:**

| Event      | Purpose                                                            | Timeout |
| ---------- | ------------------------------------------------------------------ | ------- |
| `config`   | Send configuration after connection                                | N/A     |
| `command`  | Execute VS Code command                                            | 10s     |
| `shutdown` | Kill terminals, remove workspace folders, terminate extension host | 5s      |

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

| Method                                 | Returns                          | Description                                    |
| -------------------------------------- | -------------------------------- | ---------------------------------------------- |
| `whenReady()`                          | `Promise<void>`                  | Resolves when connected to CodeHydra           |
| `workspace.getStatus()`                | `Promise<WorkspaceStatus>`       | Get current workspace status                   |
| `workspace.getMetadata()`              | `Promise<Record<string,string>>` | Get all workspace metadata                     |
| `workspace.setMetadata(key,value)`     | `Promise<void>`                  | Set metadata (null value deletes key)          |
| `workspace.getOpencodePort()`          | `Promise<number \| null>`        | Get OpenCode server port (null if not running) |
| `workspace.executeCommand(cmd, args?)` | `Promise<unknown>`               | Execute a VS Code command (10s timeout)        |

**Type Declarations:**

For TypeScript support, copy the type declarations from:
`extensions/codehydra-sidekick/api.d.ts`

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

### Extension Logging

Third-party extensions can send structured logs to CodeHydra's centralized logging system. Logs appear in CodeHydra's log files with the `[extension]` scope and include the workspace path for traceability.

**Usage:**

```javascript
// Log at different levels
api.log.info("Extension initialized", { version: "1.0.0" });
api.log.debug("Processing file", { filename: "test.ts", size: 1024 });
api.log.warn("Deprecated feature used", { feature: "oldMethod" });
api.log.error("Failed to parse config", { error: "Invalid JSON" });
api.log.silly("Iteration details", { step: 42, data: "verbose" });
```

**Log Methods:**

| Method                     | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `log.silly(message, ctx?)` | Most verbose - per-iteration details             |
| `log.debug(message, ctx?)` | Development tracing information                  |
| `log.info(message, ctx?)`  | Significant operations (start/stop, completions) |
| `log.warn(message, ctx?)`  | Recoverable issues or deprecated behavior        |
| `log.error(message, ctx?)` | Failures that require attention                  |

**Context Constraints:**

The optional context parameter must contain only primitive values:

- `string`, `number`, `boolean`, `null`
- No nested objects, arrays, or functions

**Fire-and-Forget:**

Log methods are fire-and-forget - they don't return a Promise and gracefully handle disconnected state (logs are silently dropped if not connected).

## MCP Server

CodeHydra runs an MCP (Model Context Protocol) server that exposes workspace API methods to AI agents. OpenCode servers are automatically configured to connect to this MCP server.

### Available Tools

| Tool                                | Description                                         |
| ----------------------------------- | --------------------------------------------------- |
| `workspace_get_status`              | Get workspace status (dirty flag, agent status)     |
| `workspace_get_metadata`            | Get all workspace metadata                          |
| `workspace_set_metadata`            | Set or delete a metadata key                        |
| `workspace_get_opencode_port`       | Get OpenCode server port                            |
| `workspace_restart_opencode_server` | Restart OpenCode server, preserving the same port   |
| `workspace_execute_command`         | Execute a VS Code command                           |
| `workspace_delete`                  | Delete the workspace                                |
| `workspace_create`                  | Create a new workspace with optional initial prompt |

**Note**: MCP tools mirror the Public API workspace methods. See `docs/API.md` for detailed documentation.

**VS Code Object Serialization**: Commands requiring VS Code objects (Uri, Position, Range, Selection, Location) use the `$vscode` wrapper format. Example: `{ "$vscode": "Uri", "value": "file:///path/to/file.ts" }`. See [docs/API.md#vs-code-object-serialization](docs/API.md#vs-code-object-serialization) for full format documentation.

## Development Workflow

- **Features**: Efficient coverage - implement with tests, batch validate at end
- **Bug fixes (cleanup phase)**: Fix issue, ensure test coverage exists
- Scripts: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`
- Use `pnpm add <package>` for dependencies (never edit package.json manually)

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

| Code Change                                   | Required Tests                       |
| --------------------------------------------- | ------------------------------------ |
| New feature/module                            | Integration tests (behavioral mocks) |
| Pure utility function (no deps)               | Focused tests (input/output)         |
| External interface (Git, HTTP, fs, processes) | Boundary tests                       |
| Bug fix                                       | Test that covers the fix             |

**Note**: Unit tests are **deprecated**. New code uses integration tests with behavioral mocks. Existing unit tests remain until migrated per-module.

### Behavioral Mock Pattern

Mocks simulate behavior with in-memory state via the `mock.$` accessor:

```typescript
const mock = createFileSystemMock();

// Public API for normal setup (preferred)
await mock.writeFile("/config.json", "{}");

// $ accessor for test utilities
mock.$.simulateError("/broken", "EIO"); // Error simulation
mock.$.reset(); // Restore initial state
console.log(mock.$.toString()); // Debug output

// Type-safe matchers
expect(mock).toHaveFile("/config.json");
```

See [Behavioral Mock Pattern](docs/TESTING.md#behavioral-mock-pattern) for full documentation.

### Efficient Coverage Workflow

For features and new code:

1. **IMPLEMENT**: Write implementation and tests together (no test runs per step)
2. **VALIDATE**: Run `pnpm validate:fix` after all steps complete
3. **FIX**: Address any failures

For bug fixes during cleanup:

1. **FIX**: Apply the fix
2. **COVER**: Ensure a test covers the fixed behavior (add if missing)
3. **VALIDATE**: Run `pnpm validate:fix`

### Test Commands

| Command                 | Use Case                                     |
| ----------------------- | -------------------------------------------- |
| `pnpm test`             | Run all tests                                |
| `pnpm test:integration` | Primary development feedback (fast)          |
| `pnpm test:boundary`    | When developing external interfaces          |
| `pnpm test:legacy`      | Deprecated unit tests (until migrated)       |
| `pnpm validate`         | Pre-commit check (integration tests + build) |

**Important**: Integration tests MUST be fast (<50ms per test). They replace unit tests as the primary feedback mechanism. If tests are slow, fix the behavioral mock.

## Validation Commands

| Check              | Command               | Requirement   |
| ------------------ | --------------------- | ------------- |
| TypeScript (all)   | pnpm check            | Zero errors   |
| TypeScript node    | pnpm check:node       | Zero errors   |
| TypeScript svelte  | pnpm check:svelte     | Zero errors   |
| TypeScript scripts | pnpm check:scripts    | Zero errors   |
| TypeScript ext     | pnpm check:extensions | Zero errors   |
| ESLint             | pnpm lint             | Zero errors   |
| Prettier           | pnpm format:check     | All formatted |
| Tests              | pnpm test             | All passing   |
| Build              | pnpm build            | Completes     |

**Recommended**: Use `pnpm validate:fix` to auto-fix formatting/linting issues before validation. This saves cycles on small errors.

Run all checks before marking any task complete.

---

## Feature Agent Workflow

The `@feature` agent orchestrates the complete feature lifecycle from planning to merge.

### Plan Status Transitions

| Status                  | Set By     | When                                                |
| ----------------------- | ---------- | --------------------------------------------------- |
| `REVIEW_PENDING`        | @feature   | Plan created                                        |
| `APPROVED`              | @implement | Starting implementation                             |
| `IMPLEMENTATION_REVIEW` | @implement | Implementation complete, ready for review & testing |
| `COMPLETED`             | @general   | User accepted, committed                            |

### Workflow Overview

```
PLANNING → Write plan → Ask reviewers → User approves → Invoke reviewers (parallel)
                                                              │
                              ┌───────────────────────────────┘
                              ▼
                     Reviews complete → Summarize with grades → Fix issues
                              │
                              ▼
                     @implement → @implementation-review → USER_TESTING
                              │
                              ▼
                     User accepts → @general commits → /ship
                              │
                        ┌─────┴─────┬─────────┐
                        ▼           ▼         ▼
                     MERGED     FAILED    TIMEOUT
                        │           │         │
                        ▼           ▼         ▼
                   Delete ws   User reviews  User decides
```

### /ship Command

The `/ship` command creates a PR with auto-merge and waits for merge via client-side queue:

1. Validates clean working tree (fails if uncommitted changes)
2. Checks for existing PR (idempotent - resumes if PR exists)
3. Pushes branch, creates PR with conventional commit title
4. Enables auto-merge with merge (not squash)
5. Runs `ship-wait.ts` script which handles:
   - Waiting for PRs ahead in queue (FIFO by creation time)
   - Rebasing onto main when it's our turn
   - Waiting for CI via `gh pr checks --watch`
   - Confirming auto-merge completion
6. Updates local target branch on success

**Outcomes:**

- **MERGED**: PR merged successfully, workspace deleted by default
- **FAILED**: PR failed (conflicts, checks, etc.) - requires user review
- **TIMEOUT**: Still processing after 15 min - user decides wait/abort

---

## GitHub Repository Setup

The `/ship` command requires the following GitHub configuration:

### 1. Enable Auto-Delete Branches

Settings → General → "Automatically delete head branches" ✓

### 2. Enable Auto-Merge

Settings → General → "Allow auto-merge" ✓

### 3. Configure Branch Protection (Ruleset)

Settings → Rules → Rulesets → New ruleset

**Ruleset settings:**

- Name: `main-protection`
- Enforcement status: Active
- Target branches: Include by pattern → `main`

**Branch rules:**

- ✓ Restrict deletions
- ✓ Require a pull request before merging
  - Required approvals: 0 (for automated workflow)
- ✓ Require status checks to pass before merging
  - Status checks:
    - `CI (ubuntu-24.04)`
    - `CI (windows-2025)`
  - ✓ Require branches to be up to date before merging
- ✓ Block force pushes

**Note:** GitHub merge queue is not available for personal account repos.
The `/ship` command implements a client-side queue via `.opencode/scripts/ship-wait.ts`
that provides similar functionality:

- PRs merge in FIFO order (by creation time)
- Each PR is rebased onto main before CI runs
- No merge conflicts at merge time

### 4. Verify CI Workflow Triggers

Ensure `.github/workflows/ci.yaml` has:

```yaml
on:
  push:
    branches-ignore: [main]
  pull_request:

jobs:
  ci:
    if: |
      github.event_name != 'pull_request' || 
      github.event.pull_request.head.repo.full_name != github.repository
```

The `if` condition prevents duplicate CI runs for same-repo PRs.
