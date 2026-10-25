# AGENTS.md

Guidance for coding agents working in this repository. This file holds what every session needs; the rest loads on demand — see [Where things live](#where-things-live).

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

| External System       | Required Interface                    | Forbidden Direct Access |
| --------------------- | ------------------------------------- | ----------------------- |
| Filesystem            | `FileSystemBoundary`                  | `node:fs/promises`      |
| HTTP requests         | `HttpClient`                          | `fetch()`               |
| Port operations       | `PortManager`                         | `net` module            |
| Local sockets         | `LocalSocketClient`                   | `net.createConnection`  |
| Process spawning      | `ProcessRunner`                       | `execa`                 |
| Agent operations      | `AgentProvider`, `AgentServerManager` | Direct OpenCode SDK     |
| OpenCode API          | `SdkClientFactory`                    | Direct HTTP/SSE         |
| Git operations        | `IGitClient`                          | `simple-git`            |
| Electron Window       | `WindowBoundary`                      | `BaseWindow`            |
| Electron View         | `ViewBoundary`                        | `WebContentsView`       |
| Electron Session      | `SessionBoundary`                     | `session`               |
| Electron IPC          | `ViewBoundary.send` / `onIpc`         | `ipcMain`               |
| Electron Dialog       | `DialogBoundary`                      | `dialog`                |
| Electron Image        | `ImageBoundary`                       | `nativeImage`           |
| Electron App          | `AppBoundary`                         | `app`                   |
| Electron Power        | `AppBoundary.allowPowerSaving`        | `powerSaveBlocker`      |
| Electron Menu         | `MenuBoundary`                        | `Menu`                  |
| Electron Notification | `OsNotificationBoundary`              | `Notification`          |
| PostHog telemetry     | `PostHogBoundary`                     | `posthog-node`          |

**Acceptable exceptions**: Third-party libraries that encapsulate their own I/O internally do not need abstraction layers. We abstract our own I/O, not the internals of external libraries.

**Documented exceptions** (approved direct use, where an abstraction gives no benefit):

- `AutoUpdater` → `electron-updater`: a singleton tied to the Electron lifecycle; no meaningful abstraction or isolated test benefit.
- `Config.load()` → `node:fs`: config must load synchronously before Electron `app.ready`; `FileSystemBoundary` is async-only.
- `ElectronBuildInfo` → `execSync`: unpackaged only; reads the git branch synchronously at startup, before config registration derives the dev ports from it; `ProcessRunner` is async-only and does not exist yet.

### Path Handling

**ALWAYS use the `Path` class** for internal path handling:

```typescript
import { Path } from "../utils/path/path";
const projectPath = new Path(inputPath);
map.set(path.toString(), value); // toString() for Map keys
path1.equals(path2); // equals() for comparison
```

**Rules**: Services receive `Path` objects. IPC uses strings. Convert at IPC boundary.

### Error Classification

**NEVER branch on error text** (`message`, `stderr`, `stdout`): it is localized, unstable and embeds paths. Use `error.code`, an exit code, `ProcessResult.spawnError`, `name` or `instanceof`; with no code, probe or treat all failures alike. Text is for display only. Enforced by `no-restricted-syntax` in `eslint.config.js`; see docs/PATTERNS.md (Error Classification).

### Network

**ALWAYS use `127.0.0.1`** instead of `localhost` for local connections.

### User Guide

`docs/USER_GUIDE.md` is the one user-facing guide: the site's help page, `ch guide` (what agents read) and the in-app help dialog all render it. **Every change a user or an agent can observe** — UI, keyboard shortcuts, workspace lifecycle, config keys, the `ch`/MCP surface, plugins (hooks, automations), agent behavior — must be checked against it, and the guide updated in the same change. It describes what the code does today, not what it should do. The `/ship` gate in `.ship/gates.md` enforces this.

### Ask When Uncertain

**NEVER make decisions based on assumptions.** If multiple plausible causes exist or you cannot verify an issue, ask before proceeding.

---

## Quick Reference

### Tech Stack

- **Desktop**: Electron (BaseWindow + one WebContentsView; workspaces are iframes inside it)
- **Frontend**: Svelte 5 + TypeScript + @vscode-elements
- **Backend**: Node.js services
- **Testing**: Vitest (Playwright for e2e) · **Build**: Vite · **Package manager**: pnpm

### Essential Commands

| Command             | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `pnpm dev`          | Start development mode                                 |
| `pnpm validate:fix` | Fix lint/format issues, type-check, test, build        |
| `pnpm test`         | Run all tests                                          |
| `pnpm build`        | Build for production                                   |
| `pnpm dist`         | Create distributables for Linux, Windows and macOS     |
| `pnpm dist:linux`   | Create Linux AppImage                                  |
| `pnpm dist:win`     | Create Windows NSIS installer (+ unpacked dir)         |
| `pnpm site:dev`     | Start landing page dev server                          |
| `pnpm site:build`   | Build landing page for production                      |
| `pnpm -s appctrl`   | Drive a running app for UI debugging (skill `appctrl`) |

Use `pnpm add <package>` for dependencies (never edit package.json manually).

### Project Structure

```
src/
├── main.ts         # Electron main process entry (composition root)
├── api/            # Operation registry + adapters (MCP, API server, CLI, plugins)
├── cli/            # The `ch` binary
├── preload/        # Preload scripts
├── renderer/       # Svelte frontend
├── shared/         # Types shared across processes (IPC contracts)
├── intents/        # Intent dispatcher, operations
├── modules/        # Hook modules registered on the dispatcher
├── utils/          # Pure utilities (Path, refs, liquid templates)
└── boundaries/     # External-system abstractions
    ├── platform/   # OS/runtime abstractions (Filesystem, Process, Network, Config)
    └── shell/      # Visual container abstractions (Window, View, Session, Dialog)
```

**Dependency Rule**: Shell layers may depend on Platform layers, but not vice versa.

---

## Key Concepts

One line each; the full text is where the arrow points.

- **Project** — a git repository (container, not viewable); local path or cloned from URL → docs/ARCHITECTURE.md (Core Concepts)
- **Workspace** — a git worktree CodeHydra manages (created by it or adopted), shown in the embedded VSCodium; **named once** at creation, never derived from its path → docs/ARCHITECTURE.md (Core Concepts)
- **Remote Project** — a project cloned from a git URL and identified by it → docs/ARCHITECTURE.md (Core Concepts)
- **Ref** — the one identity of a workspace/project (`ch::<machine>::<project>[::<name>]`); build with `makeWorkspaceRef`/`projectRefFor`, never by hand → docs/ARCHITECTURE.md (Core Concepts)
- **UI View** — the app's single WebContentsView; workspaces are VSCodium iframes inside it → docs/ARCHITECTURE.md
- **Intent dispatcher** — every operation is an intent run through hook modules → `src/intents/AGENTS.md`, docs/INTENTS.md
- **Operation registry** — single source of truth for every operation the outside world reaches; adapters map it exhaustively → `src/api/AGENTS.md`
- **`ch` CLI** — one binary carrying registry subcommands, `ch mcp`, the agent launchers and `ch bg` → `src/cli/AGENTS.md`, docs/API.md
- **Plugins** — YAML manifests contributing hooks and automations, from user sources or a repo's `.codehydra/plugins` → `src/modules/plugin-module/AGENTS.md`
- **ch-bg** — wrapper that opts a Claude background shell out of keeping the workspace busy → `src/modules/agent-module/claude/AGENTS.md`
- **System prompt** — what every agent session is told about its environment → `resources/prompts/AGENTS.md`
- **Lock** — single-holder resources shared across workspaces (`ch lock`) → docs/ARCHITECTURE.md (Core Concepts)
- **Wakeup script** — a hibernated workspace's poll script that can wake it → docs/ARCHITECTURE.md (Core Concepts)
- **Config / state.json / logs** → docs/CONFIGURATION.md

---

## Where things live

Nested `AGENTS.md` files load automatically when you work in their directory; skills load when a task matches; docs are read on purpose.

| Topic                          | Location                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| Intents, writing a hook module | `src/intents/AGENTS.md`, docs/INTENTS.md                      |
| UI components, CSS, icons      | `src/renderer/AGENTS.md`, docs/PATTERNS.md                    |
| Operation registry, adapters   | `src/api/AGENTS.md`, docs/API.md                              |
| `ch` CLI, MCP                  | `src/cli/AGENTS.md`, docs/API.md                              |
| Plugins                        | `src/modules/plugin-module/AGENTS.md`                         |
| Agent providers, binaries      | `src/modules/agent-module/AGENTS.md`, docs/AGENT_PROVIDERS.md |
| Agent system prompt            | `resources/prompts/AGENTS.md`                                 |
| Bundled VS Code extensions     | `extensions/AGENTS.md`                                        |
| Config, state.json, logs       | docs/CONFIGURATION.md, skill `config-key`                     |
| Driving the app (UI debugging) | skill `appctrl`                                               |
| Architecture, core concepts    | docs/ARCHITECTURE.md                                          |
| Implementation patterns        | docs/PATTERNS.md                                              |
| Testing strategy               | docs/TESTING.md                                               |
| Release                        | docs/RELEASE.md                                               |
| User-facing behavior           | docs/USER_GUIDE.md                                            |
| Contributing, `/ship`          | CONTRIBUTING.md                                               |

Files in `planning/` are historical records. Read source code and `docs/` for current state.

---

## Code Quality

- TypeScript strict mode, no `any`, no implicit types
- ESLint warnings = errors
- Prettier enforced
- All tests must pass

**Workflow**: features are implemented with tests and validated at the end with `pnpm validate:fix`; a bug fix needs a test covering it.

### Testing

Unit tests are deprecated: use integration tests with behavioral mocks. Integration tests MUST be fast (<50ms per test). Required tests per change:

- **New feature/module** — integration tests (behavioral mocks)
- **Pure utility function** — focused tests (input/output)
- **External interface** — boundary tests
- **Bug fix** — a test covering the fix
- **Packaging / startup** — e2e spec (`e2e/*.e2e.ts`)
- **Agent launch / MCP** — `e2e/agent-turn.e2e.ts`: a real agent, a mock model (`useAgentMock()`, `@copilotkit/aimock`). No login, no key, no network
- **Claude hook contract** — `claude/server-manager.boundary.test.ts`: a real `claude` against a mock model, asserting the `AgentActivity` the shipped hook chain derives. Needs `claude` on PATH + `pnpm build:wrappers` (throws, never skips)

| Command                 | Purpose                         |
| ----------------------- | ------------------------------- |
| `pnpm test`             | All tests                       |
| `pnpm test:integration` | Primary development feedback    |
| `pnpm test:boundary`    | External interface tests        |
| `pnpm test:e2e`         | Packaged-build e2e (Playwright) |
| `pnpm validate:fix`     | Auto-fix + validate             |

See docs/TESTING.md for the full strategy.
