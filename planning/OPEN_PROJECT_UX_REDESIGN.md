---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-25
reviewers: []
---

# OPEN_PROJECT_UX_REDESIGN

## Overview

- **Problem**: Opening a project and creating a workspace are currently separate flows. The "Open Project" button in the sidebar and Alt+X+O shortcut add UI complexity. When users have no workspaces, they see an empty state rather than being guided to create one.

- **Solution**: Consolidate project opening into the Create Workspace dialog by adding a folder icon next to the Project dropdown. Remove the standalone "Open Project" button and Alt+X+O shortcut. Auto-show the Create Workspace dialog whenever there are 0 workspaces.

- **Risks**:
  - Edge case timing: Dialog might appear during deletion. Mitigated by checking deletion state before auto-showing.
  - Projects with no branches: Existing behavior handles this gracefully.
  - Zero projects state: When user has no projects open, the dialog cannot auto-show. The folder icon in the dialog provides the entry point.

- **Alternatives Considered**:
  - Keep separate "Open Project" button but add quick-create: Rejected as it doesn't simplify the UX.
  - Inline dialog in empty state: Rejected - modal dialog is more consistent with existing patterns.

## Architecture

No architectural changes required. This is a UI refactor within the renderer layer:

```
┌─────────────────────────────────────────────────────────────────┐
│                         MainView.svelte                          │
│  ┌─────────────┐  ┌──────────────────────────────────────────┐  │
│  │   Sidebar    │  │          CreateWorkspaceDialog            │  │
│  │  (modified)  │  │  ┌───────────────────────────────────┐   │  │
│  │  - Remove    │  │  │ Project dropdown + folder icon    │   │  │
│  │    Open Proj │  │  │ (opens folder picker, auto-select)│   │  │
│  │    button    │  │  └───────────────────────────────────┘   │  │
│  └─────────────┘  └──────────────────────────────────────────┘  │
│                                                                  │
│  + Auto-show dialog when getAllWorkspaces().length === 0         │
└──────────────────────────────────────────────────────────────────┘
```

Files affected:

- `src/renderer/lib/components/CreateWorkspaceDialog.svelte` - Add folder icon
- `src/renderer/lib/components/Sidebar.svelte` - Remove Open Project button
- `src/renderer/lib/components/MainView.svelte` - Auto-show dialog logic
- `src/renderer/lib/components/ShortcutOverlay.svelte` - Remove "O Open" hint
- `src/renderer/lib/stores/shortcuts.svelte.ts` - Remove "o" key handling
- `src/shared/shortcuts.ts` - Remove "o" from SHORTCUT_KEYS

## UI Design

### Create Workspace Dialog with Folder Icon

```
┌──────────────────────────────────────────┐
│  Create Workspace                        │
│                                          │
│  Project                                 │
│  ┌─────────────────────────────┐ ┌───┐  │
│  │ my-project              ▼   │ │[F]│  │ ← Folder icon button (vscode-button)
│  └─────────────────────────────┘ └───┘  │
│                                          │
│  Name                                    │
│  [________________________________]      │
│                                          │
│  Base Branch                             │
│  [main_____________________________▼]    │
│                                          │
│                   [Cancel]  [Create]     │
└──────────────────────────────────────────┘
```

### User Interactions

- **Folder icon click**: Opens native folder picker. On successful selection:
  1. Calls `api.projects.open(path)` to add project
  2. Auto-selects the new project in the dropdown
  3. Moves focus to the Name input field for efficient form completion
  4. If error (not a git repo), shows error in dialog using `submitError` pattern

- **Auto-show dialog**: When workspace count becomes 0:
  1. Dialog appears automatically with first project pre-selected
  2. User can dismiss via Cancel button (sees logo backdrop)
  3. Dialog is re-shown if user opens Create via project [+] button

- **Auto-show conditions** (all must be true):
  - `getAllWorkspaces().length === 0`
  - `projects.value.length > 0`
  - `loadingState.value === "loaded"`
  - `dialogState.value.type === "closed"`
  - No deletion in progress: `!Array.from(deletionStates.value.values()).some(s => !s.completed)`

### Shortcut Overlay (Updated)

```
┌───────────────────────────────────────────────────────┐
│ ↑↓ Navigate   ⏎ New   ⌫ Del   1-0 Jump                │
└───────────────────────────────────────────────────────┘
                                         ↑
                              "O Open" hint REMOVED
```

## Testing Strategy

### Integration Tests

Test behavior through high-level entry points with behavioral mocks. All tests use component rendering with mocked `window.api`. Tests must be fast (<50ms) using `vi.useFakeTimers()`.

**Behavioral Mocks Required:**

- `MockDialogLayer`: In-memory state for folder selection with `$.selectFolder(path)` method to simulate user selection
- `MockGitClient`: State-based mock with `repositories` map per existing `git-client.state-mock.ts` pattern

| #   | Test Case                                | Entry Point                     | Boundary Mocks                 | Behavior Verified                                                      |
| --- | ---------------------------------------- | ------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| 1   | Folder icon opens picker                 | Click folder icon               | MockDialogLayer                | Folder picker visible, form remains responsive                         |
| 2   | Successful project open auto-selects     | Folder icon → select folder     | MockDialogLayer, MockGitClient | Project appears in dropdown, is selected, Name input has focus         |
| 3   | Auto-show dialog on 0 workspaces         | Delete last workspace           | -                              | CreateWorkspaceDialog opens automatically after deletion completes     |
| 4   | Dialog dismissible when auto-shown       | Auto-show → Cancel              | -                              | Dialog closes, logo backdrop visible, projects list unchanged          |
| 5   | "o" key does nothing in shortcut mode    | Alt+X → O                       | -                              | Shortcut overlay remains visible, no folder picker, projects unchanged |
| 6   | Folder icon disabled during submission   | Start create, click icon        | -                              | Icon visually disabled, click has no effect                            |
| 7   | Error shown for non-git folder           | Folder icon → select non-git    | MockDialogLayer, MockGitClient | Error message visible in dialog, project not added, dropdown unchanged |
| 8   | Auto-show NOT triggered when no projects | Delete last workspace + project | -                              | Dialog does not appear, logo backdrop visible                          |
| 9   | Auto-show suppressed during deletion     | Start deleting last workspace   | -                              | Dialog does not appear while deletion step !== 'complete'              |

### UI Integration Tests

All tests use component rendering with mocked `window.api` as entry point.

| #   | Test Case                    | Category | Component             | Entry Point            | Behavior Verified                     |
| --- | ---------------------------- | -------- | --------------------- | ---------------------- | ------------------------------------- |
| 1   | Folder icon renders          | Pure-UI  | CreateWorkspaceDialog | Render with mocked API | Icon visible next to Project dropdown |
| 2   | Icon has accessibility label | Pure-UI  | CreateWorkspaceDialog | Render with mocked API | `aria-label="Open project folder"`    |
| 3   | Icon has tooltip             | Pure-UI  | CreateWorkspaceDialog | Render with mocked API | `title="Open project folder"`         |
| 4   | Sidebar has no Open Project  | Pure-UI  | Sidebar               | Render with mocked API | Footer has no button                  |
| 5   | Overlay has no O hint        | Pure-UI  | ShortcutOverlay       | Render with mocked API | "O Open" not in hints                 |

### Test File Naming

New integration tests should use `*.integration.test.ts` suffix per project conventions. Existing `shortcuts.test.ts` uses call-tracking mocks; these tests will be updated to remove "o" key tests but not migrated to behavioral pattern (legacy acceptance).

### Manual Testing Checklist

- [ ] Open project via folder icon in Create Workspace dialog
- [ ] Verify project auto-selects in dropdown after opening
- [ ] Verify focus moves to Name input after project opens
- [ ] Verify error shows if selecting non-git folder
- [ ] Delete all workspaces, verify dialog auto-shows
- [ ] Cancel auto-shown dialog, verify logo backdrop visible
- [ ] Open dialog via project [+], verify normal behavior
- [ ] Alt+X shows overlay WITHOUT "O Open" hint
- [ ] Alt+X then press O, verify nothing happens
- [ ] Sidebar footer has no Open Project button

## Implementation Steps

- [x] **Step 1: Add folder icon to CreateWorkspaceDialog**
  - Add `<vscode-button appearance="icon">` with `<Icon name="folder-opened" />` to right of ProjectDropdown
  - Add `aria-label="Open project folder"` and `title="Open project folder"` for accessibility and tooltip
  - Keyboard accessibility is inherent with vscode-button (focusable, Enter/Space activatable)
  - Add `isOpeningProject` state to track folder picker operation
  - Add click handler that:
    1. Sets `isOpeningProject = true`
    2. Calls `api.ui.selectFolder()`
    3. On success: calls `api.projects.open(path)`, then `handleProjectSelect()`, then focuses Name input
    4. On error: sets `submitError` with user-friendly message
    5. Sets `isOpeningProject = false`
  - Disable icon when `isSubmitting || isOpeningProject`
  - Disable Create button when `isOpeningProject` (prevent submission during folder operation)
  - Files: `src/renderer/lib/components/CreateWorkspaceDialog.svelte`
  - Test criteria: Integration tests 1, 2, 6, 7; UI tests 1, 2, 3

- [x] **Step 2: Remove Open Project button from Sidebar**
  - Remove `.sidebar-footer` content (Open Project button and shortcut badge)
  - Remove `onOpenProject` prop from SidebarProps
  - Update EmptyState message to: "No projects open. Click the + button on a project header to create a workspace, or open a project via the Create Workspace dialog."
  - Remove footer structure entirely (no future use planned)
  - Files: `src/renderer/lib/components/Sidebar.svelte`, `src/renderer/lib/components/EmptyState.svelte`
  - Test criteria: UI test 4

- [x] **Step 3: Update MainView to remove onOpenProject prop**
  - Remove `onOpenProject` prop from Sidebar usage
  - Remove `handleOpenProject` function (no longer needed - folder icon in dialog has its own handler)
  - Keep `handleOpenProjectRetry` for OpenProjectErrorDialog retry functionality
  - Files: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: Build passes, no props errors

- [x] **Step 4: Add auto-show dialog logic**
  - Add `$effect` with debounce (100ms) that triggers when ALL conditions are met:
    - `getAllWorkspaces().length === 0`
    - `projects.value.length > 0`
    - `loadingState.value === "loaded"`
    - `dialogState.value.type === "closed"`
    - No deletion in progress: `!Array.from(deletionStates.value.values()).some(s => !s.completed)`
  - Call `openCreateDialog(projects.value[0].id)` when conditions met
  - Files: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: Integration tests 3, 4, 8, 9

- [x] **Step 5: Remove "o" key from shortcut system** (Step 7 depends on this)
  - Remove `"o"` from `SHORTCUT_KEYS` array in `src/shared/shortcuts.ts`
  - Remove `PROJECT_KEYS` constant and `isProjectKey` type guard
  - Update `isActionKey` to not include project key check
  - Simplify `ActionKey` type to exclude `ProjectKey`
  - Remove `case "o":` from `executeShortcutAction()` in `shortcuts.svelte.ts`
  - Remove `handleProjectOpen()` function
  - Files: `src/shared/shortcuts.ts`, `src/renderer/lib/stores/shortcuts.svelte.ts`
  - Test criteria: Integration test 5

- [x] **Step 6: Remove "O Open" from ShortcutOverlay**
  - Remove `showOpen` prop computation (currently always visible)
  - Remove "O Open" hint from overlay display
  - Files: `src/renderer/lib/components/ShortcutOverlay.svelte`
  - Test criteria: UI test 5

- [x] **Step 7: Clean up MainView event listener** (depends on Step 5)
  - Remove `codehydra:open-project` event listener since no longer dispatched from shortcuts
  - Remove `handleOpenProjectEvent` wrapper function
  - Files: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: Build passes, no unused code

- [x] **Step 8: Update tests**
  - Remove tests for "o" key functionality in `shortcuts.test.ts` and `shortcuts.test.ts` (shared)
  - Add integration tests for folder icon functionality in new `CreateWorkspaceDialog.integration.test.ts`
  - Add integration tests for auto-show dialog behavior
  - Use `vi.useFakeTimers()` and `vi.runAllTimersAsync()` for timing-dependent tests
  - Files: `src/renderer/lib/stores/shortcuts.test.ts`, `src/shared/shortcuts.test.ts`, `src/renderer/lib/components/CreateWorkspaceDialog.integration.test.ts` (new)
  - Test criteria: All tests pass, tests complete in <50ms each

- [x] **Step 9: Update documentation**
  - Update `docs/USER_INTERFACE.md`:
    - Remove "Open Project" button references from sidebar section
    - Update Create Workspace dialog wireframe to show folder icon button
    - Remove Alt+O from keyboard shortcuts table (lines 737-755)
    - Add auto-show dialog behavior in "Creating a Workspace" section:
      - Conditions: workspace count = 0, projects exist, loading complete, no dialog open, no deletion in progress
      - Dismissible via Cancel (returns to logo backdrop)
  - Update `CLAUDE.md`:
    - Remove "O open project" from Shortcut Mode description in Key Concepts table
  - Files: `docs/USER_INTERFACE.md`, `CLAUDE.md`
  - Test criteria: Documentation accurate, no stale references

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/USER_INTERFACE.md` | Remove "Open Project" button docs, update Create Workspace dialog wireframe, remove Alt+O from shortcuts table, add auto-show behavior |
| `CLAUDE.md`              | Remove "O open project" from Shortcut Mode description                                                                                 |

### New Documentation Required

| File   | Purpose                             |
| ------ | ----------------------------------- |
| (none) | No new documentation files required |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed (manual checklist complete)
- [ ] CI passed
- [ ] Merged to main
