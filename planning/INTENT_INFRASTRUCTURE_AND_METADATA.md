---
status: COMPLETED
last_updated: 2026-02-07
reviewers: [review-arch, review-quality, review-testing]
---

# INTENT_INFRASTRUCTURE_AND_METADATA

## Context

CodeHydra's main process uses monolith modules (CoreModule 1059 LOC, UiModule 170 LOC, LifecycleModule 500 LOC) plus AppState (738 LOC). Adding behavior requires modifying these monoliths. Cross-cutting concerns are interleaved with business logic.

This plan implements the first slice of the Intent-Operation architecture from `planning/INTENT_BASED_ARCHITECTURE.md`: the core infrastructure (Phase 0) and workspace metadata migration (Phase 1). Metadata get/set is the smallest operation, making it ideal for validating the pattern end-to-end.

**Intended outcome**: CoreModule loses its metadata methods, replaced by the new intent/operation/hook architecture. IPC channels unchanged. Renderer sees no difference. Old and new patterns coexist.

## Overview

- **Problem**: CoreModule monolith makes it hard to add/modify behavior. Cross-cutting concerns (IPC, events, state) interleaved with business logic.
- **Solution**: Introduce intent-operation architecture. Migrate workspace metadata as test balloon. Refactor GitWorktreeProvider to global singleton with per-project adapter for backwards compatibility.
- **Risks**: Atomic CoreModule migration (must remove + add in one step). Provider refactor touching AppState. Mitigated by per-project adapter preserving all existing call sites.
- **Alternatives Considered**: (1) Keep per-project provider, Operation resolves projectId → provider - rejected because it doesn't match the target module pattern where providers hook directly into operations. (2) Add `getRepoRoot` to IGitClient boundary - rejected to avoid boundary interface change.

## Architecture

```
BEFORE:
  IPC → ApiRegistry → CoreModule.workspaceSetMetadata() → AppState.getWorkspaceProvider() → GitWorktreeProvider

AFTER:
  IPC → ApiRegistry → dispatcher.dispatch(intent) → SetMetadataOperation → runs "set" hook → GitWorktreeProvider (global)
                                                                         → ctx.emit(workspace:metadata-changed)
                                                  → IpcEventBridge (subscribes to workspace:metadata-changed) → ApiRegistry.emit()

Provider layer:
  GitWorktreeProvider (global singleton, does NOT implement IWorkspaceProvider)
    ├── registerProject(root, workspacesDir)   ← called by adapter on creation
    ├── unregisterProject(root)                ← called by adapter on dispose
    ├── setMetadata(workspacePath, key, value)  ← used by hook handlers directly
    ├── getMetadata(workspacePath)              ← used by hook handlers directly
    └── all other methods gain projectRoot parameter (adapter binds it)

  ProjectScopedWorkspaceProvider (adapter, implements IWorkspaceProvider)
    ├── wraps global GitWorktreeProvider with bound projectRoot
    ├── delegates all IWorkspaceProvider methods → global provider (passing projectRoot)
    ├── dispose() calls global.unregisterProject()
    └── drop-in replacement for existing code (AppState, CoreModule, tests)
```

### Key Design Decisions

1. **Queries go through Dispatcher**: `get-metadata` is an Intent dispatched through the full pipeline (interceptors, causation tracking). The Operation runs a "get" hook (contributed by the provider wiring) which populates an extended hook context (`GetMetadataHookContext`), then the operation returns the result via `execute()` return value.

2. **Global GitWorktreeProvider**: Single instance manages all projects. Maintains internal `Map<workspacePath, projectRoot>` registry using `Path.toString()` for Map keys. Does NOT implement `IWorkspaceProvider` directly (no `projectRoot` property). All methods that previously used `this.projectRoot` now accept it as a parameter. Only the `ProjectScopedWorkspaceProvider` adapter implements `IWorkspaceProvider`.

3. **Per-project adapter**: `ProjectScopedWorkspaceProvider` wraps the global provider, implementing `IWorkspaceProvider`. On creation, registers the project with the global provider. `dispose()` calls `unregisterProject()`. `AppState.closeProject()` must call `dispose()`. Existing code (`AppState`, `CoreModule`) sees no change.

4. **IpcEventBridge module**: Separate intent module that subscribes to domain events and forwards them to `ApiRegistry.emit()` for IPC notification. Temporary bridge between old and new patterns — will be removed when the old module system is fully replaced.

5. **Operations orchestrate hooks, never call providers directly**: `SetMetadataOperation` runs the "set" hook point, then emits a `workspace:metadata-changed` domain event. The hook handler (registered at bootstrap, closing over the global provider) does the actual write. Same pattern for `GetMetadataOperation` — runs "get" hook, returns data from `execute()`. No separate module class needed — hook handlers are registered inline at bootstrap.

6. **Operations return results directly**: `execute()` returns the typed result (`void` for set, `Record<string, string>` for get). The dispatcher propagates this return value to the caller. Operations that need data from hooks define extended `HookContext` interfaces (e.g., `GetMetadataHookContext`) — hook handlers cast and populate the extended fields, then the operation reads them directly.

7. **Hook error semantics**: `hooks.run()` does NOT throw. It sets `ctx.error` on failure and skips subsequent non-onError handlers. Operations MUST check `ctx.error` after `hooks.run()` and throw if set. This gives operations control over error handling.

8. **Workspace resolution**: Hook handlers use `resolveWorkspace()` from `src/main/api/id-utils.ts` to resolve `projectId + workspaceName` to a workspace path. This is the same resolution logic currently in CoreModule.

### New Interfaces

```ts
// === Intent System (src/main/intents/) ===

// Intent — discriminated union describing what the system wants to do
type Intent =
  | { readonly type: "workspace:set-metadata"; readonly payload: SetMetadataPayload }
  | { readonly type: "workspace:get-metadata"; readonly payload: GetMetadataPayload };

interface SetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly key: string;
  readonly value: string | null;
}

interface GetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

// Result type mapping — dispatch() returns the correct type per intent
interface IntentResultMap {
  "workspace:set-metadata": void;
  "workspace:get-metadata": Readonly<Record<string, string>>;
}
type ResultOf<T extends Intent> = IntentResultMap[T["type"]];

// Domain events — fire-and-forget after operation completes
type DomainEvent = {
  readonly type: "workspace:metadata-changed";
  readonly payload: MetadataChangedPayload;
};

// DomainEventOf — narrow DomainEvent by type string
type DomainEventOf<T extends DomainEvent["type"]> = Extract<DomainEvent, { readonly type: T }>;

// Operation — orchestrator registered for a specific intent type
interface Operation<I extends Intent, R = void> {
  readonly id: string;
  execute(ctx: OperationContext<I>): Promise<R>;
}

// Context injected into operations by the dispatcher
interface OperationContext<I extends Intent> {
  readonly intent: I;
  readonly dispatch: DispatchFn;
  readonly emit: (event: DomainEvent) => void;
  readonly hooks: ResolvedHooks;
  readonly causation: readonly string[]; // intent ID chain, [root, ..., current]
}

// Hook system — base context extended by operations that need data flow
// Operations define extended interfaces (e.g., GetMetadataHookContext) for
// typed data passing between hooks. Hook handlers cast to the extended type.
interface HookContext {
  readonly intent: Intent;
  error?: Error;
}

// Example: operation-specific extended context
interface GetMetadataHookContext extends HookContext {
  metadata?: Readonly<Record<string, string>>;
}

interface HookHandler {
  readonly handler: (ctx: HookContext) => Promise<void>;
  readonly onError?: boolean; // if true, runs even after a previous handler errors
}

interface ResolvedHooks {
  run(hookPointId: string, ctx: HookContext): Promise<void>;
}

// HookRegistry — stores and resolves module hook contributions
interface IHookRegistry {
  register(operationId: string, hookPointId: string, handler: HookHandler): void;
  resolve(operationId: string): ResolvedHooks;
}

// Dispatcher — single entry point, orchestrates the full pipeline
interface IDispatcher {
  dispatch<T extends Intent>(intent: T, causation?: readonly string[]): Promise<ResultOf<T>>;
  subscribe(eventType: string, handler: EventHandler): () => void;
  addInterceptor(interceptor: IntentInterceptor): void;
}

// Interceptor — pre-operation policy (modify/cancel intent, preserves type)
interface IntentInterceptor {
  readonly id: string;
  readonly order?: number;
  before<T extends Intent>(intent: T): Promise<T | null>; // null = cancel
}

// Module — declarative hook and event contributions
type HookDeclarations = Readonly<Record<string, Readonly<Record<string, HookHandler>>>>;
type EventDeclarations = Readonly<Record<string, (event: DomainEvent) => void>>;

interface IntentModule {
  readonly hooks?: HookDeclarations;
  readonly events?: EventDeclarations;
  dispose?(): void;
}
```

### Changed Interfaces

```ts
// === GitWorktreeProvider (src/services/git/git-worktree-provider.ts) ===
// BEFORE: per-project instance, constructor binds projectRoot, implements IWorkspaceProvider
// AFTER:  global singleton, all methods accept projectRoot parameter, does NOT implement IWorkspaceProvider

class GitWorktreeProvider {
  // NEW: project/workspace registry
  registerProject(projectRoot: Path, workspacesDir: Path): void;
  unregisterProject(projectRoot: Path): void;

  // CHANGED: all methods now accept projectRoot as first parameter
  // metadata methods resolve projectRoot from internal registry (for direct use by hook handlers)
  // other methods receive projectRoot from the adapter
  discover(projectRoot: Path): Promise<readonly Workspace[]>;
  listBases(projectRoot: Path): Promise<readonly BaseInfo[]>;
  createWorkspace(projectRoot: Path, name: string, baseBranch: string): Promise<Workspace>;
  removeWorkspace(
    projectRoot: Path,
    workspacePath: Path,
    deleteBase: boolean
  ): Promise<RemovalResult>;
  // ... all other methods gain projectRoot parameter

  // metadata methods — resolve projectRoot from workspace registry (no projectRoot param needed)
  setMetadata(workspacePath: Path, key: string, value: string | null): Promise<void>;
  getMetadata(workspacePath: Path): Promise<Readonly<Record<string, string>>>;
}

// === ProjectScopedWorkspaceProvider (src/services/git/project-scoped-provider.ts) ===
// NEW: adapter that wraps global GitWorktreeProvider for backwards compatibility

class ProjectScopedWorkspaceProvider implements IWorkspaceProvider {
  constructor(global: GitWorktreeProvider, projectRoot: Path, workspacesDir: Path);
  // Delegates all IWorkspaceProvider methods to global provider with bound projectRoot
  // On construction: calls global.registerProject(projectRoot, workspacesDir)
  // dispose(): calls global.unregisterProject(projectRoot)
  readonly projectRoot: Path;
  dispose(): void;
}

// === IWorkspaceProvider (src/services/git/workspace-provider.ts) ===
// UNCHANGED — existing interface stays the same
```

## Implementation Steps

### Phase 0: Foundation Infrastructure

- [x] **Step 0.1: Intent types** (`src/main/intents/types.ts`)
  - Intent discriminated union (workspace:set-metadata, workspace:get-metadata)
  - IntentResultMap (set→void, get→Record<string,string>)
  - DomainEvent union (workspace:metadata-changed), DomainEventOf<T> helper
  - Payload types (reuse ProjectId, WorkspaceName from `src/shared/api/types.ts`)
  - Helper types: IntentOfType<T>, ResultOf<T>
  - Intent IDs use speaking names: `"set-metadata:<projectId>/<workspaceName>"` format. Generated by a `createIntentId(intent)` helper.
  - Files: `src/main/intents/types.ts` (new)

- [x] **Step 0.2: Operation types** (`src/main/intents/operation.ts`)
  - Operation<I, R> interface with id, execute() (no `supports()` — dispatcher matches by intent type)
  - OperationContext<I> with intent, dispatch, emit, hooks, causation
  - HookContext (base context, error field — operations extend when they need data flow)
  - HookHandler (handler fn + onError flag)
  - ResolvedHooks interface (run method — does NOT throw, sets ctx.error)
  - DispatchFn type
  - Files: `src/main/intents/operation.ts` (new)

- [x] **Step 0.3: HookRegistry** (`src/main/intents/hook-registry.ts`)
  - `Map<operationId, Map<hookPointId, HookHandler[]>>` storage
  - `register(operationId, hookPointId, handler)` - stores in registration order
  - `resolve(operationId)` → `ResolvedHooks` with `run()` method
  - Run semantics: handlers execute in order, error sets ctx.error, non-onError handlers skipped after error, onError handlers still run. `run()` does NOT throw.
  - Files: `src/main/intents/hook-registry.ts` (new)
  - Tests: `src/main/intents/hook-registry.integration.test.ts` — hook execution order, shared mutable data, error propagation, onError handlers

- [x] **Step 0.4: Dispatcher** (`src/main/intents/dispatcher.ts`)
  - IntentInterceptor interface (id, order, generic before method preserving intent type)
  - EventHandler type (receives `DomainEvent`, narrows by type internally)
  - IDispatcher interface (dispatch, subscribe, addInterceptor)
  - Dispatcher class: interceptor pipeline → operation resolution → hook injection → execute → emit events
  - Operation registration via `registerOperation(intentType: string, operation: Operation)`
  - Causation tracking (string[] chain, appended on nested dispatch)
  - Intent IDs generated via `createIntentId()` from types.ts
  - Events collected during execution, emitted after completion
  - Files: `src/main/intents/dispatcher.ts` (new)
  - Tests: `src/main/intents/dispatcher.integration.test.ts` — dispatch→execute (verified by return value), interceptor modify/cancel/ordering, event emission, causation chain, no-operation error

- [x] **Step 0.5: Module interface** (`src/main/intents/module.ts`)
  - IntentModule interface: hooks (HookDeclarations) + events (EventDeclarations) + optional dispose()
  - HookDeclarations = Record<operationId, Record<hookPointId, HookHandler>>
  - EventDeclarations = Record<eventType, (event: DomainEvent) => void>
  - Files: `src/main/intents/module.ts` (new)

- [x] **Step 0.6: Wire utility** (`src/main/intents/wire.ts`)
  - `wireModules(modules[], hookRegistry, dispatcher)` - reads declarations, registers hooks and event subscribers
  - Event handler dispatch: wire utility matches event type to handler, so handlers only receive events they declared for
  - Files: `src/main/intents/wire.ts` (new)
  - Tests: `src/main/intents/wire.integration.test.ts` — registers hooks into registry, subscribes events into dispatcher

- [x] **Step 0.7: Barrel export** (`src/main/intents/index.ts`)
  - Re-export all public types and classes
  - Files: `src/main/intents/index.ts` (new)

**CHECKPOINT — STOP FOR REVIEW**: `pnpm test` passes. No existing files modified. Review intent infrastructure before continuing.

### Phase 0.5: Global Provider Refactor

- [x] **Step 0.8: Refactor GitWorktreeProvider to global**
  - Add project registry: `Map<normalizedProjectRoot, { workspacesDir: Path }>` (keys via `Path.toString()`)
  - Add workspace registry: `Map<normalizedWorkspacePath, Path>` (workspace→projectRoot, keys via `Path.toString()`)
  - Add `registerProject(projectRoot, workspacesDir)` and `unregisterProject(projectRoot)`
  - For metadata methods (`setMetadata`, `getMetadata`): resolve `projectRoot` from workspace registry
  - All other methods that previously used `this.projectRoot` now accept `projectRoot` as a parameter
  - Global provider no longer implements `IWorkspaceProvider` (no `projectRoot` property)
  - Make constructor accept shared deps (gitClient, fileSystemLayer, logger) without projectRoot
  - Keep the static `create()` factory for the adapter pattern
  - Files: `src/services/git/git-worktree-provider.ts` (modify)

- [x] **Step 0.9: Create ProjectScopedWorkspaceProvider adapter**
  - Implements `IWorkspaceProvider`
  - Constructor takes global GitWorktreeProvider + projectRoot + workspacesDir
  - Delegates all methods to global provider, passing projectRoot
  - On creation: calls `globalProvider.registerProject(projectRoot, workspacesDir)`
  - `dispose()` calls `globalProvider.unregisterProject(projectRoot)`
  - The static `create()` factory now returns this adapter (wrapping the global instance)
  - Files: `src/services/git/project-scoped-provider.ts` (new)
  - Note: existing tests + call sites see `IWorkspaceProvider` - no changes needed

- [x] **Step 0.10: Wire adapter into AppState**
  - `AppState.openProject()` creates `ProjectScopedWorkspaceProvider` instead of direct `GitWorktreeProvider`
  - Pass the global GitWorktreeProvider instance to AppState
  - `getWorkspaceProvider()` returns the adapter (implements IWorkspaceProvider, no change for callers)
  - `AppState.closeProject()` calls `adapter.dispose()` to unregister from global provider
  - Files: `src/main/app-state.ts` (modify - provider creation + close cleanup)
  - Tests: existing workspace tests continue to pass (adapter is transparent)

**CHECKPOINT — STOP FOR REVIEW**: `pnpm test` passes. Behavior identical, GitWorktreeProvider is now global internally. Review provider refactor before continuing.

### Phase 1: Metadata Operations

- [x] **Step 1.1: SetMetadataOperation** (`src/main/operations/set-metadata.ts`)
  - Operation<SetMetadataIntent, void>
  - execute(): runs "set" hook point → checks ctx.error (throws if set) → emits `workspace:metadata-changed` domain event
  - No provider deps — hook handler does the actual write
  - Files: `src/main/operations/set-metadata.ts` (new)

- [x] **Step 1.2: GetMetadataOperation** (`src/main/operations/get-metadata.ts`)
  - Operation<GetMetadataIntent, Record<string, string>>
  - Defines `GetMetadataHookContext extends HookContext` with `metadata?` field
  - execute(): runs "get" hook point → checks ctx.error (throws if set) → returns `hookCtx.metadata`
  - No provider deps — hook handler does the actual read
  - No events needed (query)
  - Files: `src/main/operations/get-metadata.ts` (new)

- [x] **Step 1.3: IpcEventBridge module** (`src/main/modules/ipc-event-bridge.ts`)
  - IntentModule implementation
  - events: `workspace:metadata-changed` → calls `apiRegistry.emit("workspace:metadata-changed", ...)`
  - Receives IApiRegistry as dep
  - Maps domain event payloads to API event payloads
  - dispose(): no-op (subscriptions managed by wire utility)
  - Files: `src/main/modules/ipc-event-bridge.ts` (new)

- [x] **Step 1.4: Wire into bootstrap + migrate CoreModule** (atomic change)
  - **Order**: Add new registrations first, then remove old ones.
  - In `bootstrap.ts` `startServices()`:
    - Create HookRegistry, Dispatcher
    - Create SetMetadataOperation, GetMetadataOperation
    - Register provider hook handlers inline (closing over global GitWorktreeProvider + `resolveWorkspace()` from `src/main/api/id-utils.ts`):
      - `workspace:set-metadata` → "set" hook: resolves workspace, validates key, calls `provider.setMetadata()`
      - `workspace:get-metadata` → "get" hook: resolves workspace, calls `provider.getMetadata()`, casts to `GetMetadataHookContext` and sets `metadata`
    - Create IpcEventBridge module, wire via `wireModules()`
    - Register `workspaces.setMetadata` and `workspaces.getMetadata` as dispatcher bridge handlers
  - In `CoreModule`:
    - Remove `workspaceSetMetadata()` and `workspaceGetMetadata()` private methods
    - Remove their `this.api.register()` calls from `registerMethods()`
    - Remove now-unused imports (WorkspaceSetMetadataPayload if only used by these methods)
  - In `index.ts`:
    - Pass global GitWorktreeProvider and other deps to bootstrap
  - Files: `src/main/bootstrap.ts` (modify), `src/main/modules/core/index.ts` (modify), `src/main/index.ts` (modify)
  - **Critical**: Steps must be atomic - metadata registration moves from CoreModule to dispatcher bridge

- [x] **Step 1.5: Integration tests for metadata operations**
  - Test through Dispatcher entry point with behavioral mocks
  - Set metadata: dispatch intent → hook writes to git config → event emitted to subscribers
  - Get metadata: dispatch intent → hook reads from git config → returns record via execute()
  - Error cases: unknown workspace, invalid key, interceptor cancels metadata intent (no state change, no event)
  - Use existing `createMockGitClient` from `src/services/git/git-client.state-mock.ts`
  - Use behavioral MockApiRegistry with in-memory event collection for IpcEventBridge assertions
  - Files: `src/main/operations/metadata.integration.test.ts` (new)

**CHECKPOINT — STOP FOR REVIEW**: `pnpm validate:fix` passes. Metadata operations flow through intent architecture. Review full end-to-end flow before manual testing.

## Testing Strategy

### Integration Tests

| #   | Test Case                           | Entry Point                  | Boundary Mocks                 | Behavior Verified                                               |
| --- | ----------------------------------- | ---------------------------- | ------------------------------ | --------------------------------------------------------------- |
| 1   | Empty hook point is no-op           | HookRegistry.resolve().run() | None                           | No error, no side effects                                       |
| 2   | Handlers run in registration order  | HookRegistry.resolve().run() | None                           | ctx.data shows ordered writes                                   |
| 3   | Error skips non-onError handlers    | HookRegistry.resolve().run() | None                           | ctx.error set, later handlers skipped                           |
| 4   | onError handler runs after error    | HookRegistry.resolve().run() | None                           | onError handler called with ctx.error                           |
| 5   | Dispatch executes operation         | Dispatcher.dispatch()        | None (inline test op)          | Dispatch returns value produced by operation's execute()        |
| 6   | Interceptor cancels intent          | Dispatcher.dispatch()        | None                           | Returns undefined, operation not called                         |
| 7   | Events emitted after execution      | Dispatcher.dispatch()        | None                           | Subscriber called with event payload                            |
| 8   | Causation tracks chain              | Dispatcher.dispatch()        | None                           | Nested dispatch appends to causation[]                          |
| 9   | Set metadata writes to git config   | Dispatcher.dispatch()        | MockGitClient                  | Hook handler writes via provider, branch config updated         |
| 10  | Set metadata emits domain event     | Dispatcher.dispatch()        | MockGitClient, MockApiRegistry | workspace:metadata-changed event received by MockApiRegistry    |
| 11  | Get metadata returns record         | Dispatcher.dispatch()        | MockGitClient                  | Correct metadata returned via execute() return value            |
| 12  | Invalid metadata key throws         | Dispatcher.dispatch()        | MockGitClient                  | Error propagates through dispatcher pipeline                    |
| 13  | Unknown workspace throws            | Dispatcher.dispatch()        | MockGitClient                  | Provider-level "workspace not registered" error propagates      |
| 14  | ProjectScopedAdapter behavioral     | IWorkspaceProvider methods   | MockGitClient                  | Metadata set via adapter is retrievable via global provider     |
| 15  | Interceptor cancels metadata intent | Dispatcher.dispatch()        | MockGitClient                  | No state change in git config, no event emitted                 |
| 16  | Hook data flows to operation        | Dispatcher.dispatch()        | MockGitClient                  | "get" hook sets extended context metadata, operation returns it |
| 17  | unregisterProject cleans up         | GitWorktreeProvider          | MockGitClient                  | After unregister, metadata operations on its workspaces fail    |

### Test Files

| File                                                           | Tests                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `src/main/intents/hook-registry.integration.test.ts`           | #1-4                                                       |
| `src/main/intents/dispatcher.integration.test.ts`              | #5-8                                                       |
| `src/main/intents/wire.integration.test.ts`                    | wireModules registers hooks, wireModules subscribes events |
| `src/main/operations/metadata.integration.test.ts`             | #9-13, #15-16                                              |
| `src/services/git/project-scoped-provider.integration.test.ts` | #14, #17                                                   |

### Manual Testing Checklist

- [ ] `pnpm dev` - open project, create workspace
- [ ] Set metadata via MCP tool (workspace_set_metadata) - verify git config updated
- [ ] Get metadata via MCP tool (workspace_get_metadata) - verify correct record returned
- [ ] Verify metadata-changed IPC event fires (check renderer receives it)
- [ ] All other CoreModule operations still work (create, delete, switch workspace)

## Dependencies

None. All new code uses existing libraries and patterns.

## Documentation Updates

Deferred to a separate task after the pattern is validated. Scope of follow-up:

- `docs/ARCHITECTURE.md` — new component architecture (dispatcher, operations, hook registry, intent modules)
- `docs/PATTERNS.md` — intent/operation/hook pattern alongside existing Module Registration Pattern
- `CLAUDE.md` — new project structure directories (`src/main/intents/`, `src/main/operations/`, `src/main/modules/`)

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Intent infrastructure tested (HookRegistry, Dispatcher, wireModules)
- [ ] Metadata operations tested (set, get, errors, interceptor cancel)
- [ ] Provider adapter tested (existing tests pass unchanged, behavioral verification)
- [ ] Manual smoke test: metadata set/get via MCP tools works identically
- [ ] CoreModule no longer contains metadata methods
- [ ] IPC channels unchanged
