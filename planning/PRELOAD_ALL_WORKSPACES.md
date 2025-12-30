---
status: COMPLETED
last_updated: 2025-12-30
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# PRELOAD_ALL_WORKSPACES

## Overview

- **Problem**: Workspaces are lazy-loaded - URLs only load when user navigates to them. This causes a delay when switching between workspaces as code-server needs to initialize.
- **Solution**: Preload all workspace URLs in parallel when a project opens, while keeping views detached (preserving GPU optimization).
- **Risks**: Loading many workspaces simultaneously could increase memory usage (~50-100MB per workspace due to Chromium renderer process overhead). Acceptable for typical usage (<10 workspaces). Mitigated by keeping views detached (no GPU overhead).
- **Alternatives Considered**:
  - Sequential loading with "wait for green": More controlled but slower and more complex
  - No preloading (current): Simpler but poor UX when switching workspaces

**Related Documentation**:

- [View Detachment Pattern](../AGENTS.md) - Current lazy-loading behavior this plan changes
- [View Lifecycle](../docs/ARCHITECTURE.md) - State machine for view lifecycle

## Architecture

```
Current Flow:
┌─────────────────────────────────────────────────────────────┐
│ openProject()                                               │
│   ├─► createWorkspaceView() - view created, URL stored      │
│   ├─► startOpenCodeServer() - server starts                 │
│   └─► setActiveWorkspace(first) - loads URL for first only  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ User navigates to workspace                                 │
│   └─► setActiveWorkspace() - loads URL (delay here!)        │
└─────────────────────────────────────────────────────────────┘

New Flow:
┌─────────────────────────────────────────────────────────────┐
│ openProject()                                               │
│   ├─► createWorkspaceView() - view created, URL stored      │
│   ├─► startOpenCodeServer() - server starts                 │
│   ├─► setActiveWorkspace(first) - attaches first view       │
│   └─► preloadWorkspaceUrl() for others ◄─ NEW (after active)│
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ User navigates to workspace                                 │
│   └─► setActiveWorkspace() - view already loaded, instant!  │
└─────────────────────────────────────────────────────────────┘
```

**Key Behaviors**:

- `preloadWorkspaceUrl()` loads URL via `loadViewUrl()` which is fire-and-forget (`void webContents.loadURL()`)
- Preloading failures are non-fatal - errors are logged but don't block other workspaces
- Preloading does NOT affect loading state tracking (`loadingWorkspaces` map) - loading overlay still shows until OpenCode client attaches
- Views remain detached (no GPU usage) until `setActiveWorkspace()` is called

## Implementation Steps

- [x] **Step 1: Add preloadWorkspaceUrl to IViewManager interface**
  - Add method signature to `src/main/managers/view-manager.interface.ts`
  - Document that it loads URL without attaching view
  - Note idempotent behavior (safe to call multiple times or for already-loaded views)
  - Document precondition: workspace must exist (created via `createWorkspaceView()`)
  - Files affected: `src/main/managers/view-manager.interface.ts`
  - Test criteria: Interface compiles, method is documented

- [x] **Step 2: Implement preloadWorkspaceUrl in ViewManager**
  - Add public method that delegates to existing `loadViewUrl()`
  - `loadViewUrl()` is idempotent (checks `loadedWorkspaces` Set), safe to call if URL already loaded
  - `loadViewUrl()` does NOT attach view, does NOT affect `loadingWorkspaces` state
  - Add debug-level logging: `this.logger.debug("Preloading URL", { workspace: workspaceName })`
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: Method calls loadViewUrl, URL loads without attaching

- [x] **Step 3: Call preloadWorkspaceUrl in AppState.openProject()**
  - After `setActiveWorkspace(first)`, loop through remaining workspaces and preload
  - All preloads happen in parallel (no await between calls)
  - Failures are non-fatal (fire-and-forget pattern from `loadViewUrl`)
  - Files affected: `src/main/app-state.ts`
  - Test criteria: All workspace URLs load when project opens

- [x] **Step 4: Update mock in tests**
  - Add `preloadWorkspaceUrl` to mock ViewManager factory
  - Files affected: `src/main/app-state.test.ts` (if mock needs updating)
  - Test criteria: Existing tests pass, mock has new method

## Testing Strategy

### Integration Tests

Test outcomes, not implementation calls. Use behavioral mocks that track state.

| #   | Test Case                                                 | Entry Point                         | Boundary Mocks                                                         | Behavior Verified                                                           |
| --- | --------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | preloading workspace loads content without attaching view | `ViewManager.preloadWorkspaceUrl()` | Electron WebContentsView (tracks URL via `getURL()`, attachment state) | After preload: `getURL()` returns loaded URL AND view is not in contentView |
| 2   | preloading same workspace multiple times is idempotent    | `ViewManager.preloadWorkspaceUrl()` | Electron WebContentsView                                               | Outcome after 2 calls identical to 1 call (URL loaded, view detached)       |
| 3   | opening project preloads all workspace URLs               | `AppState.openProject()`            | ViewManager behavioral mock (tracks loaded URLs per workspace)         | All workspace views have URLs loaded AND remain detached except first       |
| 4   | switching to preloaded workspace is instant               | `ViewManager.setActiveWorkspace()`  | Electron WebContentsView                                               | After preload + setActive: view attached without loadURL call               |
| 5   | openProject with no workspaces does not fail              | `AppState.openProject()`            | ViewManager mock                                                       | No errors thrown, no preload calls                                          |
| 6   | openProject handles URL load failures gracefully          | `AppState.openProject()`            | ViewManager mock (one workspace fails)                                 | Other workspaces still load, project usable                                 |

### Manual Testing Checklist

- [ ] Open a project with multiple workspaces
- [ ] Verify first workspace loads and displays normally
- [ ] Switch to second workspace - should be instant (no loading delay)
- [ ] Check memory usage in Task Manager/Activity Monitor with 5+ workspaces - should increase linearly per workspace
- [ ] Verify workspace views remain detached until navigated to (loading overlay still shows until green)
- [ ] Test with project that has no workspaces - should not error

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Update View Detachment Pattern section: Change "URL not loaded (lazy loading)" to "URL preloaded in parallel during project open". Update "On first activation: URL is loaded" to "On first activation: view is attached (URL already loaded)". |
| `docs/ARCHITECTURE.md` | Update View Lifecycle section: Change "Lazy URL loading defers resource usage until workspace is first activated" to document that URLs are preloaded during project open. Update state diagram if present.                                     |

### New Documentation Required

None required.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
