---
status: COMPLETED
last_updated: 2025-12-16
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

# WORKSPACE_DELETION_STREAMING

## Overview

- **Problem**: Workspace deletion can take time (git operations, view cleanup) and currently blocks the UI. Users see a "Removing..." spinner in the dialog and can't interact with other workspaces until deletion completes.

- **Solution**: Fire-and-forget deletion with streaming progress. The dialog closes immediately on "Remove" click, and the workspace area shows a deletion progress view with status indicators for each operation. On completion with errors, users can retry or close anyway.

- **Risks**:
  - Race conditions if user rapidly deletes multiple workspaces → Mitigation: Each workspace has independent deletion state; guard prevents double-deletion
  - View cleanup race with about:blank navigation → Mitigation: Detach view first, then cleanup asynchronously
  - Retry logic complexity with idempotent operations → Mitigation: Check state before each operation
  - Fire-and-forget async could fail silently → Mitigation: Wrap in try-catch, always emit completion event

- **Alternatives Considered**:
  1. **Show deletion page in WebContentsView**: Would require preload scripts for IPC. More complex for minimal benefit.
  2. **Background deletion without UI**: Poor UX - users don't know what's happening or if errors occurred.

> **REQUIRES USER APPROVAL**: Steps 2, 10, 11, and 13 modify API/IPC interfaces. These are contract changes between processes and require explicit user approval before implementation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Renderer Process                                │
│  ┌───────────────────────┐    ┌──────────────────────────────────────────┐  │
│  │   deletion.svelte.ts  │    │                MainView                   │  │
│  │                       │    │  ┌──────────────────────────────────────┐ │  │
│  │  Map<workspacePath,   │◄───│  │   DeletionProgressView               │ │  │
│  │    DeletionProgress>  │    │  │   (shown when workspace deleting)    │ │  │
│  │                       │    │  │                                      │ │  │
│  │  setDeletionState()   │    │  │   ✓ Cleanup VS Code     [done]       │ │  │
│  │  clearDeletion()      │    │  │   ● Cleanup workspace   [in-progress]│ │  │
│  │  isDeleting()         │    │  │                                      │ │  │
│  │  getDeletionState()   │    │  │   [Retry] [Close Anyway] (on error)  │ │  │
│  └───────────────────────┘    │  └──────────────────────────────────────┘ │  │
│           ▲                   └──────────────────────────────────────────────┘
│           │                              │
│           │  IPC: api:workspace:deletion-progress
│           │  (contains FULL state each time)
│           │                              │
└───────────┼──────────────────────────────┼──────────────────────────────────┘
            │                              │
┌───────────┼──────────────────────────────┼──────────────────────────────────┐
│           │        Main Process          ▼                                   │
│  ┌────────┴──────────────────────────────────────────────────────────────┐  │
│  │                      CodeHydraApiImpl.workspaces.remove()              │  │
│  │                                                                        │  │
│  │   Main process is SOURCE OF TRUTH for operations and their states      │  │
│  │   Tracks in-progress deletions to prevent double-deletion              │  │
│  │                                                                        │  │
│  │   1. Check if deletion already in progress → return early if so        │  │
│  │   2. Emit progress { operations: [pending, pending], completed: false }│  │
│  │   3. Return immediately (fire-and-forget)                              │  │
│  │   4. Execute operations async (wrapped in try-catch):                  │  │
│  │      ┌──────────────────────────────────────────────────────────────┐  │  │
│  │      │  Operation 1: Cleanup VS Code                                │  │  │
│  │      │    - Emit { operations: [in-progress, pending], ... }        │  │  │
│  │      │    - Detach view, navigate about:blank, clear storage, close │  │  │
│  │      │    - Emit { operations: [done, pending], ... }               │  │  │
│  │      ├──────────────────────────────────────────────────────────────┤  │  │
│  │      │  Operation 2: Cleanup workspace                              │  │  │
│  │      │    - Emit { operations: [done, in-progress], ... }           │  │  │
│  │      │    - git worktree remove + prune + branch delete             │  │  │
│  │      │    - Emit { operations: [done, done], ... }                  │  │  │
│  │      └──────────────────────────────────────────────────────────────┘  │  │
│  │   5. Emit { operations: [...], completed: true, hasErrors: ... }       │  │
│  │   6. If no errors: emit workspace:removed, update internal state       │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## UI Design

### Deletion Progress View (shown in workspace area when active workspace is being deleted)

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                     Removing workspace                         │
│                     "feature-branch"                           │
│                                                                │
│     ┌──────────────────────────────────────────────────────┐   │
│     │  ✓  Cleanup VS Code                                  │   │
│     │  ●  Cleanup workspace                                │   │
│     └──────────────────────────────────────────────────────┘   │
│                                                                │
│     ┌──────────────────────────────────────────────────────┐   │
│     │  ⚠ Error: git worktree remove failed: ...            │   │ (only if error)
│     └──────────────────────────────────────────────────────┘   │
│                                                                │
│              [ Retry ]     [ Close Anyway ]                    │ (only if completed with errors)
│                                                                │
└────────────────────────────────────────────────────────────────┘

Legend:
  ✓  = done (green checkmark)
  ●  = in-progress (spinning indicator)
  ○  = pending (gray circle)
  ✗  = error (red X)
```

### Sidebar - Workspace with deletion in progress

```
┌─────────────────────────────┐
│  my-project                 │
│    ┌─────────────────────┐  │
│    │ ● main          ×   │  │  ← Spinning indicator instead of agent status
│    └─────────────────────┘  │
│    ┌─────────────────────┐  │
│    │ ○ feature-x     ×   │  │  ← Normal agent status indicator
│    └─────────────────────┘  │
└─────────────────────────────┘
```

### User Interactions

1. **Click "Remove" in dialog**: Dialog closes immediately, deletion starts
2. **View deletion progress**: If deleted workspace was active, deletion view shows in workspace area; otherwise user can continue working
3. **Switch away during deletion**: User can switch to another workspace while deletion continues in background
4. **Error recovery**: On completion with errors, user can click "Retry" to run all operations again, or "Close Anyway" to force remove
5. **Successful completion**: Deletion view closes automatically (workspace removed), next workspace becomes active or empty state shows

## Implementation Steps

- [x] **Step 1: Add deletion progress types to shared/api/types.ts**
  - Add `DeletionOperationId` type: `"cleanup-vscode" | "cleanup-workspace"` (union for type safety)
  - Add `DeletionOperationStatus` type: `"pending" | "in-progress" | "done" | "error"`
  - Add `DeletionOperation` interface: `{ id: DeletionOperationId, label: string, status: DeletionOperationStatus, error?: string }`
  - Add `DeletionProgress` interface using branded types:
    ```typescript
    interface DeletionProgress {
      readonly workspacePath: WorkspacePath; // branded type from shared/ipc.ts
      readonly workspaceName: WorkspaceName; // branded type from shared/api/types.ts
      readonly projectId: ProjectId;
      readonly keepBranch: boolean;
      readonly operations: readonly DeletionOperation[];
      readonly completed: boolean;
      readonly hasErrors: boolean;
    }
    ```
  - Note: `keepBranch` stored for retry functionality
  - Files affected: `src/shared/api/types.ts`
  - Test criteria: Types compile, exported correctly, branded types used

- [x] **Step 2: Add IPC channel for deletion progress** ⚠️ API CHANGE
  - Add `WORKSPACE_DELETION_PROGRESS: "api:workspace:deletion-progress"` to `ApiIpcChannels`
  - Files affected: `src/shared/ipc.ts`
  - Test criteria: Channel constant exported

- [x] **Step 3: Create deletion state store (renderer)**
  - Create `src/renderer/lib/stores/deletion.svelte.ts`
  - State: `Map<workspacePath, DeletionProgress>` using `$state`
  - Actions:
    - `setDeletionState(progress: DeletionProgress)` - stores/updates state for workspace
    - `clearDeletion(workspacePath: string)` - removes state
    - `isDeleting(workspacePath: string): boolean` - checks if workspace has deletion state
    - `getDeletionState(workspacePath: string): DeletionProgress | undefined` - gets state
  - Getter: `deletionStates` - reactive access to the map
  - Files affected: New file `src/renderer/lib/stores/deletion.svelte.ts`
  - Test file: `src/renderer/lib/stores/deletion.svelte.test.ts`
  - Test criteria: Store actions work correctly, reactive updates trigger

- [x] **Step 4: Create DeletionProgressView component**
  - Create `src/renderer/lib/components/DeletionProgressView.svelte`
  - Props: `progress: DeletionProgress`, `onRetry: () => void`, `onCloseAnyway: () => void`
  - Display workspace name from progress
  - Render operation list with proper accessibility:
    - Container: `role="list"` with `aria-live="polite"` for status announcements
    - Each operation: `role="listitem"`
    - Status icons with `<span class="ch-visually-hidden">` for screen reader text:
      - pending: gray circle (○) + "Pending"
      - in-progress: `<vscode-progress-ring>` + "In progress"
      - done: green checkmark (✓) + "Complete"
      - error: red X (✗) + "Error"
  - Show error box with `role="alert"` containing first error message from operations (if any has error)
  - Show Retry/Close Anyway buttons only when `completed && hasErrors`
  - Files affected: New file `src/renderer/lib/components/DeletionProgressView.svelte`
  - Test file: `src/renderer/lib/components/DeletionProgressView.test.ts`
  - Test criteria: Renders all states correctly, buttons show/hide based on state, accessibility attributes present

- [x] **Step 5: Update Sidebar to show loading indicator for deleting workspaces**
  - Import `isDeleting` from deletion store
  - In workspace item rendering, check `isDeleting(workspace.path)`
  - Show `<vscode-progress-ring>` with explicit dimensions (`width: 16px; height: 16px`) to match AgentStatusIndicator
  - In minimized sidebar: spinner replaces status indicator dot
  - In expanded sidebar: spinner appears in same position as AgentStatusIndicator
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test file: `src/renderer/lib/components/Sidebar.test.ts`
  - Test criteria: Conditional rendering shows spinner when `isDeleting()` returns true, normal indicator otherwise

- [x] **Step 6: Update MainView to show DeletionProgressView and handle events**
  - Import deletion store and DeletionProgressView
  - Subscribe to `api:workspace:deletion-progress` IPC event in `onMount`
  - **Return cleanup function** from onMount to unsubscribe (prevent memory leaks)
  - On event:
    - Call `setDeletionState(event)` - store receives full state from main
    - If `event.completed && !event.hasErrors`: call `clearDeletion(event.workspacePath)` to auto-cleanup on success
  - In template: when `activeWorkspacePath` AND `getDeletionState(activeWorkspacePath)` exists, show DeletionProgressView instead of empty-backdrop
  - Implement `handleRetry`: call `workspaces.remove(...)` using stored progress values (see Step 15)
  - Implement `handleCloseAnyway`: call `workspaces.forceRemove()` API (defined in Step 13)
  - Files affected: `src/renderer/lib/components/MainView.svelte`
  - Test file: `src/renderer/lib/components/MainView.test.ts`
  - Test criteria: IPC subscription with cleanup, deletion view shows for active deleting workspace, auto-clears on success

- [x] **Step 7: Update RemoveWorkspaceDialog for fire-and-forget**
  - Remove `isSubmitting` state and spinner display
  - On submit: use `void` operator for fire-and-forget: `void workspaces.remove(...)`, close dialog immediately
  - Remove error handling in dialog (errors shown in deletion view instead)
  - Files affected: `src/renderer/lib/components/RemoveWorkspaceDialog.svelte`
  - Test file: `src/renderer/lib/components/RemoveWorkspaceDialog.test.ts`
  - Test criteria: Dialog closes immediately on submit, uses void operator

- [x] **Step 8: Refactor ViewManager.destroyWorkspaceView for idempotency**
  - Add early return if workspace not in maps: `if (!this.workspaceViews.has(workspacePath)) return;`
  - Check `webContents.isDestroyed()` before each webContents operation
  - Wrap `window.contentView.removeChildView(view)` in try-catch (view might already be removed)
  - Ensure all map cleanups happen first (before async operations) to prevent re-entry
  - Files affected: `src/main/managers/view-manager.ts`
  - Test file: `src/main/managers/view-manager.test.ts`
  - Test criteria: Multiple calls are no-op, no throws on already-destroyed, map cleanup happens before async ops

- [x] **Step 9: Make GitWorktreeProvider.removeWorkspace idempotent**
  - Before `git worktree remove`: call `git worktree list` and check if path exists in output; skip and log if not
  - Before `git branch -D`: call `git branch --list <name>` and check output; skip and log if not
  - Return success result even if already removed (`workspaceRemoved: true`)
  - Files affected: `src/services/git/git-worktree-provider.ts`
  - Test file: `src/services/git/git-worktree-provider.test.ts`
  - Test criteria: Multiple calls return success, no throws on already-removed

- [x] **Step 10: Implement streaming deletion in CodeHydraApiImpl** ⚠️ API CHANGE
  - Add `emitDeletionProgress: (progress: DeletionProgress) => void` callback to constructor
  - Add `inProgressDeletions: Set<string>` to track ongoing deletions and prevent double-deletion
  - Create private `executeDeletion(projectId, projectPath, workspacePath, workspaceName, keepBranch)`:
    ```typescript
    private async executeDeletion(...): Promise<void> {
      try {
        // 1. Build initial operations array
        const operations: DeletionOperation[] = [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "pending" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "pending" }
        ];
        // 2. Helper to emit full state
        const emitProgress = () => this.emitDeletionProgress({ workspacePath, workspaceName, projectId, keepBranch, operations, completed: false, hasErrors: false });
        // 3. Emit initial state
        emitProgress();
        // 4-5. Execute operations with status updates...
        // 6. Emit final state
        // 7. If no errors: emit workspace:removed, update AppState
      } catch (error) {
        // Always emit completion on unexpected error - never leave UI in limbo
        this.emitDeletionProgress({ ..., completed: true, hasErrors: true });
      } finally {
        this.inProgressDeletions.delete(workspacePath);
      }
    }
    ```
  - Modify `workspaces.remove()` to:
    1. Validate inputs, resolve paths (synchronous validation)
    2. Check `if (this.inProgressDeletions.has(workspacePath))` → return `{ started: true }` early (already running)
    3. Add to `inProgressDeletions`
    4. Call `executeDeletion()` without await (fire-and-forget via `void` operator)
    5. Return `{ started: true }` immediately
  - Files affected: `src/main/api/codehydra-api.ts`
  - Test file: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Returns immediately, progress events emitted with full state, double-deletion prevented, errors always emit completion

- [x] **Step 11: Update API interface and return type** ⚠️ API CHANGE
  - Change `IWorkspaceApi.remove()` return type from `WorkspaceRemovalResult` to `{ started: true }`
  - Update renderer API types to match
  - Add explicit return type annotation in preload: `Promise<{ started: true }>`
  - Files affected: `src/shared/api/interfaces.ts`, `src/preload/index.ts`
  - Test criteria: Types compile, remove() returns `{ started: true }`, no type errors in renderer

- [x] **Step 12: Wire deletion progress emission in main process**
  - In `startServices()` where CodeHydraApiImpl is created
  - Pass `emitDeletionProgress` callback:
    ```typescript
    (progress) => {
      try {
        uiWebContents?.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
      } catch (e) {
        // Log but don't throw - deletion continues even if UI disconnected
      }
    };
    ```
  - Files affected: `src/main/index.ts`
  - Test criteria: Events reach renderer, errors logged but not thrown

- [x] **Step 13: Add forceRemove API for Close Anyway** ⚠️ API CHANGE
  - Add `workspaces.forceRemove(projectId: ProjectId, workspaceName: WorkspaceName): Promise<void>`
  - Implementation: clean up internal state (AppState), emit `workspace:removed`
  - Does NOT run cleanup operations (view/git) - leaves potential orphans (acceptable for "force" operation)
  - Add IPC handler with validation
  - Files affected: `src/main/api/codehydra-api.ts`, `src/shared/api/interfaces.ts`, `src/main/ipc/api-handlers.ts`, `src/preload/index.ts`
  - Test file: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Workspace removed from state, event emitted, no cleanup operations run

- [x] **Step 14: Implement Close Anyway handler in MainView**
  - Call `workspaces.forceRemove(progress.projectId, progress.workspaceName)`
  - Call `clearDeletion(workspacePath)` after API call succeeds
  - Files affected: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: Workspace removed from UI, deletion state cleared

- [x] **Step 15: Implement Retry handler in MainView**
  - Get stored progress: `getDeletionState(activeWorkspacePath)`
  - Call `void workspaces.remove(progress.projectId, progress.workspaceName, progress.keepBranch)`
  - Main process will emit new progress events, store will be updated automatically
  - Note: Idempotent operations that already succeeded return immediately without re-emitting progress
  - Files affected: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: New deletion starts, uses void operator

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                        | Description                                           | File                            |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------- |
| deletion store - setDeletionState                | Stores progress state by workspacePath                | `deletion.svelte.test.ts`       |
| deletion store - clearDeletion                   | Removes state for workspace                           | `deletion.svelte.test.ts`       |
| deletion store - isDeleting                      | Returns true only for stored workspaces               | `deletion.svelte.test.ts`       |
| deletion store - getDeletionState                | Returns stored state or undefined                     | `deletion.svelte.test.ts`       |
| DeletionProgressView - pending ops               | Shows gray circles with sr-only "Pending" text        | `DeletionProgressView.test.ts`  |
| DeletionProgressView - in-progress op            | Shows spinner with sr-only "In progress" text         | `DeletionProgressView.test.ts`  |
| DeletionProgressView - done ops                  | Shows green checkmarks with sr-only "Complete" text   | `DeletionProgressView.test.ts`  |
| DeletionProgressView - error op                  | Shows red X, error box with role="alert"              | `DeletionProgressView.test.ts`  |
| DeletionProgressView - completed no errors       | No buttons shown                                      | `DeletionProgressView.test.ts`  |
| DeletionProgressView - completed with errors     | Shows Retry and Close Anyway buttons                  | `DeletionProgressView.test.ts`  |
| DeletionProgressView - first error shown         | Error box shows first operation error message         | `DeletionProgressView.test.ts`  |
| MainView - subscribes to deletion-progress       | IPC subscription registered on mount                  | `MainView.test.ts`              |
| MainView - unsubscribes on unmount               | Cleanup function returned from onMount                | `MainView.test.ts`              |
| MainView - shows DeletionProgressView            | When active workspace is deleting                     | `MainView.test.ts`              |
| MainView - hides DeletionProgressView            | When switching to non-deleting workspace              | `MainView.test.ts`              |
| MainView - does not show for non-active          | When non-active workspace is deleting                 | `MainView.test.ts`              |
| MainView - auto-clears on success                | Calls clearDeletion when completed && !hasErrors      | `MainView.test.ts`              |
| MainView - retry calls remove                    | With stored projectId, workspaceName, keepBranch      | `MainView.test.ts`              |
| MainView - closeAnyway calls forceRemove         | Then clears deletion state                            | `MainView.test.ts`              |
| Sidebar - shows spinner when deleting            | isDeleting() returns true shows progress-ring         | `Sidebar.test.ts`               |
| Sidebar - shows agent status when not deleting   | isDeleting() returns false shows AgentStatusIndicator | `Sidebar.test.ts`               |
| ViewManager - idempotent destroy                 | Second call is no-op, no throws                       | `view-manager.test.ts`          |
| ViewManager - cleanup order                      | Map removal happens before async operations           | `view-manager.test.ts`          |
| GitWorktreeProvider - idempotent remove worktree | Returns success if already removed                    | `git-worktree-provider.test.ts` |
| GitWorktreeProvider - idempotent delete branch   | Returns success if branch gone                        | `git-worktree-provider.test.ts` |
| CodeHydraApiImpl - remove returns immediately    | Returns { started: true } before ops complete         | `codehydra-api.test.ts`         |
| CodeHydraApiImpl - emits full state              | Each progress event has complete operations array     | `codehydra-api.test.ts`         |
| CodeHydraApiImpl - prevents double-deletion      | Second remove() returns early if already in progress  | `codehydra-api.test.ts`         |
| CodeHydraApiImpl - error emits completion        | Unhandled error still emits completed: true           | `codehydra-api.test.ts`         |
| CodeHydraApiImpl - forceRemove no ops            | Cleans state without running operations               | `codehydra-api.test.ts`         |

### Integration Tests

| Test Case                                       | Description                                                  | File                                |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| deletion flow - success                         | Events: pending→in-progress→done for each op, then completed | `codehydra-api.integration.test.ts` |
| deletion flow - success clears state            | Completed with no errors triggers state cleanup              | `codehydra-api.integration.test.ts` |
| deletion flow - cleanup-vscode error            | First op fails, error in first operation                     | `codehydra-api.integration.test.ts` |
| deletion flow - cleanup-workspace error         | Second op fails, error in second operation                   | `codehydra-api.integration.test.ts` |
| deletion flow - retry after error               | Second remove() re-runs, idempotent ops skip done            | `codehydra-api.integration.test.ts` |
| deletion flow - forceRemove                     | Removes from state without operations                        | `codehydra-api.integration.test.ts` |
| deletion flow - concurrent different workspaces | Multiple deletions run independently                         | `codehydra-api.integration.test.ts` |
| deletion flow - every event has full state      | All operations present in every progress emission            | `codehydra-api.integration.test.ts` |

### Manual Testing Checklist

- [ ] Click Remove in dialog → dialog closes immediately
- [ ] Deletion progress view shows for active workspace being deleted
- [ ] Operations show correct status icons as they progress (pending→in-progress→done)
- [ ] Screen reader announces status changes (aria-live)
- [ ] Sidebar shows spinning indicator for deleting workspace (both layouts)
- [ ] Can switch to another workspace during deletion
- [ ] Successful deletion: workspace removed from sidebar, view disappears automatically
- [ ] Error during deletion: error icon on failed op, error box shows with role="alert", buttons appear
- [ ] Retry button restarts deletion (completed ops stay done if idempotent)
- [ ] Close Anyway removes workspace despite errors
- [ ] Deleting non-active workspace: no deletion view shown, sidebar shows spinner
- [ ] Multiple concurrent deletions work independently
- [ ] Double-clicking Remove doesn't start two deletions

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/USER_INTERFACE.md` | Add new section "Deletion Progress View" with UI mockup and state transitions. Update "Removing a Workspace" section to document fire-and-forget behavior, progress view display conditions, error recovery flow (Retry/Close Anyway buttons), and concurrent deletion support. |
| `docs/ARCHITECTURE.md`   | Update "Workspace Cleanup" section to document streaming deletion architecture, operation states (pending/in-progress/done/error), and event flow. Document the fire-and-forget IPC approach and double-deletion prevention.                                                    |
| `AGENTS.md`              | Add to "IPC Patterns" section: document fire-and-forget with `void` operator, progress events with full state emission, and operation state machine pattern for potential reuse.                                                                                                |

### New Documentation Required

| File   | Purpose                           |
| ------ | --------------------------------- |
| (none) | No new documentation files needed |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
