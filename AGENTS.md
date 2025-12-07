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
| Package Manager | pnpm                                     |

## Key Documents

| Document         | Location                       | Purpose                                 |
| ---------------- | ------------------------------ | --------------------------------------- |
| Migration Plan   | planning/ELECTRON_MIGRATION.md | Phase details, implementation workflow  |
| Architecture     | docs/ARCHITECTURE.md           | System design, component relationships  |
| UI Specification | docs/USER_INTERFACE.md         | User flows, mockups, keyboard shortcuts |

**Important**: Files in `planning/` are **historical records** that reflect the state at the time of planning/implementation. They may not reflect the current application state. To understand current state, read source code and `docs/` files. Read `planning/` files for design decision context and rationale.

## Key Concepts

| Concept         | Description                                                            |
| --------------- | ---------------------------------------------------------------------- |
| Project         | Git repository path (container, not viewable) - the main git directory |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory        |
| WebContentsView | Electron view for embedding (not iframe)                               |

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

## Development Workflow

- TDD: failing test → implement → refactor
- Scripts: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`
- Use `pnpm add <package>` for dependencies (never edit package.json manually)

## Code Quality Standards

- TypeScript strict mode, no `any`, no implicit types
- ESLint warnings treated as errors
- Prettier enforced formatting
- All tests must pass

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

| Check      | Command           | Requirement   |
| ---------- | ----------------- | ------------- |
| TypeScript | pnpm check        | Zero errors   |
| ESLint     | pnpm lint         | Zero errors   |
| Prettier   | pnpm format:check | All formatted |
| Tests      | pnpm test         | All passing   |
| Build      | pnpm build        | Completes     |

**Recommended**: Use `pnpm validate:fix` to auto-fix formatting/linting issues before validation. This saves cycles on small errors.

Run all checks before marking any task complete.
