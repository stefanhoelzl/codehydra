# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

## CRITICAL RULES

These rules MUST be followed. Violations require explicit user approval.

### No Ignore Comments

**NEVER add without explicit user approval:**

- `// @ts-ignore`, `// @ts-expect-error`, `// eslint-disable*`, `any` type assertions
- Modifications to `.eslintignore`, `.prettierignore`

### API/IPC Interface Changes

**NEVER modify without explicit user approval:**

- IPC channel names/signatures (`api:project:*`, `api:workspace:*`)
- Intent/event type definitions, operation interfaces
- Preload script exposed APIs, event names/payloads, shared types in `src/shared/`

**Why**: IPC contracts affect main/renderer sync, type safety, and backwards compatibility.

### New Boundary Interfaces

**NEVER add without explicit user approval:**

- New abstraction interfaces (`*Layer`, `*Client`, `*Provider`)
- New boundary types (I/O, network, filesystem, process abstractions)
- Entries to External System Access Rules table

**Why**: Architectural decisions with maintenance burden. Must follow established patterns.

### External System Access Rules

All external access MUST use abstraction interfaces:

| External System  | Required Interface                    | Forbidden Direct Access |
| ---------------- | ------------------------------------- | ----------------------- |
| Filesystem       | `FileSystemLayer`                     | `node:fs/promises`      |
| HTTP requests    | `HttpClient`                          | `fetch()`               |
| Port operations  | `PortManager`                         | `net` module            |
| Process spawning | `ProcessRunner`                       | `execa`                 |
| Agent operations | `AgentProvider`, `AgentServerManager` | Direct OpenCode SDK     |
| OpenCode API     | `SdkClientFactory`                    | Direct HTTP/SSE         |
| Git operations   | `IGitClient`                          | `simple-git`            |
| Electron Window  | `WindowLayer`                         | `BaseWindow`            |
| Electron View    | `ViewLayer`                           | `WebContentsView`       |
| Electron Session | `SessionLayer`                        | `session`               |
| Electron IPC     | `IpcLayer`                            | `ipcMain`               |
| Electron Dialog  | `DialogLayer`                         | `dialog`                |
| Electron Image   | `ImageLayer`                          | `nativeImage`           |
| Electron App     | `AppLayer`                            | `app`                   |
| Electron Menu    | `MenuLayer`                           | `Menu`                  |

**Acceptable exceptions**: Third-party libraries that encapsulate their own I/O (like `ignore`, `posthog-node`) do not need abstraction layers. We abstract our own I/O, not the internals of external libraries.

### Path Handling

**ALWAYS use the `Path` class** for internal path handling:

```typescript
import { Path } from "../services/platform/path";
const projectPath = new Path(inputPath);
map.set(path.toString(), value); // toString() for Map keys
path1.equals(path2); // equals() for comparison
```

**Rules**: Services receive `Path` objects. IPC uses strings. Convert at IPC boundary.

### Network

**ALWAYS use `127.0.0.1`** instead of `localhost` for local connections.

### Ask When Uncertain

**NEVER make decisions based on assumptions.** If multiple plausible causes exist or you cannot verify an issue, ask before proceeding.

---

## Documented Exceptions

Some components use external libraries directly without abstraction layers. These are approved exceptions where abstraction provides no benefit.

| Component              | Direct Dependency  | Reason                                                                                            |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `AutoUpdater`          | `electron-updater` | Singleton with Electron lifecycle integration; no meaningful abstraction or isolated test benefit |
| `ConfigService.load()` | `node:fs`          | Config must load synchronously before Electron app.ready; FileSystemLayer is async-only           |

---

## Quick Reference

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

| Command             | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`          | Start development mode                                                     |
| `pnpm validate:fix` | Fix lint/format issues, run tests                                          |
| `pnpm test`         | Run all tests                                                              |
| `pnpm build`        | Build for production                                                       |
| `pnpm dist`         | Create distributable for current OS                                        |
| `pnpm dist:linux`   | Create Linux AppImage                                                      |
| `pnpm dist:win`     | Create Windows portable exe                                                |
| `pnpm site:dev`     | Start landing page dev server                                              |
| `pnpm site:build`   | Build landing page for production                                          |
| `appctrl_*` MCP     | Control running app for UI debugging (via `scripts/appctrl.ts` MCP server) |

### Key Documents

| Document         | Location             | Purpose                                              |
| ---------------- | -------------------- | ---------------------------------------------------- |
| Patterns         | docs/PATTERNS.md     | IPC, UI, CSS implementation patterns                 |
| Architecture     | docs/ARCHITECTURE.md | System design, concepts, rules, components           |
| Intents          | docs/INTENTS.md      | Intent system, platform abstractions, mock factories |
| Agents           | docs/AGENTS.md       | Agent provider interface, status tracking, MCP       |
| API Reference    | docs/API.md          | Private/Public API documentation                     |
| Testing Strategy | docs/TESTING.md      | Test types, conventions, commands                    |
| Release          | docs/RELEASE.md      | Version format, release workflow, Windows builds     |
| Contributing     | CONTRIBUTING.md      | Feature skill workflow, GitHub setup, /ship command  |

**Note**: Files in `planning/` are historical records. Read source code and `docs/` for current state.

---

## Intent Dispatcher

All operations use an intent-based dispatcher with operations, hook modules, and domain events. The composition root is `src/main/index.ts`, which constructs all services, registers operations and modules with the dispatcher, then dispatches `app:start`. Cross-cutting concerns (e.g., idempotency) are implemented via `createIdempotencyModule()` from `src/main/intents/infrastructure/idempotency-module.ts`. This factory accepts an array of rules and produces a single `IntentModule` with one interceptor and reset event handlers, supporting singleton, singleton-with-reset, and per-key modes.

Operations include workspace create/delete/switch, project open/close, agent:update-status, and app lifecycle (app:start, app:shutdown). Other operations (create, delete, open, close) dispatch `workspace:switch` intents when the active workspace changes. The `workspace:create` intent supports an `existingWorkspace` field for activating discovered workspaces without creating new git worktrees (used by `project:open`). The `workspace:delete` intent has a `removeWorktree` flag: `true` for full deletion, `false` for runtime-only teardown (used by `project:close`). The `agent:update-status` intent is a trivial operation (no hooks) that emits an `agent:status-updated` domain event consumed by the IPC event bridge and badge module. New hook modules registered on `workspace:create` must handle both the new-worktree and existing-workspace paths.

The `app:start` and `app:shutdown` intents orchestrate application lifecycle. Configuration is loaded via `ConfigService.load()` (sync) before `app:start` is dispatched. `app:start` runs five hook points in sequence: `before-ready` (script declarations, electron flags, data paths), `init` (logging, shell, scripts; electron-lifecycle module provides `"app-ready"` capability after `whenReady()`, handlers needing Electron declare `requires: { "app-ready": ANY_VALUE }`), `show-ui` (starting screen), `check-deps` (binary/extension checks), and `start` (servers, wiring). `app:shutdown` has one hook point: `stop` (best-effort disposal, each module wraps its own try/catch). All modules are constructed and registered in `src/main/index.ts`. A shutdown idempotency interceptor ensures only one shutdown execution proceeds. Hook handlers can declare `requires` and `provides` for capability-based ordering (see `src/main/intents/infrastructure/operation.ts`). See `docs/INTENTS.md` for the complete reference.

---

## Key Concepts

| Concept         | Description                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Project         | Git repository path (container, not viewable). Can be local path or cloned from URL.                                       |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory                                                            |
| Remote Project  | Project cloned from git URL. Has `remoteUrl` field in config. Stored as bare clone in app-data.                            |
| WebContentsView | Electron view for embedding (not iframe)                                                                                   |
| Shortcut Mode   | Alt+X activates keyboard navigation. Keys: ↑↓ navigate, ←→ navigate idle, 1-0 jump, Enter new, Delete remove, Escape exits |
| .keepfiles      | Config listing files to copy to new workspaces. Gitignore syntax with **inverted semantics**                               |

---

## Project Structure

```
src/
├── main/           # Electron main process
├── preload/        # Preload scripts
├── renderer/       # Svelte frontend
└── services/       # Node.js services (pure, no Electron deps)
    ├── platform/   # OS/runtime abstractions (Path, IPC, Dialog, etc.)
    └── shell/      # Visual container abstractions (Window, View, Session)
```

**Dependency Rule**: Shell layers may depend on Platform layers, but not vice versa.

### Renderer Structure

```
src/renderer/lib/
├── api/          # Re-exports window.api for mockability
├── components/   # Svelte 5 components
├── stores/       # Svelte 5 runes-based stores (.svelte.ts)
└── styles/       # Global CSS
```

**Patterns**: Import from `$lib/api` (not `window.api`). Use Svelte 5 runes (`$state`, `$derived`, `$effect`).

---

## UI Patterns

### VSCode Elements

Use `@vscode-elements/elements` where equivalents exist:

- `<vscode-button>`, `<vscode-textfield>`, `<vscode-checkbox>` instead of native HTML
- Property binding: `value={x} oninput={...}` (not `bind:value`)

### Icons

Use `Icon` component. Never use Unicode characters.

```svelte
<Icon name="check" />
<Icon name="close" action label="Close" />
```

### CSS Theming

- Variable prefix: `--ch-*` (e.g., `--ch-foreground`)
- VS Code fallback: `var(--vscode-foreground, #cccccc)`
- Screen reader: `.ch-visually-hidden` class

See docs/PATTERNS.md for full details.

---

## Binary Distribution

Versions defined per agent in `src/agents/*/setup-info.ts`. Downloads happen during `pnpm install` (dev) and first-run setup (prod).

## VS Code Assets

Extensions in `extensions/` are packaged at build time. External extensions are listed in `extensions/external.json` (downloaded during build via `scripts/build-extensions.ts`).

---

## Development Workflow

- **Features**: Implement with tests, batch validate at end with `pnpm validate:fix`
- **Bug fixes**: Fix issue, ensure test coverage exists, validate
- Use `pnpm add <package>` for dependencies (never edit package.json manually)

### Showing Commands to the User

When the user needs to run a command (for verification, testing, or any other reason), **show it in the VS Code status bar** using the `mcp__codehydra__ui_show_message` MCP tool with `type: "status"`. Put the full command in `hint` (tooltip) and a short summary in `message`. To clear it afterward, call `ui_show_message` with `type: "status"` and `message: null`.

### Git Worktree Merge

```bash
git rebase main                    # In worktree directory
cd /path/to/main && git merge --ff-only <branch>  # Fast-forward only
```

---

## Code Quality

- TypeScript strict mode, no `any`, no implicit types
- ESLint warnings = errors
- Prettier enforced
- All tests must pass

### Testing

| Code Change           | Required Tests                       |
| --------------------- | ------------------------------------ |
| New feature/module    | Integration tests (behavioral mocks) |
| Pure utility function | Focused tests (input/output)         |
| External interface    | Boundary tests                       |
| Bug fix               | Test covering the fix                |

**Note**: Unit tests deprecated. Use integration tests with behavioral mocks.

| Command                 | Purpose                      |
| ----------------------- | ---------------------------- |
| `pnpm test`             | All tests                    |
| `pnpm test:integration` | Primary development feedback |
| `pnpm test:boundary`    | External interface tests     |
| `pnpm validate:fix`     | Auto-fix + validate          |

Integration tests MUST be fast (<50ms per test).

---

## Plugin Interface

VS Code extensions communicate via Socket.IO. Third-party extensions access CodeHydra API through the sidekick extension:

```javascript
const api = vscode.extensions.getExtension("codehydra.sidekick")?.exports?.codehydra;
await api.whenReady();
await api.workspace.getStatus();
```

See docs/API.md for full Plugin API and MCP Server documentation.

---

## Troubleshooting

### Configuration

All settings use dot-separated, kebab-case config keys. The same key works in three places:

| Source      | Format                                         | Example               |
| ----------- | ---------------------------------------------- | --------------------- |
| config.json | key as-is                                      | `"agent": "claude"`   |
| Env var     | `CH_` prefix, `.` → `__`, `-` → `_`, UPPERCASE | `CH_LOG__LEVEL=debug` |
| CLI flag    | `--` prefix                                    | `--log.level=debug`   |

Precedence (highest wins): CLI flag > env var > config.json > computed defaults > static defaults.

| Key                                 | Default | Description                                                                           |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `agent`                             | `null`  | Agent selection: claude\|opencode                                                     |
| `auto-update`                       | `ask`   | Auto-update preference: always\|ask\|never                                            |
| `version.claude`                    | `null`  | Claude agent version override                                                         |
| `version.opencode`                  | `null`  | OpenCode agent version override                                                       |
| `code-server.port`                  | (auto)  | Code-server port (auto = 25448 in prod, branch-derived in dev)                        |
| `version.code-server`               | `null`  | Code-server version override (null = built-in)                                        |
| `telemetry.enabled`                 | `true`  | Enable telemetry (false in dev/unpackaged)                                            |
| `telemetry.distinct-id`             | —       | Telemetry user ID (auto-generated)                                                    |
| `log.level`                         | `warn`  | Level spec: `<level>` or `<level>:<filter>` (e.g., `debug:git,process`)               |
| `log.output`                        | `file`  | Output destinations: `file`, `console`, or `file,console`                             |
| `electron.flags`                    | —       | Electron switches (e.g., `--disable-gpu`)                                             |
| `experimental.github.template-path` | `null`  | Path to Liquid template for GitHub auto-workspaces; set to enable (requires `gh` CLI) |
| `help`                              | `false` | Print config help and exit                                                            |

Any key can appear in config.json, env vars, or CLI flags.

Source of truth: Config definitions are registered by modules via `ConfigService.register()` in their factory functions. The service lives at `src/services/config/config-service.ts`. Type aliases live in `src/services/config/config-values.ts`.

### Log Files

- **Dev**: `./app-data/logs/`
- **Linux**: `~/.local/share/codehydra/logs/`
- **macOS**: `~/Library/Application Support/Codehydra/logs/`
- **Windows**: `%APPDATA%\Codehydra\logs\`

```bash
# Debug mode (env var form of log.level=debug, log.output=console)
CH_LOG__LEVEL=debug CH_LOG__OUTPUT=console pnpm dev
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
