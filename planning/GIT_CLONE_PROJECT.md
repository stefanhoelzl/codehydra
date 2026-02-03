---
status: APPROVED
last_updated: 2026-01-25
reviewers: [review-arch, review-quality, review-testing, review-ui]
---

# GIT_CLONE_PROJECT

## Overview

- **Problem**: Users must manually clone git repositories before opening them in CodeHydra. This creates friction when starting new projects from remote URLs.
- **Solution**: Add a "Clone from Git" button in the CreateWorkspaceDialog that opens a GitCloneDialog. Users enter a git URL, the repo is cloned (bare mode) to app-data, and the new project is auto-selected for workspace creation.
- **Risks**:
  - Clone failures (network/auth) → mitigated by error display and retry capability
  - Duplicate detection for same URL → mitigated by URL comparison and "open existing" behavior
- **Alternatives Considered**:
  - Inline clone UI in CreateWorkspaceDialog → rejected (makes dialog too complex)
  - Modal sub-dialog → rejected (requires architectural change to exclusive-dialog pattern)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Flow                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CreateWorkspaceDialog                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  [Project Dropdown] [Open Folder] [Clone from Git]  ← NEW BUTTON    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              │ click (opens git-clone, closes create)       │
│                              ▼                                              │
│  GitCloneDialog (NEW) - replaces CreateWorkspaceDialog (exclusive pattern)  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Clone from Git Repository                                          │   │
│  │  ┌───────────────────────────────────────────────────────────────┐  │   │
│  │  │ https://github.com/org/repo.git                               │  │   │
│  │  └───────────────────────────────────────────────────────────────┘  │   │
│  │                                                                     │   │
│  │  [Cancel]                                      [Clone] ← spinner   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              │ success OR cancel → openCreateDialog()       │
│                              ▼                                              │
│  CreateWorkspaceDialog (reopened with new project selected)                 │
│                                                                             │
│  NOTE: GitCloneDialog currently only returns to CreateWorkspaceDialog.      │
│  This is the only entry point - if new entry points are added, the return   │
│  behavior will need to be parameterized.                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Storage Layout                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ~/.local/share/codehydra/projects/                                         │
│  └── repo-name-<url-hash>/        ← hash computed from remote URL           │
│      ├── config.json              ← includes remoteUrl field                │
│      ├── git/                     ← bare clone location (NEW)               │
│      │   └── (bare repo files)                                              │
│      └── workspaces/                                                        │
│          └── feature-x/           ← worktrees created here                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Project ID from Remote URL**: For cloned projects, the hash is computed from the normalized remote URL (not folder path) using a new `generateProjectIdFromUrl(url): ProjectId` function. This ensures the same repo cloned multiple times is detected as a duplicate. The function returns the same `ProjectId` branded type as `generateProjectId`.

2. **Bare Clone to `git/` Subdirectory**: The bare repo lives in `<project-dir>/git/` rather than the project dir itself. Worktrees are created in `workspaces/` as usual.

3. **URL Storage**: The original remote URL is stored in `config.json`. Comparison uses a normalized form (lowercase hostname, path normalized, `.git` suffix removed). URL normalization handles edge cases: embedded credentials are stripped, port numbers preserved, trailing slashes removed.

4. **Duplicate Handling**: If URL already cloned, open/select the existing project instead of cloning again.

5. **Remote Project Cleanup**: When closing a remote project (one with `remoteUrl`), the CloseProjectDialog shows an additional "Delete cloned repository" checkbox. The two checkboxes are independent, but checking "Delete cloned repository" implies all workspaces will also be removed (enforced in UI). When checked, the entire project directory (including the bare clone in `git/`) is deleted.

6. **Dialog Transition Pattern**: GitCloneDialog follows the exclusive single-dialog pattern. Opening it closes CreateWorkspaceDialog. Both Cancel and successful clone call `openCreateDialog()` to return - Cancel passes no project ID (returns to previous state), success passes the new project ID.

### Modified/New Interfaces

**NOTE: These API/IPC interface changes require explicit user approval per CLAUDE.md rules.**

```typescript
// IGitClient - new method
interface IGitClient {
  // ... existing methods ...

  /**
   * Clone a repository in bare mode.
   * @param url - Git remote URL (HTTPS or SSH format)
   * @param targetPath - Destination path for the bare clone
   * @throws GitError - On network failure, auth failure, invalid URL, or target exists
   */
  clone(url: string, targetPath: Path): Promise<void>;
}

// ProjectConfig - extended
interface ProjectConfig {
  readonly version: number;
  readonly path: string;
  readonly remoteUrl?: string; // NEW: Original git remote URL
}

// IProjectApi - new/modified methods
interface IProjectApi {
  // ... existing methods ...
  clone(url: string): Promise<Project>; // NEW
  close(projectId: ProjectId, options?: { removeLocalRepo?: boolean }): Promise<void>; // MODIFIED (backward compatible)
}

// Project type - extended
interface Project {
  // ... existing fields ...
  readonly remoteUrl?: string; // NEW: Present if project was cloned from URL
}

// DialogState - extended
type DialogState =
  | { type: "closed" }
  | { type: "create"; projectId?: ProjectId }
  | { type: "remove"; workspaceRef: WorkspaceRef }
  | { type: "close-project"; projectId: ProjectId }
  | { type: "git-clone" }; // NEW

// IPC Channels
api: project: clone; // NEW - must be added to docs/ARCHITECTURE.md IPC Contract section
api: project: close; // MODIFIED (add removeLocalRepo option - backward compatible, optional param)
```

## UI Design

### GitCloneDialog Layout

```
┌─────────────────────────────────────────────────────────┐
│  Clone from Git Repository          [titleId]           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Repository URL                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ https://github.com/org/repo.git   [autofocus]     │  │
│  └───────────────────────────────────────────────────┘  │
│  {inline validation error for malformed URLs}           │
│                                                         │
│  {error alert box - shown only on clone failure}        │
│                                                         │
│  {status: <vscode-progress-ring> Cloning repository...} │
│                               [descriptionId]           │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                            [Cancel]  [Clone]            │
└─────────────────────────────────────────────────────────┘
```

### User Interactions

- **URL input**: `<vscode-textfield>` with placeholder "https://github.com/org/repo.git", autofocus on dialog open
- **URL validation**: Inline validation for malformed URLs (missing protocol, no domain) before submit
- **Clone button**: Disabled when URL empty, URL invalid, or during cloning; shows "Cloning..." when active
- **Cancel button**: Closes dialog, calls `openCreateDialog()` to return to CreateWorkspaceDialog
- **Error display**: Red alert box with error message, dialog stays open for retry
- **Loading state**: `<vscode-progress-ring>` with "Cloning repository..." text in `aria-live="polite"` region
- **All elements disabled during clone**: Prevents user interaction during async operation
- **Accessibility**: Define `titleId="git-clone-title"` and `descriptionId="git-clone-status"` for ARIA labeling

### CreateWorkspaceDialog Modification

Add git icon button next to the existing folder icon button:

```svelte
<vscode-button appearance="icon" onclick={handleOpenProject} disabled={isSubmitting}>
  <Icon name="folder-opened" />
</vscode-button>
<vscode-button appearance="icon" onclick={handleCloneProject} disabled={isSubmitting}>
  <Icon name="git" />
  <!-- NEW -->
</vscode-button>
```

### CloseProjectDialog Modification (Remote Projects)

For projects with `remoteUrl` (cloned from git), show an additional checkbox:

```
┌─────────────────────────────────────────────────────────┐
│  Close Project                                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Are you sure you want to close "my-repo"?              │
│                                                         │
│  [ ] Remove all workspaces (3 workspaces)               │
│  [ ] Delete cloned repository and all local files       │
│                               ↑ NEW (remote only)       │
│                                                         │
│  {warning when delete checkbox checked:}                │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ⚠ Warning: This will permanently delete the cloned ││
│  │ repository and all workspaces. You can clone it    ││
│  │ again from: https://github.com/org/repo            ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
├─────────────────────────────────────────────────────────┤
│                            [Cancel]  [Close]            │
└─────────────────────────────────────────────────────────┘
```

- **Checkbox visibility**: "Delete cloned repository" only shown when project has `remoteUrl`
- **Checkbox interaction**: The two checkboxes are independent. When "Delete cloned repository" is checked, "Remove all workspaces" is automatically checked and disabled (deletion implies workspace removal).
- **Warning message**: Shown when "Delete cloned repository" is checked, displays the original remote URL
- **Behavior**: When checked, after closing project, delete the entire project directory (including `git/` bare clone)
- **Tab order**: New checkbox placed after existing "Remove all workspaces" checkbox

## Testing Strategy

### Integration Tests

Test behavior through API entry points with behavioral mocks.

| #   | Test Case                           | Entry Point                                   | Boundary Mocks        | Behavior Verified                                                                       |
| --- | ----------------------------------- | --------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| 1   | Clone public HTTPS repo             | `projects.clone(url)`                         | GitClient, FileSystem | Project created with remoteUrl in config                                                |
| 2   | Clone SSH URL                       | `projects.clone(url)`                         | GitClient, FileSystem | Project created, URL stored as-is                                                       |
| 3   | Clone duplicate URL                 | `projects.clone(url)`                         | GitClient, FileSystem | Returns project with matching ID, gitClient.clone() not called, project count unchanged |
| 4   | Clone failure (network)             | `projects.clone(url)`                         | GitClient (throws)    | Error propagated, no project created, no partial state left behind                      |
| 5   | Lookup project by URL               | `projectStore.findByRemoteUrl()`              | FileSystem            | Returns project if normalized URL matches                                               |
| 6   | Close remote project with remove    | `projects.close(id, {removeLocalRepo: true})` | FileSystem            | Project removed from list, project directory deleted including git/                     |
| 7   | Close remote project without remove | `projects.close(id)`                          | FileSystem            | Project removed from list, project directory preserved on filesystem                    |
| 8   | Close local project (no remoteUrl)  | `projects.close(id)`                          | FileSystem            | Normal close behavior unchanged                                                         |

### UI Integration Tests

| #   | Test Case                              | Category | Component             | Behavior Verified                                               |
| --- | -------------------------------------- | -------- | --------------------- | --------------------------------------------------------------- |
| 1   | Clone button opens dialog              | UI-state | CreateWorkspaceDialog | Clicking git icon opens GitCloneDialog                          |
| 2   | Clone success returns to create        | API-call | GitCloneDialog        | After clone, CreateWorkspaceDialog opens with project           |
| 3   | Clone error shows alert                | UI-state | GitCloneDialog        | Error displayed, dialog stays open                              |
| 4   | Inputs disabled during clone           | UI-state | GitCloneDialog        | All inputs disabled while isCloning=true                        |
| 5   | Cancel returns to create               | UI-state | GitCloneDialog        | Cancel closes and reopens CreateWorkspaceDialog                 |
| 6   | Remote project shows remove checkbox   | UI-state | CloseProjectDialog    | Checkbox visible when project has remoteUrl                     |
| 7   | Local project hides remove checkbox    | UI-state | CloseProjectDialog    | Checkbox hidden when project has no remoteUrl                   |
| 8   | Remove checkbox shows warning          | UI-state | CloseProjectDialog    | Warning message shown when checkbox checked                     |
| 9   | Remove checkbox auto-checks workspaces | UI-state | CloseProjectDialog    | Checking delete repo auto-checks and disables remove workspaces |
| 10  | Close with remove calls API correctly  | API-call | CloseProjectDialog    | Calls close() with removeLocalRepo: true                        |

### Boundary Tests

| #   | Test Case               | Interface        | External System | Behavior Verified                          |
| --- | ----------------------- | ---------------- | --------------- | ------------------------------------------ |
| 1   | Bare clone creates repo | IGitClient.clone | Git CLI         | Bare repo created at target path           |
| 2   | Clone invalid URL fails | IGitClient.clone | Git CLI         | GitError thrown with message               |
| 3   | Clone auth failure      | IGitClient.clone | Git CLI         | GitError thrown with auth-specific message |

### Focused Tests

| #   | Test Case                          | Function                 | Input/Output                                                        |
| --- | ---------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| 1   | URL normalization HTTPS            | normalizeGitUrl          | "https://GitHub.com/Org/Repo.git" → "github.com/org/repo"           |
| 2   | URL normalization SSH              | normalizeGitUrl          | "git@github.com:Org/Repo.git" → "github.com/org/repo"               |
| 3   | URL normalization with credentials | normalizeGitUrl          | "https://user:pass@github.com/org/repo.git" → "github.com/org/repo" |
| 4   | URL normalization with port        | normalizeGitUrl          | "https://github.com:443/org/repo.git" → "github.com:443/org/repo"   |
| 5   | URL normalization trailing slash   | normalizeGitUrl          | "https://github.com/org/repo/" → "github.com/org/repo"              |
| 6   | Hash from URL                      | generateProjectIdFromUrl | URL → `ProjectId` ("<name>-<8-char-hash>")                          |
| 7   | Hash consistency                   | generateProjectIdFromUrl | Same normalized URL always produces same hash                       |

### Manual Testing Checklist

- [ ] Clone public GitHub repo via HTTPS
- [ ] Clone private repo via SSH (with SSH key configured)
- [ ] Attempt clone of invalid URL - error shown
- [ ] Attempt clone of already-cloned URL - existing project selected
- [ ] Cancel during clone - returns to create dialog
- [ ] Create workspace after successful clone
- [ ] Close remote project - "Delete cloned repository" checkbox visible
- [ ] Close local project - "Delete cloned repository" checkbox NOT visible
- [ ] Check "Delete cloned repository" - warning message shown, workspaces checkbox auto-checked
- [ ] Close with "Delete cloned repository" checked - git directory deleted
- [ ] Close without "Delete cloned repository" checked - git directory preserved

## Implementation Steps

- [x] **Step 1: Add IGitClient.clone() method**
  - Add `clone(url: string, targetPath: Path): Promise<void>` to IGitClient interface
  - Add JSDoc with `@throws GitError` documenting error cases (network, auth, invalid URL, target exists)
  - Implement in SimpleGitClient using `await git.clone(url, targetPath.toNative(), { '--bare': null })`
  - Follow `wrapGitOperation` pattern for consistent error logging and GitError conversion
  - Add boundary test for clone operation including auth failure case
  - Files: `src/services/git/git-client.ts`, `src/services/git/simple-git-client.ts`, `src/services/git/simple-git-client.boundary.test.ts`
  - Test criteria: Boundary test passes, bare repo created

- [x] **Step 2: Add GitClient mock support**
  - Extend GitClientMock state to track cloned repositories with bare/remote properties
  - Add cloned repo to in-memory state when clone() is called
  - Use outcome-based matcher `toHaveClonedRepository(path)` that verifies repository exists in state
  - Do NOT use call-tracking pattern (avoid `toHaveCloned(url, path)`)
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Mock correctly simulates clone behavior with outcome verification

- [x] **Step 3: Extend ProjectConfig and ProjectStore**
  - Add optional `remoteUrl` field to ProjectConfig interface
  - Add `findByRemoteUrl(url: string): Promise<string | undefined>` to ProjectStore
  - Add URL normalization utility function in `src/services/project/url-utils.ts` (NOT in shared/)
  - Add `generateProjectIdFromUrl(url: string): ProjectId` function returning branded type
  - Increment CURRENT_PROJECT_VERSION to 2 - no migration needed, remoteUrl is optional. Version bump for forward compatibility only.
  - Add focused tests for URL normalization edge cases (credentials, ports, trailing slashes)
  - Files: `src/services/project/types.ts`, `src/services/project/project-store.ts`, `src/services/project/url-utils.ts`
  - Test criteria: Integration tests for URL lookup pass, focused tests for normalization pass

- [x] **Step 4: Add projects.clone() API method**
  - **NOTE: This adds new IPC channel - requires user approval per CLAUDE.md**
  - Add `clone` method to IProjectApi interface
  - Add IPC channel `api:project:clone`
  - Implement in CoreModule:
    1. Validate URL format (reject obviously invalid URLs early)
    2. Normalize URL and check for existing project
    3. If exists, return existing project
    4. Generate project ID from URL hash using `generateProjectIdFromUrl`
    5. Create project directory structure
    6. Call gitClient.clone() to bare clone to `git/` subdir
    7. On failure, clean up any partial state (no orphaned directories)
    8. Save project config with remoteUrl
    9. Return project
  - Files: `src/shared/api/interfaces.ts`, `src/shared/ipc.ts`, `src/main/modules/core/index.ts`, `src/preload/index.ts`
  - Test criteria: Integration tests for clone flow pass, including failure cleanup test

- [x] **Step 5: Add GitCloneDialog component**
  - Create new Svelte component with URL input, Cancel/Clone buttons
  - Set autofocus on URL textfield
  - Add inline URL validation before submit (regex check for protocol/domain)
  - Implement loading state (isCloning) with `<vscode-progress-ring>` and status text
  - Define `titleId="git-clone-title"` and `descriptionId="git-clone-status"` for accessibility
  - Call `projects.clone()` on submit
  - On success: call `openCreateDialog(newProject.id)` to return
  - On cancel: call `openCreateDialog()` to return (no project ID)
  - Files: `src/renderer/lib/components/GitCloneDialog.svelte`
  - Test criteria: Component renders, form validation works, accessibility IDs present

- [x] **Step 6: Extend dialog store**
  - Add `{ type: "git-clone" }` to DialogState union
  - Add `openGitCloneDialog()` action
  - Files: `src/renderer/lib/stores/dialogs.svelte.ts`
  - Test criteria: Dialog state transitions work correctly

- [x] **Step 7: Update MainView and CreateWorkspaceDialog**
  - Add GitCloneDialog rendering in MainView
  - Add git icon button to CreateWorkspaceDialog
  - Wire button to open git-clone dialog via `openGitCloneDialog()`
  - Files: `src/renderer/lib/components/MainView.svelte`, `src/renderer/lib/components/CreateWorkspaceDialog.svelte`
  - Test criteria: UI integration tests pass

- [x] **Step 8: Extend projects.close() for remote repo removal**
  - **NOTE: This modifies IPC channel signature - backward compatible (optional param)**
  - Add optional `removeLocalRepo` parameter to close method
  - When true and project has remoteUrl, delete entire project directory
  - Update IPC payload type
  - Files: `src/shared/api/interfaces.ts`, `src/main/modules/core/index.ts`, `src/preload/index.ts`
  - Test criteria: Integration tests for close with remove pass

- [x] **Step 9: Update CloseProjectDialog for remote projects**
  - Add `removeLocalRepo` checkbox state (only shown when project.remoteUrl exists)
  - Change checkbox label to "Delete cloned repository and all local files"
  - Add warning message (styled alert box) when checkbox is checked, showing original URL
  - When "Delete cloned repository" checked, auto-check and disable "Remove all workspaces"
  - Pass `removeLocalRepo` option to close() call
  - Ensure correct tab order (new checkbox after existing one)
  - Files: `src/renderer/lib/components/CloseProjectDialog.svelte`
  - Test criteria: UI shows/hides checkbox correctly, warning displays, auto-check behavior works

- [x] **Step 10: Add UI integration tests**
  - Test clone button opens dialog
  - Test clone success flow
  - Test clone error handling
  - Test cancel behavior
  - Test CloseProjectDialog remove checkbox visibility
  - Test CloseProjectDialog remove warning
  - Test CloseProjectDialog auto-check workspaces behavior
  - Files: `src/renderer/lib/components/GitCloneDialog.integration.test.ts`, `src/renderer/lib/components/CloseProjectDialog.integration.test.ts`
  - Test criteria: All UI integration tests pass

- [x] **Step 11: Update documentation**
  - Document `projects.clone()` API in docs/API.md (new section or extend existing)
  - Document `projects.close()` extended options in docs/API.md
  - Document remoteUrl config field in docs/ARCHITECTURE.md
  - Add `api:project:clone` to IPC Contract section in docs/ARCHITECTURE.md
  - Document GitCloneDialog and CloseProjectDialog changes in docs/USER_INTERFACE.md
  - Update CLAUDE.md with:
    - `remoteUrl` concept in Project key concepts
    - URL normalization pattern for remote projects in External System Access Rules if needed
  - Files: `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/USER_INTERFACE.md`, `CLAUDE.md`
  - Test criteria: Documentation is accurate and complete

## Dependencies

No new packages required. Uses existing `simple-git` library.

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `docs/API.md`            | Add `projects.clone(url)` method, document `projects.close()` extended options                                  |
| `docs/ARCHITECTURE.md`   | Document `remoteUrl` field in ProjectConfig, bare clone storage layout, add `api:project:clone` to IPC Contract |
| `docs/USER_INTERFACE.md` | Document GitCloneDialog and CloseProjectDialog changes for remote projects                                      |
| `CLAUDE.md`              | Add `remoteUrl` to Project key concepts, document URL normalization pattern                                     |

### New Documentation Required

None - all changes fit within existing documentation structure.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated (including CLAUDE.md)
- [ ] User acceptance testing passed:
  - [ ] Can clone public repo and create workspace
  - [ ] Can clone via SSH URL
  - [ ] Duplicate URL detection works
  - [ ] Error handling works correctly
  - [ ] CloseProjectDialog shows delete checkbox for remote projects
  - [ ] Delete checkbox auto-checks workspaces removal
  - [ ] Deleting local repository removes git directory
- [ ] CI passed
