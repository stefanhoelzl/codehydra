---
status: COMPLETED
last_updated: 2025-12-15
reviewers:
  - review-ui
  - review-typescript
  - review-arch
  - review-testing
  - review-docs
---

# CLOSE_PROJECT_DIALOG

## Overview

- **Problem**: When closing a project with existing workspaces, users receive no feedback about what happens to those workspaces. The workspaces (git worktrees) remain on disk, which may not be the user's intent.
- **Solution**: Show a confirmation dialog when closing a project that has workspaces, informing the user that workspaces will be kept, with a checkbox option to remove all workspaces before closing.
- **Risks**:
  - Bulk workspace removal could fail partway through (mitigated by continuing on error and showing aggregate error summary)
  - User could accidentally delete uncommitted work (accepted per requirements - no blocking)
- **Alternatives Considered**:
  - Always delete workspaces on close: Too destructive, data loss risk
  - Always keep workspaces on close: Current behavior, lacks user control
  - Per-workspace confirmation: Too tedious for many workspaces

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MainView.svelte                         │
│                                                                 │
│  handleCloseProject(projectId)                                  │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────┐                                           │
│  │ Find project by  │                                           │
│  │ ID in store      │                                           │
│  └────────┬─────────┘                                           │
│           │                                                     │
│     ┌─────┼─────────┐                                           │
│     │     │         │                                           │
│     ▼     ▼         ▼                                           │
│  not    ws=0     ws>0                                           │
│  found    │         │                                           │
│     │     ▼         ▼                                           │
│     │   Close    Open dialog                                    │
│     │   immediately (CloseProjectDialog)                        │
│     │              │                                            │
│     │        ┌─────┴─────┐                                      │
│     │        │           │                                      │
│     │        ▼           ▼                                      │
│     │     Cancel     Confirm                                    │
│     │        │           │                                      │
│     ▼        ▼     ┌─────┴──────┐                                │
│  (early   (noop)   │            │                               │
│   return)          ▼            ▼                               │
│              removeAll=false  removeAll=true                    │
│                    │            │                               │
│                    │     ┌──────┴──────┐                        │
│                    │     │ Promise.    │                        │
│                    │     │ allSettled  │                        │
│                    │     │ remove each │                        │
│                    │     │ (keepBranch │                        │
│                    │     │  = false)   │                        │
│                    │     └──────┬──────┘                        │
│                    │            │                               │
│                    │     ┌──────┴──────┐                        │
│                    │     │ Show errors │                        │
│                    │     │ if any      │                        │
│                    │     └──────┬──────┘                        │
│                    │            │                               │
│                    └─────┬──────┘                               │
│                          ▼                                      │
│                 api.projects.close(projectId)                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Dialog State (minimal, consistent with existing patterns):
┌─────────────────────────────────────────┐
│ DialogState union type:                 │
│ | { type: "closed" }                    │
│ | { type: "create"; projectId }         │
│ | { type: "remove"; workspaceRef }      │
│ | { type: "close-project"; projectId }  │  ← NEW
└─────────────────────────────────────────┘

Component derives project from store (stays reactive):
┌─────────────────────────────────────────┐
│ const project = $derived(               │
│   projects.value.find(p => p.id === id) │
│ );                                      │
│ const workspaceCount = $derived(        │
│   project?.workspaces.length ?? 0       │
│ );                                      │
└─────────────────────────────────────────┘
```

## UI Design

```
┌──────────────────────────────────────────────────────────────┐
│  Close Project                                          [×]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  This project has 3 workspaces that will remain on disk      │
│  after closing.                                              │
│                    ^ (singular: "1 workspace")               │
│                                                              │
│  ☐ Remove all workspaces and their branches                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    [Cancel]  [Close Project]                 │
│                              ^ Dynamic: "Remove & Close"     │
│                                when checkbox is checked      │
│                              ^ "Closing..." when submitting  │
└──────────────────────────────────────────────────────────────┘

Error state (partial failure):
┌──────────────────────────────────────────────────────────────┐
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ⚠ Removed 2 of 3 workspaces. Failed:                   │  │
│  │   • feature-x: Branch in use                           │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### User Interactions

- **Cancel button**: Closes dialog, project remains open
- **Close Project / Remove & Close button**:
  - If checkbox unchecked: Closes project immediately (workspaces kept)
  - If checkbox checked: Removes all workspaces (with branches via `keepBranch=false`), then closes project
- **Escape key**: Same as Cancel
- **Overlay click**: Same as Cancel (when not busy)

### Accessibility

- Dialog uses `role="dialog"` and `aria-modal="true"` (via Dialog.svelte)
- Title linked via `aria-labelledby`
- Description linked via `aria-describedby`
- Error messages use `role="alert"` for screen reader announcement
- Focus trapped within dialog while open
- Initial focus on primary action button
- Tab key cycles through focusable elements
- Escape key closes dialog

## Implementation Steps

Steps follow TDD workflow: write failing test → implement → refactor.

- [x] **Step 1: Write dialog store tests for close-project type**
  - Add tests for new `openCloseProjectDialog(projectId)` action
  - Test state transitions: closed → close-project → closed
  - Test that only `projectId` is stored (not full Project object)
  - Files: `src/renderer/lib/stores/dialogs.test.ts`
  - Test criteria: Tests written and failing (no implementation yet)

- [x] **Step 2: Add dialog type to store**
  - Add `"close-project"` type to `DialogState` union: `{ type: "close-project"; projectId: ProjectId }`
  - Add `openCloseProjectDialog(projectId: ProjectId)` action
  - Store only `projectId` (consistent with `create` dialog pattern)
  - Files: `src/renderer/lib/stores/dialogs.svelte.ts`
  - Test criteria: All store tests pass

- [x] **Step 3: Write CloseProjectDialog component tests**
  - Test initial render with workspace count (derive from mocked store)
  - Test proper pluralization: "1 workspace" vs "3 workspaces"
  - Test checkbox state changes with `onchange` handler
  - Test checkbox disabled during submission
  - Test cancel button calls `closeDialog()`
  - Test submit without removeAll calls only `api.projects.close()`
  - Test submit with removeAll calls `api.workspaces.remove()` for each workspace, then `api.projects.close()`
  - Test `Promise.allSettled` pattern: partial failures show aggregate error but still close project
  - Test spinner shown during submission (button text changes)
  - Test dynamic button label: "Close Project" vs "Remove & Close"
  - Test button disabled during submission prevents double-click
  - Test ARIA attributes: dialog role, labelledby, describedby
  - Test focus management: initial focus on primary button
  - Test keyboard: Escape closes dialog
  - Test error display uses `role="alert"`
  - Mock `$lib/api` using `vi.mock('$lib/api')` with `vi.fn()` implementations
  - Files: `src/renderer/lib/components/CloseProjectDialog.test.ts`
  - Test criteria: Tests written and failing (no implementation yet)

- [x] **Step 4: Create CloseProjectDialog component**
  - Use Svelte 5 runes: `let { open, projectId }: Props = $props()`
  - Derive project from store: `const project = $derived(projects.value.find(p => p.id === projectId))`
  - Derive workspace count: `const workspaceCount = $derived(project?.workspaces.length ?? 0)`
  - Derive pluralized text: `const workspaceText = $derived(workspaceCount === 1 ? '1 workspace' : `${workspaceCount} workspaces`)`
  - State: `let removeAll = $state(false)`, `let isSubmitting = $state(false)`, `let submitError = $state<string | null>(null)`
  - Derive button label: `const buttonLabel = $derived(isSubmitting ? 'Closing...' : (removeAll ? 'Remove & Close' : 'Close Project'))`
  - Wrap in `<Dialog>` component with snippets for title/content/actions
  - Pass `titleId="close-project-title"`, `descriptionId="close-project-desc"`, `initialFocusSelector="vscode-button"`
  - Use `<vscode-checkbox>` with `checked={removeAll}`, `onchange` handler, `disabled={isSubmitting}`
  - Use `<vscode-button>` for actions with `disabled={isSubmitting}`, add `svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions` comments
  - On submit with `removeAll=true`: use `Promise.allSettled()` to remove all workspaces with `keepBranch=false`
  - Collect failures and show aggregate error: "Removed X of Y workspaces. Failed: name1 (error), name2 (error)"
  - After removals (even with errors), call `api.projects.close(projectId)` then `closeDialog()`
  - Error display: `<div class="submit-error" role="alert">` styled with `--ch-error-bg` and `--ch-error-fg`
  - Reuse `warning-box` CSS pattern from RemoveWorkspaceDialog for consistency
  - Handle edge case: if project becomes undefined while dialog open (closed elsewhere), show error or close gracefully
  - Files: `src/renderer/lib/components/CloseProjectDialog.svelte`
  - Test criteria: All component tests pass

- [x] **Step 5: Write MainView integration tests**
  - Create `src/renderer/lib/components/MainView.integration.test.ts`
  - Test: clicking close on project with `project.workspaces.length > 0` opens close-project dialog
  - Test: clicking close on project with `project.workspaces.length === 0` calls `api.projects.close()` directly
  - Test: project not found in store (race condition) returns early without error
  - Test: full flow with removeAll=true updates store correctly after API calls
  - Files: `src/renderer/lib/components/MainView.integration.test.ts`
  - Test criteria: Tests written and failing

- [x] **Step 6: Integrate dialog into MainView**
  - Modify `handleCloseProject(projectId: ProjectId)`:
    ```typescript
    async function handleCloseProject(projectId: ProjectId): Promise<void> {
      const project = projects.value.find((p) => p.id === projectId);
      if (!project) {
        // Project already closed or not in store - early return
        return;
      }
      if (project.workspaces.length > 0) {
        openCloseProjectDialog(projectId);
      } else {
        await api.projects.close(projectId);
      }
    }
    ```
  - Add dialog rendering alongside other dialogs:
    ```svelte
    {:else if dialogState.value.type === "close-project"}
      <CloseProjectDialog open={true} projectId={dialogState.value.projectId} />
    ```
  - Import `openCloseProjectDialog` from dialogs store
  - Import `CloseProjectDialog` component
  - Files: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: All MainView integration tests pass

- [x] **Step 7: Update documentation**
  - Update `docs/USER_INTERFACE.md` "Closing a Project" section (lines 207-224):
    - Document new dialog flow for projects with workspaces
    - Document checkbox behavior and consequences
    - Document both paths: keep workspaces vs remove workspaces
  - Update `docs/ARCHITECTURE.md` Frontend Components table:
    - Add `CloseProjectDialog` to dialog components list
  - Files: `docs/USER_INTERFACE.md`, `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects implementation

## Testing Strategy

### Unit Tests (vitest)

| Test Case                             | Description                                                | File                       |
| ------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| openCloseProjectDialog sets state     | Verify state is `{ type: "close-project", projectId }`     | dialogs.test.ts            |
| closeDialog resets from close-project | Verify clean state transition to `{ type: "closed" }`      | dialogs.test.ts            |
| CloseProjectDialog renders count      | Shows "3 workspaces" (derived from store)                  | CloseProjectDialog.test.ts |
| CloseProjectDialog singular           | Shows "1 workspace" for single workspace                   | CloseProjectDialog.test.ts |
| checkbox toggles removeAll            | State updates via onchange handler                         | CloseProjectDialog.test.ts |
| checkbox disabled when submitting     | Cannot change during async operation                       | CloseProjectDialog.test.ts |
| cancel closes dialog                  | Cancel button calls closeDialog()                          | CloseProjectDialog.test.ts |
| submit without removeAll              | Only calls close API, not remove                           | CloseProjectDialog.test.ts |
| submit with removeAll                 | Calls remove for each ws with keepBranch=false, then close | CloseProjectDialog.test.ts |
| partial failure aggregates errors     | Shows "Removed 2 of 3. Failed: name (error)"               | CloseProjectDialog.test.ts |
| partial failure still closes          | Project closes even after removal failures                 | CloseProjectDialog.test.ts |
| submit shows spinner                  | Button text changes to "Closing..."                        | CloseProjectDialog.test.ts |
| dynamic button label                  | "Close Project" vs "Remove & Close" based on checkbox      | CloseProjectDialog.test.ts |
| button disabled during submit         | Prevents double-click                                      | CloseProjectDialog.test.ts |
| ARIA attributes present               | Dialog has role, labelledby, describedby                   | CloseProjectDialog.test.ts |
| error uses role="alert"               | Screen reader announces errors                             | CloseProjectDialog.test.ts |
| Escape key closes dialog              | Keyboard navigation works                                  | CloseProjectDialog.test.ts |
| project becomes undefined             | Handles gracefully if project closed elsewhere             | CloseProjectDialog.test.ts |

### Integration Tests

| Test Case                                         | Description                                      | File                         |
| ------------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| MainView opens dialog for project with workspaces | Clicking close opens close-project dialog        | MainView.integration.test.ts |
| MainView direct close for empty project           | Clicking close calls API directly                | MainView.integration.test.ts |
| MainView handles missing project                  | Early return if project not in store             | MainView.integration.test.ts |
| Full flow with removeAll                          | Store updates correctly after removals and close | MainView.integration.test.ts |

### API Mocking Strategy

All component tests mock `$lib/api` using vitest:

```typescript
import { vi } from "vitest";

vi.mock("$lib/api", () => ({
  projects: {
    close: vi.fn().mockResolvedValue(undefined),
  },
  workspaces: {
    remove: vi.fn().mockResolvedValue({ branchDeleted: true }),
  },
}));
```

### Manual Testing Checklist

- [ ] Close project with 0 workspaces - closes immediately (no dialog)
- [ ] Close project with 1 workspace - dialog shows "1 workspace"
- [ ] Close project with 3 workspaces - dialog shows "3 workspaces"
- [ ] Click Cancel - dialog closes, project still open
- [ ] Press Escape - dialog closes
- [ ] Click overlay - dialog closes
- [ ] Click Close Project (unchecked) - project closes, workspaces remain on disk
- [ ] Verify button says "Close Project" when unchecked
- [ ] Check the checkbox - button changes to "Remove & Close"
- [ ] Click Remove & Close - all workspaces removed, branches deleted, project closes
- [ ] Verify spinner appears during removal (button shows "Closing...")
- [ ] Verify checkbox is disabled during removal
- [ ] Test partial failure: manually make one workspace undeletable, verify error shown but project still closes

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| docs/USER_INTERFACE.md | Update "Closing a Project" section to document new dialog flow, checkbox behavior, and both outcome paths |
| docs/ARCHITECTURE.md   | Add CloseProjectDialog to Frontend Components table                                                       |

### New Documentation Required

None required - feature is self-explanatory from UI.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
