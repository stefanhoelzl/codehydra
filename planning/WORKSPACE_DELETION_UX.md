---
status: COMPLETED
last_updated: 2025-12-28
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

# WORKSPACE_DELETION_UX

## Overview

- **Problem**: When a workspace is being deleted, users can still trigger deletion again (X button, Alt+X+Del, shortcut overlay shows Del hint). After deletion fails, the spinner continues showing instead of an error indicator.
- **Solution**: Disable deletion triggers during active deletion, show spinner only while in progress, show warning icon on failure, hide Del shortcut hint during deletion.
- **Risks**: None - purely UI state management changes.
- **Alternatives Considered**: None needed - straightforward UX fix.

## Architecture

```
DeletionProgress state:
┌─────────────────────────────────────────────────────────────┐
│  workspacePath: string                                      │
│  completed: boolean                                         │
│  hasErrors: boolean                                         │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  Helper Function (NEW)                                      │
│  ─────────────────────                                      │
│  getDeletionStatus(path) → "none" | "in-progress" | "error" │
│                                                             │
│  Replaces existing isDeleting() for clarity                 │
└─────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
┌────────────┐ ┌──────────┐ ┌─────────────────┐
│ Sidebar    │ │shortcuts │ │ ShortcutOverlay │
│ ──────────│ │──────────│ │ ───────────────│
│ X button:  │ │handleDia-│ │ showDelete:     │
│ - hidden   │ │log: skip │ │ - false when    │
│   when in- │ │ if in-   │ │   in-progress   │
│   progress │ │ progress │ │                 │
│   or error │ │          │ │                 │
│ Indicator: │ │          │ │                 │
│ - spinner  │ │          │ │                 │
│   if in-   │ │          │ │                 │
│   progress │ │          │ │                 │
│ - ⚠ if     │ │          │ │                 │
│   error    │ │          │ │                 │
└────────────┘ └──────────┘ └─────────────────┘
```

## State Transitions

```
Normal ──(start deletion)──► In-Progress ──(success)──► [state cleared]
                                   │
                                   ├──(failure)──► Error
                                   │                 │
                                   │    (retry)──────┘
                                   │        │
                                   └────────┘
```

**Key behaviors:**

- Starting deletion: `completed: false` → status = "in-progress"
- Deletion succeeds: state is cleared entirely
- Deletion fails: `completed: true, hasErrors: true` → status = "error"
- Retry after failure: new deletion starts → status = "in-progress" (clears error)

## Implementation Steps

- [x] **Step 1: Add getDeletionStatus helper to deletion store**
  - Add `getDeletionStatus(path): "none" | "in-progress" | "error"` discriminated return type
  - Deprecate existing `isDeleting()` function (leave in place with JSDoc deprecation)
  - Files: `src/renderer/lib/stores/deletion.svelte.ts`
  - Test criteria: Returns correct status for each state (none, in-progress, error)

- [x] **Step 2: Update Sidebar expanded layout**
  - Replace `isDeleting()` calls with `getDeletionStatus()`
  - Hide X button when status is "in-progress" or "error"
  - Show spinner only when status is "in-progress"
  - Show warning triangle (⚠) when status is "error"
  - Add accessibility: `<span role="img" aria-label="Deletion failed">⚠</span>`
  - Use `color: var(--ch-danger)` for warning icon
  - Files: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Correct indicator shown for each deletion state, accessible

- [x] **Step 3: Update Sidebar minimized layout**
  - Show spinner only when status is "in-progress"
  - Show warning triangle (⚠) when status is "error" with same accessibility
  - Files: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Minimized view matches expanded behavior

- [x] **Step 4: Guard shortcut handler**
  - In `handleDialog("Delete")`, after getting `workspaceRef`, check deletion status
  - If status is "in-progress", return early without opening dialog
  - Import `getDeletionStatus` from deletion store
  - Files: `src/renderer/lib/stores/shortcuts.svelte.ts`
  - Test criteria: Alt+X+Del does nothing when deletion in progress

- [x] **Step 5: Hide Del shortcut hint during deletion**
  - Add `activeWorkspaceDeletionInProgress` prop to ShortcutOverlay
  - Update `showDelete` derived: `hasActiveWorkspace && !activeWorkspaceDeletionInProgress`
  - In MainView, pass prop using `getDeletionStatus(activeWorkspacePath.value) === "in-progress"`
  - Files: `src/renderer/lib/components/ShortcutOverlay.svelte`, `src/renderer/lib/components/MainView.svelte`
  - Test criteria: Del hint hidden when active workspace deletion in progress

- [x] **Step 6: Update USER_INTERFACE.md documentation**
  - Update "Removing a Workspace" section to document error state
  - Add mockup showing warning icon state
  - Files: `docs/USER_INTERFACE.md`
  - Test criteria: Documentation accurately reflects new behavior

## Testing Strategy

### Integration Tests

| #   | Test Case                                                        | Entry Point                                                                         | Boundary Mocks                         | Behavior Verified                                   |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| 1   | getDeletionStatus returns "none" when no state                   | `getDeletionStatus()`                                                               | None                                   | Returns "none" for unknown path                     |
| 2   | getDeletionStatus returns "in-progress" during deletion          | `setDeletionState()` → `getDeletionStatus()`                                        | None                                   | Returns "in-progress" when completed=false          |
| 3   | getDeletionStatus returns "none" after successful deletion       | `setDeletionState()` → `clearDeletion()` → `getDeletionStatus()`                    | None                                   | Returns "none" after state cleared                  |
| 4   | getDeletionStatus returns "error" on failure                     | `setDeletionState()` → `getDeletionStatus()`                                        | None                                   | Returns "error" when completed=true, hasErrors=true |
| 5   | getDeletionStatus transitions from error to in-progress on retry | `setDeletionState(error)` → `setDeletionState(in-progress)` → `getDeletionStatus()` | None                                   | Returns "in-progress" after retry starts            |
| 6   | handleDialog skips when deletion in progress                     | `handleDialog("Delete")` with mock                                                  | Mock getDeletionStatus → "in-progress" | Dialog not opened                                   |

### UI Integration Tests

| #   | Test Case                               | Category      | Component       | Behavior Verified                                   |
| --- | --------------------------------------- | ------------- | --------------- | --------------------------------------------------- |
| 1   | X button hidden during deletion         | UI-state      | Sidebar         | Button not rendered when status="in-progress"       |
| 2   | X button hidden after failure           | UI-state      | Sidebar         | Button not rendered when status="error"             |
| 3   | Spinner shown during deletion           | UI-state      | Sidebar         | Progress ring visible when status="in-progress"     |
| 4   | Warning shown after failure             | UI-state      | Sidebar         | Warning triangle visible when status="error"        |
| 5   | Warning has accessible label            | Accessibility | Sidebar         | role="img" and aria-label present                   |
| 6   | Minimized shows spinner during deletion | UI-state      | Sidebar         | Progress ring in minimized layout                   |
| 7   | Minimized shows warning on failure      | UI-state      | Sidebar         | Warning triangle in minimized layout                |
| 8   | Del hint hidden during deletion         | UI-state      | ShortcutOverlay | Del hint has hidden class when deletion in progress |
| 9   | Del hint visible when no deletion       | UI-state      | ShortcutOverlay | Del hint visible with active workspace, no deletion |

### Manual Testing Checklist

- [ ] Start workspace deletion, verify X button disappears
- [ ] During deletion, verify Del hint hidden in shortcut overlay
- [ ] During deletion, press Alt+X+Del, verify nothing happens
- [ ] During deletion, verify spinner shows in sidebar (expanded and minimized)
- [ ] Force deletion failure (e.g., lock file), verify warning icon appears
- [ ] Verify warning icon has correct color (danger/red)
- [ ] Verify minimized sidebar shows warning on failure
- [ ] Click Retry in DeletionProgressView, verify spinner replaces warning
- [ ] Verify clicking workspace with error opens DeletionProgressView

## Dependencies

None - uses existing dependencies.

## Documentation Updates

### Files to Update

| File                     | Changes Required                                              |
| ------------------------ | ------------------------------------------------------------- |
| `docs/USER_INTERFACE.md` | Add error state to "Removing a Workspace" section with mockup |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
