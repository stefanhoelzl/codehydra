---
status: COMPLETED
last_updated: 2025-12-11
reviewers:
  - review-electron
  - review-typescript
  - review-arch
  - review-testing
  - review-senior
  - review-docs
  - review-ui
---

# VIEW_DETACH_OPTIMIZATION

## Overview

- **Problem**: Keeping all WebContentsViews attached to the window consumes GPU resources even when they're hidden (zero-bounds). With >5 workspaces, GPU load becomes significant.
- **Solution**: Detach hidden views from `contentView` entirely. Only the active workspace view (and UI layer) remain attached. Detached views stay in memory but don't render. Additionally, defer URL loading until first activation to minimize initial resource usage.
- **Risks**:
  - VS Code might have visual "wake up" lag when re-attached → Mitigated by attach-before-detach ordering and acceptance threshold (<200ms)
  - Edge case: detaching during in-progress render → Mitigated by Electron's internal handling and try-catch
  - Platform-specific GPU behavior differences → Mitigated by multi-platform testing
- **Alternatives Considered**:
  - Zero-bounds (current): Still consumes GPU resources
  - webContents.setBackgroundThrottling: Only affects timers, not rendering
  - Destroy/recreate views: Would lose VS Code state, much more complex

## Architecture

```
Current (all attached, zero bounds):
┌─────────────────────────────────────────────┐
│ BaseWindow.contentView                      │
│  ├── UIView (z: bottom or top)              │
│  ├── WorkspaceView1 (bounds: full)  ◄─ GPU  │
│  ├── WorkspaceView2 (bounds: 0x0)   ◄─ GPU  │
│  ├── WorkspaceView3 (bounds: 0x0)   ◄─ GPU  │
│  └── WorkspaceView4 (bounds: 0x0)   ◄─ GPU  │
└─────────────────────────────────────────────┘

Proposed (only active attached, lazy loading):
┌─────────────────────────────────────────────┐
│ BaseWindow.contentView                      │
│  ├── UIView (z: bottom or top)              │
│  └── WorkspaceView1 (bounds: full)  ◄─ GPU  │
└─────────────────────────────────────────────┘

Memory (detached, no GPU, URL loaded):
  ├── WorkspaceView2 (webContents alive)
  └── WorkspaceView3 (webContents alive)

Memory (detached, no GPU, URL NOT loaded):
  └── WorkspaceView4 (never activated)
```

### State Invariants

1. At most one workspace view is attached at any time
2. UIView is always attached
3. If `activeWorkspacePath` is non-null, that view MUST be attached
4. If `activeWorkspacePath` is null, no workspace views are attached
5. All views in `workspaceViews` map are either attached OR detached (never destroyed while in map)
6. Views are only loaded (`loadURL`) when first activated
7. Keyboard shortcuts (Alt+X) only work on the active (attached) view

### View Lifecycle State Machine

```
                    createWorkspaceView()
                           │
                           ▼
                    ┌─────────────┐
                    │   CREATED   │  (in map, detached, URL not loaded)
                    └─────────────┘
                           │
            setActiveWorkspace(path)  [first time]
                           │
                           ▼
                    ┌─────────────┐
         ┌─────────│   ACTIVE    │─────────┐
         │         │  (attached) │         │
         │         └─────────────┘         │
         │                │                │
   setActiveWorkspace  setActiveWorkspace  destroyWorkspaceView()
      (same path)       (other/null)             │
         │                │                      │
         │ (no-op)        ▼                      ▼
         │         ┌─────────────┐        ┌─────────────┐
         └────────►│  DETACHED   │        │  DESTROYED  │
                   │ (URL loaded)│        │ (cleaned up)│
                   └─────────────┘        └─────────────┘
                          │
           setActiveWorkspace(path)
                          │
                          ▼
                   ┌─────────────┐
                   │   ACTIVE    │
                   └─────────────┘
```

## Implementation Steps

### Step 1: Write tests for createWorkspaceView changes

- [x] **Step 1a: Test - view not attached on creation**
  - Write failing test: `createWorkspaceView-not-attached: view created but NOT added to contentView`
  - Assert `addChildView` is NOT called for workspace view (only for UI view during create)
- [x] **Step 1b: Test - URL not loaded on creation**
  - Write failing test: `createWorkspaceView-url-not-loaded: loadURL not called on creation`
  - Assert `webContents.loadURL` is NOT called during `createWorkspaceView()`
  - Store the URL in the view manager for later loading

- [x] **Step 1c: Test - view stored in map**
  - Write failing test: `createWorkspaceView-stored: view accessible via getWorkspaceView`
  - Assert view is in internal map and retrievable

### Step 2: Implement createWorkspaceView changes

- [x] **Step 2a: Add URL storage and state tracking**
  - Add `private readonly workspaceUrls: Map<string, string>` to store URLs
  - Add `private attachedWorkspacePath: string | null = null` for explicit attachment tracking
  - Update interface JSDoc to reflect new behavior

- [x] **Step 2b: Update createWorkspaceView implementation**
  - Remove `addChildView()` call
  - Remove `loadURL()` call - store URL in `workspaceUrls` map instead
  - Remove `updateBounds()` call (detached views don't need bounds)
  - Keep ShortcutController registration (will work when view becomes active)
  - Verify all Step 1 tests pass

### Step 3: Write tests for setActiveWorkspace changes

- [x] **Step 3a: Test - first activation loads URL and attaches**
  - Write failing test: `setActiveWorkspace-first-activation: loads URL and attaches view`
  - Assert `loadURL` called with stored URL
  - Assert `addChildView` called
  - Assert `attachedWorkspacePath` updated

- [x] **Step 3b: Test - attach new before detach old (visual continuity)**
  - Write failing test: `setActiveWorkspace-attach-before-detach: new view attached before old detached`
  - Assert call order: `addChildView(newView)` before `removeChildView(oldView)`

- [x] **Step 3c: Test - detaches previous workspace**
  - Write failing test: `setActiveWorkspace-detaches-previous: previous active gets removeChildView`
  - Assert `removeChildView` called with previous view

- [x] **Step 3d: Test - same workspace is no-op**
  - Write failing test: `setActiveWorkspace-same-noop: same workspace doesn't detach/reattach`
  - Assert neither `addChildView` nor `removeChildView` called

- [x] **Step 3e: Test - null workspace detaches current**
  - Write failing test: `setActiveWorkspace-null-detaches: null workspace detaches current`
  - Assert `removeChildView` called, `attachedWorkspacePath` is null

- [x] **Step 3f: Test - error handling for attach failure**
  - Write failing test: `setActiveWorkspace-attach-error: handles addChildView error gracefully`
  - Mock `addChildView` to throw, assert no exception propagates, state remains consistent

- [x] **Step 3g: Test - error handling for detach failure**
  - Write failing test: `setActiveWorkspace-detach-error: handles removeChildView error gracefully`
  - Mock `removeChildView` to throw, assert no exception propagates

- [x] **Step 3h: Test - z-order maintained during dialog mode**
  - Write failing test: `setActiveWorkspace-dialog-mode-zorder: UI stays on top when in dialog mode`
  - Set dialog mode, switch workspace, assert UI layer remains on top

### Step 4: Implement setActiveWorkspace changes

- [x] **Step 4a: Extract private helper methods**
  - Add `private attachView(workspacePath: string): void` with try-catch
  - Add `private detachView(workspacePath: string): void` with try-catch
  - Add `private loadViewUrl(workspacePath: string): void` for first-time URL loading

- [x] **Step 4b: Add reentrant guard**
  - Add `private isChangingWorkspace = false` flag
  - Early return if already changing workspace

- [x] **Step 4c: Implement new setActiveWorkspace logic**

  ```typescript
  setActiveWorkspace(workspacePath: string | null, focus = true): void {
    // Early returns
    if (this.isChangingWorkspace) return;
    if (this.activeWorkspacePath === workspacePath) return;

    try {
      this.isChangingWorkspace = true;
      const previousPath = this.activeWorkspacePath;

      // Update state first
      this.activeWorkspacePath = workspacePath;

      // Attach new view FIRST (visual continuity - no gap)
      if (workspacePath !== null) {
        this.loadViewUrl(workspacePath);  // Only loads if not already loaded
        this.attachView(workspacePath);
      }

      // Then detach previous
      if (previousPath !== null && previousPath !== workspacePath) {
        this.detachView(previousPath);
      }

      // Maintain z-order if in dialog mode
      if (this.isDialogMode) {
        this.setDialogMode(true);  // Re-apply to ensure UI on top
      }

      this.updateBounds();

      // Focus after everything is set up
      if (focus && workspacePath) {
        const view = this.workspaceViews.get(workspacePath);
        view?.webContents.focus();
      }
    } finally {
      this.isChangingWorkspace = false;
    }
  }
  ```

- [x] **Step 4d: Track dialog mode state**
  - Add `private isDialogMode = false` field
  - Update `setDialogMode()` to track state

- [x] **Step 4e: Verify all Step 3 tests pass**

### Step 5: Write tests for updateBounds changes

- [x] **Step 5a: Test - only active workspace gets bounds**
  - Write failing test: `updateBounds-only-active: only active workspace bounds updated`
  - Assert `setBounds` called only for UI view and active workspace view (O(1) not O(n))

- [x] **Step 5b: Test - detached workspaces don't get setBounds**
  - Write failing test: `updateBounds-detached-no-call: detached workspaces skip setBounds`
  - Create multiple workspaces, activate one, call updateBounds
  - Assert `setBounds` NOT called on inactive views

### Step 6: Implement updateBounds changes

- [x] **Step 6a: Simplify updateBounds to O(1)**
  - Remove loop over all `workspaceViews`
  - Only update UI view bounds (always)
  - Only update active workspace bounds if `activeWorkspacePath` is set
  - Verify Step 5 tests pass

### Step 7: Write tests for destroyWorkspaceView changes

- [x] **Step 7a: Test - destroying detached view works**
  - Write failing test: `destroyWorkspaceView-detached: destroying detached view doesn't throw`
  - Create view (detached), destroy it, assert no error

- [x] **Step 7b: Test - destroying active view clears state**
  - Write failing test: `destroyWorkspaceView-active: clears activeWorkspacePath and attachedWorkspacePath`
  - Create view, activate it, destroy it
  - Assert `activeWorkspacePath` is null, `attachedWorkspacePath` is null

- [x] **Step 7c: Test - URL map cleaned up**
  - Write failing test: `destroyWorkspaceView-url-cleanup: removes URL from workspaceUrls map`

### Step 8: Implement destroyWorkspaceView changes

- [x] **Step 8a: Update destroyWorkspaceView**
  - Clear `activeWorkspacePath` if destroying active
  - Clear `attachedWorkspacePath` if destroying attached
  - Remove from `workspaceUrls` map
  - Use `detachView()` helper (handles already-detached gracefully)
  - Verify Step 7 tests pass

### Step 9: Integration tests

- [x] **Step 9a: Full flow integration test**
  - Write test: `integration-full-flow: create project → workspaces → switch → destroy`
  - Verify complete lifecycle works end-to-end

- [x] **Step 9b: Dialog mode integration test**
  - Write test: `integration-dialog-mode: dialog overlay works with detached workspaces`

- [x] **Step 9c: Rapid switching test**
  - Write test: `integration-rapid-switching: multiple workspace switches in sequence`
  - Switch 10 times rapidly, verify correct final state

- [x] **Step 9d: Multiple attach/detach cycles test**
  - Write test: `integration-multiple-cycles: view survives multiple attach/detach cycles`
  - Verify no memory leaks or state corruption after many cycles

### Step 10: Update existing tests

- [x] **Step 10a: Fix addChildView call count tests**
  - Update tests that check `addChildView` call count for workspace creation

- [x] **Step 10b: Fix zero-bounds tests**
  - Change tests for "inactive workspace gets zero bounds" to "inactive workspace is detached"

- [x] **Step 10c: Add test utilities**
  - Skipped - not needed, assertions are clear enough inline

### Step 11: Documentation updates

- [x] **Step 11a: Update ARCHITECTURE.md**
  - Update "View Management" section (~line 80): replace "Hide: Set bounds to zero" with "Hide: Detach from contentView"
  - Update "View Lifecycle" diagram (lines 85-106) to show detached state and lazy loading
  - Update line 109 to explain detach vs zero-bounds trade-offs

- [x] **Step 11b: Update view-manager.interface.ts JSDoc**
  - Update `setActiveWorkspace` docs: "Active workspace is attached with full content bounds, others are detached (not in contentView)"
  - Update `createWorkspaceView` docs: "Creates view but does not attach or load URL - view is activated via setActiveWorkspace"

- [x] **Step 11c: Update AGENTS.md**
  - Add "View Detachment Pattern" section explaining:
    - Only active workspace + UI layer are attached to contentView
    - Hidden views are detached but WebContents stays alive
    - URLs are loaded lazily on first activation
    - GPU savings rationale (>5 workspaces caused significant GPU load)

## Testing Strategy

### Unit Tests (vitest)

| Test Case                               | Description                               | File                 |
| --------------------------------------- | ----------------------------------------- | -------------------- |
| createWorkspaceView-not-attached        | View created but NOT added to contentView | view-manager.test.ts |
| createWorkspaceView-url-not-loaded      | loadURL not called on creation            | view-manager.test.ts |
| createWorkspaceView-stored              | View accessible via getWorkspaceView      | view-manager.test.ts |
| setActiveWorkspace-first-activation     | Loads URL and attaches view               | view-manager.test.ts |
| setActiveWorkspace-attach-before-detach | New view attached before old detached     | view-manager.test.ts |
| setActiveWorkspace-detaches-previous    | Previous active gets removeChildView      | view-manager.test.ts |
| setActiveWorkspace-same-noop            | Same workspace doesn't detach/reattach    | view-manager.test.ts |
| setActiveWorkspace-null-detaches        | Null workspace detaches current           | view-manager.test.ts |
| setActiveWorkspace-attach-error         | Handles addChildView error gracefully     | view-manager.test.ts |
| setActiveWorkspace-detach-error         | Handles removeChildView error gracefully  | view-manager.test.ts |
| setActiveWorkspace-dialog-mode-zorder   | UI stays on top when in dialog mode       | view-manager.test.ts |
| updateBounds-only-active                | Only active workspace bounds updated      | view-manager.test.ts |
| updateBounds-detached-no-call           | Detached workspaces skip setBounds        | view-manager.test.ts |
| destroyWorkspaceView-detached           | Destroying detached view doesn't throw    | view-manager.test.ts |
| destroyWorkspaceView-active             | Clears activeWorkspacePath                | view-manager.test.ts |
| destroyWorkspaceView-url-cleanup        | Removes URL from workspaceUrls map        | view-manager.test.ts |

### Integration Tests (vitest)

| Test Case                   | Description                                    | File                 |
| --------------------------- | ---------------------------------------------- | -------------------- |
| integration-full-flow       | Create project → workspaces → switch → destroy | view-manager.test.ts |
| integration-dialog-mode     | Dialog overlay works with detached workspaces  | view-manager.test.ts |
| integration-rapid-switching | Multiple workspace switches in sequence        | view-manager.test.ts |
| integration-multiple-cycles | View survives multiple attach/detach cycles    | view-manager.test.ts |

### Manual Testing Checklist

#### GPU Verification (measure before AND after)

- [ ] Baseline measurement: GPU usage with current main branch, 5+ workspaces (document: VRAM, GPU%, renderer processes)
- [ ] Post-implementation: Same measurement with new code
- [ ] Verify significant GPU reduction (target: >50% reduction in GPU memory with inactive views)
- [ ] Test on Linux (X11/Wayland), macOS, Windows if possible

#### Visual Quality

- [ ] No white flash between workspace switches
- [ ] No blank content area visible during switch
- [ ] Active workspace renders within 200ms of selection (acceptance threshold)
- [ ] Test rapid switching (10+ times quickly) - no visual race conditions
- [ ] Test switching between workspaces with different VS Code themes

#### Functionality

- [ ] Open project with 5+ workspaces - all create correctly
- [ ] Switch between workspaces - VS Code appears correctly each time
- [ ] Verify keyboard shortcuts (Alt+X) work after switching
- [ ] Verify terminal sessions remain responsive after switch
- [ ] Verify file watcher detects changes while workspace is detached
- [ ] Close workspace - verify no errors
- [ ] Close project - verify all views cleaned up

#### IPC Communication

- [ ] Agent status updates display correctly after workspace switch
- [ ] Document any edge cases with IPC to detached views

## Dependencies

None - uses existing Electron APIs.

## Documentation Updates

### Files to Update

| File                                        | Changes Required                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| docs/ARCHITECTURE.md                        | Update View Management section, View Lifecycle diagram, remove "bounds-based hiding" references |
| src/main/managers/view-manager.interface.ts | Update JSDoc for setActiveWorkspace and createWorkspaceView                                     |
| AGENTS.md                                   | Add "View Detachment Pattern" section with GPU savings rationale                                |

## Definition of Done

- [ ] All implementation steps complete
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (ARCHITECTURE.md, interface JSDoc, AGENTS.md)
- [ ] Manual testing checklist completed with documented measurements
- [ ] GPU savings verified (>50% reduction target)
- [ ] Visual quality verified (<200ms switch time)
- [ ] User acceptance testing passed
- [ ] Changes committed
