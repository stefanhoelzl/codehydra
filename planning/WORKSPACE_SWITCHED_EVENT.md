---
status: CODE_REVIEW_DONE
last_updated: 2024-12-29
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

# WORKSPACE_SWITCHED_EVENT

## Overview

- **Problem**: When opening a project with 0 workspaces and canceling the "Create Workspace" dialog, the title bar still shows the previous workspace's information while the view area is blank.
- **Solution**: Emit `workspace:switched` event from `ViewManager.setActiveWorkspace()` via a callback pattern, ensuring the event is always emitted when the active workspace changes.
- **Risks**: Event ordering changes slightly (workspace:switched may fire before project:opened). Verified this is acceptable since renderer handles these independently.
- **Alternatives Considered**:
  - Emit in CoreModule.projectOpen() - violates single responsibility, disconnected from actual state change
  - Move setActiveWorkspace call to CoreModule - breaks encapsulation of AppState.openProject()
  - Have ViewManager emit directly - requires domain knowledge (ProjectId) in low-level component

## Architecture

```
Before (Bug):
┌─────────────────────────────────────────────────────────────────────┐
│ AppState.openProject()                                              │
│   └─► viewManager.setActiveWorkspace(null)  ──► NO EVENT EMITTED   │
└─────────────────────────────────────────────────────────────────────┘

After (Fix):
┌─────────────────────────────────────────────────────────────────────┐
│ ViewManager.setActiveWorkspace(path)                                │
│   └─► workspaceChangeCallbacks.forEach(cb => cb(path))              │
│         │                                                           │
│         ▼                                                           │
│   ┌─────────────────────────────────────────────────────────────────┐
│   │ Callback (wired in index.ts):                                   │
│   │   path ──► appState.findProjectForWorkspace(path)               │
│   │         ──► api.emit("workspace:switched", WorkspaceRef)        │
│   └─────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────┘

Why wire in index.ts (not inside ViewManager)?
ViewManager is a low-level Electron component that manages WebContentsViews.
It shouldn't have domain knowledge (ProjectId, WorkspaceRef). The wiring layer
in index.ts translates low-level state changes (workspace path) to high-level
domain events (WorkspaceRef with projectId, workspaceName, path).
```

## Implementation Steps

- [x] **Step 1: Add onWorkspaceChange to IViewManager interface**
  - Add `onWorkspaceChange(callback: (path: string | null) => void): Unsubscribe` method signature
  - Use existing `Unsubscribe` type from line 12 of the interface file
  - Files affected: `src/main/managers/view-manager.interface.ts`
  - Test criteria: TypeScript compiles

- [x] **Step 2: Implement onWorkspaceChange in ViewManager**
  - Add `workspaceChangeCallbacks: Set<(path: string | null) => void>` private field
  - Implement `onWorkspaceChange()` method following `onModeChange` pattern exactly:
    ```typescript
    onWorkspaceChange(callback: (path: string | null) => void): Unsubscribe {
      this.workspaceChangeCallbacks.add(callback);
      return () => {
        this.workspaceChangeCallbacks.delete(callback);
      };
    }
    ```
  - Call callbacks at end of `setActiveWorkspace()` INSIDE the try block (before finally), after all state changes complete
  - Wrap each callback invocation in try-catch following the `setMode` pattern (lines 666-676):
    ```typescript
    for (const callback of this.workspaceChangeCallbacks) {
      try {
        callback(workspacePath);
      } catch (error) {
        this.logger.error(
          "Error in workspace change callback",
          {},
          error instanceof Error ? error : undefined
        );
      }
    }
    ```
  - Only invoke callbacks when workspace actually changes (path !== previousPath)
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: Callback is called when setActiveWorkspace changes the active workspace (path !== currentPath), not called when path === currentPath (no-op case)

- [x] **Step 3: Add ViewManager integration tests for onWorkspaceChange**
  - Add tests to existing `src/main/managers/view-manager.test.ts` (ViewManager already has state/side effects, existing tests are already there)
  - Test naming convention following existing pattern:
    - `onWorkspaceChange-fires-on-change: callback called when workspace changes`
    - `onWorkspaceChange-fires-null: callback called with null when set to null`
    - `onWorkspaceChange-no-op: callback NOT fired when same workspace`
    - `onWorkspaceChange-unsubscribe: unsubscribed callback not called`
    - `onWorkspaceChange-multiple: multiple callbacks all called`
  - Files affected: `src/main/managers/view-manager.test.ts`
  - Test criteria: All new tests pass

- [x] **Step 4: Wire onWorkspaceChange callback in index.ts**
  - Wire callback BEFORE `appState.loadPersistedProjects()` to ensure events are emitted during `openProject()`
  - Add comment explaining ordering dependency:
    ```typescript
    // Wire workspace change callback BEFORE loading projects
    // to ensure workspace:switched events are emitted during openProject()
    ```
  - Handle null path explicitly before calling findProjectForWorkspace:
    ```typescript
    viewManager.onWorkspaceChange((path) => {
      if (path === null) {
        api.emit("workspace:switched", null);
        return;
      }
      const project = appState.findProjectForWorkspace(path);
      if (!project) {
        // Workspace not found - skip event emission
        // This can happen during cleanup or race conditions
        return;
      }
      api.emit("workspace:switched", {
        projectId: generateProjectId(project.path),
        workspaceName: extractWorkspaceName(path),
        path,
      });
    });
    ```
  - Example emitted event: `api.emit('workspace:switched', { projectId: 'my-app-abc123', workspaceName: 'feature-x', path: '/path/to/workspace' })`
  - Note: IPC handler for 'api:workspace:switched' already exists in `src/main/ipc/api-handlers.ts` - no changes needed there
  - Files affected: `src/main/index.ts`
  - Test criteria: Event emitted when workspace changes

- [x] **Step 5: Remove manual workspace:switched emission from UIModule**
  - Remove `api.emit("workspace:switched", ...)` from `switchWorkspace()` method
  - Add comment explaining event is now emitted via ViewManager callback:
    ```typescript
    // Note: workspace:switched event is emitted via ViewManager.onWorkspaceChange callback
    // wired in index.ts, not directly here
    ```
  - Files affected: `src/main/modules/ui/index.ts`
  - Test criteria: Existing tests still pass (event now emitted by callback)

- [x] **Step 6: Remove manual workspace:switched emission from CoreModule**
  - Remove `api.emit("workspace:switched", ...)` from `switchToNextWorkspaceIfAvailable()` (2 locations: lines 501-505 and 517-522)
  - Remove `api.emit("workspace:switched", null)` from `workspaceRemove()` (line 290) and `workspaceForceRemove()` (line 316)
  - Files affected: `src/main/modules/core/index.ts`
  - Test criteria: Existing tests still pass

- [x] **Step 7: Update mock ViewManagers in tests**
  - Add `onWorkspaceChange: vi.fn().mockReturnValue(() => {})` to all mock ViewManagers
  - Find all affected files using: `rg 'onModeChange.*vi\.fn' --type ts --glob '*test.ts'` (onWorkspaceChange should be added wherever onModeChange mock exists)
  - Known affected files:
    - `src/main/modules/core/index.test.ts`
    - `src/main/modules/core/index.integration.test.ts`
    - `src/main/modules/ui/index.test.ts`
    - `src/main/bootstrap.test.ts`
    - `src/main/bootstrap.integration.test.ts`
    - `src/main/app-state.integration.test.ts`
  - Files affected: Multiple test files (see list above)
  - Test criteria: All tests compile and pass

- [x] **Step 8: Add integration tests for the bug scenario**
  - Add tests to `src/main/app-state.integration.test.ts` (existing test suite for AppState)
  - Test 1: Opening project with 0 workspaces emits workspace:switched(null) to clear title bar
    - Mock GitWorktreeProvider to return empty list from `discover()`
    - Verify onWorkspaceChange callback received `null`
  - Test 2: Opening project with workspaces emits workspace:switched with first workspace
    - Mock GitWorktreeProvider to return list with at least one workspace from `discover()`
    - Verify onWorkspaceChange callback received the first workspace path
  - Test 3: Opening empty project AFTER non-empty project emits both events (bug reproduction)
    - Open project A (has workspaces) → verify callback receives workspace path
    - Open project B (empty) → verify callback receives `null`
    - This directly reproduces the reported bug scenario
  - Files affected: `src/main/app-state.integration.test.ts`
  - Test criteria: Bug scenario is covered, all tests pass

- [x] **Step 9: Update architecture documentation**
  - Add section to `docs/ARCHITECTURE.md` explaining callback-based event emission pattern
  - Document that `workspace:switched` is emitted via ViewManager callback registered in index.ts
  - Update Event Flow section if it exists
  - Files affected: `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects the new pattern

## Testing Strategy

### Integration Tests

Test behavior through high-level entry points with behavioral mocks.

| #   | Test Case                                  | Entry Point                                   | Boundary Mocks                                   | Behavior Verified                                          |
| --- | ------------------------------------------ | --------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 1   | opening empty project clears title         | `appState.openProject(emptyProject)`          | GitWorktreeProvider (returns empty `discover()`) | `onWorkspaceChange` callback receives `null`               |
| 2   | opening project with workspaces sets title | `appState.openProject(projectWithWorkspaces)` | GitWorktreeProvider (returns workspace list)     | `onWorkspaceChange` callback receives first workspace path |
| 3   | switching from non-empty to empty project  | `openProject(A)` then `openProject(B)`        | GitWorktreeProvider (A has workspaces, B empty)  | callback receives path then null (bug repro)               |

### ViewManager Infrastructure Tests

Minimal tests to verify callback mechanism works correctly (in `view-manager.test.ts`):

| #   | Test Case                         | Behavior Verified                          |
| --- | --------------------------------- | ------------------------------------------ |
| 1   | onWorkspaceChange-fires-on-change | callback called when workspace changes     |
| 2   | onWorkspaceChange-fires-null      | callback called with null when set to null |
| 3   | onWorkspaceChange-no-op           | callback NOT fired when same workspace     |
| 4   | onWorkspaceChange-unsubscribe     | unsubscribed callback not called           |
| 5   | onWorkspaceChange-multiple        | multiple callbacks all called              |

### Manual Testing Checklist

- [ ] Open Project A with workspace W1 (title shows "Project A / W1")
- [ ] Open Project B with 0 workspaces, cancel dialog (title shows "CodeHydra" or default)
- [ ] Open Project C with workspaces (title shows "Project C / first-workspace")
- [ ] Switch workspaces via sidebar click (title updates)
- [ ] Delete active workspace (title updates to next workspace or default)

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                                          | Changes Required                                                    |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `src/main/managers/view-manager.interface.ts` | Add onWorkspaceChange to interface with JSDoc                       |
| `docs/ARCHITECTURE.md`                        | Add section on callback-based event emission for workspace:switched |

### New Documentation Required

None required.

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
