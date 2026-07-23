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

| External System   | Required Interface                    | Forbidden Direct Access |
| ----------------- | ------------------------------------- | ----------------------- |
| Filesystem        | `FileSystemBoundary`                  | `node:fs/promises`      |
| HTTP requests     | `HttpClient`                          | `fetch()`               |
| Port operations   | `PortManager`                         | `net` module            |
| Process spawning  | `ProcessRunner`                       | `execa`                 |
| Agent operations  | `AgentProvider`, `AgentServerManager` | Direct OpenCode SDK     |
| OpenCode API      | `SdkClientFactory`                    | Direct HTTP/SSE         |
| Git operations    | `IGitClient`                          | `simple-git`            |
| Electron Window   | `WindowBoundary`                      | `BaseWindow`            |
| Electron View     | `ViewBoundary`                        | `WebContentsView`       |
| Electron Session  | `SessionBoundary`                     | `session`               |
| Electron IPC      | `IpcBoundary`                         | `ipcMain`               |
| Electron Dialog   | `DialogBoundary`                      | `dialog`                |
| Electron Image    | `ImageBoundary`                       | `nativeImage`           |
| Electron App      | `AppBoundary`                         | `app`                   |
| Electron Power    | `AppBoundary.allowPowerSaving`        | `powerSaveBlocker`      |
| Electron Menu     | `MenuBoundary`                        | `Menu`                  |
| PostHog telemetry | `PostHogBoundary`                     | `posthog-node`          |

**Acceptable exceptions**: Third-party libraries that encapsulate their own I/O (like `ignore`) do not need abstraction layers. We abstract our own I/O, not the internals of external libraries.

### Path Handling

**ALWAYS use the `Path` class** for internal path handling:

```typescript
import { Path } from "../utils/path/path";
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

| Component       | Direct Dependency  | Reason                                                                                            |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `AutoUpdater`   | `electron-updater` | Singleton with Electron lifecycle integration; no meaningful abstraction or isolated test benefit |
| `Config.load()` | `node:fs`          | Config must load synchronously before Electron app.ready; FileSystemBoundary is async-only        |

---

## Quick Reference

### Tech Stack

| Layer           | Technology                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| Desktop         | Electron (BaseWindow + one WebContentsView; workspaces are iframes inside it) |
| Frontend        | Svelte 5 + TypeScript + @vscode-elements                                      |
| Backend         | Node.js services                                                              |
| Testing         | Vitest                                                                        |
| Build           | Vite                                                                          |
| Package Manager | pnpm                                                                          |

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

All operations use an intent-based dispatcher with operations, hook modules, and domain events. The composition root is `src/main.ts`, which constructs all services, registers operations and modules with the dispatcher, then dispatches `app:start`. Cross-cutting concerns (e.g., idempotency) are implemented via `createIdempotencyModule()` from `src/intents/lib/idempotency-module.ts`. This factory accepts an array of rules and produces a single `IntentModule` with one interceptor and reset event handlers, supporting singleton, singleton-with-reset, and per-key modes.

Operations include workspace create/delete/switch, project open/close, agent:update-status, and app lifecycle (app:start, app:shutdown). Other operations (create, delete, open, close) dispatch `workspace:switch` intents when the active workspace changes. The `workspace:create` intent supports an `existingWorkspace` field for activating discovered workspaces without creating new git worktrees (used by `project:open`). The `workspace:delete` intent has a `removeWorktree` flag: `true` for full deletion, `false` for runtime-only teardown (used by `project:close`). The `agent:update-status` intent is a trivial operation (no hooks) that emits an `agent:status-updated` domain event consumed by the IPC event bridge and badge module. New hook modules registered on `workspace:create` must handle both the new-worktree and existing-workspace paths.

The `app:start` and `app:shutdown` intents orchestrate application lifecycle. Configuration is loaded via `Config.load()` (sync) before `app:start` is dispatched. `app:start` runs these hook points in sequence: `before-ready` (script declarations, electron flags, data paths), `init` (logging, shell, scripts; electron-lifecycle module provides `"app-ready"` capability after `whenReady()`, handlers needing Electron declare `requires: { "app-ready": ANY_VALUE }`), `show-ui` (starting screen), `register-agents`/`agent-selection`/`save-agent` (first run only — the picker; must precede `check-deps`, which is agent-specific), `check-deps` (binary/extension checks), and `start` (servers, wiring). `app:shutdown` has one hook point: `stop` (best-effort disposal, each module wraps its own try/catch). All modules are constructed and registered in `src/main.ts`. A shutdown idempotency interceptor ensures only one shutdown execution proceeds. Hook handlers can declare `requires` and `provides` for capability-based ordering (see `src/intents/lib/operation.ts`). See `docs/INTENTS.md` for the complete reference.

---

## Key Concepts

| Concept        | Description                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | Git repository path (container, not viewable). Can be local path or cloned from URL.                                                                                                                                                                                                               |
| Workspace      | Git worktree (viewable in the embedded IDE, VSCodium) - NOT the main directory                                                                                                                                                                                                                     |
| Remote Project | Project cloned from git URL. Has `remoteUrl` field in config. Stored as bare clone in app-data.                                                                                                                                                                                                    |
| UI View        | The app's single WebContentsView (Svelte UI). Workspaces render as VSCodium iframes inside its DOM (WorkspaceFrames)                                                                                                                                                                               |
| Shortcut Mode  | Alt+X activates keyboard navigation. Keys: ↑↓ navigate, ←→ navigate idle, 1-0 jump, Enter new, Delete remove, Escape exits                                                                                                                                                                         |
| .keepfiles     | Config listing files to copy to new workspaces. Gitignore syntax with **inverted semantics**                                                                                                                                                                                                       |
| ch-bg          | Passthrough wrapper on the agent's PATH. A background shell keeps a workspace busy by default; running it via `ch-bg <cmd>` (e.g. `ch-bg npm run dev`) opts that shell out. Detected by the `ch-bg` marker in Claude's `background_tasks[].command` (`taskKeepsBusy`). Subagents always keep busy. |

---

## Project Structure

```
src/
├── main.ts         # Electron main process entry (composition root)
├── preload/        # Preload scripts
├── renderer/       # Svelte frontend
├── shared/         # Types shared across processes (IPC contracts)
├── intents/        # Intent dispatcher, operations
├── modules/        # Hook modules registered on the dispatcher
├── utils/          # Pure utilities (Path, liquid templates)
└── boundaries/     # External-system abstractions
    ├── platform/   # OS/runtime abstractions (Filesystem, Process, Network, Config)
    └── shell/      # Visual container abstractions (Window, View, Session, Dialog)
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
<Icon name="sync" spin />
```

### CSS Theming

- Variable prefix: `--ch-*` (e.g., `--ch-foreground`)
- VS Code fallback: `var(--vscode-foreground, #cccccc)`
- Screen reader: `.ch-visually-hidden` class

See docs/PATTERNS.md for full details.

---

## Binary Distribution

Versions defined per agent in `src/modules/agent-module/*/setup-info.ts`. Downloads happen during `pnpm install` (dev) and first-run setup (prod).

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
| Packaging / startup   | e2e spec (`e2e/*.e2e.ts`)            |

**Note**: Unit tests deprecated. Use integration tests with behavioral mocks.

| Command                 | Purpose                         |
| ----------------------- | ------------------------------- |
| `pnpm test`             | All tests                       |
| `pnpm test:integration` | Primary development feedback    |
| `pnpm test:boundary`    | External interface tests        |
| `pnpm test:e2e`         | Packaged-build e2e (Playwright) |
| `pnpm validate:fix`     | Auto-fix + validate             |

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

| Key                            | Default    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                        | `claude`   | Agent selection: claude\|opencode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sidebar.width`                | `250`      | Expanded sidebar width in pixels. Set by dragging the sidebar's right edge (grow-only from 250; max 75% of the window width); also user-editable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `update.notification`          | `true`     | Show a sidebar notification when an update is available (also gates the periodic update check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `silent`                       | `false`    | Silence the audible notification played when an agent goes idle. `appctrl` always launches the app with `--silent=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sidebar.label-scroll`         | `hover`    | How an overflowing sidebar row label (title / branch / tags) scrolls horizontally: `always`\|`hover`\|`off`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `auto-tag.new`                 | `true`     | Tag workspaces created in the background (`stealFocus: false` — MCP, plugin-server, auto-workspace) with a blue `new` tag, cleared on first switch. Gates tagging only: removal always runs, so turning it off never strands a tag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `version.claude`               | `null`     | Claude agent version override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `version.opencode`             | `null`     | OpenCode agent version override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ide-server.port`              | (auto)     | Embedded IDE server (VSCodium reh-web) port (auto = 25448 in prod, branch-derived in dev). Renamed from the retired `code-server.port` via `legacyNames`, so an old key in config.json is still read (translated) as this one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `version.vscodium`             | (built-in) | VSCodium version override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `telemetry.enabled`            | `true`     | Enable telemetry (false in dev/unpackaged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `log.level`                    | `warn`     | Level spec: `<level>` or `<level>:<filter>` (e.g., `debug:git,process`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `log.output`                   | `file`     | Output destinations: `file`, `console`, or `file,console`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `electron.flags`               | —          | Electron switches (e.g., `--disable-gpu`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `electron.disabled-features`   | (curated)  | Comma-separated Chromium features for `--disable-features`. `null` = curated defaults; `""` = nothing disabled; any value fully replaces defaults                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `auto-workspace.sources`       | `null`     | Auto-workspace sources: a multi-document YAML stream (one `---`-separated document per source), each `{ name, type: cron, cmd, template }`. The `cmd` (run via `sh -c` / `cmd /c`) prints a JSON array of domain objects; the nested `template` renders one workspace per object (string leaves are Liquid). Edited inline in settings (multiline text control with a help panel). Kept out of bug reports (`omit`) but shown in the clear (may inline secrets). The retired `experimental.{github,youtrack}.*` keys stay registered as `deprecated` so an upgrade does not strip them from `config.json`, but nothing reads them — there is no automatic migration; old templates and credentials are ported into this key by hand. |
| `auto-workspace.poll-interval` | `60`       | Seconds to wait between the **end** of one auto-workspace poll cycle and the **start** of the next (a chained timer, not a fixed period — a slow cycle never stacks). Minimum 1, no maximum. Re-read when each wait is armed, so a change made in the settings dialog applies once the current wait elapses                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `help`                         | `false`    | Print config help and exit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Any key can appear in config.json, env vars, or CLI flags.

Source of truth: Config definitions are registered by modules via `Config.register()` in their factory functions. The service lives at `src/boundaries/platform/config.ts`. Shared type aliases live in `src/boundaries/platform/config-definition.ts`.

### Persisted State (state.json)

Values the **app writes at runtime** (not user-authored settings) live in `state.json` (data dir), not `config.json`. `StateService` (`src/boundaries/platform/state-service.ts`) is the Config sibling for these: same `register()`/accessor API, but a minimal async single-file load — no env/CLI overrides, no precedence. Both services compose a shared `PersistedStore` (`persisted-store.ts`: register + accessor + read-modify-write persistence). `PersistedStore` **serializes its writes** (per-instance promise chain), so several owners sharing one file (state.json) can't lose an update to interleaved read-modify-writes.

| State key (state.json)     | Owner                 | Description                                                                                                                                                                                                                                                                                        |
| -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.distinct-id`    | telemetry-module      | Auto-generated telemetry user id (sensitive)                                                                                                                                                                                                                                                       |
| `update.dismissed-version` | auto-updater-module   | The update version the user last dismissed (silences re-notify)                                                                                                                                                                                                                                    |
| `auto-workspaces`          | auto-workspace-module | `Record<"${source}/${itemKey}", {workspaceName,createdAt}>` tracking map. An entry means "already handled, skip"; it is forgotten when its item leaves the source's poll (so a re-appearing item is recreated) or when its source is removed from config. No auto-deletion, no dismissal sentinel. |
| `sidebar.hide-hibernated`  | presentation-module   | Whether hibernated workspaces are hidden from the sidebar list (bottom toggle / Alt+X+T); default `false`                                                                                                                                                                                          |

Two migration shapes feed `state.json`. (1) **config→state** (telemetry, update): the owning module registers the live key in `StateService` plus a read-only `deprecated` shadow in Config and contributes a `{from, to}` pair to the migration registry; the `state` module (`src/modules/state-module.ts`) drains it in the `app:start` "init" hook, seeding `state.json` from `config.json` and stripping the shadow via `reset()`. (2) **file→state** (auto-workspaces): the auto-workspace module does a one-shot import of the pre-state.json `auto-workspaces.json` at activation — if its key is still default and the old file exists, it imports the entries and deletes the file (guarded on `isDefault()`, so a lingering file is harmless).

`deprecated: true` config keys are **readable** (`get()` returns the loaded value) but **not settable** (`set()` throws); `reset()` deletes the key from `config.json`. This makes a deprecated key a clean one-shot migration source.

**Redaction.** A key definition may carry a `redact` field that scrubs its value in any payload that leaves the machine (e.g. bug reports). `getRedactedOverrides()` — on both `Config` and `StateService`, backed by `PersistedStore` — returns the non-default, non-deprecated values with each key's `redact` policy applied: `redact: true` replaces the whole value with `"<redacted>"`; `redact: (value, redacted) => …` returns a custom projection (the redaction token is passed in as the second arg), letting a key scrub only part of its value. A redactor must not throw; `getRedactedOverrides()` fails closed to the token if it does. A separate `omit: true` field replaces a key's value with the `"<omitted>"` token in `getRedactedOverrides()` (the key still appears, so a set value is visible) but — unlike `redact: true` — does **not** mask the settings field in the UI; it is for values edited in the clear that should still stay out of diagnostics (e.g. `auto-workspace.sources`). `getEffective()` is **not** redacted — it's for local diagnostics only. Telemetry flows through the `PostHogBoundary` sink (a pure sink — it never gates and never reads Config/State; the modules pass redacted overrides in): `telemetry-module` sends `config` overrides as person properties via `identify`, while `error-report-module` attaches `getRedactedOverrides()` (config + state) plus compressed logs to every `$exception` — both automatic crash reports and the manual bug report.

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

| Logger              | Module                               |
| ------------------- | ------------------------------------ |
| `[process]`         | Process spawning                     |
| `[network]`         | HTTP requests, ports                 |
| `[fs]`              | Filesystem operations                |
| `[git]`             | Git operations                       |
| `[opencode]`        | OpenCode SDK                         |
| `[opencode-server]` | OpenCode server manager              |
| `[keepfiles]`       | .keepfiles copying                   |
| `[api]`             | IPC handlers                         |
| `[window]`          | WindowManager                        |
| `[view]`            | ViewManager                          |
| `[badge]`           | BadgeManager                         |
| `[power]`           | Sleep prevention                     |
| `[app]`             | Application lifecycle                |
| `[state]`           | StateService (state.json)            |
| `[ui]`              | Renderer UI components               |
| `[presenter]`       | PresentationModule (ui:event intake) |
