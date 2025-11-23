# TDD Plan: Remove Workspace Feature

## Feature Summary

When a user hovers over a workspace in the sidebar:

- A close (X) button appears alongside the branch name (branch stays visible)
- Clicking the X opens a confirmation dialog

The dialog has three options:

- **Cancel**: Close dialog, no action
- **Keep Branch**: Delete only the git worktree, keep the branch
- **Delete**: Delete both the worktree and the branch

The dialog shows a warning if there are uncommitted changes.

---

## Critical: Close Button Behaviors

| Element                          | Close Button             | Behavior                                                                                                      |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Project item** (main worktree) | [x] next to project name | **ONLY removes project from sidebar** - NO git operations, NO file deletions. Calls existing `closeProject()` |
| **Additional workspace**         | [x] appears on hover     | Opens RemoveWorkspaceDialog - deletes worktree (and optionally branch)                                        |

**IMPORTANT**: The project-level close button must NEVER delete any files or git data. It only removes the project from the UI state (same as current `closeProject` behavior). This is existing functionality and must not change.

---

## UI Mockup

### Sidebar - Default State

```
┌─────────────────────────────────┐
│  Projects                       │
├─────────────────────────────────┤
│                                 │
│  📁 my-project          [+] [×] │  ← Project close = remove from sidebar only
│    ├─ 🔀 feature-auth  (feat-1) │  ← Additional worktree with branch
│    └─ 🔀 bugfix-123    (fix-1)  │
│                                 │
│  [Open Project]                 │
└─────────────────────────────────┘
```

### Sidebar - Workspace Hovered

```
┌─────────────────────────────────┐
│  Projects                       │
├─────────────────────────────────┤
│                                 │
│  📁 my-project          [+] [×] │
│    ├─ 🔀 feature-auth (feat) [×]│  ← Branch VISIBLE, close button ADDED
│    └─ 🔀 bugfix-123    (fix-1)  │
│                                 │
│  [Open Project]                 │
└─────────────────────────────────┘
```

**Note**: The branch name stays visible on hover. The close button appears alongside it using the same opacity transition pattern as the project-level buttons.

### RemoveWorkspaceDialog - No Uncommitted Changes

```
┌────────────────────────────────────────────┐
│  Remove Workspace                          │
├────────────────────────────────────────────┤
│                                            │
│  Are you sure you want to remove the       │
│  workspace "feature-auth"?                 │
│                                            │
│                                            │
│                                            │
│  ┌────────┐  ┌─────────────┐  ┌────────┐  │
│  │ Cancel │  │ Keep Branch │  │ Delete │  │
│  └────────┘  └─────────────┘  └────────┘  │
└────────────────────────────────────────────┘
```

### RemoveWorkspaceDialog - With Uncommitted Changes

```
┌────────────────────────────────────────────┐
│  Remove Workspace                          │
├────────────────────────────────────────────┤
│                                            │
│  Are you sure you want to remove the       │
│  workspace "feature-auth"?                 │
│                                            │
│  ┌────────────────────────────────────┐    │
│  │ ⚠ Warning: This workspace has      │    │
│  │   uncommitted changes that will    │    │
│  │   be lost.                         │    │
│  └────────────────────────────────────┘    │
│                                            │
│  ┌────────┐  ┌─────────────┐  ┌────────┐  │
│  │ Cancel │  │ Keep Branch │  │ Delete │  │
│  └────────┘  └─────────────┘  └────────┘  │
└────────────────────────────────────────────┘
```

### Button Behaviors

| Button          | Action                                | Style             |
| --------------- | ------------------------------------- | ----------------- |
| **Cancel**      | Close dialog, no changes              | Secondary         |
| **Keep Branch** | Remove worktree only, branch remains  | Secondary         |
| **Delete**      | Remove worktree AND delete the branch | Destructive (red) |

---

## Implementation Phases (TDD)

Each phase follows the Red-Green-Refactor cycle:

1. **RED**: Write a failing test
2. **GREEN**: Write minimal code to pass
3. **REFACTOR**: Clean up while keeping tests passing

### Order of Implementation

```
Phase 0 (Test Utils) ──► Phase 1 (Rust) ──► Phase 2 (Rust) ──► Phase 3 (Rust)
                                                                     │
                                                                     ▼
Phase 4 (TS types/API) ◄─────────────────────────────────────────────┘
         │
         ▼
Phase 5 (Store) ──► Phase 6 (Service) ──► Phase 7 (Dialog) ──► Phase 8 (Sidebar)
```

---

## Phase 0: Extend Test Utilities

**Goal**: Add helper methods to `TestRepo` for creating dirty workspace states

**File**: `src-tauri/src/test_utils.rs`

### Methods to Add

```rust
impl TestRepo {
    /// Create a modified (unstaged) file in a worktree
    pub fn create_modified_file(&self, worktree_path: &Path, filename: &str, content: &str) -> Result<(), Box<dyn std::error::Error>>;

    /// Create a staged file in a worktree
    pub fn create_staged_file(&self, worktree_path: &Path, filename: &str, content: &str) -> Result<(), Box<dyn std::error::Error>>;

    /// Create an untracked file in a worktree
    pub fn create_untracked_file(&self, worktree_path: &Path, filename: &str, content: &str) -> Result<(), Box<dyn std::error::Error>>;
}
```

---

## Phase 1: Backend - Check for Uncommitted Changes

**Goal**: Add ability to detect if a workspace has uncommitted changes

**File**: `src-tauri/src/git_worktree_provider.rs`

### Method to Implement

```rust
impl GitWorktreeProvider {
    /// Check if a workspace has uncommitted changes (modified, staged, or untracked files)
    pub async fn has_uncommitted_changes(&self, workspace_path: &Path) -> Result<bool, WorkspaceError>;
}
```

### Implementation Notes

- Use `git2::Repository::statuses()` with appropriate `StatusOptions`
- Run in `spawn_blocking` to avoid blocking async runtime
- Consider adding timeout like `discover()` has for large repos

### Test Cases

```rust
#[tokio::test]
async fn test_has_uncommitted_changes_clean_workspace();

#[tokio::test]
async fn test_has_uncommitted_changes_with_modified_files();

#[tokio::test]
async fn test_has_uncommitted_changes_with_staged_files();

#[tokio::test]
async fn test_has_uncommitted_changes_with_untracked_files();

#[tokio::test]
async fn test_has_uncommitted_changes_with_staged_and_modified();

#[tokio::test]
async fn test_has_uncommitted_changes_with_deleted_files();

#[tokio::test]
async fn test_has_uncommitted_changes_invalid_path();

#[tokio::test]
async fn test_has_uncommitted_changes_main_worktree();
```

---

## Phase 2: Backend - Remove Workspace

**Goal**: Add ability to remove a git worktree, optionally deleting its branch

**File**: `src-tauri/src/workspace_provider.rs` (error types)
**File**: `src-tauri/src/git_worktree_provider.rs` (implementation)

### Error Types to Add

```rust
pub enum WorkspaceError {
    // ... existing variants ...

    #[error("Cannot remove main worktree")]
    CannotRemoveMainWorktree,

    #[error("Workspace not found: {0}")]
    WorkspaceNotFound(PathBuf),

    #[error("Worktree removal failed: {0}")]
    WorktreeRemovalFailed(String),

    #[error("Branch deletion failed: {0}")]
    BranchDeletionFailed(String),
}
```

### Return Type

```rust
/// Result of a workspace removal operation
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalResult {
    pub worktree_removed: bool,
    pub branch_deleted: bool,
}
```

### Method to Implement

```rust
impl GitWorktreeProvider {
    /// Remove a workspace (git worktree).
    ///
    /// # Arguments
    /// * `workspace_path` - Path to the worktree to remove
    /// * `delete_branch` - If true, also deletes the associated branch
    ///
    /// # Returns
    /// `RemovalResult` indicating what was removed
    ///
    /// # Note
    /// This operation is NOT atomic. If worktree removal succeeds but branch
    /// deletion fails, the worktree is still removed.
    pub async fn remove_workspace(
        &self,
        workspace_path: &Path,
        delete_branch: bool,
    ) -> Result<RemovalResult, WorkspaceError>;
}
```

### Implementation Notes

- git2 does NOT have a direct `remove_worktree` method
- Must manually: (1) remove directory with `std::fs::remove_dir_all`, (2) prune worktree metadata
- Branch deletion may fail if branch is checked out elsewhere or has other refs
- Operation is NOT atomic - document this clearly
- Make idempotent: removing already-removed workspace should succeed or return specific status

### Test Cases

```rust
#[tokio::test]
async fn test_remove_workspace_keeps_branch();

#[tokio::test]
async fn test_remove_workspace_deletes_branch();

#[tokio::test]
async fn test_remove_workspace_rejects_main_worktree();

#[tokio::test]
async fn test_remove_workspace_nonexistent_path();

#[tokio::test]
async fn test_remove_workspace_not_a_worktree();

#[tokio::test]
async fn test_remove_workspace_with_uncommitted_changes();

#[tokio::test]
async fn test_remove_workspace_cleans_metadata();

#[tokio::test]
async fn test_remove_workspace_not_found_in_discover_after_removal();

#[tokio::test]
async fn test_remove_workspace_idempotent_already_removed();

#[tokio::test]
async fn test_remove_workspace_concurrent_removal_attempts();

#[tokio::test]
async fn test_remove_workspace_branch_deletion_fails_worktree_still_removed();
```

---

## Phase 3: Backend - Tauri Commands

**Goal**: Expose backend functionality to frontend via Tauri commands

**File**: `src-tauri/src/lib.rs`

### Structs/Commands to Add

```rust
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub has_uncommitted_changes: bool,
    pub is_main_worktree: bool,
}

pub async fn check_workspace_status_impl(
    state: &AppState,
    handle: String,
    workspace_path: String,
) -> Result<WorkspaceStatus, String>;

#[tauri::command]
async fn check_workspace_status(
    state: tauri::State<'_, AppState>,
    handle: String,
    workspace_path: String,
) -> Result<WorkspaceStatus, String>;

pub async fn remove_workspace_impl(
    state: &AppState,
    handle: String,
    workspace_path: String,
    delete_branch: bool,
) -> Result<RemovalResult, String>;

#[tauri::command]
async fn remove_workspace(
    state: tauri::State<'_, AppState>,
    handle: String,
    workspace_path: String,
    delete_branch: bool,
) -> Result<RemovalResult, String>;
```

### Registration Note

Add to `invoke_handler![]` macro in `lib.rs`:

```rust
tauri::generate_handler![
    // ... existing handlers ...
    check_workspace_status,
    remove_workspace,
]
```

### Test Cases

```rust
#[tokio::test]
async fn test_check_workspace_status_impl_clean();

#[tokio::test]
async fn test_check_workspace_status_impl_dirty();

#[tokio::test]
async fn test_check_workspace_status_impl_main_worktree();

#[tokio::test]
async fn test_check_workspace_status_impl_invalid_handle();

#[tokio::test]
async fn test_remove_workspace_impl_keep_branch();

#[tokio::test]
async fn test_remove_workspace_impl_delete_branch();

#[tokio::test]
async fn test_remove_workspace_impl_invalid_handle();

#[tokio::test]
async fn test_remove_workspace_impl_partial_failure_returns_result();
```

---

## Phase 4: Frontend - TypeScript API & Types

**Goal**: Add TypeScript types and API wrapper functions

**File**: `src/lib/types/project.ts`

### Types to Add

```typescript
export interface WorkspaceStatus {
  hasUncommittedChanges: boolean;
  isMainWorktree: boolean;
}

export interface RemovalResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}
```

**File**: `src/lib/api/tauri.ts`

### Functions to Add

```typescript
/**
 * Check workspace status (uncommitted changes, is main worktree).
 */
export async function checkWorkspaceStatus(
  handle: ProjectHandle,
  workspacePath: string
): Promise<WorkspaceStatus> {
  return await invoke<WorkspaceStatus>('check_workspace_status', { handle, workspacePath });
}

/**
 * Remove a workspace (git worktree).
 * @param deleteBranch - If true, also deletes the associated branch
 */
export async function removeWorkspace(
  handle: ProjectHandle,
  workspacePath: string,
  deleteBranch: boolean
): Promise<RemovalResult> {
  return await invoke<RemovalResult>('remove_workspace', { handle, workspacePath, deleteBranch });
}
```

### Test Cases

_(No unit tests - thin wrapper layer, validated by TypeScript compiler)_

---

## Phase 5: Frontend - Store Updates

**Goal**: Add store function to remove workspace and handle active workspace switching

**File**: `src/lib/stores/projects.ts`

### Function to Add

```typescript
/**
 * Remove a workspace from a project in the store.
 * If the removed workspace was active, switches to the main workspace.
 */
export function removeWorkspaceFromProject(handle: ProjectHandle, workspacePath: string): void;
```

### Implementation Notes

- Must handle case where removed workspace was the active workspace
- Switch to main workspace (first workspace) when active is removed
- Main worktree cannot be removed, so there's always at least one workspace

### Test Cases

```typescript
describe('removeWorkspaceFromProject', () => {
  it('removes workspace from project workspaces array');

  it('does not affect other projects');

  it('switches to main workspace if removed workspace was active');

  it('does not change activeWorkspace if different workspace was active');

  it('handles removing from project that does not exist gracefully');
});
```

---

## Phase 6: Frontend - Service Layer

**Goal**: Add service function that coordinates API call and store update

**File**: `src/lib/services/projectManager.ts`

### Functions to Add

```typescript
/**
 * Check workspace status (uncommitted changes).
 */
export async function checkWorkspaceStatus(
  handle: ProjectHandle,
  workspacePath: string
): Promise<WorkspaceStatus>;

/**
 * Remove a workspace from a project.
 * - Navigates away from workspace if it's currently active in the iframe
 * - Calls backend to remove worktree (and optionally branch)
 * - Updates store on success
 */
export async function removeWorkspace(
  handle: ProjectHandle,
  workspacePath: string,
  deleteBranch: boolean
): Promise<RemovalResult>;
```

**File**: `src/lib/services/projectManager.test.ts`

### Test Cases

```typescript
describe('removeWorkspace', () => {
  it('calls backend API with correct parameters for keep branch');

  it('calls backend API with correct parameters for delete branch');

  it('removes workspace from store after successful API call');

  it('switches to main workspace if removed workspace was active');

  it('throws error and does not update store if API call fails');

  it('returns RemovalResult from backend');
});

describe('checkWorkspaceStatus', () => {
  it('returns status from backend API');

  it('propagates backend errors');
});
```

---

## Phase 7: Frontend - RemoveWorkspaceDialog Component

**Goal**: Create the confirmation dialog with three buttons and warning message

**File**: `src/lib/components/RemoveWorkspaceDialog.svelte` (new)
**File**: `src/lib/components/RemoveWorkspaceDialog.test.ts` (new)

### Component Props

```typescript
interface Props {
  project: Project;
  workspace: Workspace;
  onClose: () => void;
  onRemoved: () => void;
  triggerElement: HTMLElement | null;
}
```

### Implementation Notes

- Use `$props()` for incoming data (match CreateWorkspaceDialog pattern)
- Add `dialogRef` for focus trapping
- Fetch status on mount (not as prop) to ensure fresh data
- Add `aria-labelledby="dialog-title"` for accessibility
- Add `aria-describedby` pointing to warning when uncommitted changes exist
- Add `aria-busy` on buttons during loading
- Use `role="alert"` on warning message for screen readers
- Delete button should have destructive styling (red)

### Test Cases

```typescript
describe('RemoveWorkspaceDialog', () => {
  it('renders dialog with correct title');

  it('displays workspace name in confirmation message');

  it('fetches workspace status on mount');

  it('shows loading state while fetching status');

  it('shows warning when workspace has uncommitted changes');

  it('does not show warning when workspace is clean');

  it('Cancel button closes dialog without action');

  it('Keep Branch button calls removeWorkspace with deleteBranch=false');

  it('Delete button calls removeWorkspace with deleteBranch=true');

  it('shows loading state during removal');

  it('disables all buttons during removal');

  it('calls onRemoved callback after successful removal');

  it('displays error message if removal fails');

  it('displays error message if status check fails');

  it('closes on Escape key press');

  it('closes when clicking outside dialog');

  it('traps focus within dialog');

  it('has correct aria attributes for accessibility');

  it('prevents double-click submission');
});
```

---

## Phase 8: Frontend - Sidebar Hover Behavior

**Goal**: Show close button on workspace hover (alongside branch name)

**File**: `src/lib/components/Sidebar.svelte`
**File**: `src/lib/components/Sidebar.test.ts`

### State to Add

```typescript
let hoveredWorkspacePath = $state<string | null>(null);
let removeDialogWorkspace = $state<{ project: Project; workspace: Workspace } | null>(null);
```

### Implementation Notes

- Close button appears via opacity transition (same as project buttons)
- Branch name stays visible (not hidden on hover)
- Only additional worktrees get the close button, not the main worktree
- Main worktree close is handled by existing project close button

### Test Cases

```typescript
describe('Workspace hover behavior', () => {
  it('shows branch name by default');

  it('shows close button on workspace hover via opacity');

  it('branch name remains visible on hover');

  it('hides close button when hover ends');

  it('does not show close button for main workspace (project item)');
});

describe('Workspace removal integration', () => {
  it('opens RemoveWorkspaceDialog when close button clicked');

  it('closes dialog and removes workspace from list after removal');

  it('workspace disappears from sidebar after removal');

  it('switches active workspace to main if removed workspace was active');
});

describe('Main worktree close button safety', () => {
  it('project close button only removes from sidebar without any git operations');

  it('project close button does not open RemoveWorkspaceDialog');

  it('project close button calls closeProject not removeWorkspace');

  it('closing project does not delete any files on disk');
});
```

---

## Files to Create/Modify

| File                                               | Action                           |
| -------------------------------------------------- | -------------------------------- |
| `src-tauri/src/test_utils.rs`                      | Modify - add helper methods      |
| `src-tauri/src/workspace_provider.rs`              | Modify - add error variants      |
| `src-tauri/src/git_worktree_provider.rs`           | Modify - add methods + tests     |
| `src-tauri/src/lib.rs`                             | Modify - add commands            |
| `src/lib/types/project.ts`                         | Modify - add types               |
| `src/lib/api/tauri.ts`                             | Modify - add API functions       |
| `src/lib/stores/projects.ts`                       | Modify - add store function      |
| `src/lib/stores/projects.test.ts`                  | **Create** - store tests         |
| `src/lib/services/projectManager.ts`               | Modify - add service functions   |
| `src/lib/services/projectManager.test.ts`          | Modify - add tests               |
| `src/lib/components/RemoveWorkspaceDialog.svelte`  | **Create**                       |
| `src/lib/components/RemoveWorkspaceDialog.test.ts` | **Create**                       |
| `src/lib/components/Sidebar.svelte`                | Modify - hover behavior + dialog |
| `src/lib/components/Sidebar.test.ts`               | Modify - add tests               |

---

## Summary

| Phase | Location           | Tests | Methods/Components                        |
| ----- | ------------------ | ----- | ----------------------------------------- |
| 0     | Rust Test Utils    | 0     | `TestRepo` helper methods                 |
| 1     | Rust Backend       | 8     | `has_uncommitted_changes()`               |
| 2     | Rust Backend       | 11    | `remove_workspace()`, error types, result |
| 3     | Rust Backend       | 8     | Tauri commands                            |
| 4     | TypeScript         | 0     | Types, API wrappers                       |
| 5     | TypeScript Store   | 5     | `removeWorkspaceFromProject()`            |
| 6     | TypeScript Service | 8     | Service functions                         |
| 7     | Svelte Component   | 19    | `RemoveWorkspaceDialog`                   |
| 8     | Svelte Component   | 13    | Sidebar updates + safety tests            |

**Total: 72 test cases**

---

## Reviewer Feedback Addressed

| Issue                                                           | Resolution                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Don't hide branch name on hover                                 | Show close button alongside branch via opacity transition                             |
| Add `isMainWorktree` property                                   | Added to `WorkspaceStatus` type returned by `check_workspace_status`                  |
| Invalid test "clears activeWorkspace if last workspace removed" | Removed - main worktree cannot be removed                                             |
| Partial failure handling                                        | Added `RemovalResult` return type and `BranchDeletionFailed` error variant            |
| git2 worktree removal complexity                                | Documented manual cleanup in implementation notes                                     |
| Add Phase 5 unit tests                                          | Added direct tests for store function                                                 |
| Accessibility gaps                                              | Added `aria-labelledby`, `aria-describedby`, `aria-busy`, `role="alert"` requirements |
| Missing Tauri handler registration                              | Added note in Phase 3                                                                 |
| Extend `TestRepo` helper                                        | Added Phase 0 for test utility extensions                                             |
| Concurrent removal handling                                     | Added test case for concurrent removal attempts                                       |
| Main worktree safety                                            | Added explicit test cases verifying project close does not delete files               |
