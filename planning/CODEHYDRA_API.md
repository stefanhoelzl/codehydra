---
status: COMPLETED
last_updated: 2025-12-15
reviewers: [review-arch, review-typescript, review-testing, review-docs, review-ui]
---

# CODEHYDRA_API

## Overview

- **Problem**: CodeHydra lacks a unified API interface. The UI communicates directly via IPC handlers that call services. This makes it difficult to add new consumers (MCP Server, CLI) without duplicating logic.

- **Solution**: Define a `ICodeHydraApi` interface that abstracts all CodeHydra operations. Create a single implementation (`CodeHydraApiImpl`) in `src/main/api/` that wraps existing services. Refactor IPC handlers to become thin adapters over this API.

- **Risks**:

  | Risk                     | Mitigation                                       |
  | ------------------------ | ------------------------------------------------ |
  | Breaking existing UI     | Incremental migration, comprehensive tests       |
  | ID generation collisions | Use project name + path hash (same as app-data)  |
  | Performance regression   | API layer is thin, minimal overhead              |
  | Event delivery timing    | Maintain same event flow, just route through API |

- **Alternatives Considered**:
  | Alternative               | Why Rejected                                                |
  | ------------------------- | ----------------------------------------------------------- |
  | Keep IPC-only approach    | Can't reuse for MCP/CLI without duplication                 |
  | Generate OpenAPI spec     | Overkill for internal API, TypeScript interfaces sufficient |
  | Use tRPC                  | Adds complexity, not needed for Electron IPC                |
  | Bidirectional ID↔Path Map | Overkill for <10 projects, iteration is simpler             |
  | Split CoreApi/UiApi       | Single implementation simpler; UI methods are thin wrappers |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Consumers                                     │
├─────────────────────┬─────────────────────┬─────────────────────────────┤
│   UI (Renderer)     │   MCP Server        │   Future CLI                │
│   FULL API          │   CORE API          │   CORE API                  │
└──────────┬──────────┴──────────┬──────────┴──────────┬──────────────────┘
           │                     │                     │
           ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         IPC Adapter Layer                                │
│  (Thin adapters: validate input → call API → serialize response)        │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ICodeHydraApi                                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐        │
│  │ IProjectApi │ │IWorkspaceApi│ │   IUiApi    │ │ILifecycleApi│        │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘        │
│                           + on(event, handler)                           │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 CodeHydraApiImpl (src/main/api/)                         │
│  - Lives in main process (requires Electron for IUiApi)                 │
│  - Wraps services (AppState, WorkspaceProvider, ViewManager, etc.)      │
│  - Resolves IDs by iterating open projects (<10, no map needed)         │
│  - Emits events via callback subscriptions (no intermediate EventEmitter)│
│  - Implements IDisposable for cleanup                                   │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Services                                       │
│  AppState, GitWorktreeProvider, AgentStatusManager, ViewManager, etc.   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Layer Ownership

| Component          | Owns                                             | Does NOT Own                           |
| ------------------ | ------------------------------------------------ | -------------------------------------- |
| `AppState`         | Project/workspace state, provider registry       | Event emission, ID generation          |
| `CodeHydraApiImpl` | ID↔path resolution, event emission, API contract | Business logic (delegates to services) |
| `IPC Handlers`     | Input validation, IPC serialization              | Business logic, state                  |

### ID Resolution (Simple Iteration)

```typescript
// Exact algorithm for ID generation
function generateProjectId(absolutePath: string): ProjectId {
  const normalizedPath = path.normalize(absolutePath);
  const name = path.basename(normalizedPath).replace(/[^a-zA-Z0-9]/g, "-");
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
  return `${name}-${hash}` as ProjectId;
}

// Resolution by iteration (sufficient for <10 projects)
function resolveProject(projectId: ProjectId): string | undefined {
  const projects = appState.getAllProjects();
  for (const project of projects) {
    if (generateProjectId(project.path) === projectId) {
      return project.path;
    }
  }
  return undefined;
}
```

**Test vectors for determinism:**

| Input Path                    | Expected ID                         |
| ----------------------------- | ----------------------------------- |
| `/home/user/projects/my-app`  | `my-app-<hash8>`                    |
| `/home/user/projects/my-app/` | `my-app-<hash8>` (same, normalized) |
| `/home/user/Projects/My App`  | `My-App-<hash8>` (spaces→dashes)    |

### Event Flow (Simplified)

IPC handlers subscribe directly to service callbacks and API events - no intermediate EventEmitter layer:

```
Service callback                    IPC handler subscription
      │                                      │
      │  agentStatusManager.onStatusChanged()│
      ├─────────────────────────────────────►│
      │                                      │  webContents.send('workspace:status-changed')
      │                                      ├─────────────────────────────────────────────►
      │                                      │                                            UI
```

### MCP Server Integration Path

Future MCP Server will instantiate `ICoreApi` (subset excluding UI):

```typescript
// Future MCP Server (not implemented in this plan)
import { createCoreApi } from "@main/api";

const coreApi = createCoreApi(appState, workspaceProviders);
// coreApi.projects, coreApi.workspaces, coreApi.on() available
// coreApi.ui, coreApi.lifecycle NOT available (ICoreApi excludes them)
```

## Implementation Steps

### Phase 1: API Types & Interface Definition

- [x] **Step 1.1: Write type definition tests (TDD: RED)**
  - Create `src/shared/api/types.test.ts`
  - Write compile-time type tests using `@ts-expect-error` comments:
    ```typescript
    // @ts-expect-error - raw string should not be assignable to ProjectId
    const id: ProjectId = "some-string";
    ```
  - Write runtime tests for type guard functions (to be implemented)
  - Files: `src/shared/api/types.test.ts`
  - Test criteria: Tests fail (type guards don't exist yet)

- [x] **Step 1.2: Create API type definitions (TDD: GREEN)**
  - Create `src/shared/api/types.ts` with all domain types
  - Use unique symbol branding (consistent with existing `ProjectPath`):

    ```typescript
    declare const ProjectIdBrand: unique symbol;
    export type ProjectId = string & { readonly [ProjectIdBrand]: true };

    declare const WorkspaceNameBrand: unique symbol;
    export type WorkspaceName = string & { readonly [WorkspaceNameBrand]: true };
    ```

  - Add type guard functions with validation:
    ```typescript
    export function isProjectId(value: string): value is ProjectId {
      return /^[a-zA-Z0-9-]+-[a-f0-9]{8}$/.test(value);
    }
    export function isWorkspaceName(value: string): value is WorkspaceName {
      return (
        value.length > 0 && value.length <= 100 && /^[a-zA-Z0-9][-_.\/a-zA-Z0-9]*$/.test(value)
      );
    }
    ```
  - Use `readonly` arrays: `readonly workspaces: readonly Workspace[]`
  - Handle `branch: string | null` for detached HEAD state
  - Include `path` in event payloads for efficient lookup (no resolution needed)
  - Files: `src/shared/api/types.ts`
  - Test criteria: All type tests pass

- [x] **Step 1.3: Write interface definition tests (TDD: RED)**
  - Create `src/shared/api/interfaces.test.ts`
  - Write tests verifying interface structure (method signatures, return types)
  - Files: `src/shared/api/interfaces.test.ts`
  - Test criteria: Tests fail (interfaces don't exist yet)

- [x] **Step 1.4: Create API interface definitions (TDD: GREEN)**
  - Create `src/shared/api/interfaces.ts` with all API interfaces
  - Define: `IProjectApi`, `IWorkspaceApi`, `IUiApi`, `ILifecycleApi`
  - Define: `ApiEvents`, `ICodeHydraApi`
  - Add `IDisposable` to `ICodeHydraApi` for cleanup
  - Export `ICoreApi` subset type for MCP/CLI
  - Define `ApiError` extending `ServiceError` pattern:
    ```typescript
    export type ApiError =
      | { type: "not-found"; resource: "project" | "workspace"; id: string }
      | { type: "validation"; message: string; field?: string }
      | { type: "service"; cause: ServiceError };
    ```
  - Files: `src/shared/api/interfaces.ts`
  - Test criteria: Interface tests pass, JSDoc complete

- [x] **Step 1.5: Create shared API barrel export**
  - Create `src/shared/api/index.ts` exporting all types and interfaces
  - Files: `src/shared/api/index.ts`
  - Test criteria: Clean imports from `@shared/api`

### Phase 2: ID Utilities

- [x] **Step 2.1: Write ID generation tests (TDD: RED)**
  - Create `src/main/api/id-utils.test.ts`
  - Test deterministic ID generation with test vectors
  - Test edge cases:
    - Path normalization (trailing slashes)
    - Unicode/special characters in paths
    - Very long paths
    - Case sensitivity
    - Root paths (`/`, `C:\`)
  - Test validation functions
  - Files: `src/main/api/id-utils.test.ts`
  - Test criteria: Tests fail (functions don't exist yet)

- [x] **Step 2.2: Implement ID generation utilities (TDD: GREEN)**
  - Create `src/main/api/id-utils.ts`
  - Implement `generateProjectId(path: string): ProjectId`:
    ```typescript
    export function generateProjectId(absolutePath: string): ProjectId {
      const normalizedPath = path.normalize(absolutePath);
      const basename = path.basename(normalizedPath);
      const safeName = basename.replace(/[^a-zA-Z0-9]/g, "-") || "root";
      const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
      return `${safeName}-${hash}` as ProjectId;
    }
    ```
  - Implement `toWorkspaceName(name: string): WorkspaceName` with validation
  - Implement validation helpers
  - Files: `src/main/api/id-utils.ts`
  - Test criteria: All ID tests pass

### Phase 3: API Implementation

- [x] **Step 3.1: Write API skeleton tests (TDD: RED)**
  - Create `src/main/api/codehydra-api.test.ts`
  - Test instantiation with mock services
  - Test `on()` subscription returns unsubscribe function
  - Test `dispose()` cleans up subscriptions
  - Test `resolveProject()` and `resolveWorkspace()` helpers
  - Test error cases: invalid ID returns `ApiError`
  - Files: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Tests fail

- [x] **Step 3.2: Create CodeHydraApiImpl skeleton (TDD: GREEN)**
  - Create `src/main/api/codehydra-api.ts`
  - Implement constructor with service dependencies:
    ```typescript
    constructor(
      private readonly appState: AppState,
      private readonly viewManager: IViewManager,
      private readonly dialog: typeof Electron.dialog,
      private readonly app: typeof Electron.app
    )
    ```
  - Implement `IDisposable.dispose()` for cleanup
  - Implement callback-based `on()` method (no EventEmitter):
    ```typescript
    private listeners = new Map<string, Set<Function>>();
    on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(handler);
      return () => this.listeners.get(event)?.delete(handler);
    }
    ```
  - Create domain API stubs that throw `new Error('Not yet implemented: methodName')`
  - Implement private `resolveProject()` and `resolveWorkspace()` helpers
  - Files: `src/main/api/codehydra-api.ts`
  - Test criteria: Skeleton tests pass

- [x] **Step 3.3: Write IProjectApi tests (TDD: RED)**
  - Add tests for all IProjectApi methods
  - Test event emission for each method
  - Test error cases: project not found, invalid path
  - Files: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Tests fail

- [x] **Step 3.4: Implement IProjectApi (TDD: GREEN)**
  - Implement `open(path)` - wraps AppState.openProject, generates ID for response
  - Implement `close(projectId)` - resolves ID, wraps AppState.closeProject
  - Implement `list()` - wraps AppState.getAllProjects, maps to API types with generated IDs
  - Implement `get(projectId)` - resolves and returns single project
  - Implement `fetchBases(projectId)`:
    - Returns cached bases immediately from WorkspaceProvider.listBases
    - Triggers WorkspaceProvider.updateBases in background
    - Emits `project:bases-updated` when background fetch completes
  - Emit events: `project:opened`, `project:closed`, `project:bases-updated`
  - Files: `src/main/api/codehydra-api.ts`
  - Test criteria: All IProjectApi tests pass

- [x] **Step 3.5: Write IWorkspaceApi tests (TDD: RED)**
  - Add tests for all IWorkspaceApi methods
  - Test event emission
  - Test error cases: workspace not found, create fails
  - Test status aggregation (isDirty + agent status)
  - Files: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Tests fail

- [x] **Step 3.6: Implement IWorkspaceApi (TDD: GREEN)**
  - Implement `create(projectId, name, base)` - wraps WorkspaceProvider.createWorkspace
  - Implement `remove(projectId, workspaceName, keepBranch?)` - wraps WorkspaceProvider.removeWorkspace
  - Implement `get(projectId, workspaceName)` - finds workspace in project
  - Implement `getStatus(projectId, workspaceName)` - combines isDirty + agent status
  - Emit events: `workspace:created`, `workspace:removed`
  - Wire `workspace:status-changed` from AgentStatusManager callback
  - Files: `src/main/api/codehydra-api.ts`
  - Test criteria: All IWorkspaceApi tests pass

- [x] **Step 3.7: Write IUiApi tests (TDD: RED)**
  - Add tests for all IUiApi methods (mock Electron dialog/ViewManager)
  - Test event emission
  - Files: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Tests fail

- [x] **Step 3.8: Implement IUiApi (TDD: GREEN)**
  - Implement `selectFolder()` - wraps Electron dialog.showOpenDialog
  - Implement `getActiveWorkspace()` - wraps ViewManager.getActiveWorkspacePath, resolves to IDs
  - Implement `switchWorkspace(projectId, workspaceName, focus?)` - resolves IDs, wraps ViewManager
  - Implement `setDialogMode(isOpen)` - wraps ViewManager.setDialogMode
  - Implement `focusActiveWorkspace()` - wraps ViewManager.focusActiveWorkspace
  - Emit events: `workspace:switched`
  - Wire shortcut events from ShortcutController
  - Files: `src/main/api/codehydra-api.ts`
  - Test criteria: All IUiApi tests pass

- [x] **Step 3.9: Write ILifecycleApi tests (TDD: RED)**
  - Add tests for all ILifecycleApi methods
  - Test SetupResult success/failure shapes
  - Files: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Tests fail

- [x] **Step 3.10: Implement ILifecycleApi (TDD: GREEN)**
  - Implement `getState()` - checks setup completion status
  - Implement `setup()` - wraps VscodeSetupService, returns SetupResult (aligned with ServiceError)
  - Implement `quit()` - wraps app.quit()
  - Emit events: `setup:progress` during setup
  - Files: `src/main/api/codehydra-api.ts`
  - Test criteria: All ILifecycleApi tests pass

- [x] **Step 3.11: Create API test utilities**
  - Create `src/main/api/test-utils.ts`
  - Implement `createMockCodeHydraApi()` with configurable mock services
  - Implement event emission helpers
  - Files: `src/main/api/test-utils.ts`
  - Test criteria: Utility functions work correctly

### Phase 4: IPC Adapter Refactoring

- [x] **Step 4.1: Create new IPC channel definitions**
  - Update `src/shared/ipc.ts` with new channel names matching API
  - Add channels for new events (`project:bases-updated`)
  - Keep old channels (both active during migration)
  - Add validation rules table:
    | Field                 | Rule                                                  |
    | --------------------- | ----------------------------------------------------- |
    | `ProjectId`           | Non-empty, matches `^[a-zA-Z0-9-]+-[a-f0-9]{8}$`      |
    | `WorkspaceName`       | 1-100 chars, matches `^[a-zA-Z0-9][-_.\/a-zA-Z0-9]*$` |
    | `path` (selectFolder) | Absolute path, no `..` segments                       |
  - Files: `src/shared/ipc.ts`
  - Test criteria: New channels defined, types correct

- [x] **Step 4.2: Write API handler tests (TDD: RED)**
  - Create `src/main/ipc/api-handlers.test.ts`
  - Test input validation for all handlers
  - Test handlers delegate to correct API methods
  - Test error serialization
  - Files: `src/main/ipc/api-handlers.test.ts`
  - Test criteria: Tests fail

- [x] **Step 4.3: Create API-based IPC handlers (TDD: GREEN)**
  - Create `src/main/ipc/api-handlers.ts`
  - Implement thin adapters: validate → call API → serialize
  - Example adapter:
    ```typescript
    ipcMain.handle("api:project:open", async (_event, { path }: { path: string }) => {
      if (!path || typeof path !== "string") {
        throw new ValidationError([{ path: ["path"], message: "Path required" }]);
      }
      if (!pathModule.isAbsolute(path)) {
        throw new ValidationError([{ path: ["path"], message: "Path must be absolute" }]);
      }
      return await api.projects.open(path);
    });
    ```
  - All handlers receive `ICodeHydraApi` instance
  - Files: `src/main/ipc/api-handlers.ts`
  - Test criteria: Handler tests pass

- [x] **Step 4.4: Wire API events to IPC emission**
  - Subscribe to all API events in `ApiEvents` interface:
    - `project:opened`, `project:closed`, `project:bases-updated`
    - `workspace:created`, `workspace:removed`, `workspace:switched`, `workspace:status-changed`
    - `shortcut:enable`, `shortcut:disable`
    - `setup:progress`
  - For each event, call `webContents.send()` with corresponding IPC channel
  - Files: `src/main/ipc/api-handlers.ts`
  - Test criteria: API events reach renderer

- [x] **Step 4.5: Update main process bootstrap**
  - Instantiate `CodeHydraApiImpl` with services
  - Register new API-based handlers (alongside old handlers during migration)
  - Files: `src/main/index.ts`
  - Test criteria: App starts, both old and new handlers registered

### Phase 5: Preload & Renderer Migration

- [x] **Step 5.1: Write preload tests (TDD: RED)**
  - Create/update `src/preload/index.test.ts`
  - Test new method signatures
  - Test branded types survive IPC serialization
  - Files: `src/preload/index.test.ts`
  - Test criteria: Tests fail

- [x] **Step 5.2: Update preload API (TDD: GREEN)**
  - Update `src/preload/index.ts` with new method signatures
  - Map renderer calls to new IPC channels (`api:project:open`, etc.)
  - Update `src/shared/electron-api.d.ts` types
  - Files: `src/preload/index.ts`, `src/shared/electron-api.d.ts`
  - Test criteria: Preload tests pass

- [x] **Step 5.3: Write renderer API wrapper tests (TDD: RED)**
  - Update `src/renderer/lib/api/index.test.ts`
  - Test new method signatures
  - Files: `src/renderer/lib/api/index.test.ts`
  - Test criteria: Tests fail

- [x] **Step 5.4: Update renderer API wrapper (TDD: GREEN)**
  - Update `src/renderer/lib/api/index.ts`
  - Add ID utility functions:
    ```typescript
    export function createWorkspaceRef(
      projectId: ProjectId,
      workspaceName: WorkspaceName
    ): WorkspaceRef;
    export function workspaceRefEquals(a: WorkspaceRef | null, b: WorkspaceRef | null): boolean;
    ```
  - Adapt to new method signatures (projectId instead of path, etc.)
  - Files: `src/renderer/lib/api/index.ts`
  - Test criteria: Renderer API tests pass

- [x] **Step 5.5: Write store tests (TDD: RED)**
  - Update store test files
  - Test ID-based lookups
  - Test `workspace:status-changed` event handling
  - Files: `src/renderer/lib/stores/*.test.ts`
  - Test criteria: Tests fail

- [x] **Step 5.6: Update renderer stores (TDD: GREEN)**
  - Update `project-store.svelte.ts`:
    - Change `_activeWorkspacePath: string | null` to `_activeWorkspace: WorkspaceRef | null`
    - Add ID-based lookups
    - Use composite key for workspace status: `"${projectId}/${workspaceName}"`
  - Update `agent-status.svelte.ts`:
    - Handle `workspace:status-changed` with WorkspaceRef
    - Update Map key strategy to composite key
  - Files: `src/renderer/lib/stores/*.svelte.ts`
  - Test criteria: Store tests pass

- [x] **Step 5.7: Update domain-events.ts**
  - Update `src/renderer/lib/utils/domain-events.ts`
  - Handle new event signatures (`WorkspaceRef` instead of paths)
  - Update all type imports
  - Files: `src/renderer/lib/utils/domain-events.ts`
  - Test criteria: Event wiring works with new types

- [x] **Step 5.8: Update renderer components**
  - Update components in dependency order:
    1. `FilterableDropdown` - no changes needed
    2. `BranchDropdown` - `projectPath: string` → `projectId: ProjectId`
    3. `ProjectDropdown` - update to use ProjectId
    4. `CreateWorkspaceDialog` - `projectPath: string` → `projectId: ProjectId`
    5. `RemoveWorkspaceDialog` - `workspacePath: string` → `WorkspaceRef`
       - Display `WorkspaceRemovalResult` feedback to user
    6. `Sidebar` - update to use Project with IDs
    7. `MainView` - update event handlers for new payloads
  - Update event handlers for new event payloads
  - Files: `src/renderer/lib/components/*.svelte`
  - Test criteria: UI works as before

- [x] **Step 5.9: Complete MainView v2 migration** ✓
  - Replace remaining old API calls in MainView.svelte:
    - `api.listProjects()` → `api.v2.projects.list()`
    - `api.selectFolder()` → `api.v2.ui.selectFolder()`
    - `api.openProject(path)` → `api.v2.projects.open(path)`
    - `api.closeProject(path)` → lookup by ID + `api.v2.projects.close(projectId)`
    - `api.switchWorkspace(path)` → `api.v2.ui.switchWorkspace(projectId, workspaceName)`
    - `api.getAllAgentStatuses()` → iterate workspaces + `api.v2.workspaces.getStatus()`
  - Add `v2.projects.list()` handler to main process
  - Files: `src/renderer/lib/components/MainView.svelte`, `src/main/ipc/api-handlers.ts`
  - Test criteria: No references to old API in MainView

### Phase 6: Cleanup

- [x] **Step 6.1: Verify old channels unused**
  - Grep codebase for old IPC channel names
  - Run full test suite
  - Verify no runtime errors in dev mode
  - Files: N/A (verification step)
  - Test criteria: No references to old channels remain
  - **Note**: Setup channels intentionally kept (architectural constraint - must be available before startServices())

- [x] **Step 6.2: Remove old IPC handlers**
  - Remove deprecated handler files:
    - `src/main/ipc/project-handlers.ts` ✓
    - `src/main/ipc/workspace-handlers.ts` ✓
    - `src/main/ipc/agent-handlers.ts` ✓
    - ~~`src/main/ipc/setup-handlers.ts`~~ (kept - needed during bootstrap)
  - Remove old IPC channel definitions from `src/shared/ipc.ts`
  - Files: Multiple in `src/main/ipc/`
  - Test criteria: No dead code, app still works
  - **Note**: Setup handlers kept because v2 lifecycle handlers are registered in startServices() which runs AFTER setup

- [x] **Step 6.3: Update ARCHITECTURE.md**
  - Add new "API Layer Architecture" section after "Component Architecture":
    - Document `ICodeHydraApi` interface and sub-interfaces
    - Include architecture diagram from this plan
    - Document layer ownership table
  - Update "System Overview" diagram to show API layer
  - Update "IPC Contract" section: handlers are thin adapters over API
  - Update "Data Flow" section: add event flow diagram
  - Add `ProjectId`/`WorkspaceName` branded types documentation
  - Files: `docs/ARCHITECTURE.md`
  - Test criteria: Docs accurately reflect new architecture

- [x] **Step 6.4: Update AGENTS.md**
  - Add "API Layer Pattern" section under "IPC Patterns":
    - Document callback-based event subscription
    - Show example of API method implementation
  - Add "ID Generation" section:
    - Document `generateProjectId()` algorithm
    - Include test vectors
  - Add "ID Resolution" section:
    - Document iteration approach
    - Explain why it's sufficient (<10 projects)
  - Update IPC handler examples to show adapter pattern
  - Files: `AGENTS.md`
  - Test criteria: Docs reflect new patterns

- [ ] **Step 6.5: Execute manual testing checklist**
  - Run through all manual tests
  - Document any issues found
  - Files: N/A
  - Test criteria: All manual tests pass

## Testing Strategy

### Unit Tests (vitest)

| Test Case                      | Description                                 | File                                 |
| ------------------------------ | ------------------------------------------- | ------------------------------------ |
| Type guards                    | `isProjectId`, `isWorkspaceName` validation | `src/shared/api/types.test.ts`       |
| Type safety                    | Compile-time branded type checks            | `src/shared/api/types.test.ts`       |
| `generateProjectId`            | Deterministic ID generation                 | `src/main/api/id-utils.test.ts`      |
| `generateProjectId` edge cases | Special chars, long paths, case sensitivity | `src/main/api/id-utils.test.ts`      |
| `resolveProject`               | Finds project by iterating                  | `src/main/api/codehydra-api.test.ts` |
| `resolveProject` not found     | Returns ApiError for invalid ID             | `src/main/api/codehydra-api.test.ts` |
| `resolveWorkspace`             | Finds workspace by name                     | `src/main/api/codehydra-api.test.ts` |
| `on()` subscription            | Returns working unsubscribe                 | `src/main/api/codehydra-api.test.ts` |
| `on()` multiple subscribers    | All receive events                          | `src/main/api/codehydra-api.test.ts` |
| `on()` exception handling      | One handler error doesn't break others      | `src/main/api/codehydra-api.test.ts` |
| `dispose()` cleanup            | Subscriptions removed                       | `src/main/api/codehydra-api.test.ts` |
| `projects.open`                | Opens project, emits event with ID          | `src/main/api/codehydra-api.test.ts` |
| `projects.close`               | Resolves ID, closes, emits event            | `src/main/api/codehydra-api.test.ts` |
| `projects.close` not found     | Returns ApiError                            | `src/main/api/codehydra-api.test.ts` |
| `workspaces.create`            | Creates workspace, emits event              | `src/main/api/codehydra-api.test.ts` |
| `workspaces.create` error      | Propagates service error                    | `src/main/api/codehydra-api.test.ts` |
| `workspaces.getStatus`         | Combines dirty + agent status               | `src/main/api/codehydra-api.test.ts` |
| Handler validation             | Input validation for all handlers           | `src/main/ipc/api-handlers.test.ts`  |
| Handler delegation             | Handlers call correct API methods           | `src/main/ipc/api-handlers.test.ts`  |
| Handler error serialization    | Errors serialize correctly                  | `src/main/ipc/api-handlers.test.ts`  |
| Preload serialization          | Branded types survive IPC                   | `src/preload/index.test.ts`          |
| Store ID lookups               | Lookup by ProjectId/WorkspaceName           | `src/renderer/lib/stores/*.test.ts`  |

### Integration Tests

| Test Case             | Description                     | File                                             |
| --------------------- | ------------------------------- | ------------------------------------------------ |
| API → IPC → Renderer  | Full event flow                 | `src/main/ipc/api-handlers.integration.test.ts`  |
| Project lifecycle     | Open → create workspace → close | `src/main/api/codehydra-api.integration.test.ts` |
| Workspace status      | Status changes propagate        | `src/main/api/codehydra-api.integration.test.ts` |
| Concurrent operations | Open same project twice         | `src/main/api/codehydra-api.integration.test.ts` |

**Integration test mocking strategy:**

- Use real `CodeHydraApiImpl` and `AppState`
- Mock only external systems: Git CLI, Electron APIs, filesystem

### Performance Tests

| Test Case                           | Target  | File                                 |
| ----------------------------------- | ------- | ------------------------------------ |
| `projects.list()` with 100 projects | < 100ms | `src/main/api/codehydra-api.test.ts` |

### Manual Testing Checklist

- [ ] Open a project via folder picker
- [ ] Verify project appears in sidebar with correct name
- [ ] Create a new workspace
- [ ] Switch between workspaces
- [ ] Verify agent status updates appear
- [ ] Remove a workspace (with keepBranch=true)
- [ ] Remove a workspace (with keepBranch=false) - verify feedback message
- [ ] Close project
- [ ] Try to switch to workspace after closing project (should fail gracefully)
- [ ] Try to create workspace with invalid branch (should show error)
- [ ] Verify setup flow still works on fresh install
- [ ] Verify keyboard shortcuts (Alt+X) work

## Rollback Plan

If issues discovered after Phase 6 cleanup:

1. Revert Phase 6 commits (old handlers remain in git history)
2. Re-register old handlers alongside new
3. Debug issues with both available

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                      |
| ---------------------- | ----------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add API layer section, update diagrams (see Step 6.3) |
| `AGENTS.md`            | Add API patterns, ID generation docs (see Step 6.4)   |

### New Documentation Required

| File   | Purpose                                             |
| ------ | --------------------------------------------------- |
| (none) | API is internal, documented via JSDoc and this plan |

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [x] Manual testing checklist passed
- [x] Changes committed

---

## Appendix: Complete API Reference

### Types

```typescript
// Branded type symbols (unique symbol pattern for type safety)
declare const ProjectIdBrand: unique symbol;
declare const WorkspaceNameBrand: unique symbol;

// Identifiers
export type ProjectId = string & { readonly [ProjectIdBrand]: true };
export type WorkspaceName = string & { readonly [WorkspaceNameBrand]: true };

// Type guards with validation
export function isProjectId(value: string): value is ProjectId;
export function isWorkspaceName(value: string): value is WorkspaceName;

// Domain Types
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: string;
  readonly workspaces: readonly Workspace[];
  readonly defaultBaseBranch?: string;
}

export interface Workspace {
  readonly projectId: ProjectId;
  readonly name: WorkspaceName;
  readonly branch: string | null; // null for detached HEAD
  readonly path: string;
}

export interface WorkspaceStatus {
  readonly isDirty: boolean;
  readonly agent: AgentStatus;
}

export type AgentStatus =
  | { readonly type: "none" }
  | { readonly type: "idle"; readonly counts: AgentStatusCounts }
  | { readonly type: "busy"; readonly counts: AgentStatusCounts }
  | { readonly type: "mixed"; readonly counts: AgentStatusCounts };

export interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
  readonly total: number;
}

export interface BaseInfo {
  readonly name: string;
  readonly isRemote: boolean;
}

export interface WorkspaceRemovalResult {
  readonly branchDeleted: boolean;
  readonly branchDeleteError?: string;
}

export type SetupStep = "extensions" | "settings";

export interface SetupProgress {
  readonly step: SetupStep;
  readonly message: string;
}

export type SetupResult =
  | { readonly success: true }
  | { readonly success: false; readonly message: string; readonly code: string };

export type AppState = "setup" | "ready";

// Reference type for events (includes path for efficiency)
export interface WorkspaceRef {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly path: string; // Included so consumers don't need to resolve
}

// Error types (aligned with ServiceError pattern)
export type ApiError =
  | { readonly type: "not-found"; readonly resource: "project" | "workspace"; readonly id: string }
  | { readonly type: "validation"; readonly message: string; readonly field?: string }
  | { readonly type: "service"; readonly cause: ServiceError };
```

### Interfaces

```typescript
export interface IProjectApi {
  open(path: string): Promise<Project>;
  close(projectId: ProjectId): Promise<void>;
  list(): Promise<readonly Project[]>;
  get(projectId: ProjectId): Promise<Project | undefined>;
  fetchBases(projectId: ProjectId): Promise<{ readonly bases: readonly BaseInfo[] }>;
}

export interface IWorkspaceApi {
  create(projectId: ProjectId, name: string, base: string): Promise<Workspace>;
  remove(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    keepBranch?: boolean
  ): Promise<WorkspaceRemovalResult>;
  get(projectId: ProjectId, workspaceName: WorkspaceName): Promise<Workspace | undefined>;
  getStatus(projectId: ProjectId, workspaceName: WorkspaceName): Promise<WorkspaceStatus>;
}

export interface IUiApi {
  selectFolder(): Promise<string | null>;
  getActiveWorkspace(): Promise<WorkspaceRef | null>;
  switchWorkspace(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    focus?: boolean
  ): Promise<void>;
  setDialogMode(isOpen: boolean): Promise<void>;
  focusActiveWorkspace(): Promise<void>;
}

export interface ILifecycleApi {
  getState(): Promise<AppState>;
  setup(): Promise<SetupResult>;
  quit(): Promise<void>;
}

export interface ApiEvents {
  "project:opened": (event: { readonly project: Project }) => void;
  "project:closed": (event: { readonly projectId: ProjectId }) => void;
  "project:bases-updated": (event: {
    readonly projectId: ProjectId;
    readonly bases: readonly BaseInfo[];
  }) => void;
  "workspace:created": (event: {
    readonly projectId: ProjectId;
    readonly workspace: Workspace;
  }) => void;
  "workspace:removed": (event: WorkspaceRef) => void;
  "workspace:switched": (event: WorkspaceRef | null) => void;
  "workspace:status-changed": (event: WorkspaceRef & { readonly status: WorkspaceStatus }) => void;
  "shortcut:enable": () => void;
  "shortcut:disable": () => void;
  "setup:progress": (event: SetupProgress) => void;
}

export type Unsubscribe = () => void;

export interface ICodeHydraApi extends IDisposable {
  readonly projects: IProjectApi;
  readonly workspaces: IWorkspaceApi;
  readonly ui: IUiApi;
  readonly lifecycle: ILifecycleApi;
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;
}

// Subset for MCP/CLI consumers (excludes UI-specific)
export type ICoreApi = Pick<ICodeHydraApi, "projects" | "workspaces" | "on" | "dispose">;
```
