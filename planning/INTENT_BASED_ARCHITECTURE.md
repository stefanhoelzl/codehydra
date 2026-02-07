# Intent-Operation Architecture for CodeHydra

## Context

CodeHydra's main process currently uses three monolith modules (CoreModule 1059 LOC, UiModule 170 LOC, LifecycleModule 500 LOC) plus AppState (738 LOC) to handle all operations. Adding new behavior requires modifying these monoliths. Cross-cutting concerns (telemetry, IPC notifications, state updates) are interleaved with business logic.

This plan introduces an **Intent-Operation architecture** that separates *what* the system wants to achieve (intents) from *how* it's achieved (operations), with modules providing behavior through declarative hook registrations.

**Core principle: Operations do not call each other. They emit intents.**

---

## Core Concepts

### Intent

An **Intent** represents *what the system wants to achieve*, independent of how it is done.

- Typed discriminated union (e.g., `'workspace:create'`, `'project:open'`)
- Contains a payload with all required parameters
- Can be intercepted, modified, or canceled before an operation executes
- Intents do not know about operations or modules
- Triggered by external events: IPC, UI actions, API calls, system callbacks
- 1:1 mapping to operations

**Rule of thumb:** Intent = "what we want to do" — declarative, behavior-agnostic.

### Operation

An **Operation** represents *how an intent is fulfilled*. It is the orchestrator of business logic and provides hook points for modules to extend or modify behavior.

- Declares typed hook points (e.g., `gatherConfig`, `create`, `finalize`)
- Receives an `OperationContext` with intent, hooks, dispatcher, and event emitter
- Can dispatch other intents (intent transitions / chains)
- Emits typed domain events after execution
- Does NOT call other operations directly — emits intents instead
- Does NOT wire hooks — modules declare contributions; the app shell wires them

**Rule of thumb:** Operation = "how we do it" — orchestrator, declares hooks but does not own wiring.

### Intent vs Operation

| Aspect | Intent | Operation |
|---|---|---|
| Represents | What the system wants | How the system achieves it |
| Typed | Yes (discriminated union) | Yes (generic over Intent) |
| Knows about modules/hooks? | No | Declares hooks; does not wire them |
| Triggers | Dispatched by triggers or other operations | Can dispatch new intents or emit events |
| Extensible? | Yes (new intent types) | Yes (hook points allow module extension) |
| Behavior | Passive description | Active orchestrator |

### Hook

Module-contributed behavior at operation hook points.

- **Declarative**: modules declare what they contribute; the dispatcher / hook registry orchestrates execution
- No module should execute another module's hook directly
- **Single hook type** with unified execution model:
  1. Handlers run in registration order
  2. Each handler receives a shared `HookContext` with mutable data objects
  3. Handlers enrich the context by mutating shared objects (data gathering)
  4. If a handler throws, error is set on context
  5. Subsequent handlers that didn't opt into error handling are **skipped**
  6. Handlers that opted in (`onError: true`) still run (for cleanup)

### Event

Informational side effect after operation completes. Fire-and-forget.

- **Declarative**: modules declare event subscribers; the dispatcher event bus invokes them
- Only the dispatcher emits events — modules never emit directly
- Must not affect correctness. If ordering matters, it should be a hook, not an event

### Interceptor

Pre-operation policy. Runs before operation resolution.

- Can modify the intent payload, cancel the intent (return `null`), or enrich it
- Used for: permissions, platform checks, feature flags, confirmations

### Dispatcher

Single entry point into the system. Orchestrates the full pipeline.

- Runs interceptors → resolves operation → injects context → executes → emits events
- Owns the event bus for domain event subscribers
- The only component that orchestrates execution

**Composition happens in the app shell / composition root. Always.**

> Hooks and events are declarative. Modules declare what they contribute; the dispatcher / hook registry orchestrates execution. No module should execute another module's hook directly.

### Wiring Separation

```
Module hooks        → HookRegistry     → Operation executes hook points
Module eventSubscribers → Dispatcher.eventBus → async side-effects
```

`HookRegistry` handles **behavioral extension points** (hooks).
`Dispatcher.eventBus` handles **observational side-effects** (events).

---

## Architecture Flow

```
           ┌─────────────┐
           │  Trigger     │
           │ (UI / IPC /  │
           │  System)     │
           └─────┬───────┘
                 │
                 ▼
           ┌─────────────┐
           │   Intent     │
           │ (typed DU)   │
           └─────┬───────┘
                 │
                 ▼
        ┌───────────────────┐
        │ Intent Interceptors│
        │ (modify / cancel)  │
        └─────┬─────────────┘
                 │
                 ▼
        ┌───────────────────┐
        │ Operation Resolver │
        │ (1:1 mapping)      │
        └─────┬─────────────┘
                 │
                 ▼
        ┌───────────────────┐
        │   Operation        │
        │ (orchestrator)     │
        │ - execute(ctx)     │
        │ - declares hooks   │
        │ - may dispatch     │
        │   new intents      │
        └─────┬─────────────┘
                 │
       ┌─────────┴──────────┐
       ▼                     ▼
┌─────────────┐       ┌───────────────┐
│ Hook Points │       │ Domain Events  │
│ (unified    │       │ (typed, fired  │
│  model)     │       │  after op)     │
│             │       └───────┬───────┘
└──────┬──────┘               │
       │                      ▼
       ▼               ┌─────────────┐
Modules contribute     │ Event Bus    │
handlers declaratively │ Subscribers  │
                       └─────────────┘
```

1. **Trigger** — user click, IPC call, or system event initiates an Intent
2. **Intent** — fully typed, describing what to do
3. **Interceptors** — optional pre-processing: modify, cancel, or enrich
4. **Operation Resolver** — chooses which Operation handles the intent
5. **Operation** — orchestrates execution via hook points, emits events, may dispatch new intents
6. **Hook Points** — modules contribute behavior declaratively; shared context for data, error opt-in for cleanup
7. **Domain Events → Event Bus** — subscribers react asynchronously (analytics, IPC, logging)
8. **New intents dispatched** — trigger another pass through the same pipeline (intent chains)

---

## Intent Catalog

### Command Intents

**App Lifecycle:**

| Intent | Payload |
|---|---|
| `app:get-state` | `{}` |
| `app:select-agent` | `{ agent: 'opencode' \| 'claude' }` |
| `app:setup` | `{}` |
| `app:start` | `{}` |
| `app:shutdown` | `{}` |

**Workspace:**

| Intent | Payload |
|---|---|
| `workspace:create` | `{ projectPath, name, baseBranch, initialPrompt?, keepInBackground? }` |
| `workspace:delete` | `{ projectPath, workspaceName, keepBranch? }` |
| `workspace:switch` | `{ projectPath, workspacePath }` |
| `workspace:set-metadata` | `{ workspacePath, key, value }` |

**Project:**

| Intent | Payload |
|---|---|
| `project:open` | `{ path }` (clone from URL or first-time open) |
| `project:load` | `{ path }` (load existing from disk) |
| `project:close` | `{ projectId }` |

**Agent:**

| Intent | Payload |
|---|---|
| `agent:restart` | `{ workspacePath }` |
| `agent:change-status` | `{ workspacePath, status, session? }` |

**UI:**

| Intent | Payload |
|---|---|
| `ui:enter-shortcut-mode` | `{}` |
| `ui:change-view-mode` | `{ mode }` |

### Queries (approach decided during implementation)

| Query | Returns |
|---|---|
| `workspace:get-status` | `WorkspaceStatus` |
| `workspace:get-metadata` | `Record<string, string>` |
| `agent:get-session` | `AgentSession \| null` |

---

## Type System

### Intent (Discriminated Union)

```ts
type Intent =
  | { type: 'workspace:create'; payload: CreateWorkspacePayload }
  | { type: 'workspace:delete'; payload: DeleteWorkspacePayload }
  | { type: 'workspace:switch'; payload: SwitchWorkspacePayload }
  | { type: 'workspace:set-metadata'; payload: SetMetadataPayload }
  | { type: 'project:open'; payload: OpenProjectPayload }
  | { type: 'project:load'; payload: LoadProjectPayload }
  | { type: 'project:close'; payload: CloseProjectPayload }
  | { type: 'agent:restart'; payload: RestartAgentPayload }
  | { type: 'agent:change-status'; payload: ChangeAgentStatusPayload }
  | { type: 'ui:enter-shortcut-mode'; payload: {} }
  | { type: 'ui:change-view-mode'; payload: ChangeViewModePayload }
  | { type: 'app:get-state'; payload: {} }
  | { type: 'app:select-agent'; payload: SelectAgentPayload }
  | { type: 'app:setup'; payload: {} }
  | { type: 'app:start'; payload: {} }
  | { type: 'app:shutdown'; payload: {} }
```

### Operation (Generic Over Intent)

```ts
interface Operation<I extends Intent, R = void> {
  readonly id: string
  supports(intent: Intent): intent is I
  execute(ctx: OperationContext<I>): Promise<R>
}
```

### OperationContext (Injected, Not Owned)

```ts
interface OperationContext<I extends Intent> {
  readonly intent: I
  readonly dispatch: DispatchFn
  readonly emit: <E extends DomainEvent>(event: E) => void
  readonly hooks: ResolvedHooks   // resolved by registry, injected by dispatcher
  readonly causation: {
    intentId: string
    parentIntentId?: string       // causal chain for tracing
  }
}
```

### HookContext and HookHandler

```ts
interface HookContext {
  readonly intent: Intent
  readonly data: Record<string, unknown>   // mutable, shared across handlers
  error?: Error                            // set when a handler fails
}

interface HookHandler {
  handler: (ctx: HookContext) => Promise<void>
  onError?: boolean   // if true, called even after a previous handler errors
}
```

Single hook type. Execution model:
1. Handlers run in registration order, sharing the same `HookContext`
2. Handlers mutate `ctx.data` to contribute data (replaces gather)
3. On error: `ctx.error` is set, handlers without `onError: true` are skipped
4. Handlers with `onError: true` still run (for cleanup / rollback)

### HookPoint (Standardized Interface)

```ts
interface HookPoint {
  readonly id: string
  run(ctx: HookContext): Promise<void>
}
```

### HookRegistry (App Shell Owns Wiring)

```ts
interface HookRegistry {
  register(operationId: string, hookPointId: string, handler: HookHandler): void
  resolve(operationId: string): ResolvedHooks
}
```

### DomainEvent (Typed Discriminated Union)

```ts
type DomainEvent =
  | { type: 'workspace:created'; payload: WorkspaceCreatedPayload }
  | { type: 'workspace:deleted'; payload: WorkspaceDeletedPayload }
  | { type: 'workspace:switched'; payload: WorkspaceSwitchedPayload }
  | { type: 'project:opened'; payload: ProjectOpenedPayload }
  | { type: 'project:closed'; payload: ProjectClosedPayload }
  | { type: 'agent:status-changed'; payload: AgentStatusChangedPayload }
  // ...etc
```

### IntentInterceptor

```ts
interface IntentInterceptor {
  id: string
  order?: number
  before(intent: Intent): Promise<Intent | null>  // null = cancel
}
```

### Dispatcher

```ts
interface Dispatcher {
  dispatch<T extends Intent>(intent: T): Promise<ResultOf<T>>
  subscribe(eventType: string, handler: EventHandler): void
  addInterceptor(interceptor: IntentInterceptor): void
}
```

---

## Operations and Their Hook Points

Operations are general orchestrators. They declare hook points. Modules contribute behavior.

### `workspace:create` — CreateWorkspaceOperation

```
Hook: gatherConfig  → modules contribute config (ports, options) via ctx.data
Hook: create        → modules perform creation steps
                      handlers with onError: true provide rollback
Hook: activate      → modules start workspace services
TRANSITION:         → dispatch workspace:switch if !keepInBackground
Hook: finalize      → modules do post-creation work
Event: workspace:created
```

### `workspace:delete` — DeleteWorkspaceOperation

```
TRANSITION:         → dispatch workspace:switch if active
Hook: prepare       → modules stop services, clean up
Hook: delete        → core deletion steps
                      handlers with onError: true provide rollback
Event: workspace:deleted
```

Interceptor: Windows process blocking detection.

### `workspace:switch` — SwitchWorkspaceOperation

```
Hook: switch        → modules perform switch
Event: workspace:switched
```

### `workspace:set-metadata` — SetMetadataOperation

```
Hook: set           → write to git config
Hook: onSet         → post-write actions
Event: metadata:changed
```

### `project:open` — OpenProjectOperation

```
Hook: open          → validate, clone if remote, setup git
Event: project:opened
```

### `project:load` — LoadProjectOperation

```
Hook: load          → load existing project data, worktrees
Event: project:loaded
```

### `project:close` — CloseProjectOperation

```
Hook: close         → cleanup resources
Event: project:closed
```

### `agent:restart` — RestartAgentOperation

```
Hook: restart       → stop + restart agent server
Event: agent:restarted
```

### `agent:change-status` — ChangeAgentStatusOperation

```
Hook: gatherState   → aggregate status via ctx.data
Hook: onChanged     → update badge, etc.
Event: agent:status-changed
```

### `ui:enter-shortcut-mode` — EnterShortcutModeOperation

```
Hook: enter         → enable shortcut mode
Event: shortcut:entered
```

### `ui:change-view-mode` — ChangeViewModeOperation

```
Hook: change        → change layout mode
Event: view-mode:changed
```

### `app:setup` — SetupOperation

```
Hook: preflight     → modules report what they need via ctx.data
Hook: execute       → modules perform setup steps (with progress)
Hook: verify        → modules verify setup via ctx.data
```

### `app:start` — StartOperation

```
Hook: start         → modules start processes (ordered)
```

Emits `project:load` intents for saved projects.

### `app:shutdown` — ShutdownOperation

```
Hook: shutdown      → reverse order of start registrations
```

### `app:get-state` / `app:select-agent`

Simple operations, no hooks needed.

---

## Intent Chains (Transitions Between Operations)

Operations can dispatch new **intents** during execution. This creates **intent chains** — but only for genuine transitions to other user/system-meaningful actions.

**Key distinction:**
- **Intents** = real goals a user or system would trigger independently (`workspace:create`, `workspace:switch`, `project:open`)
- **Hook points** = internal extension points within an operation (`gatherConfig`, `create`, `activate`, `finalize`) — these are NOT intents
- **Only intents are dispatched.** Operations are never dispatched directly.

Internal operation steps (`finalize`, `activate`, `gatherConfig`) are hook points, not intents. A user would never "finalize a workspace" independently — it only makes sense as part of creating one.

**Example: `workspace:create` with intent transition**

```
workspace:create  →  CreateWorkspaceOperation
    │
    ├── hook: gatherConfig  [gather]     → modules contribute config
    ├── hook: create        [sequential] → modules perform creation
    ├── hook: onError       [error]      → modules clean up on failure
    ├── hook: activate      [sequential] → modules start services
    │
    ├── dispatches workspace:switch       ← REAL INTENT (user can also trigger independently)
    │   (condition: !keepInBackground)
    │
    ├── hook: finalize      [sequential] → modules do post-creation work
    └── emits workspace:created event
```

The only dispatched intent here is `workspace:switch` — a genuine, independently-meaningful action. Everything else (`gatherConfig`, `create`, `activate`, `finalize`) is a hook point within the operation.

**Intent transitions in CodeHydra (complete map):**

```
workspace:create  → dispatches workspace:switch  (if !keepInBackground)
workspace:delete  → dispatches workspace:switch  (if active workspace)
app:start         → dispatches project:load      (for each saved project)
```

All other operations are self-contained — no transitions.

**Causation chain:** The dispatcher tracks `parentIntentId`, so transitions like `workspace:create → workspace:switch` are traceable for debugging and logging.

---

## Module Pattern

Modules are plain classes. They declare their hooks and events as data. The app shell reads declarations and wires them.

> Hooks and events are declarative. Modules declare what they contribute; the dispatcher / hook registry orchestrates execution. No module should execute another module's hook directly. Only the dispatcher emits events.

```ts
class KeepfilesManager {
  constructor(private fs: FileSystemProvider) {}

  // Domain methods
  getOptions(): ConfigOption[] { ... }
  async copyKeepfiles(workspacePath: string) { ... }

  // Hook declarations (data — what this module contributes)
  readonly hooks = {
    'workspace:create': {
      gatherConfig: {
        handler: (ctx: HookContext) => {
          ctx.data.options ??= []
          ctx.data.options.push(...this.getOptions())
        },
      },
      finalize: {
        handler: (ctx: HookContext) => this.copyKeepfiles(ctx.data.workspacePath),
      },
    }
  }
}

class WorkspaceManager {
  // Cleanup handler runs even after errors
  readonly hooks = {
    'workspace:create': {
      create: {
        handler: (ctx: HookContext) => this.createWorktree(ctx),
        onError: true,   // also called for rollback when ctx.error is set
      },
    }
  }
}

class TelemetryTracker {
  trackCreated(e: WorkspaceCreatedEvent) { ... }
  trackDeleted(e: WorkspaceDeletedEvent) { ... }

  // Event subscriber declarations (data)
  readonly events = {
    'workspace:created': (e: WorkspaceCreatedEvent) => this.trackCreated(e),
    'workspace:deleted': (e: WorkspaceDeletedEvent) => this.trackDeleted(e),
  }
}
```

When `WorkspaceManager.create` is called with `ctx.error` set, it knows to roll back (remove failed worktree) instead of creating.

### App Shell Wiring (Generic)

```ts
function wireModules(
  modules: Module[],
  hookRegistry: HookRegistry,
  dispatcher: Dispatcher
) {
  for (const module of modules) {
    for (const [opId, hooks] of Object.entries(module.hooks ?? {})) {
      for (const [hookId, handler] of Object.entries(hooks)) {
        hookRegistry.register(opId, hookId, handler)
      }
    }
    for (const [eventType, handler] of Object.entries(module.events ?? {})) {
      dispatcher.subscribe(eventType, handler)
    }
  }
}
```

Module registration order = hook execution order within each hook point.

---

## Module Catalog

### Core Modules

| Module | Hooks | Events | Providers |
|---|---|---|---|
| WorkspaceManager | `workspace:create` (create, onError), `workspace:delete` (delete) | — | GitProvider, FileSystemProvider |
| WorkspaceSwitcher | `workspace:switch` (switch) | — | — |
| ProjectManager | `project:open` (open), `project:load` (load), `project:close` (close) | — | GitProvider, FileSystemProvider, PathProvider |
| ProjectRegistry | `app:start` (start), `workspace:create` (finalize), `agent:change-status` (gatherState) | `workspace:created`, `workspace:deleted`, `project:opened`, `project:closed` (state update + IPC) | IpcProvider |
| ProjectPersistence | `app:start` (start), `app:shutdown` (shutdown) | — | ConfigProvider |
| AgentLifecycle | `app:start` (start), `app:shutdown` (shutdown), `workspace:create` (gatherConfig, activate), `workspace:delete` (prepare), `agent:restart` (restart) | `agent:restarted` (IPC) | ProcessProvider, HttpProvider, ConfigProvider, IpcProvider |
| AgentStatusTracker | `agent:change-status` (gatherState, onChanged), `app:start` (start) | `agent:status-changed` (IPC) | HttpProvider, IpcProvider |

### View/UI Modules

| Module | Hooks | Events | Providers |
|---|---|---|---|
| WindowSetup | `app:start` (start), `app:shutdown` (shutdown) | — | WindowProvider, ImageProvider |
| WindowTitleUpdater | `workspace:switch` (switch) | — | WindowProvider |
| ViewLifecycle | `workspace:create` (activate), `workspace:delete` (prepare) | — | ViewProvider, SessionProvider |
| ViewActivation | `workspace:switch` (switch) | `workspace:switched` (IPC) | ViewProvider, IpcProvider |
| WorkspaceLoadingTracker | `workspace:create` (activate, finalize) | — | ViewProvider |
| SessionConfigurator | `workspace:create` (activate) | — | SessionProvider |
| ShortcutHandler | `app:start` (start), `ui:enter-shortcut-mode` (enter) | — | ViewProvider, IpcProvider |
| UiModeManager | `ui:enter-shortcut-mode` (enter), `ui:change-view-mode` (change) | `shortcut:entered`, `view-mode:changed` (IPC) | ViewProvider |
| CreateWsDialog | — (renderer-side currently) | — | — |
| OpenProjectDialog | — (renderer-side currently) | — | — |

### Infrastructure Modules

| Module | Hooks | Events | Providers |
|---|---|---|---|
| CodeServerRunner | `app:start` (start), `app:shutdown` (shutdown), `app:setup` (preflight, execute), `workspace:create` (gatherConfig) | — | ProcessProvider, PortProvider, PathProvider, DownloadProvider, FileSystemProvider |
| PluginBridge | `app:start` (start), `app:shutdown` (shutdown), `workspace:create` (gatherConfig) | — | HttpProvider |
| McpServer | `app:start` (start), `app:shutdown` (shutdown), `workspace:create` (gatherConfig) | — | HttpProvider, PortProvider |

### Utility Modules

| Module | Hooks | Events | Providers |
|---|---|---|---|
| WorkspaceFileGen | `workspace:create` (finalize) | — | FileSystemProvider |
| KeepfilesManager | `workspace:create` (gatherConfig, finalize) | — | FileSystemProvider |
| ProcessKiller | `workspace:delete` (prepare) | — | ProcessProvider |
| BadgeUpdater | `agent:change-status` (onChanged) | — | AppProvider, ImageProvider, WindowProvider |
| TelemetryTracker | — | `workspace:created`, `workspace:deleted`, `project:opened`, `project:closed` (track) | ConfigProvider, HttpProvider |
| WorkspaceMetadataManager | `workspace:create` (finalize), `workspace:set-metadata` (set, onSet) | `metadata:changed` (IPC) | GitProvider, IpcProvider |
| BranchPreferenceCache | — | `workspace:created`, `project:opened` (cache branch) | ConfigProvider |
| OrphanedWorkspaceCleaner | — | `project:loaded` (cleanup) | GitProvider, FileSystemProvider |
| AutoUpdater | `app:start` (start) | — | LoggingProvider |

---

## Dispatcher Pipeline

```
dispatch(intent)
  1. Generate intentId, set parentIntentId from context
  2. Run interceptors (ordered by .order, then registration order)
     - Each can modify intent or return null (cancel)
  3. Resolve operation (1:1 mapping for now, extensible later)
  4. Resolve hooks from HookRegistry for this operation
  5. Build OperationContext { intent, dispatch, emit, hooks, causation }
  6. operation.execute(ctx)
  7. Return result
```

### Operation Resolution (Simple Start)

```ts
// 1:1 mapping — extend to priority-based resolution later
const operationMap = new Map<Intent['type'], Operation<any, any>>()
operationMap.set('workspace:create', createWorkspaceOp)
operationMap.set('workspace:delete', deleteWorkspaceOp)
// ...etc
```

---

## Migration Strategy

### Coexistence via ApiRegistry

The existing ApiRegistry is the migration seam:

```
BEFORE: IPC → ApiRegistry → CoreModule.method() → AppState → services
AFTER:  IPC → ApiRegistry → dispatcher.dispatch(intent) → operation → hooks → modules
```

IPC channels never change. Renderer sees no difference. Per-method migration.

### Phase 0: Foundation

**Goal:** Create core infrastructure. No existing code changes.

**Create:**
- `src/main/intents/types.ts` — Intent discriminated union, DomainEvent union
- `src/main/intents/operation.ts` — Operation interface, OperationContext, HookPoint types
- `src/main/intents/dispatcher.ts` — Dispatcher implementation, interceptor pipeline, event bus
- `src/main/intents/hook-registry.ts` — HookRegistry, hook point resolution
- `src/main/intents/module.ts` — Module interface (hooks + events declarations)
- Tests for: hook dispatch behavior (gather merges, sequential fail-fast, error no-fail-fast), dispatcher pipeline, interceptor ordering

**Risk:** Zero — new files only.

### Phase 1: Test Balloon — Metadata

**Goal:** Validate end-to-end with smallest scope.

- `workspace:set-metadata` intent + SetMetadataOperation
- `workspace:get-metadata` query (approach TBD)
- WorkspaceMetadataManager module with declared hooks
- Wire through ApiRegistry (remove from CoreModule, add dispatcher route)

**Validates:** Intent dispatch, operation execution, hook resolution, module declarations, coexistence.

### Phase 2: Simple Operations

- Queries (`workspace:get-status`, `agent:get-session`)
- `agent:restart`, `ui:enter-shortcut-mode`, `ui:change-view-mode`, `workspace:switch`
- After this phase: **delete UiModule**

### Phase 3: Core Operations

- `workspace:create` (most complex — many modules participate)
- `workspace:delete` (with interceptor for Windows process blocking)
- `project:open`, `project:load`, `project:close`
- After this phase: **delete CoreModule**

### Phase 4: App Lifecycle

- `app:setup`, `app:start`, `app:shutdown`
- `app:get-state`, `app:select-agent`
- `agent:change-status`
- Replaces LifecycleModule + startServices()
- Extract composition root from index.ts
- After this phase: **delete LifecycleModule, AppState**

### Phase 5: Cleanup

- Provider renames (`*Layer` → `*Provider`)
- Directory renames (`src/services/` → `src/providers/`)
- Delete empty monolith files
- index.ts → thin entry (~100 LOC)

### Monolith Decomposition

| Monolith | Shrinks During | Deleted After |
|---|---|---|
| CoreModule (1059 LOC) | Phase 1-3 | Phase 3 |
| UiModule (170 LOC) | Phase 2 | Phase 2 |
| LifecycleModule (500 LOC) | Phase 4 | Phase 4 |
| AppState (738 LOC) | Phase 2-4 | Phase 4 |
| index.ts (1226 LOC) | Phase 4 | Stays as ~100 LOC |

---

## Post-Migration File Layout

```
src/main/
  index.ts                            # Thin entry (~100 LOC)
  composition-root.ts                 # Creates everything, wires modules

  intents/
    types.ts                          # Intent + DomainEvent discriminated unions
    operation.ts                      # Operation interface, OperationContext, HookPoint
    dispatcher.ts                     # Dispatcher implementation
    hook-registry.ts                  # HookRegistry, resolution
    module.ts                         # Module interface

  operations/
    create-workspace.ts
    delete-workspace.ts
    switch-workspace.ts
    set-workspace-metadata.ts
    open-project.ts
    load-project.ts
    close-project.ts
    restart-agent.ts
    change-agent-status.ts
    enter-shortcut-mode.ts
    change-view-mode.ts
    get-state.ts
    select-agent.ts
    setup.ts
    start.ts
    shutdown.ts

  modules/
    workspace-manager.ts
    workspace-switcher.ts
    workspace-metadata-manager.ts
    workspace-file-gen.ts
    workspace-loading-tracker.ts
    project-manager.ts
    project-registry.ts
    project-persistence.ts
    agent-lifecycle.ts
    agent-status-tracker.ts
    window-setup.ts
    window-title-updater.ts
    view-lifecycle.ts
    view-activation.ts
    session-configurator.ts
    shortcut-handler.ts
    ui-mode-manager.ts
    code-server-runner.ts
    plugin-bridge.ts
    mcp-server.ts
    keepfiles-manager.ts
    process-killer.ts
    badge-updater.ts
    telemetry-tracker.ts
    branch-preference-cache.ts
    orphaned-workspace-cleaner.ts
    auto-updater.ts

  interceptors/
    windows-process-check.ts

  api/                                # UNCHANGED — ApiRegistry stays as IPC routing
  utils/                              # UNCHANGED
```

---

## Verification

1. `pnpm test` — all existing tests pass at every migration step
2. New tests for each operation + module
3. `pnpm dev` — manual smoke test:
   - Open project, create workspace, delete workspace, switch workspace
   - Agent starts, status updates, badge changes
   - Remove a module registration → app still boots (extensibility proof)
4. IPC channels unchanged — renderer behavior identical
