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

**Important**: Files in `planning/` are **historical records** that reflect the state at the time of planning/implementation. They may not reflect the current application state. To understand current state, read source code and `docs/` files. Read `planning/` files for design decision context and rationale.

## Key Concepts

| Concept         | Description                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project         | Git repository path (container, not viewable) - the main git directory                                                                                |
| Workspace       | Git worktree (viewable in code-server) - NOT the main directory                                                                                       |
| WebContentsView | Electron view for embedding (not iframe)                                                                                                              |
| Shortcut Mode   | Keyboard-driven navigation activated by Alt+X, shows overlay with workspace actions (↑↓ navigate, 1-0 jump, Enter new, Delete remove, O open project) |
| VS Code Setup   | First-run setup that installs extensions and config; runs once before code-server starts; marker at `<app-data>/vscode/.setup-completed`              |

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

1. `setupReady()` is called in App.svelte's `onMount` - determines which mode to show
2. `listProjects()`, `getAllAgentStatuses()` are called in MainView.svelte's `onMount` - only when setup is complete
3. Domain event subscriptions (project/workspace/agent) happen in MainView.svelte
4. Global event subscriptions (shortcuts, setup events) stay in App.svelte

This prevents "handler not registered" errors during setup mode, when normal IPC handlers aren't available.

### Main Process Startup Architecture

The main process uses two-phase startup:

| Function          | Responsibility                                                     |
| ----------------- | ------------------------------------------------------------------ |
| `bootstrap()`     | Infrastructure only: window, views, setup handlers, load UI        |
| `startServices()` | All app services: code-server, AppState, OpenCode, normal handlers |

```
bootstrap() -> UI loads -> setupReady() called
                               |
               +---------------+---------------+
               | ready: true                   | ready: false
               v                               v
        startServices()                 run setup process
               |                               |
               |                         startServices()
               |                               |
               |                         emit setup:complete
               v                               v
        App ready                       App ready
```

**Key Timing Guarantee**: The `setup:complete` event is emitted to the renderer only AFTER `startServices()` completes. This ensures that normal IPC handlers are registered before MainView mounts and tries to call them.

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

OpenCode services use constructor DI for testability (NOT singletons):

```typescript
// Service with injected dependencies
class DiscoveryService {
  constructor(
    private readonly portScanner: PortScanner,
    private readonly processTree: ProcessTreeProvider,
    private readonly instanceProbe: InstanceProbe
  ) {}
}

// Services owned and wired by AppState
class AppState {
  readonly discoveryService: DiscoveryService;
  readonly agentStatusManager: AgentStatusManager;

  constructor() {
    const portScanner = new NetstatPortScanner();
    const processTree = new PidtreeProvider();
    const instanceProbe = new HttpInstanceProbe();
    this.discoveryService = new DiscoveryService(portScanner, processTree, instanceProbe);
    this.agentStatusManager = new AgentStatusManager();
  }
}
```

### SSE Connection Lifecycle

`OpenCodeClient` manages SSE connections with auto-reconnection:

```typescript
// Connection lifecycle
client.connect(); // Start SSE connection
client.disconnect(); // Stop and cleanup
client.dispose(); // Full cleanup, stops reconnection

// Exponential backoff: 1s, 2s, 4s, 8s... max 30s
// Resets to 1s on successful connection
// Stops reconnecting after dispose()
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

| Check      | Command              | Requirement   |
| ---------- | -------------------- | ------------- |
| TypeScript | npm run check        | Zero errors   |
| ESLint     | npm run lint         | Zero errors   |
| Prettier   | npm run format:check | All formatted |
| Tests      | npm test             | All passing   |
| Build      | npm run build        | Completes     |

**Recommended**: Use `npm run validate:fix` to auto-fix formatting/linting issues before validation. This saves cycles on small errors.

Run all checks before marking any task complete.
