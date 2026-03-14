# CodeHydra Intent System

Concrete reference for the intent-based architecture. For conceptual overview and rules, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick Navigation

| Section                                                                     | Description                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Infrastructure Types](#infrastructure-types)                               | Core TypeScript interfaces (Intent, Operation, Module, etc.) |
| [Capability-Based Hook Ordering](#capability-based-hook-ordering)           | requires/provides mechanism for hook execution order         |
| [Idempotency](#idempotency)                                                 | Duplicate dispatch prevention patterns                       |
| [IPC-to-Intent Mapping](#ipc-to-intent-mapping)                             | How IPC channels map to intents                              |
| [Operations Reference](#operations-reference)                               | All operations with hook points and module contributions     |
| [Domain Events](#domain-events)                                             | Event types, payloads, and flow                              |
| [Composition Root](#composition-root)                                       | Bootstrap pattern in src/main/index.ts                       |
| [External System Access Rules](#external-system-access-rules)               | Required abstraction interfaces                              |
| [Platform Abstractions](#platform-abstractions)                             | FileSystemLayer, NetworkLayer, ProcessRunner, Path, etc.     |
| [Shell and Platform Layers](#shell-and-platform-layers)                     | Electron abstraction architecture                            |
| [Service Patterns](#service-patterns)                                       | DI, WorkspaceLockHandler, PowerShell assets                  |
| [Configuration and Binary Resolution](#configuration-and-binary-resolution) | ConfigService and BinaryResolutionService                    |
| [Mock Factories Reference](#mock-factories-reference)                       | All mock factories by interface                              |

**Related Documentation:**

- [ARCHITECTURE.md](ARCHITECTURE.md) - System overview, concepts, rules
- [PATTERNS.md](PATTERNS.md) - IPC, UI, CSS implementation patterns
- [AGENTS.md](AGENTS.md) - Agent provider interface, status tracking, MCP

---

## Infrastructure Types

### Intent and DomainEvent

Source: `src/main/intents/infrastructure/types.ts`

```typescript
/**
 * Base intent type. Concrete intents extend this with specific type literal,
 * payload shape, and result type R.
 *
 * The R type parameter is phantom (not used structurally) -- it carries the
 * expected result type for type-safe dispatch via IntentResult.
 */
export interface Intent<R = unknown> {
  readonly type: string;
  readonly payload: unknown;
  /** Phantom type carrier for IntentResult -- never set at runtime. */
  readonly _brand?: R;
}

/**
 * Extract the result type from an intent type.
 * Uses conditional type inference to pull R from Intent<R>.
 */
export type IntentResult<I> = I extends Intent<infer R> ? R : never;

/**
 * Base domain event type. Fired after operations complete.
 * Concrete events extend this with specific type literal and payload shape.
 */
export interface DomainEvent {
  readonly type: string;
  readonly payload: unknown;
}
```

`Intent<R>` is the base type for all intents. The phantom type parameter `R` enables type-safe dispatch -- when you `await dispatch(intent)`, the return type is automatically inferred from the intent's `R`. `IntentResult<I>` is the utility type that extracts `R` from any intent type. `DomainEvent` is the base type for all domain events emitted by operations after completing their work.

### DispatchFn, HookContext, HookHandler, HookResult, and ResolvedHooks

Source: `src/main/intents/infrastructure/operation.ts`

```typescript
/**
 * Dispatch function signature for nested intent dispatch.
 * Available in OperationContext for operations that need to trigger sub-intents.
 */
export type DispatchFn = <I extends Intent>(
  intent: I,
  causation?: readonly string[]
) => Promise<IntentResult<I>>;

/** Sentinel for requires: capability must exist, any value accepted. */
export const ANY_VALUE: unique symbol = Symbol("any-value");

/**
 * Base context passed to hook handlers.
 * Operations build extended contexts (with readonly fields) to pass data
 * between hook points. Each handler receives a frozen shallow copy.
 */
export interface HookContext {
  readonly intent: Intent;
  /** Accumulated capabilities from previously-executed handlers. Defaults to {}. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

/**
 * A handler registered for a hook point.
 *
 * Generic parameter T is the return type for collect() -- defaults to unknown
 * so that HookDeclarations (which uses HookHandler) accepts handlers with any return type.
 */
export interface HookHandler<T = unknown> {
  readonly handler: (ctx: HookContext) => Promise<T>;
  /** Capabilities this handler requires before it can execute.
   *  Key = capability name. Value = required value, or ANY_VALUE for "must exist, any value". */
  readonly requires?: Readonly<Record<string, unknown>>;
  /** Capabilities this handler provides after successful execution.
   *  Called after the handler completes; return value is merged into capabilities. */
  readonly provides?: () => Readonly<Record<string, unknown>>;
}

/**
 * Result of collect() -- typed results from all handlers plus any collected errors.
 * All handlers always run regardless of earlier errors.
 */
export interface HookResult<T = unknown> {
  readonly results: readonly T[];
  readonly errors: readonly Error[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/**
 * Resolved hooks for a specific operation.
 *
 * collect() provides isolated-context execution: each handler receives a frozen
 * clone of the input context. All handlers always run. Returns typed results + errors.
 */
export interface ResolvedHooks {
  collect<T = unknown>(hookPointId: string, ctx: HookContext): Promise<HookResult<T>>;
}
```

`DispatchFn` is the type signature for nested dispatch, available in `OperationContext`. `ANY_VALUE` is a sentinel symbol used in `requires` to mean "this capability must exist, but any value is accepted." `HookContext` is the base context passed to hook handlers -- operations extend it with additional readonly fields. `HookHandler<T>` declares a handler function plus optional capability requirements (`requires`) and provisions (`provides`). `HookResult<T>` collects all handler results, errors, and accumulated capabilities from a single `collect()` call. `ResolvedHooks` is the interface operations use to run hook points.

### OperationContext and Operation

Source: `src/main/intents/infrastructure/operation.ts`

```typescript
/**
 * Context injected into operations by the dispatcher.
 */
export interface OperationContext<I extends Intent = Intent> {
  readonly intent: I;
  readonly dispatch: DispatchFn;
  readonly emit: (event: DomainEvent) => void;
  readonly hooks: ResolvedHooks;
  readonly causation: readonly string[];
}

/**
 * An operation that handles a specific intent type.
 * Operations orchestrate hooks and emit domain events.
 * They never call providers directly -- hook handlers do the actual work.
 */
export interface Operation<I extends Intent = Intent, R = void> {
  readonly id: string;
  execute(ctx: OperationContext<I>): Promise<R>;
}
```

`OperationContext<I>` provides everything an operation needs: the typed intent, a dispatch function for sub-intents, an emit function for domain events, resolved hooks for running hook points, and the causation chain for tracing. `Operation<I, R>` is the interface all operations implement -- `id` identifies the operation for hook registration, and `execute()` contains the orchestration logic.

### HookDeclarations, EventDeclarations, and IntentModule

Source: `src/main/intents/infrastructure/module.ts`

```typescript
/**
 * Hook declarations: operationId -> hookPointId -> HookHandler.
 * Each module contributes handlers to specific hook points on specific operations.
 */
export type HookDeclarations = Readonly<Record<string, Readonly<Record<string, HookHandler>>>>;

/**
 * Event declarations: eventType -> handler function.
 * Each module subscribes to domain events by type.
 */
export type EventDeclarations = Readonly<Record<string, (event: DomainEvent) => void>>;

/**
 * A module that contributes hooks and/or event subscriptions to the intent system.
 * Modules are registered at bootstrap via dispatcher.registerModule().
 */
export interface IntentModule {
  /** Human-readable module name for logging and diagnostics. */
  readonly name: string;
  /** Hook contributions: operationId -> hookPointId -> HookHandler */
  readonly hooks?: HookDeclarations;
  /** Event subscriptions: eventType -> handler */
  readonly events?: EventDeclarations;
  /** Interceptors to add to the dispatcher pipeline */
  readonly interceptors?: readonly IntentInterceptor[];
  /** Optional cleanup when the module is disposed. */
  dispose?(): void;
}
```

`HookDeclarations` maps `operationId -> hookPointId -> HookHandler`, declaring which hook points a module contributes to. `EventDeclarations` maps `eventType -> handler`, declaring which domain events a module subscribes to. `IntentModule` is the primary registration unit -- modules declare their hooks, events, and interceptors declaratively, and the dispatcher wires everything at bootstrap.

### IntentHandle, IntentInterceptor, and IDispatcher

Source: `src/main/intents/infrastructure/dispatcher.ts`

```typescript
/**
 * Deferred-based thenable returned by dispatch().
 *
 * - `await handle` -- waits for the full operation result (thenable via .then())
 * - `await handle.accepted` -- resolves after interceptors: true if accepted, false if cancelled
 *
 * Backwards compatible: existing `await dispatch(intent)` unwraps via .then().
 */
export class IntentHandle<T> implements PromiseLike<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;

  get accepted(): Promise<boolean>;
  signalAccepted(value: boolean): void;
}

/**
 * Pre-operation policy that can modify or cancel an intent.
 * Returning null from before() cancels the intent.
 */
export interface IntentInterceptor {
  readonly id: string;
  readonly order?: number;
  before(intent: Intent): Promise<Intent | null>;
}

/**
 * Dispatcher interface for dispatching intents and subscribing to domain events.
 */
export interface IDispatcher {
  dispatch<I extends Intent>(
    intent: I,
    causation?: readonly string[]
  ): IntentHandle<IntentResult<I>>;
  subscribe(eventType: string, handler: EventHandler): () => void;
  addInterceptor(interceptor: IntentInterceptor): void;
  registerModule(module: IntentModule): void;
}
```

`IntentHandle<T>` is a deferred-based thenable that supports two-phase awaiting: `await handle` waits for the full result, while `await handle.accepted` resolves immediately after interceptors pass/reject the intent. `IntentInterceptor` is a pre-operation policy that can modify or cancel intents -- returning `null` from `before()` cancels the intent. Interceptors are sorted by `order` (lower runs first). `IDispatcher` is the main entry point for the intent system, supporting dispatch, event subscription, interceptor registration, and module registration.

---

## Capability-Based Hook Ordering

Hooks are unordered by default. When execution order matters, handlers declare `requires` and `provides` capabilities. The `collect()` function topologically sorts handlers based on these declarations, running providers before consumers.

Each `HookHandler` has three fields:

| Field      | Type                               | Purpose                                                      |
| ---------- | ---------------------------------- | ------------------------------------------------------------ |
| `handler`  | `(ctx: HookContext) => Promise<T>` | The hook logic                                               |
| `requires` | `Record<string, unknown>`          | Capabilities this handler needs before it can run            |
| `provides` | `() => Record<string, unknown>`    | Capabilities this handler makes available after it completes |

The `ANY_VALUE` sentinel (exported from `operation.ts`) matches any value for a required capability -- it means "this capability must exist, but I do not care about its value."

**Example**: In the `app:start` operation's `start` hook point, the code-server module provides `{ codeServerPort: number }` after starting code-server. The plugin-server module requires `{ codeServerPort: ANY_VALUE }` so it runs after the port is known.

Capabilities accumulate across handlers within a single `collect()` call and are available on `HookResult.capabilities` for the operation to inspect.

---

## Idempotency

Source: `src/main/intents/infrastructure/idempotency-module.ts`

The idempotency module prevents duplicate intent dispatches using a single interceptor that covers multiple rules.

### IdempotencyRule Interface

```typescript
export interface IdempotencyRule {
  /** Intent type this rule applies to. */
  readonly intentType: string;
  /** Extract a tracking key from the intent payload. Omit for singleton (boolean flag).
   *  Return undefined to skip the rule for this payload. */
  readonly getKey?: (payload: unknown) => string | undefined;
  /** Domain event type(s) that reset tracking state.
   *  Uses getKey on event payload for per-key reset. */
  readonly resetOn?: string | readonly string[];
  /** Return true to bypass the idempotency block (intent still gets tracked). */
  readonly isForced?: (intent: Intent) => boolean;
}
```

### Three Modes

| Mode                     | Configuration                     | Behavior                                                             |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------- |
| **Singleton**            | No `getKey`, no `resetOn`         | Blocks after first dispatch. Never resets.                           |
| **Singleton with reset** | No `getKey`, with `resetOn`       | Blocks after first dispatch. Resets when the specified event fires.  |
| **Per-key**              | With `getKey`, optional `resetOn` | Tracks by key extracted from payload. Each key blocks independently. |

### createIdempotencyModule Factory

```typescript
export function createIdempotencyModule(rules: readonly IdempotencyRule[]): IntentModule;
```

Returns a single `IntentModule` with:

- One interceptor (id: `"idempotency"`, order: `0`) covering all rules
- Event handlers for each unique `resetOn` value that clear the tracking state

The interceptor runs before any operation. For each dispatched intent, it looks up the matching rule by intent type:

- **No rule found**: passes through (returns the intent unchanged)
- **Singleton**: blocks if the flag is already set; otherwise sets the flag and passes through
- **Per-key**: extracts a key via `getKey()`; blocks if that key is already tracked; otherwise tracks it and passes through
- **Force bypass**: if `isForced(intent)` returns true, the intent passes through even if already tracked (but the key is still recorded)

### Usage in Composition Root

From `src/main/index.ts`:

```typescript
const idempotencyModule = createIdempotencyModule([
  // Singleton: app:shutdown runs at most once
  { intentType: INTENT_APP_SHUTDOWN },

  // Singleton with reset: setup blocks re-dispatch until setup error resets it
  { intentType: INTENT_SETUP, resetOn: EVENT_SETUP_ERROR },

  // Per-key: workspace:delete keyed by workspacePath, with force bypass
  {
    intentType: INTENT_DELETE_WORKSPACE,
    getKey: (p) => {
      const { workspacePath } = p as DeleteWorkspacePayload;
      return workspacePath;
    },
    resetOn: [EVENT_WORKSPACE_DELETED, EVENT_WORKSPACE_DELETE_FAILED],
    isForced: (intent) => (intent as DeleteWorkspaceIntent).payload.force,
  },

  // Per-key: project:open keyed by path or git URL
  {
    intentType: INTENT_OPEN_PROJECT,
    getKey: (p) => {
      const payload = p as OpenProjectPayload;
      if (payload.path) return payload.path.toString();
      if (payload.git) return expandGitUrl(payload.git);
      return undefined; // select-folder case: no dedup
    },
    resetOn: [EVENT_PROJECT_OPENED, EVENT_PROJECT_OPEN_FAILED],
  },
]);
```

---

## IPC-to-Intent Mapping

IPC channels map directly to intents through `IpcEventBridge`. There are no separate API interfaces -- each IPC handler creates a typed intent and dispatches it:

| IPC Channel            | Intent Type        | Operation                |
| ---------------------- | ------------------ | ------------------------ |
| `api:project:open`     | `project:open`     | OpenProjectOperation     |
| `api:project:close`    | `project:close`    | CloseProjectOperation    |
| `api:workspace:create` | `workspace:open`   | OpenWorkspaceOperation   |
| `api:workspace:remove` | `workspace:delete` | DeleteWorkspaceOperation |
| `api:workspace:switch` | `workspace:switch` | SwitchWorkspaceOperation |
| `api:ui:set-mode`      | `ui:setMode`       | SetModeOperation         |
| `api:lifecycle:quit`   | `app:shutdown`     | AppShutdownOperation     |

Non-IPC consumers (MCP Server, Plugin API) dispatch intents directly through the Dispatcher.

---

## Operations Reference

All operations use the intent dispatcher (`Dispatcher` + `HookRegistry`). Intents are dispatched through operations that run hook points, with hook modules contributing behavior. This pattern decouples orchestration from implementation.

| Operation              | Intent Type              | Hook Points                                                                                            | Domain Event        |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------- |
| `set-metadata`         | `workspace:setMetadata`  | `set`                                                                                                  | --                  |
| `get-metadata`         | `workspace:getMetadata`  | `get`                                                                                                  | --                  |
| `get-workspace-status` | `workspace:getStatus`    | `get`                                                                                                  | --                  |
| `get-agent-session`    | `workspace:getSession`   | `get`                                                                                                  | --                  |
| `restart-agent`        | `workspace:restartAgent` | `restart`                                                                                              | --                  |
| `set-mode`             | `ui:setMode`             | `set`                                                                                                  | --                  |
| `get-active-workspace` | `ui:getActiveWorkspace`  | `get`                                                                                                  | --                  |
| `create-workspace`     | `workspace:create`       | `create`, `setup`, `finalize`                                                                          | `workspace:created` |
| `delete-workspace`     | `workspace:delete`       | `shutdown`, `release`, `delete`                                                                        | `workspace:deleted` |
| `open-project`         | `project:open`           | `open`                                                                                                 | `project:opened`    |
| `close-project`        | `project:close`          | `close`                                                                                                | `project:closed`    |
| `app-start`            | `app:start`              | `register-config`, `before-ready`, `await-ready`, `init`, `show-ui`, `check-deps`, `start`, `activate` | --                  |
| `app-shutdown`         | `app:shutdown`           | `stop`                                                                                                 | --                  |
| `app-setup`            | `app:setup`              | `setup`                                                                                                | --                  |
| `app-resume`           | `app:resume`             | `resume`                                                                                               | --                  |

IPC handlers in `IpcEventBridge` create typed intents and dispatch them. Domain events (e.g., `workspace:created`) are subscribed to by event handlers in modules (IpcEventBridge, BadgeModule, WindowTitleModule) which forward them to the renderer via `sendToUI()` or react internally.

The `create-workspace` operation uses these hook modules:

- **create**: WorktreeModule (creates git worktree, or populates context from `existingWorkspace` data when activating discovered workspaces)
- **setup**: KeepFilesModule (copies .keepfiles), AgentModule (starts agent server) -- both best-effort with internal try/catch
- **finalize**: CodeServerModule (creates .code-workspace file)

The `delete-workspace` operation uses these hook modules:

- **shutdown**: ViewModule (switch active workspace + destroy view), AgentModule (kill terminals, stop server, clear MCP/TUI tracking)
- **release**: WindowsLockModule (detect + kill/close blocking processes) -- Windows-only, skipped in force mode. Skipped when `removeWorktree` is false.
- **delete**: WorktreeModule (remove git worktree), CodeServerModule (delete .code-workspace file). Skipped when `removeWorktree` is false.

The delete operation uses an `IdempotencyInterceptor` to prevent duplicate deletions of the same workspace. Force mode (`force: true`) bypasses the interceptor and wraps hook errors in try/catch. The `workspace:deleted` domain event triggers StateModule (removes workspace from state), IpcEventBridge (emits `workspace:removed` IPC event), and clears the idempotency flag. When `removeWorktree` is false, only the shutdown hooks run (runtime teardown without deleting the git worktree).

The `open-project` operation uses these hook modules:

- **open**: ProjectResolverModule (clone if URL, validate git, create provider), ProjectDiscoveryModule (discover workspaces, orphan cleanup), ProjectRegistryModule (generate ID, load config, register state, persist)

After the open hook, the operation dispatches `workspace:create` per discovered workspace (best-effort, continues on failure), sets the first workspace as active, and emits `project:opened`. A `ProjectOpenIdempotencyInterceptor` prevents concurrent/duplicate opens of the same project path.

The `close-project` operation uses these hook modules:

- **close**: ProjectCloseManagerModule (dispose provider, delete cloned dir if removeLocalRepo), ProjectCloseRegistryModule (remove from state + store)

Before the close hook, the operation resolves projectId to path, gets the workspace list, then dispatches `workspace:delete { removeWorktree: false, skipSwitch: true }` per workspace for runtime-only teardown. After all workspaces are torn down, it sets active workspace to null if no other projects are open, runs the close hook, then emits `project:closed`.

The `app-start` operation runs eight hook points in sequence:

- **register-config**: All modules return their config key definitions
- **before-ready**: Env config + script declarations (no I/O, pre-Electron ready)
- **await-ready**: Wait for Electron `app.whenReady()`
- **init**: Post-ready initialization (config file, logging, shell, scripts)
- **show-ui**: Show starting screen, capture waitForRetry callback
- **check-deps**: Binary + extension checks (collect, isolated contexts). Dispatches `app:setup` if needed.
- **start**: CodeServerLifecycleModule (start PluginServer with graceful degradation, ensure dirs, start code-server, update ports), AgentLifecycleModule (wire status changes to dispatcher), McpLifecycleModule (start MCP server, wire callbacks, configure agent server manager), TelemetryLifecycleModule (capture app_launched), AutoUpdaterLifecycleModule (start auto-updater, wire title updates), IpcBridgeLifecycleModule (wire API events to IPC, wire Plugin API)
- **activate**: DataLifecycleModule (load persisted projects), ViewLifecycleModule (wire loading-state IPC, set first workspace active + title)

The multi-phase design ensures config is loaded before Electron ready, servers are running before data is loaded (activate hook modules can read ports from the shared hook context). Errors in early hooks abort startup; errors in the activate hook propagate to the renderer error screen.

The `app-shutdown` operation uses a single hook point:

- **stop**: All lifecycle modules dispose their resources independently, each wrapping its own logic in try/catch (best-effort). A shutdown idempotency interceptor (boolean flag) ensures only one execution proceeds across `window-all-closed` and `before-quit` entry points.

---

## Domain Events

Operations emit domain events via `ctx.emit()`. The dispatcher delivers these to all module event subscribers. `IpcEventBridge` forwards relevant events to the renderer via `sendToUI()`:

```
Operation
    |
    +-- ctx.emit({ type: "workspace:switched", payload })
    |
    v
Dispatcher delivers to subscribers
    |
    +-- IpcEventBridge  ->  sendToUI("api:workspace:switched", payload)  ->  Renderer
    +-- BadgeModule     ->  updates dock badge
    +-- WindowTitleModule -> updates window title
```

### Workspace Switching Example

The `workspace:switched` event is emitted through the intent dispatcher via `SwitchWorkspaceOperation`:

- `SwitchWorkspaceOperation` runs the `activate` hook (resolves workspace, calls `ViewManager.setActiveWorkspace`) then emits `workspace:switched` via `ctx.emit()`
- Other operations dispatch `workspace:switch` intents for active-workspace changes (e.g., `OpenWorkspaceOperation` dispatches after creating a workspace)
- Null deactivation (delete last workspace, close last project) emits `workspace:switched(null)` directly via `ctx.emit()` without going through the intent
- `IpcEventBridge` subscribes to `workspace:switched` and forwards to the renderer via `deps.sendToUI()`
- `WindowTitleModule` subscribes to `workspace:switched` and updates the window title

### Domain Events Table

| Event                        | Payload                                                    | Description                                 |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `project:opened`             | `{ project: Project }`                                     | Project was opened                          |
| `project:closed`             | `{ projectId: ProjectId }`                                 | Project was closed                          |
| `project:bases-updated`      | `{ projectId, bases }`                                     | Branch list refreshed                       |
| `workspace:created`          | `{ projectId, workspace }`                                 | Workspace was created                       |
| `workspace:removed`          | `WorkspaceRef`                                             | Workspace was removed                       |
| `workspace:switched`         | `WorkspaceRef \| null`                                     | Active workspace changed                    |
| `workspace:status-changed`   | `WorkspaceRef & { status }`                                | Dirty/agent status changed                  |
| `workspace:metadata-changed` | `{ projectId, workspaceName, key, value: string \| null }` | Metadata key set or deleted                 |
| `ui:mode-changed`            | `{ mode, previousMode }`                                   | UI mode changed (shortcut/dialog/workspace) |
| `shortcut:key`               | `ShortcutKey`                                              | Shortcut action key pressed                 |
| `setup:progress`             | `{ step, message }`                                        | Setup progress update                       |

---

## Composition Root

The main process uses a composition-root pattern in `src/main/index.ts`. All services are constructed (pure, no I/O), all operations and modules are registered, then `app:start` is dispatched to orchestrate the startup flow:

```
index.ts (composition root)
    |
    +-- Construct all services (no I/O)
    +-- Create Dispatcher + HookRegistry
    +-- Register all operations (25+)
    +-- Create IpcEventBridge (registers IPC handlers)
    +-- Register all modules (30+)
    +-- Dispatch app:start intent
              |
              v
        AppStartOperation
              |
              +-- "register-config" (collect config definitions from all modules)
              +-- "before-ready" (env config, script declarations)
              +-- "await-ready" (Electron app.whenReady())
              +-- "init" (config file, logging, shell, scripts)
              +-- "show-ui" (starting screen)
              +-- "check-deps" (binary/extension checks -> app:setup if needed)
              |
              +-- "start" hook point (servers, wiring)
              |     CodeServerModule, PluginServerModule, AgentModules,
              |     TelemetryModule, AutoUpdaterModule, McpModule, etc.
              |
              +-- "activate" hook point (load data, set active workspace)
              |     DataModule (load persisted projects),
              |     ViewModule (wire loading-state IPC, set first workspace active)
              |
              +-- Renderer notified -> ready
```

---

## External System Access Rules

**CRITICAL**: All external system access MUST go through abstraction interfaces. Direct library/module usage is forbidden in service code.

| External System    | Interface              | Implementation                | Forbidden Direct Access     |
| ------------------ | ---------------------- | ----------------------------- | --------------------------- |
| Filesystem         | `FileSystemLayer`      | `DefaultFileSystemLayer`      | `node:fs/promises` directly |
| HTTP requests      | `HttpClient`           | `DefaultNetworkLayer`         | `fetch()` directly          |
| Port operations    | `PortManager`          | `DefaultNetworkLayer`         | `net` module directly       |
| Process spawning   | `ProcessRunner`        | `ExecaProcessRunner`          | `execa` directly            |
| Build info         | `BuildInfo`            | `ElectronBuildInfo`           | `app.isPackaged` directly   |
| Platform info      | `PlatformInfo`         | `NodePlatformInfo`            | `process.platform` directly |
| Path resolution    | `PathProvider`         | `DefaultPathProvider`         | Hardcoded paths             |
| Path normalization | `Path` (class)         | Self-normalizing object       | Manual string manipulation  |
| Blocking processes | `WorkspaceLockHandler` | `WindowsWorkspaceLockHandler` | Direct PowerShell calls     |

**Why this matters:**

1. **Testability**: Unit tests inject mocks; no real I/O in unit tests
2. **Boundary testing**: Real implementations tested in `*.boundary.test.ts`
3. **Consistency**: Unified error handling (e.g., `FileSystemError`, `ServiceError`)
4. **Maintainability**: Single point of change for external dependencies

**Exception - Pure Libraries:**

The `ignore` package (used by KeepFilesService) is acceptable for direct usage because it's a pure pattern-matching library with no I/O or side effects. It only performs string operations on patterns and paths.

**Implementation pattern:**

```typescript
// CORRECT: Inject interface via constructor
class MyService {
  constructor(
    private readonly fs: FileSystemLayer,
    private readonly http: HttpClient
  ) {}

  async doWork() {
    const data = await this.fs.readFile("/path");
    const response = await this.http.fetch("http://api/endpoint");
  }
}

// WRONG: Direct imports
import * as fs from "node:fs/promises";
class MyService {
  async doWork() {
    const data = await fs.readFile("/path", "utf-8"); // Not testable
  }
}
```

---

## Platform Abstractions

### FileSystemLayer

`FileSystemLayer` provides a testable abstraction over `node:fs/promises`. Services that need filesystem access receive `FileSystemLayer` via constructor injection.

```typescript
interface FileSystemLayer {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<readonly DirEntry[]>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  copyTree(src: string, dest: string): Promise<CopyTreeResult>;
}

interface CopyTreeResult {
  copiedCount: number; // Number of files copied
  skippedSymlinks: readonly string[]; // Paths of symlinks skipped (security)
}
```

**copyTree Behavior:**

- Copies files and directories recursively from `src` to `dest`
- Uses `fs.copyFile()` internally for correct binary file handling
- Skips symlinks (security measure - prevents symlink attacks)
- Overwrites existing destination files
- Creates parent directories as needed
- Throws `FileSystemError` with `ENOENT` if source doesn't exist

**Error Handling:**

All methods throw `FileSystemError` (extends `ServiceError`) with mapped error codes:

| Code        | Description                         |
| ----------- | ----------------------------------- |
| `ENOENT`    | File/directory not found            |
| `EACCES`    | Permission denied                   |
| `EEXIST`    | File/directory already exists       |
| `ENOTDIR`   | Not a directory                     |
| `EISDIR`    | Is a directory (when file expected) |
| `ENOTEMPTY` | Directory not empty                 |
| `UNKNOWN`   | Other errors (check `originalCode`) |

**Testing with Behavioral Mocks:**

```typescript
import { createFileSystemMock, file, directory, symlink } from "../platform/filesystem.state-mock";

// Create mock with initial filesystem state
const mock = createFileSystemMock({
  entries: {
    "/projects": directory(),
    "/projects/config.json": file('{"key": "value"}'),
    "/projects/bin/run.sh": file("#!/bin/bash", { executable: true }),
    "/projects/current": symlink("/projects/v1"),
  },
});

// Simulate error on specific entry
const mockWithError = createFileSystemMock({
  entries: {
    "/protected.txt": file("secret", { error: "EACCES" }),
  },
});

// Inject into service
const service = new ProjectStore(projectsDir, mock);

// Assert filesystem state after operations
await service.saveConfig({ debug: true });
expect(mock).toHaveFile("/projects/config.json");
expect(mock).toHaveFileContaining("/projects/config.json", "debug");

// Access state directly via $ property
expect(mock.$.entries.size).toBe(4);

// Use snapshot for unchanged assertions
const snapshot = mock.$.snapshot();
await expect(mock.readFile("/missing")).rejects.toThrow();
expect(mock).toBeUnchanged(snapshot);
```

**Boundary test file:** `filesystem.boundary.test.ts`

### NetworkLayer

NetworkLayer provides unified interfaces for all localhost network operations, designed following the Interface Segregation Principle. Consumers depend only on the specific interface(s) they need.

```
+-----------------------------------------------------------------------+
|                         Focused Interfaces                               |
|  +-------------------+ +-------------------+ +-----------------------+  |
|  |    HttpClient     | |     SseClient     | |     PortManager       |  |
|  |  fetch(url, opts) | | createSseConn()   | |  findFreePort()       |  |
|  |                   | |                   | |  getListeningPorts()  |  |
|  +-------------------+ +-------------------+ +-----------------------+  |
+-----------------------------------------------------------------------+
                                |
                                v
+-----------------------------------------------------------------------+
|                       DefaultNetworkLayer                                |
|                  implements HttpClient, PortManager                      |
|                                                                          |
|  Single class that implements both interfaces for convenience.           |
|  Consumers inject only the interface(s) they need.                       |
+-----------------------------------------------------------------------+
```

**Interface Responsibilities:**

| Interface     | Methods               | Purpose                       | Used By                                                    |
| ------------- | --------------------- | ----------------------------- | ---------------------------------------------------------- |
| `HttpClient`  | `fetch(url, options)` | HTTP GET with timeout support | CodeServerManager, OpenCodeServerManager                   |
| `PortManager` | `findFreePort()`      | Find available ports          | CodeServerManager, OpenCodeServerManager, McpServerManager |

**Dependency Injection:**

```typescript
// DefaultNetworkLayer implements both interfaces
const networkLayer = new DefaultNetworkLayer();

// Inject only the interface(s) each consumer needs
const serverManager = new OpenCodeServerManager(
  runner,
  networkLayer,
  fsLayer,
  networkLayer,
  pathProvider,
  logger
);
const codeServerManager = new CodeServerManager(config, runner, networkLayer, networkLayer);
```

**Testing with Mock Utilities:**

```typescript
import { createMockHttpClient } from "../platform/network.test-utils";
import { createPortManagerMock } from "../platform/port-manager.state-mock";

const mockHttpClient = createMockHttpClient({
  response: new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
});

const portManager = createPortManagerMock([9999]);

const service = new SomeService(mockHttpClient, portManager);
```

**waitForPort() Utility:**

For boundary tests that need to wait for a server to start:

```typescript
import { waitForPort, CI_TIMEOUT_MS } from "../platform/network.test-utils";

// Start a server process
const proc = await startServer();

// Wait for it to be ready (uses longer timeout in CI)
const timeout = process.env.CI ? CI_TIMEOUT_MS : 5000;
await waitForPort(8080, timeout);

// Now safe to connect
```

**Boundary test file:** `network.boundary.test.ts`

### ProcessRunner

`ProcessRunner` provides a unified interface for spawning processes:

```typescript
// ProcessRunner returns a SpawnedProcess handle synchronously
const proc = runner.run("code-server", ["--port", "8080"], { cwd: "/app", env: cleanEnv });
console.log(`PID: ${proc.pid}`);

// Wait for completion (never throws for exit status)
const result = await proc.wait();
if (result.exitCode !== 0) {
  console.error(result.stderr);
}
```

**SpawnedProcess Handle:**

| Property/Method  | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `pid`            | Process ID (undefined if spawn failed)                           |
| `kill(signal?)`  | Send signal (default: SIGTERM). Returns true if sent.            |
| `wait(timeout?)` | Wait for exit. Returns `ProcessResult` with exitCode/signal/etc. |

**Graceful Shutdown with Timeout Escalation:**

```typescript
// Send SIGTERM and wait up to 5s
proc.kill("SIGTERM");
const result = await proc.wait(5000);

// If still running after timeout, escalate to SIGKILL
if (result.running) {
  proc.kill("SIGKILL");
  await proc.wait();
}
```

**ProcessResult Fields:**

| Field      | Type             | Description                                         |
| ---------- | ---------------- | --------------------------------------------------- |
| `exitCode` | `number \| null` | Exit code (null if killed/timeout/spawn error)      |
| `signal`   | `string?`        | Signal name if killed (e.g., "SIGTERM")             |
| `running`  | `boolean?`       | True if still running after wait(timeout)           |
| `stdout`   | `string`         | Captured stdout                                     |
| `stderr`   | `string`         | Captured stderr (includes spawn errors like ENOENT) |

**Platform-specific kill behavior:**

- **Windows**: Always uses `taskkill /t /f` (immediate forceful termination) because WM_CLOSE cannot signal console processes and CTRL_C_EVENT cannot be sent to detached processes
- **Unix**: Uses two-phase SIGTERM -> SIGKILL with configurable timeouts

**Kill Timeouts:**

```typescript
// Default timeouts (1 second each)
import { PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS } from "./process";

// Use with the new kill() API
const result = await proc.kill(
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS, // 1000ms for SIGTERM
  PROCESS_KILL_FORCE_TIMEOUT_MS // 1000ms for SIGKILL
);

if (!result.success) {
  console.error("Process did not terminate");
}
```

**Testing with Mocks:**

```typescript
import { createMockProcessRunner } from "../platform/process.state-mock";

// Create mock with controllable behavior and state tracking
const runner = createMockProcessRunner();

// Inject into service
const service = new SomeService(runner);
```

**Boundary test file:** `process.boundary.test.ts`

### Path Class

The `Path` class normalizes filesystem paths to a canonical internal format:

- **POSIX separators**: Always forward slashes (`/`)
- **Absolute only**: Throws on relative paths
- **Case normalization**: Lowercase on Windows
- **Clean format**: No trailing slashes, resolved `..` segments

```typescript
import { Path } from "../services/platform/path";

const p = new Path("C:\\Users\\Name");
p.toString(); // "c:/users/name" (Windows)
p.toNative(); // "c:\users\name" (for OS APIs)
p.equals("C:/users/name"); // true (case-insensitive on Windows)
```

**When to Use Each Method:**

| Method        | Use Case                                         |
| ------------- | ------------------------------------------------ |
| `toString()`  | Map keys, comparisons, JSON serialization        |
| `toNative()`  | (Internal use by FileSystemLayer, ProcessRunner) |
| `equals()`    | Path comparison (handles different formats)      |
| `isChildOf()` | Containment checks (not `startsWith()`)          |

**IPC Boundary Handling:**

```
Renderer (strings) --IPC--> Main Process IPC Handlers --> Services (Path objects)
                              |
                              +- INCOMING: new Path(payload.path)
                              +- OUTGOING: path.toString() (automatic via toJSON)
```

- **Shared types in `src/shared/`**: Use `string` for paths (IPC compatibility)
- **Internal services**: Use `Path` objects for all path handling
- **Renderer**: Receives pre-normalized strings; safe to compare with `===`

**Common Patterns:**

```typescript
// Creating Path from external input
const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
const projectPath = new Path(result.filePaths[0]);

// Using paths in Maps
const views = new Map<string, WebContentsView>();
views.set(path.toString(), view);
views.get(path.toString());

// Path comparison
if (workspacePath.equals(projectRoot)) { ... }

// Containment checks
if (workspacePath.isChildOf(projectRoot)) { ... }
```

**Testing with Paths:**

```typescript
// Verify a path was stored correctly
const stored = service.getPath();
expect(stored.toString()).toBe("/normalized/path");

// Compare path equality
expect(path1.equals(path2)).toBe(true);

// Mock PathProvider returns Path objects
const mockPathProvider = createMockPathProvider({
  vscodeDir: new Path("/test/vscode"),
  projectsDir: new Path("/test/projects"),
});
```

### BuildInfo and PathProvider

The application uses dependency injection to abstract build mode detection and path resolution.

**Interfaces (defined in `src/services/platform/`):**

| Interface         | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `BuildInfo`       | Build mode detection (`isDevelopment`)     |
| `PlatformInfo`    | Platform detection (`platform`, `homeDir`) |
| `PathProvider`    | Application path resolution                |
| `FileSystemLayer` | Filesystem operations (read, write, mkdir) |

**Implementations:**

| Class                    | Location        | Description                                  |
| ------------------------ | --------------- | -------------------------------------------- |
| `ElectronBuildInfo`      | `src/main/`     | Uses `app.isPackaged`                        |
| `NodePlatformInfo`       | `src/main/`     | Uses `process.platform`, `os.homedir()`      |
| `DefaultPathProvider`    | `src/services/` | Computes paths from BuildInfo + PlatformInfo |
| `DefaultFileSystemLayer` | `src/services/` | Wraps `node:fs/promises` with error mapping  |

**Instantiation Order (in `src/main/index.ts`):**

1. Module level (before `app.whenReady()`):
   - Create `ElectronBuildInfo`, `NodePlatformInfo`, `DefaultPathProvider`, `DefaultFileSystemLayer`
   - Call `redirectElectronDataPaths(pathProvider)` - requires paths early
2. In `bootstrap()`:
   - Pass `pathProvider` and `fileSystemLayer` to services via constructor DI
3. In `startServices()` (construction phase):
   - Construct all remaining services (CodeServerManager, agent services, etc.)
   - No I/O -- constructors/factories only
4. In `startServices()` (dispatch phase):
   - Wire intent dispatcher, get API, then dispatch `app:start`
   - Lifecycle modules handle all I/O (starting servers, loading data, wiring callbacks)

**Testing with PathProvider:**

```typescript
const mockPathProvider = createMockPathProvider({
  vscodeDir: "/test/vscode",
});
const service = new VscodeSetupService(mockRunner, mockPathProvider, mockFs);
```

---

## Shell and Platform Layers

Electron APIs are abstracted behind testable interfaces in two domains:

| Domain   | Location             | Purpose                       | Examples                                   |
| -------- | -------------------- | ----------------------------- | ------------------------------------------ |
| Platform | `services/platform/` | OS/runtime abstractions       | `IpcLayer`, `DialogLayer`, `ImageLayer`    |
| Shell    | `services/shell/`    | Visual container abstractions | `WindowLayer`, `ViewLayer`, `SessionLayer` |

**Dependency Rule**: Shell layers may depend on Platform layers, but not vice versa.

**Architecture:**

```
+-----------------------------------------------------------------------------+
|                             Main Process Components                         |
|  +-----------------+  +-----------------+  +-----------------------------+  |
|  | WindowManager   |  |  ViewManager    |  |    BadgeManager             |  |
|  | ShortcutCtrl    |  |                 |  |                             |  |
|  +--------+--------+  +--------+--------+  +-------------+---------------+  |
|           |                    |                         |                  |
+-----------|--------------------|--------------------------|-----------------+
            |                    |                         |
+-----------v--------------------v--------------------------v-----------------+
|                          Abstraction Layers                                 |
|  +---------------------------------+  +-----------------------------------+ |
|  |          Shell Layers           |  |         Platform Layers           | |
|  |         (services/shell/)       |  |       (services/platform/)        | |
|  |  WindowLayer ---> ImageLayer ---+--+-> ImageLayer                      | |
|  |       |                         |  |   IpcLayer                        | |
|  |       v                         |  |   DialogLayer                     | |
|  |  ViewLayer ---> SessionLayer    |  |   AppLayer                        | |
|  |                                 |  |   MenuLayer                       | |
|  +---------------------------------+  +-----------------------------------+ |
+-----------------------------------------------------------------------------+
            |                    |                         |
+-----------v--------------------v--------------------------v-----------------+
|                            Electron APIs                                    |
|  BaseWindow    WebContentsView    session    ipcMain    dialog    app       |
|  nativeImage   Menu                                                         |
+-----------------------------------------------------------------------------+
```

**Layer Dependency Rules:**

| Rule                 | Description                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| Shell -> Platform    | Shell layers may depend on Platform layers (e.g., WindowLayer uses ImageLayer for overlay icons) |
| Platform -> Platform | Platform layers are independent (no dependencies on each other)                                  |
| Shell -> Shell       | Shell layers may depend on each other (e.g., ViewLayer uses SessionLayer)                        |
| Platform -/> Shell   | Platform layers may NOT depend on Shell layers                                                   |

**Handle-Based Design:**

Layers return opaque handles instead of raw Electron objects:

| Layer          | Returns         | Instead of        |
| -------------- | --------------- | ----------------- |
| `WindowLayer`  | `WindowHandle`  | `BaseWindow`      |
| `ViewLayer`    | `ViewHandle`    | `WebContentsView` |
| `SessionLayer` | `SessionHandle` | `Session`         |
| `ImageLayer`   | `ImageHandle`   | `NativeImage`     |

This pattern:

- Prevents Electron types from leaking into manager code
- Enables behavioral mocks that just return `{ id: "test-1", __brand: "ViewHandle" }`
- Centralizes all Electron access in layer implementations

**Example:**

```typescript
// Interface returns handles, not Electron objects
interface ViewLayer {
  createView(options: ViewOptions): ViewHandle; // Returns handle
  loadURL(handle: ViewHandle, url: string): Promise<void>;
  destroy(handle: ViewHandle): void;
}

// Branded type prevents accidental mixing
interface ViewHandle {
  readonly id: string;
  readonly __brand: "ViewHandle";
}
```

**Behavioral Mocks for Layers:**

```typescript
import { createViewLayerMock } from "../shell/view.state-mock";

// Create mock with state access via $ property
const mock = createViewLayerMock();

// All ViewLayer methods work with in-memory state
const handle = mock.createView({ backgroundColor: "#1e1e1e" });
await mock.loadURL(handle, "http://127.0.0.1:8080");

// State access via $ property
const snapshot = mock.$.snapshot();

// Trigger simulated events
mock.$.triggerDidFinishLoad(handle);
mock.$.triggerWillNavigate(handle, "http://example.com");

// Custom matchers for assertions
expect(mock).toHaveView(handle.id);
expect(mock).toHaveView(handle.id, {
  url: "http://127.0.0.1:8080",
  attachedTo: null,
  backgroundColor: "#1e1e1e",
});
```

**Error Handling:**

Each domain has its own error class with typed codes:

```typescript
// Platform errors
throw new PlatformError("IPC_HANDLER_EXISTS", `Handler already exists for channel: ${channel}`);

// Shell errors include handle context
throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
```

**Error codes:**

| Domain   | Error Codes                                                                 |
| -------- | --------------------------------------------------------------------------- |
| Platform | `IPC_HANDLER_EXISTS`, `IPC_HANDLER_NOT_FOUND`, `DIALOG_CANCELLED`, etc.     |
| Shell    | `WINDOW_NOT_FOUND`, `VIEW_NOT_FOUND`, `VIEW_DESTROYED`, `SESSION_NOT_FOUND` |

**Boundary Tests:**

Each layer has boundary tests that verify behavior against real Electron APIs:

| Layer          | Boundary Test              |
| -------------- | -------------------------- |
| `IpcLayer`     | `ipc.boundary.test.ts`     |
| `DialogLayer`  | `dialog.boundary.test.ts`  |
| `ImageLayer`   | `image.boundary.test.ts`   |
| `AppLayer`     | `app.boundary.test.ts`     |
| `MenuLayer`    | `menu.boundary.test.ts`    |
| `WindowLayer`  | `window.boundary.test.ts`  |
| `ViewLayer`    | `view.boundary.test.ts`    |
| `SessionLayer` | `session.boundary.test.ts` |

---

## Service Patterns

### Dependency Injection

Services use constructor DI for testability (NOT singletons):

```typescript
// Service with injected dependencies
class DiscoveryService {
  constructor(
    private readonly portManager: PortManager,
    private readonly instanceProbe: InstanceProbe
  ) {}
}

// Services owned and wired in main process
// Example from bootstrap() and startServices():
const networkLayer = new DefaultNetworkLayer();
const processRunner = new ExecaProcessRunner();
const binaryDownloadService = new DefaultBinaryDownloadService(...);
vscodeSetupService = new VscodeSetupService(processRunner, pathProvider, fsLayer, platformInfo, binaryDownloadService);
codeServerManager = new CodeServerManager(config, processRunner, networkLayer, networkLayer);
```

### WorkspaceLockHandler

`WorkspaceLockHandler` detects and manages processes that block file operations (Windows-only). It uses a three-operation model:

| Method                | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `detect(path)`        | Detect processes with handles on files under path (full scan)     |
| `detectCwd(path)`     | Detect processes with CWD under path (lightweight, no RM/handles) |
| `killProcesses(pids)` | Kill processes by PID array via taskkill                          |
| `closeHandles(path)`  | Close file handles in path (requires UAC elevation on Win 10)     |

```typescript
// Factory creates platform-specific implementation
const workspaceLockHandler = createWorkspaceLockHandler(
  processRunner,
  platformInfo,
  pathProvider,
  logger
);

// Windows: Uses Restart Manager API via PowerShell script
// Other platforms: Returns undefined (detection steps skipped)
```

**Three-Operation Workflow:**

```
detect(path)           ->  Returns BlockingProcess[] (full: RM + CWD + handles)
detectCwd(path)        ->  Returns BlockingProcess[] (lightweight: CWD only)
    |
    +- killProcesses(pids) ->  Terminates processes by PID array
    |
    +- closeHandles(path)  ->  Closes file handles (may require elevation)
```

**Usage in Deletion Flow:**

```typescript
// In CoreModule.executeDeletion()
if (unblock === "kill") {
  await workspaceLockHandler.killProcesses();
} else if (unblock === "close") {
  await workspaceLockHandler.closeHandles();
}

// Proactive detection runs after cleanup, before workspace removal
const detected = await workspaceLockHandler.detect(workspacePath);
if (detected.length > 0) {
  emitProgress({ step: "detecting-blockers", blockingProcesses: detected, hasErrors: true });
}
```

**BlockingProcess Type:**

```typescript
interface BlockingProcess {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly files: readonly string[]; // Locked files (relative to detected path)
  readonly cwd: string | null; // Process working directory
}
```

**Testing with Mocks:**

```typescript
import { createMockWorkspaceLockHandler } from "../platform/workspace-lock-handler.test-utils";

// Return specific blocking processes
const mockHandler = createMockWorkspaceLockHandler({
  initialProcesses: [
    {
      pid: 1234,
      name: "node.exe",
      commandLine: "node server.js",
      files: ["index.js"],
      cwd: "/app",
    },
  ],
});

// Inject into CoreModule
const module = new CoreModule(api, { ...deps, workspaceLockHandler: mockHandler });
```

**Boundary test file:** `workspace-lock-handler.boundary.test.ts`

### PowerShell Script Assets

For Windows-specific functionality requiring .NET/COM APIs, use PowerShell scripts bundled as assets:

**Asset Location:**

```
resources/scripts/          -> Source scripts
out/main/assets/scripts/    -> Bundled (via vite-plugin-static-copy)
```

**Script Structure (parameter-based modes):**

```powershell
# blocking-processes.ps1
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("Detect", "CloseHandles")]
    [string]$Action,

    [Parameter(Mandatory=$true)]
    [string]$Path
)

# Output JSON to stdout for parsing
$result = @{ processes = @(); ... }
$result | ConvertTo-Json -Depth 10
```

**Service Integration:**

```typescript
// Get script path from PathProvider
const scriptPath = this.pathProvider.scriptsDir.join("blocking-processes.ps1");

// Run with ProcessRunner
const proc = this.runner.run("powershell", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  scriptPath.toNative(),
  "-Action",
  "Detect",
  "-Path",
  targetPath.toNative(),
]);

const result = await proc.wait();
const data = JSON.parse(result.stdout);
```

**Self-Elevation Pattern:**

For operations requiring admin privileges, scripts can self-elevate:

```powershell
# Check if elevated
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    # Re-launch elevated, capture output via temp file
    $tempFile = [System.IO.Path]::GetTempFileName()
    Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-Action", $Action, "-Path", $Path,
        "-OutputFile", $tempFile
    )
    Get-Content $tempFile
    Remove-Item $tempFile
    exit
}
```

**JSON Output Schema:**

Scripts should return structured JSON for parsing:

```json
{
  "processes": [
    {
      "pid": 1234,
      "name": "node.exe",
      "commandLine": "node server.js",
      "files": ["index.js", "lib/util.js"],
      "cwd": "C:\\projects\\app"
    }
  ],
  "error": null
}
```

---

## Configuration and Binary Resolution

### ConfigService

`ConfigService` manages user preferences and version configuration stored in `config.json`:

```typescript
// Load config (creates defaults if missing)
const config = await configService.load();
// Returns: { agent: "claude" | "opencode" | null, versions: { ... } }

// Update agent selection
await configService.update({ agent: "claude" });

// Config is validated on load - invalid JSON returns defaults with warning
```

**Key behaviors:**

- `load()` creates file with defaults if missing
- `update()` merges changes with existing config
- Invalid JSON is handled gracefully (returns defaults, logs warning)
- Uses `FileSystemLayer` for I/O (per External System Access Rules)

**Config file location:** `{dataRootDir}/config.json`

**Testing with FileSystemMock:**

```typescript
const mock = createFileSystemMock({
  entries: {
    "/data/config.json": file('{"agent": "claude"}'),
  },
});
const service = new ConfigService(new Path("/data/config.json"), mock, logger);
const config = await service.load();
expect(config.agent).toBe("claude");
```

### BinaryResolutionService

`BinaryResolutionService` determines binary availability using a priority-based resolution:

```typescript
// Resolution priority for agents (versions.{agent} = null):
// 1. System binary (via which/where)
// 2. Downloaded binary (any version in bundles dir)
// 3. Mark for download

const result = await resolutionService.resolve("claude");
// Returns: { available: true, path: "/usr/local/bin/claude", source: "system" }
//     or: { available: true, path: "/bundles/claude/1.0.58/claude", source: "downloaded", version: "1.0.58" }
//     or: { available: false, needsDownload: true }
```

**Resolution logic by version config:**

| `versions.{binary}` | Resolution Order                               |
| ------------------- | ---------------------------------------------- |
| `null`              | System binary -> Latest downloaded -> Download |
| `"1.0.58"` (pinned) | Exact version in bundles -> Download           |

**System binary detection:**

```typescript
// Uses ProcessRunner to invoke which/where
const proc = runner.run(platform === "win32" ? "where" : "which", [binaryName]);
const result = await proc.wait();
if (result.exitCode === 0) {
  return result.stdout.trim().split("\n")[0]; // First line for Windows
}
return null;
```

**Version directory scanning:**

```typescript
// Find latest downloaded version using locale-aware comparison
const versions = await fs.readdir(bundlesBaseDir);
versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
return versions[0]; // Highest version
```

---

## Mock Factories Reference

All paths below are relative to `src/services/`.

### Platform Layer Mocks

| Interface              | Mock Factory                       | Location                                          |
| ---------------------- | ---------------------------------- | ------------------------------------------------- |
| `ArchiveExtractor`     | `createArchiveExtractorMock()`     | `binary-download/archive-extractor.state-mock.ts` |
| `FileSystemLayer`      | `createFileSystemMock()`           | `platform/filesystem.state-mock.ts`               |
| `HttpClient`           | `createMockHttpClient()`           | `platform/network.test-utils.ts`                  |
| `PortManager`          | `createPortManagerMock()`          | `platform/port-manager.state-mock.ts`             |
| `ProcessRunner`        | `createMockProcessRunner()`        | `platform/process.state-mock.ts`                  |
| `PathProvider`         | `createMockPathProvider()`         | `platform/path-provider.test-utils.ts`            |
| `WorkspaceLockHandler` | `createMockWorkspaceLockHandler()` | `platform/workspace-lock-handler.test-utils.ts`   |

### Shell Layer Mocks

| Interface             | Mock Factory                      | Location                        |
| --------------------- | --------------------------------- | ------------------------------- |
| `IpcLayer`            | `createBehavioralIpcLayer()`      | `platform/ipc.test-utils.ts`    |
| `DialogLayer`         | `createBehavioralDialogLayer()`   | `platform/dialog.test-utils.ts` |
| `ImageLayer`          | `createImageLayerMock()`          | `platform/image.state-mock.ts`  |
| `AppLayer`            | `createAppLayerMock()`            | `platform/app.state-mock.ts`    |
| `MenuLayer`           | `createBehavioralMenuLayer()`     | `platform/menu.test-utils.ts`   |
| `WindowLayer`         | `createWindowLayerMock()`         | `shell/window.state-mock.ts`    |
| `WindowLayerInternal` | `createWindowLayerInternalMock()` | `shell/window.state-mock.ts`    |
| `ViewLayer`           | `createViewLayerMock()`           | `shell/view.state-mock.ts`      |
| `SessionLayer`        | `createSessionLayerMock()`        | `shell/session.state-mock.ts`   |

### Domain Mocks

| Interface    | Mock Factory            | Location                    |
| ------------ | ----------------------- | --------------------------- |
| `IGitClient` | `createMockGitClient()` | `git/git-client.state-mock` |

**Git client mock example:**

```typescript
import { createMockGitClient } from "./git/git-client.state-mock";

const mock = createMockGitClient({
  repositories: {
    "/project": {
      branches: ["main", "feature-x"],
      remoteBranches: ["origin/main"],
      remotes: ["origin"],
      worktrees: [
        { name: "feature-x", path: "/workspaces/feature-x", branch: "feature-x", isDirty: true },
      ],
      branchConfigs: { "feature-x": { "codehydra.base": "main" } },
      mainIsDirty: false,
      currentBranch: "main",
    },
  },
});

// Mutations update state
await mock.createBranch(new Path("/project"), "feature-y", "main");
expect(mock).toHaveBranch("/project", "feature-y");

// Custom matchers
expect(mock).toHaveWorktree("/project", "/workspaces/feature-x");
expect(mock).toHaveBranchConfig("/project", "feature-x", "codehydra.base", "main");
```
