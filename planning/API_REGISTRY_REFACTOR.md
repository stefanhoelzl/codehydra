---
status: COMPLETED
last_updated: 2025-12-27
reviewers: [review-arch, review-typescript, review-testing, review-docs]
---

# API_REGISTRY_REFACTOR

## Overview

- **Problem**: `CodeHydraApiImpl` (in `src/main/api/codehydra-api.ts`) is a 1000+ line monolithic class that creates all sub-APIs internally. Services are injected INTO the API, creating tight coupling and making it hard to add new functionality without modifying the central class.

- **Solution**: Refactor to a registry pattern where:
  1. API registry is instantiated very early (before all services)
  2. Services receive the API registry in their constructor
  3. Services register their own methods on the registry after creation

- **Risks**:
  - Type safety loss during dynamic registration → Mitigated by `MethodRegistry` interface as single source of truth
  - Circular dependencies → Mitigated by registry being pure infrastructure with no domain logic
  - IPC handler synchronization → Mitigated by auto-generating handlers at registration time
  - Event system complexity → Mitigated by reusing existing `ApiEvents` from `src/shared/api/interfaces.ts`

- **Alternatives Considered**:
  - Keep monolithic class, just split into files → Rejected: doesn't address tight coupling
  - Full plugin system with dynamic loading → Rejected: over-engineering for current needs

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                API REGISTRY                                      │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  ApiRegistry                                                               │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │  │
│  │  Methods:                                                                  │  │
│  │  • register<P>(path, handler, options)  - Register API method             │  │
│  │  • emit<E>(event, payload)              - Emit event to subscribers       │  │
│  │  • on<E>(event, handler)                - Subscribe to events             │  │
│  │  • getInterface(): ICodeHydraApi        - Get typed public facade         │  │
│  │  • dispose()                            - Cleanup all subscriptions       │  │
│  │                                                                            │  │
│  │  Internal:                                                                 │  │
│  │  • methodMap: Map<MethodPath, Handler>                                    │  │
│  │  • eventListeners: { [E in ApiEvents]?: Set<Handler> }  (type-safe)       │  │
│  │  • ipcCleanup: Array<() => void>                                          │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                       │                                          │
│            ┌──────────────────────────┼──────────────────────────┐              │
│            ▼                          ▼                          ▼              │
│     ┌─────────────┐          ┌─────────────┐          ┌─────────────┐          │
│     │ IPC Layer   │          │ Event Layer │          │Method Layer │          │
│     │ (auto-gen)  │          │ (pub/sub)   │          │ (handlers)  │          │
│     │             │          │ (ApiEvents) │          │             │          │
│     └─────────────┘          └─────────────┘          └─────────────┘          │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
         ┌──────────────────────────────┼──────────────────────────┐
         ▼                              ▼                          ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│ LifecycleModule │          │   CoreModule    │          │    UiModule     │
│ (bootstrap)     │          │ (startServices) │          │ (startServices) │
│                 │          │                 │          │                 │
│ Methods:        │          │ Methods:        │          │ Methods:        │
│ • lifecycle.    │          │ • projects.open │          │ • ui.selectDir  │
│   getState      │          │ • projects.close│          │ • ui.getActive  │
│ • lifecycle.    │          │ • projects.list │          │ • ui.switch     │
│   setup         │          │ • projects.get  │          │ • ui.setMode    │
│ • lifecycle.    │          │ • projects.     │          │                 │
│   quit          │          │   fetchBases    │          │ Events:         │
│                 │          │ • workspaces.*  │          │ • ui:mode-      │
│ Events:         │          │   (all methods) │          │   changed       │
│ • setup:progress│          │                 │          └─────────────────┘
└─────────────────┘          │ Events:         │
                             │ • project:*     │
                             │ • workspace:*   │
                             └─────────────────┘
```

### Two-Phase Initialization

```
bootstrap()
    │
    ├─► Create ApiRegistry
    ├─► Create LifecycleModule (registers lifecycle.* methods)
    ├─► Load UI (lifecycle handlers now available)
    │
    └─► [If setup complete] ──► startServices()
                                    │
                                    ├─► Create AppState, ViewManager, etc.
                                    ├─► Create CoreModule (registers projects.*, workspaces.*)
                                    ├─► Create UiModule (registers ui.*)
                                    └─► api.getInterface() for external consumers
```

## Type System Design

### Single Source of Truth: MethodRegistry

All method paths and signatures are defined once in `MethodRegistry`. Everything else is derived.

**Key Design Decisions**:

1. Handlers accept a **single payload object** instead of positional arguments
2. Events reuse existing `ApiEvents` from `src/shared/api/interfaces.ts`
3. IPC channel names come from `ApiIpcChannels` (explicit, not derived)

```typescript
// src/main/api/registry-types.ts

import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  SetupResult,
  AppState,
} from "../../shared/api/types";
import type { UIMode } from "../../shared/ipc";
import type { ApiEvents, Unsubscribe, ICodeHydraApi } from "../../shared/api/interfaces";

// =============================================================================
// Payload Types - Define the shape of each method's input
// =============================================================================

/** Methods with no input - use empty object {} */
export type EmptyPayload = object;

/** projects.open */
export interface ProjectOpenPayload {
  readonly path: string;
}

/** projects.close, projects.get, projects.fetchBases */
export interface ProjectIdPayload {
  readonly projectId: ProjectId;
}

/** workspaces.create */
export interface WorkspaceCreatePayload {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly base: string;
}

/** workspaces.remove */
export interface WorkspaceRemovePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly keepBranch?: boolean;
}

/** workspaces.forceRemove, workspaces.get, workspaces.getStatus,
    workspaces.getOpencodePort, workspaces.getMetadata */
export interface WorkspaceRefPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

/** workspaces.setMetadata */
export interface WorkspaceSetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly key: string;
  readonly value: string | null;
}

/** ui.switchWorkspace */
export interface UiSwitchWorkspacePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly focus?: boolean;
}

/** ui.setMode */
export interface UiSetModePayload {
  readonly mode: UIMode;
}

// =============================================================================
// Method Registry - Single Source of Truth
// =============================================================================

/**
 * Single source of truth for all API methods.
 * Maps method path to: (payload) => Promise<result>
 *
 * MethodPath format: `<namespace>.<method>` (e.g., 'projects.open', 'workspaces.create')
 */
export interface MethodRegistry {
  // Lifecycle (no payload)
  "lifecycle.getState": (payload: EmptyPayload) => Promise<AppState>;
  "lifecycle.setup": (payload: EmptyPayload) => Promise<SetupResult>;
  "lifecycle.quit": (payload: EmptyPayload) => Promise<void>;

  // Projects
  "projects.open": (payload: ProjectOpenPayload) => Promise<Project>;
  "projects.close": (payload: ProjectIdPayload) => Promise<void>;
  "projects.list": (payload: EmptyPayload) => Promise<readonly Project[]>;
  "projects.get": (payload: ProjectIdPayload) => Promise<Project | undefined>;
  "projects.fetchBases": (
    payload: ProjectIdPayload
  ) => Promise<{ readonly bases: readonly BaseInfo[] }>;

  // Workspaces
  "workspaces.create": (payload: WorkspaceCreatePayload) => Promise<Workspace>;
  "workspaces.remove": (payload: WorkspaceRemovePayload) => Promise<{ started: true }>;
  "workspaces.forceRemove": (payload: WorkspaceRefPayload) => Promise<void>;
  "workspaces.get": (payload: WorkspaceRefPayload) => Promise<Workspace | undefined>;
  "workspaces.getStatus": (payload: WorkspaceRefPayload) => Promise<WorkspaceStatus>;
  "workspaces.getOpencodePort": (payload: WorkspaceRefPayload) => Promise<number | null>;
  "workspaces.setMetadata": (payload: WorkspaceSetMetadataPayload) => Promise<void>;
  "workspaces.getMetadata": (
    payload: WorkspaceRefPayload
  ) => Promise<Readonly<Record<string, string>>>;

  // UI
  "ui.selectFolder": (payload: EmptyPayload) => Promise<string | null>;
  "ui.getActiveWorkspace": (payload: EmptyPayload) => Promise<WorkspaceRef | null>;
  "ui.switchWorkspace": (payload: UiSwitchWorkspacePayload) => Promise<void>;
  "ui.setMode": (payload: UiSetModePayload) => Promise<void>;
}

// =============================================================================
// Derived Types - No Duplication!
// =============================================================================

/**
 * Union of all valid method paths.
 * Derived from MethodRegistry keys.
 */
export type MethodPath = keyof MethodRegistry;

/**
 * Grouped method paths for better organization.
 */
export type LifecyclePath = "lifecycle.getState" | "lifecycle.setup" | "lifecycle.quit";
export type ProjectPath =
  "projects.open" | "projects.close" | "projects.list" | "projects.get" | "projects.fetchBases";
export type WorkspacePath =
  | "workspaces.create"
  | "workspaces.remove"
  | "workspaces.forceRemove"
  | "workspaces.get"
  | "workspaces.getStatus"
  | "workspaces.getOpencodePort"
  | "workspaces.setMetadata"
  | "workspaces.getMetadata";
export type UiPath =
  "ui.selectFolder" | "ui.getActiveWorkspace" | "ui.switchWorkspace" | "ui.setMode";

/**
 * Get the handler signature for a method path.
 */
export type MethodHandler<P extends MethodPath> = MethodRegistry[P];

/**
 * Get the payload type for a method path.
 */
export type MethodPayload<P extends MethodPath> = Parameters<MethodRegistry[P]>[0];

/**
 * Get the return type for a method path.
 */
export type MethodResult<P extends MethodPath> = Awaited<ReturnType<MethodRegistry[P]>>;

/**
 * Complete list of all method paths - used for completeness verification.
 * This array must contain all keys from MethodRegistry.
 */
export const ALL_METHOD_PATHS = [
  "lifecycle.getState",
  "lifecycle.setup",
  "lifecycle.quit",
  "projects.open",
  "projects.close",
  "projects.list",
  "projects.get",
  "projects.fetchBases",
  "workspaces.create",
  "workspaces.remove",
  "workspaces.forceRemove",
  "workspaces.get",
  "workspaces.getStatus",
  "workspaces.getOpencodePort",
  "workspaces.setMetadata",
  "workspaces.getMetadata",
  "ui.selectFolder",
  "ui.getActiveWorkspace",
  "ui.switchWorkspace",
  "ui.setMode",
] as const satisfies readonly MethodPath[];
```

### Registration Options

```typescript
/**
 * Options for method registration.
 */
export interface RegistrationOptions {
  /**
   * IPC channel name for this method.
   * If provided, an IPC handler is automatically registered.
   * Must be a value from ApiIpcChannels (explicit, not derived from path).
   */
  readonly ipc?: string;
}
```

### Module Interface

```typescript
/**
 * Interface that all API modules must implement.
 * Formalizes the module contract for consistency and testing.
 */
export interface IApiModule {
  /**
   * Dispose module resources.
   * Called during shutdown in reverse order of creation.
   */
  dispose(): void;
}
```

### Registry Interface

```typescript
/**
 * API Registry interface - used by modules to register methods.
 * Events reuse ApiEvents from src/shared/api/interfaces.ts.
 */
export interface IApiRegistry {
  /**
   * Register an API method.
   * Type-safe: path must exist in MethodRegistry, handler must match signature.
   * @throws Error if path is already registered (prevents accidental overwrites)
   */
  register<P extends MethodPath>(
    path: P,
    handler: MethodHandler<P>,
    options?: RegistrationOptions
  ): void;

  /**
   * Emit an event to all subscribers.
   * Uses ApiEvents from src/shared/api/interfaces.ts.
   */
  emit<E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]): void;

  /**
   * Subscribe to an event.
   */
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;

  /**
   * Get the typed public API interface.
   * Builds ICodeHydraApi facade from registered methods.
   * @throws Error if not all methods are registered
   */
  getInterface(): ICodeHydraApi;

  /**
   * Cleanup all subscriptions and IPC handlers.
   * Safe to call multiple times (idempotent).
   */
  dispose(): Promise<void>;
}
```

### Public API Facade

The `getInterface()` method returns an `ICodeHydraApi` that wraps payload-based handlers
with positional-argument functions for backward compatibility with existing consumers:

```typescript
// Internal handler (payload-based)
handler: (payload: { projectId: ProjectId }) => Promise<void>

// Public API (positional args, matches existing IProjectApi)
api.projects.close(projectId: ProjectId): Promise<void>

// Conversion in getInterface():
projects: {
  close: (projectId) => get("projects.close")({ projectId }),
  // ... etc
}
```

## Domain Grouping

Based on coupling analysis, domains are grouped as:

| Module          | Domains          | Created In      | Rationale                                       |
| --------------- | ---------------- | --------------- | ----------------------------------------------- |
| LifecycleModule | lifecycle.\*     | bootstrap()     | Must register first, needed before UI loads     |
| CoreModule      | projects._, ws._ | startServices() | Tightly coupled (workspaces belong to projects) |
| UiModule        | ui.\*            | startServices() | Standalone UI operations                        |

**Future**: Additional modules can be added for new domains (e.g., AgentModule for agent-specific operations).

## Module Dependencies

Each module receives `IApiRegistry` plus its domain-specific dependencies:

```typescript
// LifecycleModule - minimal deps, created in bootstrap()
interface LifecycleModuleDeps {
  /** VS Code setup service (undefined in dev mode without setup) */
  vscodeSetup: IVscodeSetup | undefined;
  /** Electron app instance for quit() */
  app: Pick<typeof Electron.app, "quit">;
  /** Callback when setup completes successfully */
  onSetupComplete: () => void;
}

// CoreModule - domain deps, created in startServices()
interface CoreModuleDeps {
  appState: AppState;
  viewManager: IViewManager;
  /** Callback for deletion progress events */
  emitDeletionProgress: DeletionProgressCallback;
  /** Callback to kill terminals before workspace deletion */
  killTerminalsCallback?: KillTerminalsCallback;
  logger: Logger;
}

// UiModule - UI deps, created in startServices()
interface UiModuleDeps {
  viewManager: IViewManager;
  dialog: Pick<typeof Electron.dialog, "showOpenDialog">;
}
```

## Implementation Steps

### Phase 1: Infrastructure (Non-Breaking)

**Acceptance Criteria**: Compiles without errors, registry tests pass, no integration with existing code yet.

- [x] **Step 1.1: Create registry types**
  - Create `src/main/api/registry-types.ts`
  - Define ALL payload types (see complete list above)
  - Define `MethodRegistry` (single source of truth)
  - Define derived types: `MethodPath`, `MethodHandler`, `MethodPayload`, `MethodResult`
  - Define `ALL_METHOD_PATHS` const array with `satisfies` for compile-time verification
  - Define `RegistrationOptions`, `IApiRegistry`, `IApiModule`
  - Test: Type validation tests with `expectTypeOf`
  - Files: `src/main/api/registry-types.ts`, `src/main/api/registry-types.test.ts`

- [x] **Step 1.2: Create ApiRegistry class**
  - Create `src/main/api/registry.ts`
  - Implement `register()`, `emit()`, `on()`, `getInterface()`, `dispose()`
  - Use type-safe event listeners: `{ [E in keyof ApiEvents]?: Set<ApiEvents[E]> }`
  - Use `ALL_METHOD_PATHS` for completeness verification (not hardcoded array)
  - Auto-generate IPC handlers when `options.ipc` is provided:

    ```typescript
    // When registering:
    registry.register("projects.open", handler, { ipc: ApiIpcChannels.PROJECT_OPEN });

    // Generated IPC handler:
    ipcMain.handle("api:project:open", async (_event, payload) => {
      return await handler(payload ?? {});
    });
    ```

  - `getInterface()` wraps handlers to convert positional args → payload
  - `dispose()` is async and idempotent (safe to call twice)
  - Test: Unit tests for registration, events, IPC handler creation, error scenarios
  - Files: `src/main/api/registry.ts`, `src/main/api/registry.test.ts`

- [x] **Step 1.3: Create registry boundary tests**
  - Create `src/main/api/registry.boundary.test.ts`
  - Test actual Electron IPC behavior (not mocked)
  - Verify IPC handler receives invocations
  - Verify IPC cleanup removes handlers
  - Verify multiple registries don't conflict
  - Files: `src/main/api/registry.boundary.test.ts`

- [x] **Step 1.4: Create registry test utilities**
  - Create `src/main/api/registry.test-utils.ts`
  - `createMockRegistry()` for module testing
  - Mock must match real registry behavior (throws on duplicate, validates completeness)
  - Test: Verify mock matches real registry behavior
  - Files: `src/main/api/registry.test-utils.ts`, `src/main/api/registry.test-utils.test.ts`

### Phase 2: Module Extraction (Non-Breaking)

**Acceptance Criteria**: All modules have 100% test coverage for extracted logic, no behavior changes from existing code.

- [x] **Step 2.1: Create LifecycleModule**
  - Create `src/main/modules/lifecycle/index.ts`
  - Extract lifecycle logic from `src/main/api/codehydra-api.ts` (createLifecycleApi method)
  - Implement `IApiModule` interface
  - Register on `IApiRegistry` in constructor with explicit IPC channels:
    ```typescript
    this.api.register("lifecycle.getState", this.getState.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_GET_STATE,
    });
    ```
  - Test: Unit tests for all lifecycle methods + registration verification
  - Files: `src/main/modules/lifecycle/index.ts`, `src/main/modules/lifecycle/index.test.ts`

- [x] **Step 2.2: Create CoreModule**
  - Create `src/main/modules/core/index.ts`
  - Extract project + workspace logic from `src/main/api/codehydra-api.ts`
  - Implement `IApiModule` interface
  - Handle `DeletionProgressCallback` internally (emit via registry events or callback)
  - Register on `IApiRegistry` in constructor
  - Test: Unit tests for all project/workspace methods + registration verification
  - Files: `src/main/modules/core/index.ts`, `src/main/modules/core/index.test.ts`

- [x] **Step 2.3: Create UiModule**
  - Create `src/main/modules/ui/index.ts`
  - Extract UI logic from `src/main/api/codehydra-api.ts`
  - Implement `IApiModule` interface
  - Wire ViewManager mode changes to `api.emit("ui:mode-changed", ...)`
  - Register on `IApiRegistry` in constructor
  - Test: Unit tests for all UI methods + registration verification
  - Files: `src/main/modules/ui/index.ts`, `src/main/modules/ui/index.test.ts`

### Phase 3: Parallel Operation (Non-Breaking)

**Acceptance Criteria**: Both old and new bootstrap paths work, can switch via env var.

- [x] **Step 3.1: Create bootstrap-v2 function**
  - Create `src/main/bootstrap-v2.ts`
  - New bootstrap using `ApiRegistry` pattern
  - **Important**: During Phase 3, do NOT register IPC handlers (pass `ipc: undefined`)
  - Enable via env var: `CODEHYDRA_USE_REGISTRY=1`
  - Test: Integration test for new startup flow
  - Files: `src/main/bootstrap-v2.ts`, `src/main/bootstrap-v2.test.ts`

- [x] **Step 3.2: Wire modules in bootstrap-v2**
  - Instantiate `ApiRegistry` first
  - Create modules in order: Lifecycle → (after setup) → Core → UI
  - Verify `getInterface()` returns complete `ICodeHydraApi`
  - Test: Integration tests for:
    - `bootstrap-v2.startup` - Full startup with registry and modules
    - `bootstrap-v2.module.order` - Lifecycle registered before Core/UI
    - `bootstrap-v2.events.roundtrip` - Events flow correctly
    - `bootstrap-v2.events.unsubscribe` - Unsubscribe works
  - Files: `src/main/bootstrap-v2.ts`, `src/main/bootstrap-v2.integration.test.ts`

### Phase 4: Migration (Breaking)

**Acceptance Criteria**: All old code removed, all tests pass, docs updated.

- [x] **Step 4.1: Enable IPC handlers in registry**
  - Now that old code will be removed, enable IPC registration in modules
  - Pass actual `ApiIpcChannels` values to `register()` options
  - Test: Verify IPC handlers work end-to-end
  - Files: All module files

- [x] **Step 4.2: Switch to new bootstrap**
  - Replace `bootstrap()` with new implementation
  - Remove env var check
  - Test: Full integration test suite
  - Files: `src/main/index.ts`

- [x] **Step 4.3: Remove old code**
  - Delete `src/main/api/codehydra-api.ts` (monolithic implementation)
  - Delete `src/main/ipc/api-handlers.ts` (IPC handlers now auto-generated)
  - Delete `src/main/api/lifecycle-api.ts` (replaced by LifecycleModule)
  - Test: All existing integration tests pass unchanged
  - Test: Migration regression test comparing old vs new API results
  - Files: Delete listed files, add `src/main/api/migration.test.ts`

- [x] **Step 4.4: Update documentation**
  - `AGENTS.md`: Update "IPC Patterns" section to reference new Module Registration Pattern
  - `docs/ARCHITECTURE.md`: Replace CodeHydraApiImpl diagram with ApiRegistry architecture
  - `docs/PATTERNS.md`: Add "Module Registration Pattern" subsection with example
  - Files: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PATTERNS.md`

## Testing Strategy

### Unit Tests (vitest)

| Test Case                      | Description                                       | File                                     |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------- |
| registry-types.paths           | ALL_METHOD_PATHS contains all MethodRegistry keys | src/main/api/registry-types.test.ts      |
| registry-types.payload         | Payload type extraction works for each method     | src/main/api/registry-types.test.ts      |
| registry-types.handler         | Handler type inference works                      | src/main/api/registry-types.test.ts      |
| registry.register              | Registers method, callable via getInterface()     | src/main/api/registry.test.ts            |
| registry.register.ipc          | Auto-creates IPC handler when ipc option provided | src/main/api/registry.test.ts            |
| registry.register.duplicate    | Throws on duplicate registration                  | src/main/api/registry.test.ts            |
| registry.emit                  | Emits to all subscribers                          | src/main/api/registry.test.ts            |
| registry.emit.error            | Catches handler errors, continues to next         | src/main/api/registry.test.ts            |
| registry.emit.error.logged     | Error details are logged                          | src/main/api/registry.test.ts            |
| registry.on                    | Subscribes to events, returns unsubscribe         | src/main/api/registry.test.ts            |
| registry.getInterface          | Returns typed ICodeHydraApi facade                | src/main/api/registry.test.ts            |
| registry.getInterface.partial  | Throws if not all methods registered              | src/main/api/registry.test.ts            |
| registry.dispose               | Cleans up IPC handlers and subscriptions          | src/main/api/registry.test.ts            |
| registry.dispose.twice         | Second dispose is no-op (idempotent)              | src/main/api/registry.test.ts            |
| registry.dispose.during.emit   | Handles dispose during event emission             | src/main/api/registry.test.ts            |
| registry.ipc.payload.undefined | Handler receives {} when payload undefined        | src/main/api/registry.test.ts            |
| registry.ipc.payload.null      | Handler receives {} when payload null             | src/main/api/registry.test.ts            |
| mock-registry.behavior         | Mock matches real registry behavior               | src/main/api/registry.test-utils.test.ts |
| lifecycle.getState             | Returns correct app state                         | src/main/modules/lifecycle/index.test.ts |
| lifecycle.setup                | Runs setup, emits progress                        | src/main/modules/lifecycle/index.test.ts |
| lifecycle.quit                 | Calls app.quit()                                  | src/main/modules/lifecycle/index.test.ts |
| lifecycle.registration         | All lifecycle.\* paths registered with IPC        | src/main/modules/lifecycle/index.test.ts |
| core.projects.\*               | All project methods work correctly                | src/main/modules/core/index.test.ts      |
| core.workspaces.\*             | All workspace methods work correctly              | src/main/modules/core/index.test.ts      |
| core.registration              | All projects._/workspaces._ paths registered      | src/main/modules/core/index.test.ts      |
| ui.\*                          | All UI methods work correctly                     | src/main/modules/ui/index.test.ts        |
| ui.registration                | All ui.\* paths registered with IPC               | src/main/modules/ui/index.test.ts        |

### Boundary Tests

| Test Case                | Description                                    | File                                   |
| ------------------------ | ---------------------------------------------- | -------------------------------------- |
| registry.ipc.receive     | IPC handler receives invocations from renderer | src/main/api/registry.boundary.test.ts |
| registry.ipc.cleanup     | IPC cleanup removes handlers                   | src/main/api/registry.boundary.test.ts |
| registry.ipc.no-conflict | Multiple registries don't conflict on channels | src/main/api/registry.boundary.test.ts |

### Integration Tests

| Test Case                       | Description                                    | File                                      |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| bootstrap-v2.startup            | Full startup with registry and modules         | src/main/bootstrap-v2.integration.test.ts |
| bootstrap-v2.module.order       | Lifecycle registered before Core/UI can use it | src/main/bootstrap-v2.integration.test.ts |
| bootstrap-v2.ipc.roundtrip      | Call from mock renderer, verify result matches | src/main/bootstrap-v2.integration.test.ts |
| bootstrap-v2.events.multiple    | Multiple subscribers receive same event        | src/main/bootstrap-v2.integration.test.ts |
| bootstrap-v2.events.unsubscribe | Unsubscribed handlers don't receive events     | src/main/bootstrap-v2.integration.test.ts |
| bootstrap-v2.error.propagation  | IPC errors propagate as rejected promises      | src/main/bootstrap-v2.integration.test.ts |
| migration.comparison            | New API returns identical results to old API   | src/main/api/migration.test.ts            |

### Performance Tests

| Test Case                   | Description            | File                          |
| --------------------------- | ---------------------- | ----------------------------- |
| registry.emit.many.handlers | <10ms for 100 handlers | src/main/api/registry.test.ts |
| registry.getInterface.perf  | Facade creation <1ms   | src/main/api/registry.test.ts |

### Manual Testing Checklist

- [ ] App starts successfully
- [ ] Setup flow works (fresh install)
- [ ] Project open/close works
- [ ] Workspace create/remove works
- [ ] Workspace switching works
- [ ] Shortcut mode works
- [ ] Agent status updates work
- [ ] All IPC calls from renderer work

## Disposal Order

During shutdown, modules are disposed in reverse order of creation:

1. UiModule.dispose()
2. CoreModule.dispose()
3. LifecycleModule.dispose()
4. ApiRegistry.dispose() (cleans up remaining IPC handlers and event listeners)

This matches the existing cleanup order in `src/main/index.ts`.

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                 | Section                | Changes Required                                          |
| -------------------- | ---------------------- | --------------------------------------------------------- |
| AGENTS.md            | IPC Patterns           | Reference new Module Registration Pattern in PATTERNS.md  |
| docs/ARCHITECTURE.md | API Layer Architecture | Replace CodeHydraApiImpl diagram with ApiRegistry diagram |
| docs/PATTERNS.md     | (new section)          | Add "Module Registration Pattern" with full example       |

### New Documentation Required

| File   | Purpose                       |
| ------ | ----------------------------- |
| (none) | Existing docs will be updated |

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes (note: 3 pre-existing failures in vscode-setup unrelated to this work)
- [x] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed

---

## Appendix: Detailed Code Examples

### ApiRegistry Implementation

```typescript
// src/main/api/registry.ts
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type {
  IApiRegistry,
  MethodPath,
  MethodHandler,
  RegistrationOptions,
  ALL_METHOD_PATHS,
} from "./registry-types";
import type { ICodeHydraApi, ApiEvents, Unsubscribe } from "../../shared/api/interfaces";
import { createSilentLogger, type Logger } from "../../services/logging";

export class ApiRegistry implements IApiRegistry {
  // Type-safe method storage
  private readonly methods = new Map<MethodPath, Function>();

  // Type-safe event listeners - no unsafe casts
  private readonly listeners: {
    [E in keyof ApiEvents]?: Set<ApiEvents[E]>;
  } = {};

  private readonly ipcCleanup: Array<() => void> = [];
  private readonly logger: Logger;
  private disposed = false;

  constructor(logger?: Logger) {
    this.logger = logger ?? createSilentLogger();
  }

  register<P extends MethodPath>(
    path: P,
    handler: MethodHandler<P>,
    options?: RegistrationOptions
  ): void {
    if (this.disposed) {
      throw new Error("Cannot register on disposed registry");
    }

    // Prevent duplicate registration
    if (this.methods.has(path)) {
      throw new Error(`Method already registered: ${path}`);
    }

    // Store handler
    this.methods.set(path, handler);

    // Auto-register IPC handler if channel provided
    if (options?.ipc) {
      const channel = options.ipc;
      const ipcHandler = async (_event: IpcMainInvokeEvent, payload: unknown) => {
        return handler((payload ?? {}) as Parameters<MethodHandler<P>>[0]);
      };
      ipcMain.handle(channel, ipcHandler);
      this.ipcCleanup.push(() => ipcMain.removeHandler(channel));
      this.logger.debug("Registered IPC handler", { path, channel });
    }
  }

  emit<E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]): void {
    const handlers = this.listeners[event];
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(payload as never);
      } catch (error) {
        this.logger.error(
          "Event handler error",
          { event },
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe {
    const handlers = this.listeners[event] ?? new Set();
    if (!this.listeners[event]) {
      this.listeners[event] = handlers;
    }
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
    };
  }

  getInterface(): ICodeHydraApi {
    // Verify all methods are registered using derived constant
    this.verifyComplete();

    // Helper to get typed handler (safe because verifyComplete passed)
    const get = <P extends MethodPath>(path: P): MethodHandler<P> =>
      this.methods.get(path) as MethodHandler<P>;

    // Build facade that converts positional args to payload objects
    return {
      projects: {
        open: (path) => get("projects.open")({ path }),
        close: (projectId) => get("projects.close")({ projectId }),
        list: () => get("projects.list")({}),
        get: (projectId) => get("projects.get")({ projectId }),
        fetchBases: (projectId) => get("projects.fetchBases")({ projectId }),
      },
      workspaces: {
        create: (projectId, name, base) => get("workspaces.create")({ projectId, name, base }),
        remove: (projectId, workspaceName, keepBranch) =>
          get("workspaces.remove")({ projectId, workspaceName, keepBranch }),
        forceRemove: (projectId, workspaceName) =>
          get("workspaces.forceRemove")({ projectId, workspaceName }),
        get: (projectId, workspaceName) => get("workspaces.get")({ projectId, workspaceName }),
        getStatus: (projectId, workspaceName) =>
          get("workspaces.getStatus")({ projectId, workspaceName }),
        getOpencodePort: (projectId, workspaceName) =>
          get("workspaces.getOpencodePort")({ projectId, workspaceName }),
        setMetadata: (projectId, workspaceName, key, value) =>
          get("workspaces.setMetadata")({ projectId, workspaceName, key, value }),
        getMetadata: (projectId, workspaceName) =>
          get("workspaces.getMetadata")({ projectId, workspaceName }),
      },
      ui: {
        selectFolder: () => get("ui.selectFolder")({}),
        getActiveWorkspace: () => get("ui.getActiveWorkspace")({}),
        switchWorkspace: (projectId, workspaceName, focus) =>
          get("ui.switchWorkspace")({ projectId, workspaceName, focus }),
        setMode: (mode) => get("ui.setMode")({ mode }),
      },
      lifecycle: {
        getState: () => get("lifecycle.getState")({}),
        setup: () => get("lifecycle.setup")({}),
        quit: () => get("lifecycle.quit")({}),
      },
      on: this.on.bind(this),
      dispose: this.dispose.bind(this),
    };
  }

  private verifyComplete(): void {
    // Use the derived constant, not a hardcoded array
    const missing = ALL_METHOD_PATHS.filter((p) => !this.methods.has(p));
    if (missing.length > 0) {
      throw new Error(`Missing method registrations: ${missing.join(", ")}`);
    }
  }

  async dispose(): Promise<void> {
    // Idempotent - safe to call twice
    if (this.disposed) return;
    this.disposed = true;

    // Clean up IPC handlers (continue even if one fails)
    for (const cleanup of this.ipcCleanup) {
      try {
        cleanup();
      } catch (error) {
        this.logger.error("IPC cleanup error", {}, error instanceof Error ? error : undefined);
      }
    }
    this.ipcCleanup.length = 0;

    // Clear listeners
    for (const key of Object.keys(this.listeners) as (keyof ApiEvents)[]) {
      delete this.listeners[key];
    }

    this.methods.clear();
  }
}
```

### Module Implementation Example

```typescript
// src/main/modules/lifecycle/index.ts
import type { IApiRegistry, IApiModule, EmptyPayload } from "../../api/registry-types";
import type {
  IVscodeSetup,
  SetupStep as ServiceSetupStep,
} from "../../../services/vscode-setup/types";
import type { SetupStep as ApiSetupStep, AppState, SetupResult } from "../../../shared/api/types";
import { ApiIpcChannels } from "../../../shared/ipc";

export interface LifecycleModuleDeps {
  /** VS Code setup service (undefined in dev mode without setup) */
  vscodeSetup: IVscodeSetup | undefined;
  /** Electron app instance for quit() */
  app: Pick<typeof Electron.app, "quit">;
  /** Callback when setup completes successfully */
  onSetupComplete: () => void;
}

export class LifecycleModule implements IApiModule {
  private cachedPreflightResult:
    import("../../../services/vscode-setup/types").PreflightResult | null = null;

  constructor(
    private readonly api: IApiRegistry,
    private readonly deps: LifecycleModuleDeps
  ) {
    this.registerMethods();
  }

  private registerMethods(): void {
    this.api.register("lifecycle.getState", this.getState.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_GET_STATE,
    });

    this.api.register("lifecycle.setup", this.setup.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_SETUP,
    });

    this.api.register("lifecycle.quit", this.quit.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_QUIT,
    });
  }

  private async getState(_payload: EmptyPayload): Promise<AppState> {
    if (!this.deps.vscodeSetup) return "ready";

    this.cachedPreflightResult = await this.deps.vscodeSetup.preflight();
    if (!this.cachedPreflightResult.success) return "setup";
    return this.cachedPreflightResult.needsSetup ? "setup" : "ready";
  }

  private async setup(_payload: EmptyPayload): Promise<SetupResult> {
    if (!this.deps.vscodeSetup) return { success: true };

    let preflight = this.cachedPreflightResult;
    if (!preflight) {
      preflight = await this.deps.vscodeSetup.preflight();
    }
    this.cachedPreflightResult = null;

    const result = await this.deps.vscodeSetup.setup(preflight, (progress) => {
      const apiStep = this.mapSetupStep(progress.step);
      if (apiStep) {
        this.api.emit("setup:progress", {
          step: apiStep,
          message: progress.message,
        });
      }
    });

    if (result.success) {
      this.deps.onSetupComplete();
      return { success: true };
    }

    return {
      success: false,
      message: result.error.message,
      code: result.error.code ?? "UNKNOWN",
    };
  }

  private async quit(_payload: EmptyPayload): Promise<void> {
    this.deps.app.quit();
  }

  private mapSetupStep(serviceStep: ServiceSetupStep): ApiSetupStep | undefined {
    switch (serviceStep) {
      case "extensions":
        return "extensions";
      case "config":
        return "settings";
      case "finalize":
        return undefined;
      default:
        return undefined;
    }
  }

  dispose(): void {
    // LifecycleModule has no resources to dispose
    // (IPC handlers cleaned up by ApiRegistry)
  }
}
```

### Startup Flow

```typescript
// src/main/index.ts (after migration)

async function bootstrap(): Promise<void> {
  // 1. Create registry FIRST (before any services)
  const api = new ApiRegistry(loggingService.createLogger("api"));

  // 2. Create window infrastructure
  const windowManager = new WindowManager(...);
  const viewManager = new ViewManager(...);

  // 3. Create LifecycleModule (must be ready before UI loads)
  const lifecycleModule = new LifecycleModule(api, {
    vscodeSetup: vscodeSetupService,
    app,
    onSetupComplete: () => startServices(api, viewManager, lifecycleModule),
  });

  // 4. Load UI - lifecycle handlers are now available
  await loadUI();
}

async function startServices(
  api: IApiRegistry,
  viewManager: IViewManager,
  lifecycleModule: LifecycleModule
): Promise<void> {
  // 5. Create remaining infrastructure
  const codeServerManager = await startCodeServer();
  const appState = new AppState(...);

  // 6. Create remaining modules (they register their methods)
  const coreModule = new CoreModule(api, {
    appState,
    viewManager,
    emitDeletionProgress: (progress) => { /* ... */ },
    killTerminalsCallback,
    logger: loggingService.createLogger("core"),
  });

  const uiModule = new UiModule(api, {
    viewManager,
    dialog,
  });

  // 7. Get typed interface for external consumers
  const codeHydraApi = api.getInterface();
  wirePluginApi(pluginServer, codeHydraApi);

  // 8. Bridge events to renderer
  bridgeEventsToRenderer(api, webContents);

  // 9. Store modules for cleanup (reverse order)
  modules = [uiModule, coreModule, lifecycleModule];
}

async function cleanup(): Promise<void> {
  // Dispose modules in reverse order
  for (const module of modules) {
    module.dispose();
  }
  await api.dispose();
}
```
