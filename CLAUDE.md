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
- API interface definitions (`ICodeHydraApi`, `ElectronApi`, etc.)
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

| External System | Required Interface | Forbidden Direct Access |
|----------------|-------------------|------------------------|
| Filesystem | `FileSystemLayer` | `node:fs/promises` |
| HTTP requests | `HttpClient` | `fetch()` |
| Port operations | `PortManager` | `net` module |
| Process spawning | `ProcessRunner` | `execa` |
| OpenCode API | `OpenCodeClient` | Direct HTTP/SSE |
| Git operations | `GitClient` | `simple-git` |
| Electron Window | `WindowLayer` | `BaseWindow` |
| Electron View | `ViewLayer` | `WebContentsView` |
| Electron Session | `SessionLayer` | `session` |
| Electron IPC | `IpcLayer` | `ipcMain` |
| Electron Dialog | `DialogLayer` | `dialog` |
| Electron Image | `ImageLayer` | `nativeImage` |
| Electron App | `AppLayer` | `app` |
| Electron Menu | `MenuLayer` | `Menu` |

### Path Handling

**ALWAYS use the `Path` class** for internal path handling:
```typescript
import { Path } from "../services/platform/path";
const projectPath = new Path(inputPath);
map.set(path.toString(), value);  // toString() for Map keys
path1.equals(path2);              // equals() for comparison
```

**Rules**: Services receive `Path` objects. IPC uses strings. Convert at IPC boundary.

### Network

**ALWAYS use `127.0.0.1`** instead of `localhost` for local connections.

### Ask When Uncertain

**NEVER make decisions based on assumptions.** If multiple plausible causes exist or you cannot verify an issue, ask before proceeding.

---

## Quick Reference

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron (BaseWindow + WebContentsViews) |
| Frontend | Svelte 5 + TypeScript + @vscode-elements |
| Backend | Node.js services |
| Testing | Vitest |
| Build | Vite |
| Package Manager | pnpm |

### Essential Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start development mode |
| `pnpm validate:fix` | Fix lint/format issues, run tests |
| `pnpm test` | Run all tests |
| `pnpm build` | Build for production |

### Key Documents

| Document | Location | Purpose |
|----------|----------|---------|
| Patterns | docs/PATTERNS.md | Implementation patterns with code examples |
| Architecture | docs/ARCHITECTURE.md | System design, component relationships |
| API Reference | docs/API.md | Private/Public API documentation |
| Testing Strategy | docs/TESTING.md | Test types, conventions, commands |
| Release | docs/RELEASE.md | Version format, release workflow, Windows builds |
| Contributing | CONTRIBUTING.md | Feature skill workflow, GitHub setup, /ship command |

**Note**: Files in `planning/` are historical records. Read source code and `docs/` for current state.

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| Project | Git repository path (container, not viewable) |
| Workspace | Git worktree (viewable in code-server) - NOT the main directory |
| WebContentsView | Electron view for embedding (not iframe) |
| Shortcut Mode | Alt+X activates keyboard navigation. Keys: ↑↓ navigate, 1-0 jump, Enter new, Delete remove, O open project, Escape exits |
| .keepfiles | Config listing files to copy to new workspaces. Gitignore syntax with **inverted semantics** |

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

Versions defined in `src/services/binary-download/versions.ts`. Downloads happen during `pnpm install` (dev) and first-run setup (prod).

## VS Code Assets

Extensions in `extensions/` are packaged at build time. See `extensions/external.json` for external extensions.

---

## Development Workflow

- **Features**: Implement with tests, batch validate at end with `pnpm validate:fix`
- **Bug fixes**: Fix issue, ensure test coverage exists, validate
- Use `pnpm add <package>` for dependencies (never edit package.json manually)

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

| Code Change | Required Tests |
|-------------|---------------|
| New feature/module | Integration tests (behavioral mocks) |
| Pure utility function | Focused tests (input/output) |
| External interface | Boundary tests |
| Bug fix | Test covering the fix |

**Note**: Unit tests deprecated. Use integration tests with behavioral mocks.

| Command | Purpose |
|---------|---------|
| `pnpm test` | All tests |
| `pnpm test:integration` | Primary development feedback |
| `pnpm test:boundary` | External interface tests |
| `pnpm validate:fix` | Auto-fix + validate |

Integration tests MUST be fast (<50ms per test).

---

## Feature Agent Workflow

The `/feature` skill orchestrates features from planning to merge. See [CONTRIBUTING.md](CONTRIBUTING.md) for full workflow details, plan status transitions, and `/ship` command documentation.

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

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CODEHYDRA_ELECTRON_FLAGS` | Electron switches (e.g., `--disable-gpu`) |
| `CODEHYDRA_LOGLEVEL` | Log level: silly\|debug\|info\|warn\|error |
| `CODEHYDRA_PRINT_LOGS` | Print logs to stdout/stderr |
| `CODEHYDRA_LOGGER` | Filter logs by name (e.g., `git,process`) |

### Log Files

- **Dev**: `./app-data/logs/`
- **Linux**: `~/.local/share/codehydra/logs/`
- **macOS**: `~/Library/Application Support/Codehydra/logs/`
- **Windows**: `%APPDATA%\Codehydra\logs\`

```bash
# Debug mode
CODEHYDRA_LOGLEVEL=debug CODEHYDRA_PRINT_LOGS=1 pnpm dev
```
