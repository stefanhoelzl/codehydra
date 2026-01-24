---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-23
reviewers: []
---

# CREATE_WORKSPACE_DIALOG_IMPROVEMENTS

## Overview

- **Problem**: The Create Workspace dialog has several UX issues:
  1. Arrow key navigation doesn't scroll the branch list to keep highlighted items visible
  2. Remote branches that no longer exist on the remote still appear (stale refs)
  3. Users can't select existing branches - must type names manually
  4. No auto-selection of base branch when selecting an existing branch
  5. Default base branch prefers local over remote (should prefer `origin/main` over `main`)

- **Solution**:
  1. Add `scrollIntoView()` to FilterableDropdown on keyboard navigation
  2. Add `--prune` flag to git fetch in `updateBases()`
  3. Convert name input to a filterable dropdown that allows both selection and free text
  4. Enhance `fetchBases()` API to return suggested base branch and derivable workspace names
  5. Update `defaultBase()` to prefer remote branches

- **Risks**:
  - API change to `BaseInfo` type (mitigated: additive change, backwards compatible)
  - Git fetch --prune removes refs user might expect (acceptable: these are stale)

- **Alternatives Considered**:
  - New API endpoint instead of enhancing `fetchBases()` - rejected for simplicity
  - Separate worktree status endpoint - rejected, can compute in single call

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CreateWorkspaceDialog                         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ ProjectDropdown │  │NameBranchDropdown│  │ BranchDropdown │  │
│  └─────────────────┘  └──────────────────┘  └────────────────┘  │
│                              │                      │            │
│                              └──────────┬───────────┘            │
│                                         │                        │
│                              ┌──────────▼───────────┐            │
│                              │ FilterableDropdown   │            │
│                              │ (+ scrollIntoView)   │            │
│                              └──────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                                         │
                                         │ fetchBases()
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       GitWorktreeProvider                        │
│  listBases() - returns BaseInfo[] with:                         │
│    - name: full ref ("main" or "origin/main")                   │
│    - isRemote: boolean                                          │
│    - base?: suggested base branch                               │
│    - derives?: workspace name if can create workspace           │
└─────────────────────────────────────────────────────────────────┘
```

**Data computation in `listBases()`:**

1. Get all branches (`git branch -a`)
2. Get all worktrees (to know which local branches have worktrees)
3. Get `codehydra.base` config for local branches
4. Compute `derives`:
   - Local branch without worktree → `derives` = branch name
   - Remote branch without local counterpart → `derives` = name without remote prefix (e.g., `origin/feature-x` → `feature-x`)
   - For branches with `/` in name (e.g., `origin/feature/login`), strip only the remote prefix → `feature/login`
   - Dedupe across multiple remotes: prefer `origin`, then alphabetically first remote
5. Compute `base`:
   - Local: `codehydra.base` config if set, otherwise matching `origin/*` branch if exists
   - Remote: the full ref itself (e.g., `origin/feature-x`)

## UI Design

### Name Field (NameBranchDropdown)

```
┌─────────────────────────────────────────┐
│ Name                                    │
│ ┌─────────────────────────────────────┐ │
│ │ feature-login                     ▼ │ │  ← Input with dropdown
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ LOCAL BRANCHES                      │ │  ← Header (non-selectable)
│ │   feature-auth                      │ │
│ │   bugfix-header                     │ │
│ │ REMOTE BRANCHES                     │ │
│ │   feature-payments                  │ │  ← Shown without "origin/"
│ │   feature-dashboard                 │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### User Interactions

1. **Type custom name**: User types "my-feature" → creates new branch from selected base
2. **Select existing local branch**: User selects "feature-auth" → base auto-fills from config or matching remote
3. **Select remote branch**: User selects "feature-payments" (actually `origin/feature-payments`) → base auto-fills to `origin/feature-payments`
4. **Arrow navigation**: Highlighted option scrolls into view when moving up/down
5. **Keyboard for custom name**: When user types a name and presses Enter with no option highlighted, the typed text is used as the new branch name (no auto-fill of base)

## Testing Strategy

### Integration Tests

Note: Tests 1-7 use `GitWorktreeProvider.listBases()` directly as the entry point because the `derives` and `base` computation logic is internal to the provider and not exposed through the public API. This allows focused testing of the computation logic with controlled mock state.

| #   | Test Case                                                      | Entry Point                         | Boundary Mocks | Behavior Verified                                                         |
| --- | -------------------------------------------------------------- | ----------------------------------- | -------------- | ------------------------------------------------------------------------- |
| 1   | listBases returns derives for local branch without worktree    | `GitWorktreeProvider.listBases()`   | GitClient      | Branch with no worktree has `derives` set                                 |
| 2   | listBases excludes derives for local branch with worktree      | `GitWorktreeProvider.listBases()`   | GitClient      | Branch with worktree has `derives` undefined                              |
| 3   | listBases returns derives for remote without local counterpart | `GitWorktreeProvider.listBases()`   | GitClient      | Remote branch gets `derives` = name without prefix                        |
| 4   | listBases excludes derives for remote with local counterpart   | `GitWorktreeProvider.listBases()`   | GitClient      | Remote branch has `derives` undefined when local exists                   |
| 5   | listBases deduplicates remotes for derives                     | `GitWorktreeProvider.listBases()`   | GitClient      | Only one remote gets `derives` when multiple exist (prefer origin)        |
| 6   | listBases returns base from codehydra.base config              | `GitWorktreeProvider.listBases()`   | GitClient      | Local branch `base` = config value                                        |
| 7   | listBases returns base from matching remote                    | `GitWorktreeProvider.listBases()`   | GitClient      | Local branch `base` = `origin/*` when exists                              |
| 8   | updateBases removes stale remote refs after fetch              | `GitWorktreeProvider.updateBases()` | GitClient      | Stale remote branches no longer appear in listBases() after updateBases() |
| 9   | defaultBase prefers remote over local                          | `GitWorktreeProvider.defaultBase()` | GitClient      | Returns `origin/main` when both `main` and `origin/main` exist            |

**Note for Test #8**: The GitClient mock must simulate prune behavior - when `fetch()` is called with prune enabled, the mock should remove any remote branches from its in-memory state that are marked as "deleted on remote". This tests the actual outcome, not the implementation detail.

### UI Integration Tests

| #   | Test Case                                            | Category | Component             | Behavior Verified                           |
| --- | ---------------------------------------------------- | -------- | --------------------- | ------------------------------------------- |
| 1   | Arrow down scrolls into view                         | Pure-UI  | FilterableDropdown    | Highlighted option visible after navigation |
| 2   | Arrow up scrolls into view                           | Pure-UI  | FilterableDropdown    | Highlighted option visible after navigation |
| 3   | Name dropdown shows local branches without worktrees | UI-state | NameBranchDropdown    | Only branches with `derives` shown          |
| 4   | Name dropdown shows remote branches without local    | UI-state | NameBranchDropdown    | Remote branches displayed without prefix    |
| 5   | Selecting branch auto-fills base                     | API-call | CreateWorkspaceDialog | Base dropdown value updated                 |
| 6   | Custom name entry works                              | Pure-UI  | NameBranchDropdown    | Typed text used as workspace name           |
| 7   | Name validation still applies                        | Pure-UI  | CreateWorkspaceDialog | Invalid names show error                    |

**Note for UI Tests 1-2**: `scrollIntoView()` may not work as expected in JSDOM. These tests should verify the method is called with correct arguments, and actual scroll behavior should be verified in manual testing.

### Manual Testing Checklist

- [ ] Open Create Workspace dialog
- [ ] Arrow down through long branch list - verify scroll follows
- [ ] Arrow up through long branch list - verify scroll follows
- [ ] Type partial branch name - verify filtering works
- [ ] Select local branch - verify base auto-fills
- [ ] Select remote branch - verify base auto-fills to origin/\*
- [ ] Type custom name - verify new branch created with selected base
- [ ] Type custom name and press Enter with no selection - verify no base auto-fill
- [ ] Delete remote branch externally, re-open dialog after fetch - verify stale branch removed
- [ ] Test with repo having multiple remotes
- [ ] Verify default base is origin/main (not main) when both exist

## Implementation Steps

- [x] **Step 1: Add scrollIntoView to FilterableDropdown**
  - Use ID-based approach: `document.getElementById(highlightedId)?.scrollIntoView({ block: 'nearest' })` in an `$effect` that watches `highlightedIndex`
  - The option IDs are already computed as `${baseId}-option-${...}`
  - Files: `src/renderer/lib/components/FilterableDropdown.svelte`
  - Test: Arrow navigation scrolls highlighted option into view

- [x] **Step 2: Add --prune flag to git fetch**
  - Modify `fetch()` method in SimpleGitClient:
    - With remote: `await git.fetch([remote, '--prune'])`
    - Without remote: `await git.fetch(['--all', '--prune'])`
  - Files: `src/services/git/simple-git-client.ts`
  - Test: Stale remote refs removed after fetch

- [x] **Step 3: Enhance BaseInfo type**
  - Add `base?: string` and `derives?: string` fields with JSDoc comments
  - Files: `src/shared/api/types.ts`
  - Test: Types compile

- [x] **Step 4: Enhance listBases() to compute derives and base**
  - Get worktrees to determine which local branches have worktrees
  - Get codehydra.base configs for local branches
  - Compute `derives` with deduplication across remotes (prefer `origin`, then alphabetically)
  - Compute `base` from config or matching remote
  - Consider extracting derives computation to a private `computeDerives()` method for testability
  - Files: `src/services/git/git-worktree-provider.ts`
  - Test: Integration tests 1-7

- [x] **Step 5: Update defaultBase() to prefer remote**
  - Return full ref `origin/main` when it exists (not just `main`)
  - Check order: `origin/main` → `main` → `origin/master` → `master`
  - Fallback: if only local `main` exists without remote, return `main`
  - Files: `src/services/git/git-worktree-provider.ts`
  - Test: Integration test 9

- [x] **Step 6: Create NameBranchDropdown component**
  - Wrap FilterableDropdown
  - Filter options to those with `derives` set
  - Group by local/remote with headers (headers hidden when their group has no matching options after filtering)
  - DropdownOption mapping:
    - `label`: the `derives` value (display name, e.g., "feature-payments")
    - `value`: the full ref for API calls (e.g., "origin/feature-payments")
  - Allow free text entry for new branch names
  - Callback signature:
    ```typescript
    interface NameBranchSelection {
      name: string;                    // The workspace/branch name
      suggestedBase?: string;          // Base branch if selecting existing branch
      isExistingBranch: boolean;       // true if selected from list, false if custom typed
    }
    onSelect: (selection: NameBranchSelection) => void;
    ```
  - When user types custom name and presses Enter with no highlighted option, emit with `isExistingBranch: false` and no `suggestedBase`
  - Files: `src/renderer/lib/components/NameBranchDropdown.svelte`
  - Test: UI tests 3-6

- [x] **Step 7: Update CreateWorkspaceDialog to use NameBranchDropdown**
  - Replace `<vscode-textfield>` with `<NameBranchDropdown>`
  - Handle selection to auto-fill base branch only when `isExistingBranch` is true
  - Preserve existing validation timing: validate on blur, show errors only after `touched` state is true
  - Keep existing validation logic (no `/`, `\`, `..`, max length, etc.)
  - Files: `src/renderer/lib/components/CreateWorkspaceDialog.svelte`
  - Test: UI tests 5, 7

- [x] **Step 8: Update BranchDropdown for new BaseInfo structure**
  - Ensure it handles new optional fields gracefully (they're not used in BranchDropdown)
  - Files: `src/renderer/lib/components/BranchDropdown.svelte`
  - Test: Existing branch dropdown functionality preserved
  - Note: No changes needed - BranchDropdown only uses `name` and `isRemote`, new optional fields are handled gracefully by TypeScript

## Dependencies

None - using existing libraries.

## Documentation Updates

### Files to Update

| File                      | Changes Required                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/api/types.ts` | Add JSDoc for new `base` and `derives` fields                                                                                            |
| `docs/API.md`             | Update BaseInfo type documentation to include new `base` and `derives` fields                                                            |
| `docs/USER_INTERFACE.md`  | Update "Creating a Workspace" section to document the new name dropdown behavior (selecting existing branches, auto-fill of base branch) |

### New Documentation Required

None - internal implementation change.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Arrow key navigation scrolls highlighted option into view
- [ ] Stale remote branches no longer appear after fetch
- [ ] Name field allows selecting existing branches
- [ ] Selecting branch auto-fills base branch
- [ ] Custom names still work for new branches
- [ ] Default base branch prefers remote (origin/main > main)
- [ ] All tests pass
- [ ] Manual testing checklist complete
- [ ] Documentation updated (API.md, USER_INTERFACE.md)
