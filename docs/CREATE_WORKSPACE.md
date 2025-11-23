# Create Workspace Feature

**Document Version:** 2.0  
**Last Updated:** 2025-11-23

This document describes the implementation plan for the "Create Workspace" feature.

---

## Overview

The feature allows users to create new git worktrees (workspaces) from within the UI. A user clicks a "+" button on a project, fills in a dialog with name and base branch, and a new workspace is created and activated.

---

## User Flow

1. User clicks "+" button on a project in the sidebar
2. Dialog opens with:
   - Name input field
   - Base branch dropdown (filterable, shows local + remote branches)
   - Small spinner shown while branches are being fetched in background
3. User types a name (validated in real-time)
4. User selects a base branch (can type to filter)
5. User clicks OK
6. New workspace is created and becomes active
7. UI updates to show the new workspace

---

## UI Mockups

### Sidebar with Create Button

```
┌─────────────────────────────────┐
│  Projects                       │
├─────────────────────────────────┤
│                                 │
│  📁 my-project          [+]     │  ← [+] appears on hover
│     🌿 feature-auth (feat-auth) │
│     🌿 bugfix-123 (fix-123)     │
│                                 │
│  📁 other-project       [+]     │
│     🌿 experiment (exp)         │
│                                 │
│  [ Open Project ]               │
│                                 │
└─────────────────────────────────┘
```

### Create Workspace Dialog

**Initial state (fetching branches):**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Base Branch                       [◐]   │  ← Spinner while fetching
│  ┌────────────────────────────────────┐  │
│  │ main                           [▼] │  │
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [ OK ]          │
│                         ~~~~~~~~         │  ← OK disabled
└──────────────────────────────────────────┘
```

**Typing to filter branches:**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │ my-feature                         │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Base Branch                             │
│  ┌────────────────────────────────────┐  │
│  │ feat|                              │  │  ← User typing "feat"
│  ├────────────────────────────────────┤  │
│  │   feature-auth                     │  │  ← Filtered local branches
│  │   feature-new                      │  │
│  │   origin/feature-auth              │  │  ← Filtered remote branches
│  │   origin/feature-new               │  │
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [ OK ]          │
└──────────────────────────────────────────┘
```

**Name validation error:**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │ -invalid                           │  │  ← Red border (invalid state)
│  └────────────────────────────────────┘  │
│  ⚠ Must start with letter or number     │
│                                          │
│  Base Branch                             │
│  ┌────────────────────────────────────┐  │
│  │ main                           [▼] │  │
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [ OK ]          │
│                         ~~~~~~~~         │  ← OK disabled
└──────────────────────────────────────────┘
```

**Name matches existing branch (auto-select as base):**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │ feature-auth                       │  │  ← Red border
│  └────────────────────────────────────┘  │
│  ⚠ A local branch with this name exists │
│                                          │
│  Base Branch                             │
│  ┌────────────────────────────────────┐  │
│  │ origin/feature-auth            [▼] │  │  ← Auto-selected!
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [ OK ]          │
│                         ~~~~~~~~         │  ← OK disabled (name invalid)
└──────────────────────────────────────────┘
```

**Valid state:**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │ my-feature                         │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Base Branch                             │
│  ┌────────────────────────────────────┐  │
│  │ origin/main                    [▼] │  │
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [ OK ]          │
│                         ══════           │  ← OK enabled
└──────────────────────────────────────────┘
```

**Creating (loading):**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │ my-feature                         │  │  ← Disabled
│  └────────────────────────────────────┘  │
│                                          │
│  Base Branch                             │
│  ┌────────────────────────────────────┐  │
│  │ origin/main                    [▼] │  │  ← Disabled
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [◐ Creating...] │  ← Spinner + text
│               ~~~~~~~~   ~~~~~~~~~~~~~~~ │  ← Both disabled
└──────────────────────────────────────────┘
```

**Backend error:**

```
┌──────────────────────────────────────────┐
│         Create Workspace                 │
│                                          │
│  Name                                    │
│  ┌────────────────────────────────────┐  │
│  │ my-feature                         │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Base Branch                             │
│  ┌────────────────────────────────────┐  │
│  │ origin/main                    [▼] │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ ⚠ Could not create workspace.     │  │  ← User-friendly message
│  │   Please try again.               │  │
│  └────────────────────────────────────┘  │
│                                          │
│              [ Cancel ]  [ OK ]          │  ← OK enabled for retry
└──────────────────────────────────────────┘
```

---

## Keyboard Navigation

| Key               | Context                                   | Action                                                                  |
| ----------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| **Tab**           | Dialog                                    | Move focus between Name → Base Branch → Cancel → OK (trapped in dialog) |
| **Shift+Tab**     | Dialog                                    | Move focus backwards (wraps from Name to OK)                            |
| **Enter**         | Name input                                | Submit form (same as clicking OK) if valid                              |
| **Enter**         | Base Branch dropdown (closed)             | Open dropdown                                                           |
| **Enter**         | Base Branch dropdown (open, item focused) | Select item, close dropdown                                             |
| **Enter**         | OK button focused                         | Submit form                                                             |
| **Arrow Up/Down** | Base Branch dropdown open                 | Navigate options                                                        |
| **Escape**        | Dropdown open                             | Close dropdown (check dropdown state first)                             |
| **Escape**        | Dialog (dropdown closed)                  | Close dialog, return focus to "+" button                                |
| **Type any char** | Base Branch dropdown                      | Filter options                                                          |

### Focus Management

1. **On dialog open**: Focus name input field
2. **Focus trap**: Tab cycles within dialog (Name → Branch → Cancel → OK → Name)
3. **On dialog close**: Return focus to the "+" button that triggered the dialog

---

## Validation Rules

### Name Validation (Frontend Only)

All validation is performed in the frontend. The backend trusts the frontend validation.

1. **Format**: `^[a-zA-Z0-9][a-zA-Z0-9_\-\./]*$`
   - Must start with letter or number
   - Can contain letters, numbers, hyphens, underscores, slashes, dots
   - Max 100 characters
   - **Security**: Must not contain `..` (path traversal)

2. **Uniqueness check** (against):
   - Existing branch names:
     - For remote branches: strip the remote prefix (e.g., `origin/feat/auth` → `feat/auth`)
     - For local branches: use as-is (e.g., `fix/a` stays `fix/a`)
     - Example: `fix/a` and `feat/a` are different, both valid
   - Existing workspace names in project

3. **OK button enabled when**:
   - Name is non-empty
   - Name passes format validation
   - Name does not contain `..`
   - Name is unique
   - Branch is selected
   - Not currently loading

### Auto-select Behavior

When the entered workspace name matches a remote branch name (after stripping the remote prefix), automatically select that remote branch as the base branch.

Example: User types `feat/auth` → if `origin/feat/auth` exists, select it as base branch.

---

## Error Messages

User-friendly error messages mapped from backend errors:

| Backend Error            | User Message                                                          |
| ------------------------ | --------------------------------------------------------------------- |
| `BranchNotFound`         | "The selected branch no longer exists. Please refresh and try again." |
| `WorkspaceAlreadyExists` | "A workspace with this name already exists."                          |
| `WorktreeCreationFailed` | "Could not create workspace. Please try again."                       |
| `GitError`               | "Could not create workspace. Please try again."                       |
| Other errors             | "An unexpected error occurred. Please try again."                     |

---

## Architecture

### Worktree Path

New worktrees are created at:

```
<app-data>/projects/<project-name>-<8-char-hash>/workspaces/<workspace-name>
```

Example:

```
~/.local/share/chime/projects/my-app-a1b2c3d4/workspaces/feature-auth/
```

### Backend Components

All git operations are contained within `GitWorktreeProvider`:

```rust
impl GitWorktreeProvider {
    // Existing
    async fn new(project_root: PathBuf) -> Result<Self, WorkspaceError>;
    async fn discover(&self) -> Result<Vec<GitWorktree>, WorkspaceError>;

    // New methods
    async fn list_branches(&self) -> Result<Vec<BranchInfo>, WorkspaceError>;
    async fn create_workspace(&self, name: &str, base_branch: &str) -> Result<GitWorktree, WorkspaceError>;
    async fn fetch_branches(&self) -> Result<(), WorkspaceError>;
}
```

Tauri commands in `lib.rs` follow the `_impl` pattern for testability:

```rust
// Implementation function (testable)
pub async fn list_branches_impl(state: &AppState, handle: String) -> Result<Vec<BranchInfo>, String> { ... }

// Thin Tauri command wrapper
#[tauri::command]
async fn list_branches(state: tauri::State<'_, AppState>, handle: String) -> Result<Vec<BranchInfo>, String> {
    list_branches_impl(&state, handle).await
}
```

**No git logic in `lib.rs`.**

### Shared Utilities

Add `get_project_workspaces_dir()` to `platform/paths.rs`. Do NOT move `project_dir_name` from `ProjectStore`:

```rust
// platform/paths.rs
/// Get the workspaces directory for a project.
/// Path: <app-data>/projects/<project-name>-<8-char-hash>/workspaces/
pub fn get_project_workspaces_dir(project_path: &Path) -> PathBuf {
    let name = project_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string());

    let mut hasher = Sha256::new();
    hasher.update(project_path.to_string_lossy().as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    get_data_projects_dir()
        .join(format!("{}-{}", name, &hash[..8]))
        .join("workspaces")
}
```

---

## Implementation Tasks

### Backend

#### 1. Update `workspace_provider.rs`

Add `BranchInfo` struct with serde rename:

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
}
```

Add new error variants with user-friendly messages:

```rust
#[derive(Debug, Error)]
pub enum WorkspaceError {
    // ... existing variants ...

    #[error("Branch not found: {0}")]
    BranchNotFound(String),

    #[error("Workspace already exists at: {0}")]
    WorkspaceAlreadyExists(PathBuf),

    #[error("Worktree creation failed: {0}")]
    WorktreeCreationFailed(String),
}
```

#### 2. Update `platform/paths.rs`

Add `get_project_workspaces_dir()` function (see code above).

**Do NOT modify `project_store.rs`** - keep `project_dir_name` where it is.

#### 3. Implement in `git_worktree_provider.rs`

**Important: All git2 operations must be in a single `spawn_blocking` block** because git2 types are `!Send`.

**`list_branches`:**

```rust
async fn list_branches(&self) -> Result<Vec<BranchInfo>, WorkspaceError> {
    let project_root = self.project_root.clone();

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_root)?;
        let mut branches = Vec::new();

        // Local branches
        for branch_result in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                branches.push(BranchInfo {
                    name: name.to_string(),
                    is_remote: false,
                });
            }
        }

        // Remote branches (skip */HEAD refs)
        for branch_result in repo.branches(Some(BranchType::Remote))? {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                if !name.ends_with("/HEAD") {
                    branches.push(BranchInfo {
                        name: name.to_string(),
                        is_remote: true,
                    });
                }
            }
        }

        Ok(branches)
    })
    .await
    .map_err(|_| WorkspaceError::TaskCancelled)?
}
```

**`create_workspace` with rollback on failure:**

```rust
async fn create_workspace(&self, name: &str, base_branch: &str) -> Result<GitWorktree, WorkspaceError> {
    let project_root = self.project_root.clone();
    let name = name.to_string();
    let base_branch = base_branch.to_string();

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_root)?;

        // Build worktree path
        let worktree_path = get_project_workspaces_dir(&project_root).join(&name);

        // Find base branch (try local first, then remote)
        let base_ref = repo
            .find_branch(&base_branch, BranchType::Local)
            .or_else(|_| repo.find_branch(&base_branch, BranchType::Remote))
            .map_err(|_| WorkspaceError::BranchNotFound(base_branch.clone()))?;

        let commit = base_ref.get().peel_to_commit()?;

        // Create new local branch
        let new_branch = repo.branch(&name, &commit, false).map_err(|e| {
            if e.code() == ErrorCode::Exists {
                WorkspaceError::WorkspaceAlreadyExists(worktree_path.clone())
            } else {
                WorkspaceError::GitError(e)
            }
        })?;

        // Create parent directories
        if let Some(parent) = worktree_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Create worktree - if this fails, clean up the orphan branch
        let mut opts = WorktreeAddOptions::new();
        opts.reference(Some(&new_branch.into_reference()));

        match repo.worktree(&name, &worktree_path, Some(&opts)) {
            Ok(_) => Ok(GitWorktree {
                name: name.clone(),
                path: worktree_path,
                branch: Some(name),
            }),
            Err(e) => {
                // Rollback: delete orphan branch (best effort)
                if let Ok(mut branch) = repo.find_branch(&name, BranchType::Local) {
                    let _ = branch.delete();
                }
                // Remove any partial directory (best effort)
                let _ = std::fs::remove_dir_all(&worktree_path);

                Err(WorkspaceError::WorktreeCreationFailed(e.to_string()))
            }
        }
    })
    .await
    .map_err(|_| WorkspaceError::TaskCancelled)?
}
```

**`fetch_branches` (cancellable, no timeout):**

The fetch operation runs in background. When the user closes the dialog (OK or Cancel), the fetch is cancelled via dropping the `AbortHandle`.

```rust
async fn fetch_branches(&self) -> Result<(), WorkspaceError> {
    let project_root = self.project_root.clone();

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_root)?;

        // Fetch all remotes
        for remote_name in repo.remotes()?.iter().flatten() {
            if let Ok(mut remote) = repo.find_remote(remote_name) {
                // Best effort - don't fail if one remote fails
                let _ = remote.fetch(&[] as &[&str], None, None);
            }
        }

        Ok(())
    })
    .await
    .map_err(|_| WorkspaceError::TaskCancelled)?
}
```

#### 4. Add Tauri commands in `lib.rs`

Follow the `_impl` pattern for testability:

```rust
/// Internal implementation for listing branches
pub async fn list_branches_impl(state: &AppState, handle: String) -> Result<Vec<BranchInfo>, String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    provider.list_branches().await.to_tauri()
}

#[tauri::command]
async fn list_branches(
    state: tauri::State<'_, AppState>,
    handle: String,
) -> Result<Vec<BranchInfo>, String> {
    list_branches_impl(&state, handle).await
}

/// Internal implementation for creating a workspace
pub async fn create_workspace_impl(
    state: &AppState,
    handle: String,
    name: String,
    base_branch: String,
) -> Result<WorkspaceInfo, String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    let workspace = provider.create_workspace(&name, &base_branch).await.to_tauri()?;

    // Build WorkspaceInfo with code-server URL
    let port = state.code_server_manager.ensure_running().await.map_err(|e| e.to_string())?;
    let url = format!(
        "http://localhost:{}/?folder={}",
        port,
        crate::platform::paths::encode_path_for_url(workspace.path())
    );

    Ok(WorkspaceInfo {
        name: workspace.name().to_string(),
        path: workspace.path().to_string_lossy().to_string(),
        branch: workspace.branch().map(String::from),
        port,
        url,
    })
}

#[tauri::command]
async fn create_workspace(
    state: tauri::State<'_, AppState>,
    handle: String,
    name: String,
    base_branch: String,
) -> Result<WorkspaceInfo, String> {
    create_workspace_impl(&state, handle, name, base_branch).await
}

/// Internal implementation for fetching branches
pub async fn fetch_branches_impl(state: &AppState, handle: String) -> Result<(), String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    provider.fetch_branches().await.to_tauri()
}

#[tauri::command]
async fn fetch_branches(
    state: tauri::State<'_, AppState>,
    handle: String,
) -> Result<(), String> {
    fetch_branches_impl(&state, handle).await
}
```

Register in `invoke_handler`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    list_branches,
    create_workspace,
    fetch_branches,
])
```

### Frontend

#### 5. Update types (`src/lib/types/project.ts`)

```typescript
export interface BranchInfo {
  name: string;
  isRemote: boolean;
}
```

#### 6. Add API functions (`src/lib/api/tauri.ts`)

Use consistent verb+noun naming with snake_case for invoke:

```typescript
export async function listBranches(handle: ProjectHandle): Promise<BranchInfo[]> {
  return await invoke<BranchInfo[]>('list_branches', { handle });
}

export async function createWorkspace(
  handle: ProjectHandle,
  name: string,
  baseBranch: string
): Promise<Workspace> {
  return await invoke<Workspace>('create_workspace', { handle, name, baseBranch });
}

export async function fetchBranches(handle: ProjectHandle): Promise<void> {
  return await invoke('fetch_branches', { handle });
}
```

#### 7. Update stores (`src/lib/stores/projects.ts`)

Match existing pattern:

```typescript
export function addWorkspaceToProject(handle: ProjectHandle, workspace: Workspace): void {
  projects.update((p) =>
    p.map((proj) =>
      proj.handle === handle ? { ...proj, workspaces: [...proj.workspaces, workspace] } : proj
    )
  );
}
```

#### 8. Update service (`src/lib/services/projectManager.ts`)

Use `ProjectHandle` for consistency:

```typescript
import {
  listBranches as listBranchesApi,
  createWorkspace as createWorkspaceApi,
  fetchBranches as fetchBranchesApi,
} from '$lib/api/tauri';
import { addWorkspaceToProject, activeWorkspace } from '$lib/stores/projects';
import type { ProjectHandle, Workspace, BranchInfo } from '$lib/types/project';

export async function listBranches(handle: ProjectHandle): Promise<BranchInfo[]> {
  return await listBranchesApi(handle);
}

export async function fetchBranches(handle: ProjectHandle): Promise<void> {
  return await fetchBranchesApi(handle);
}

export async function createNewWorkspace(
  handle: ProjectHandle,
  name: string,
  baseBranch: string
): Promise<Workspace> {
  try {
    const workspace = await createWorkspaceApi(handle, name, baseBranch);

    // Add to store
    addWorkspaceToProject(handle, workspace);

    // Set as active
    activeWorkspace.set({
      projectHandle: handle,
      workspacePath: workspace.path,
    });

    return workspace;
  } catch (error) {
    console.error('Failed to create workspace:', error);
    throw error;
  }
}
```

#### 9. Create `CreateWorkspaceDialog.svelte`

Use Svelte 5 syntax with proper accessibility:

```svelte
<script lang="ts">
  import type { Project, BranchInfo, Workspace, ProjectHandle } from '$lib/types/project';
  import { listBranches, fetchBranches, createNewWorkspace } from '$lib/services/projectManager';

  interface Props {
    project: Project;
    onClose: () => void;
    onCreated: (workspace: Workspace) => void;
    triggerElement: HTMLElement | null;
  }

  let { project, onClose, onCreated, triggerElement }: Props = $props();

  // Refs
  let dialogRef: HTMLElement | null = $state(null);
  let nameInputRef: HTMLElement | null = $state(null);
  let branchSelectRef: HTMLElement | null = $state(null);

  // Form state
  let name = $state('');
  let selectedBranch = $state('');
  let branches = $state<BranchInfo[]>([]);
  let isCreating = $state(false);
  let isLoadingBranches = $state(true);
  let isFetchingRemotes = $state(false);
  let backendError = $state<string | null>(null);

  // Abort controller for cancelling fetch
  let fetchAbortController: AbortController | null = null;

  // Validation
  let nameError = $derived(validateName(name));
  let isValid = $derived(name.trim() !== '' && !nameError && selectedBranch !== '' && !isCreating);

  // Extract branch names for uniqueness check
  let existingNames = $derived(
    new Set([
      ...branches.map((b) => {
        // For remote branches, strip prefix (e.g., origin/feat/auth -> feat/auth)
        if (b.isRemote) {
          const parts = b.name.split('/');
          return parts.slice(1).join('/');
        }
        return b.name;
      }),
      ...project.workspaces.map((w) => w.name),
    ])
  );

  function validateName(value: string): string | null {
    if (!value.trim()) return null;

    // Security: no path traversal
    if (value.includes('..')) {
      return 'Name cannot contain ".."';
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/.test(value)) {
      return 'Must start with letter/number, can contain letters, numbers, hyphens, underscores, slashes, dots';
    }

    if (value.length > 100) {
      return 'Name must be 100 characters or less';
    }

    if (existingNames.has(value)) {
      // Determine if it's local or remote for better message
      const matchingBranch = branches.find((b) => {
        if (b.isRemote) {
          return b.name.split('/').slice(1).join('/') === value;
        }
        return b.name === value;
      });
      if (matchingBranch) {
        return matchingBranch.isRemote
          ? `A remote branch '${matchingBranch.name}' with this name exists`
          : `A local branch with this name already exists`;
      }
      return 'A workspace with this name already exists';
    }

    return null;
  }

  // Clear backend error when user modifies inputs
  $effect(() => {
    // Dependencies: name and selectedBranch
    name;
    selectedBranch;
    backendError = null;
  });

  // Auto-select remote branch when name matches
  $effect(() => {
    const trimmedName = name.trim();
    if (trimmedName && branches.length > 0) {
      const matchingRemote = branches.find(
        (b) => b.isRemote && b.name.split('/').slice(1).join('/') === trimmedName
      );
      if (matchingRemote) {
        selectedBranch = matchingRemote.name;
      }
    }
  });

  // Focus name input when dialog mounts
  $effect(() => {
    if (nameInputRef) {
      setTimeout(() => nameInputRef?.focus(), 50);
    }
  });

  // Web component event handling for vscode-single-select
  $effect(() => {
    if (branchSelectRef) {
      const handler = (e: Event) => {
        const target = e.target as HTMLSelectElement;
        selectedBranch = target.value;
      };
      branchSelectRef.addEventListener('change', handler);
      return () => branchSelectRef?.removeEventListener('change', handler);
    }
  });

  async function loadBranches() {
    isLoadingBranches = true;
    try {
      branches = await listBranches(project.handle);

      // Default to main workspace's branch
      const mainBranch = project.workspaces[0]?.branch;
      if (mainBranch && branches.some((b) => b.name === mainBranch)) {
        selectedBranch = mainBranch;
      } else if (branches.length > 0) {
        // Prefer local branches
        const firstLocal = branches.find((b) => !b.isRemote);
        selectedBranch = firstLocal?.name ?? branches[0].name;
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    } finally {
      isLoadingBranches = false;
    }
  }

  async function startBackgroundFetch() {
    isFetchingRemotes = true;
    fetchAbortController = new AbortController();

    try {
      await fetchBranches(project.handle);
      // Refresh branches after fetch
      await loadBranches();
    } catch (e) {
      // Silently ignore - branches might be stale but dialog still works
      console.warn('Background fetch failed:', e);
    } finally {
      isFetchingRemotes = false;
      fetchAbortController = null;
    }
  }

  function cancelFetch() {
    if (fetchAbortController) {
      fetchAbortController.abort();
      fetchAbortController = null;
    }
  }

  async function handleSubmit() {
    if (!isValid || isCreating) return;

    isCreating = true;
    backendError = null;

    try {
      const workspace = await createNewWorkspace(project.handle, name.trim(), selectedBranch);
      onCreated(workspace);
      handleClose();
    } catch (e) {
      // Map backend errors to user-friendly messages
      const errorStr = String(e);
      if (errorStr.includes('BranchNotFound') || errorStr.includes('Branch not found')) {
        backendError = 'The selected branch no longer exists. Please refresh and try again.';
      } else if (
        errorStr.includes('WorkspaceAlreadyExists') ||
        errorStr.includes('already exists')
      ) {
        backendError = 'A workspace with this name already exists.';
      } else {
        backendError = 'Could not create workspace. Please try again.';
      }
    } finally {
      isCreating = false;
    }
  }

  function handleClose() {
    cancelFetch();
    onClose();
    // Return focus to trigger element
    triggerElement?.focus();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Check if dropdown is open first
      const isDropdownOpen = branchSelectRef?.hasAttribute('open');
      if (!isDropdownOpen) {
        e.preventDefault();
        handleClose();
      }
    }
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && isValid) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // Focus trap
  function handleFocusTrap(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !dialogRef) return;

    const focusables = dialogRef.querySelectorAll<HTMLElement>(
      'input, select, button, [tabindex]:not([tabindex="-1"]), vscode-textfield, vscode-single-select, vscode-button'
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }

  // Initialize
  $effect(() => {
    loadBranches();
    startBackgroundFetch();
  });
</script>

<div
  class="modal-overlay"
  onclick={handleClose}
  onkeydown={(e) => {
    handleKeydown(e);
    handleFocusTrap(e);
  }}
  role="presentation"
>
  <div
    bind:this={dialogRef}
    class="modal-content"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
  >
    <h2 id="dialog-title">Create Workspace</h2>

    <div class="form-group">
      <label for="workspace-name">Name</label>
      <vscode-textfield
        id="workspace-name"
        bind:this={nameInputRef}
        value={name}
        oninput={(e: Event) => (name = (e.target as HTMLInputElement).value)}
        onkeydown={handleNameKeydown}
        aria-invalid={!!nameError}
        aria-describedby={nameError ? 'name-error' : undefined}
        disabled={isCreating}
      />
      {#if nameError}
        <div id="name-error" class="field-error">{nameError}</div>
      {/if}
    </div>

    <div class="form-group">
      <label for="base-branch">
        Base Branch
        {#if isFetchingRemotes}
          <vscode-icon name="loading" class="spin"></vscode-icon>
        {/if}
      </label>
      {#if isLoadingBranches}
        <div class="loading">Loading branches...</div>
      {:else}
        <vscode-single-select
          id="base-branch"
          bind:this={branchSelectRef}
          combobox
          filter="contains"
          value={selectedBranch}
          disabled={isCreating}
        >
          {#each branches.filter((b) => !b.isRemote) as branch}
            <vscode-option value={branch.name}>{branch.name}</vscode-option>
          {/each}
          {#each branches.filter((b) => b.isRemote) as branch}
            <vscode-option value={branch.name}>{branch.name}</vscode-option>
          {/each}
        </vscode-single-select>
      {/if}
    </div>

    {#if backendError}
      <div class="error-box" role="alert">{backendError}</div>
    {/if}

    <div class="button-row">
      <vscode-button secondary onclick={handleClose} disabled={isCreating}> Cancel </vscode-button>
      <vscode-button
        onclick={handleSubmit}
        disabled={!isValid || isCreating}
        aria-busy={isCreating}
      >
        {#if isCreating}
          <vscode-icon name="loading" class="spin"></vscode-icon>
          Creating...
        {:else}
          OK
        {/if}
      </vscode-button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 8px;
    padding: 24px;
    min-width: 400px;
    max-width: 500px;
  }

  h2 {
    margin: 0 0 20px 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .field-error {
    margin-top: 4px;
    font-size: 12px;
    color: var(--vscode-errorForeground, #f48771);
  }

  .loading {
    padding: 8px;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 13px;
  }

  .error-box {
    margin-bottom: 16px;
    padding: 12px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    border-radius: 4px;
    font-size: 13px;
    color: var(--vscode-inputValidation-errorForeground, #f48771);
  }

  .button-row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 20px;
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
```

#### 10. Update `Sidebar.svelte`

Migrate to Svelte 5 syntax and add create button:

```svelte
<script lang="ts">
  import { projects, activeWorkspace } from '$lib/stores/projects';
  import { openNewProject, closeProject } from '$lib/services/projectManager';
  import type { Project, Workspace } from '$lib/types/project';
  import CreateWorkspaceDialog from './CreateWorkspaceDialog.svelte';

  // Dialog state
  let dialogProject = $state<Project | null>(null);
  let triggerButtonRef = $state<HTMLElement | null>(null);

  function mainWorkspace(project: Project): Workspace {
    return project.workspaces[0];
  }

  function additionalWorktrees(project: Project): Workspace[] {
    return project.workspaces.slice(1);
  }

  function selectWorkspace(project: Project, workspace: Workspace) {
    activeWorkspace.set({
      projectHandle: project.handle,
      workspacePath: workspace.path,
    });
  }

  function handleCloseProject(event: Event, project: Project) {
    event.stopPropagation();
    closeProject(project);
  }

  function openCreateDialog(event: Event, project: Project) {
    event.stopPropagation();
    triggerButtonRef = event.currentTarget as HTMLElement;
    dialogProject = project;
  }

  function handleDialogClose() {
    dialogProject = null;
  }

  function handleWorkspaceCreated(workspace: Workspace) {
    // Already handled by service
    dialogProject = null;
  }
</script>

<aside class="sidebar">
  <div class="header">
    <h2>Projects</h2>
  </div>

  <div class="projects-list">
    {#each $projects as project (project.handle)}
      <div class="project-group">
        <div
          class="project-item"
          class:active={$activeWorkspace?.projectHandle === project.handle &&
            $activeWorkspace?.workspacePath === mainWorkspace(project).path}
          onclick={() => selectWorkspace(project, mainWorkspace(project))}
          onkeydown={(e) => e.key === 'Enter' && selectWorkspace(project, mainWorkspace(project))}
          role="button"
          tabindex="0"
        >
          <vscode-icon name="folder" class="icon"></vscode-icon>
          <span class="name">{project.path.split('/').pop()}</span>
          <vscode-icon
            name="add"
            class="add-btn"
            onclick={(e: Event) => openCreateDialog(e, project)}
            onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && openCreateDialog(e, project)}
            role="button"
            tabindex="0"
            title="Create Workspace"
          ></vscode-icon>
          <vscode-icon
            name="close"
            class="close-btn"
            onclick={(e: Event) => handleCloseProject(e, project)}
            onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleCloseProject(e, project)}
            role="button"
            tabindex="0"
          ></vscode-icon>
        </div>

        {#each additionalWorktrees(project) as workspace (workspace.path)}
          <div
            class="workspace-item"
            class:active={$activeWorkspace?.projectHandle === project.handle &&
              $activeWorkspace?.workspacePath === workspace.path}
            onclick={() => selectWorkspace(project, workspace)}
            onkeydown={(e) => e.key === 'Enter' && selectWorkspace(project, workspace)}
            role="button"
            tabindex="0"
          >
            <vscode-icon name="git-branch" class="icon"></vscode-icon>
            <span class="name">{workspace.name}</span>
            <span class="branch">
              {#if workspace.branch}
                ({workspace.branch})
              {:else}
                <span class="detached">(detached)</span>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/each}
  </div>

  <vscode-button class="open-btn" onclick={openNewProject} role="button" tabindex="0">
    Open Project
  </vscode-button>
</aside>

{#if dialogProject}
  <CreateWorkspaceDialog
    project={dialogProject}
    onClose={handleDialogClose}
    onCreated={handleWorkspaceCreated}
    triggerElement={triggerButtonRef}
  />
{/if}

<style>
  /* ... existing styles ... */

  .add-btn {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  }

  .project-item:hover .add-btn,
  .project-item:focus-within .add-btn {
    opacity: 1;
  }

  .add-btn:hover {
    color: var(--vscode-textLink-foreground, #3794ff);
  }
</style>
```

---

## Files to Create/Modify

| File                                              | Action     | Description                                                     |
| ------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `src-tauri/src/workspace_provider.rs`             | Modify     | Add `BranchInfo` with serde, error variants                     |
| `src-tauri/src/platform/paths.rs`                 | Modify     | Add `get_project_workspaces_dir()` only                         |
| `src-tauri/src/git_worktree_provider.rs`          | Modify     | Implement `list_branches`, `create_workspace`, `fetch_branches` |
| `src-tauri/src/lib.rs`                            | Modify     | Add `_impl` functions and Tauri commands                        |
| `src/lib/types/project.ts`                        | Modify     | Add `BranchInfo` interface                                      |
| `src/lib/api/tauri.ts`                            | Modify     | Add `listBranches`, `createWorkspace`, `fetchBranches`          |
| `src/lib/stores/projects.ts`                      | Modify     | Add `addWorkspaceToProject`                                     |
| `src/lib/services/projectManager.ts`              | Modify     | Add service functions with `ProjectHandle`                      |
| `src/lib/components/CreateWorkspaceDialog.svelte` | **Create** | New dialog with Svelte 5 syntax, accessibility                  |
| `src/lib/components/Sidebar.svelte`               | Modify     | Migrate to Svelte 5 `onclick`, add create button                |

---

## Data Flow

```
User clicks "+" icon on project
        │
        ▼
Dialog opens, starts background fetch
        │
        ├─▶ fetchBranches(handle) → fetch_branches command (cancellable)
        │         │
        │         ▼
        │   GitWorktreeProvider::fetch_branches() [spinner shown]
        │
        ├─▶ listBranches(handle) → list_branches command
        │         │
        │         ▼
        │   GitWorktreeProvider::list_branches()
        │         │
        │         ▼
        │   Return Vec<BranchInfo> (local + remote)
        │
        ▼
User types name → real-time validation in UI (frontend only)
        │
        ├─▶ Check: regex format
        ├─▶ Check: no ".." (path traversal)
        ├─▶ Check: not already in branches or workspaces
        ├─▶ Auto-select matching remote branch as base
        └─▶ OK button enabled only when valid
        │
        ▼
User clicks OK or Cancel
        │
        ├─▶ Cancel: cancel fetch, close dialog, return focus to "+"
        │
        └─▶ OK: createNewWorkspace(handle, name, baseBranch)
                  │
                  ▼ IPC
            create_workspace_impl()
                  │
                  ▼
            GitWorktreeProvider::create_workspace()
                  │
                  ├─▶ Find base commit
                  ├─▶ Create new branch
                  ├─▶ Create worktree (rollback branch on failure)
                  │
                  ▼
            Return WorkspaceInfo
                  │
                  ▼
        Store: addWorkspaceToProject()
                  │
                  ▼
        Store: activeWorkspace.set()
                  │
                  ▼
        UI re-renders, dialog closes, focus returns to "+"
```

---

## Testing Strategy

### Rust Unit Tests

#### Critical Tests

```rust
#[tokio::test]
async fn test_create_workspace_path_already_exists() {
    // Setup: manually create directory at worktree path
    // Action: call create_workspace
    // Assert: returns WorkspaceAlreadyExists error
}

#[tokio::test]
async fn test_create_workspace_concurrent_same_name() {
    // Setup: create two concurrent create_workspace calls with same name
    // Assert: one succeeds, one fails with appropriate error
}

#[tokio::test]
async fn test_create_workspace_validates_path_traversal() {
    // Action: call create_workspace with name "../etc/passwd"
    // Assert: returns error (validation should prevent this)
}

#[tokio::test]
async fn test_list_branches_after_fetch_shows_new_remotes() {
    // Setup: repo with remote
    // Action: fetch_branches then list_branches
    // Assert: remote branches appear in list
}
```

#### Major Tests

```rust
#[tokio::test]
async fn test_create_workspace_with_nonexistent_base_branch() {
    // Action: create_workspace with deleted branch name
    // Assert: returns BranchNotFound error
}

#[tokio::test]
async fn test_create_workspace_with_remote_branch_as_base() {
    // Action: create_workspace from "origin/main"
    // Assert: worktree created, local branch created
}

#[tokio::test]
async fn test_create_workspace_local_branch_priority_over_remote() {
    // Setup: both "feat/auth" (local) and "origin/feat/auth" exist
    // Action: create_workspace with base "feat/auth"
    // Assert: uses local branch
}

#[tokio::test]
async fn test_list_branches_excludes_head_refs() {
    // Action: list_branches on repo with remotes
    // Assert: no "origin/HEAD" in results
}

#[tokio::test]
async fn test_list_branches_handles_no_remotes() {
    // Setup: local repo with no remotes
    // Action: list_branches
    // Assert: returns local branches only, no error
}

#[tokio::test]
async fn test_create_workspace_sets_correct_commit() {
    // Action: create_workspace from branch
    // Assert: worktree HEAD matches base branch commit
}

#[tokio::test]
async fn test_fetch_branches_network_failure() {
    // Setup: repo with unreachable remote
    // Action: fetch_branches
    // Assert: returns Ok (best effort), no crash
}

#[tokio::test]
async fn test_create_workspace_name_collision_with_workspace() {
    // Setup: workspace "feat" already exists
    // Action: create_workspace with name "feat"
    // Assert: returns WorkspaceAlreadyExists
}

#[tokio::test]
async fn test_create_workspace_rollback_on_worktree_failure() {
    // Setup: make worktree path unwritable
    // Action: create_workspace
    // Assert: error returned, branch cleaned up
}
```

#### Minor Tests

```rust
#[tokio::test]
async fn test_create_workspace_name_max_length_boundary() {
    // Test 99, 100, 101 character names
}

#[tokio::test]
async fn test_create_workspace_name_empty_string() {
    // Assert: validation error
}

#[tokio::test]
async fn test_create_workspace_name_whitespace_only() {
    // Assert: validation error
}

#[tokio::test]
async fn test_list_branches_empty_repository() {
    // Assert: empty vec, no error
}

#[tokio::test]
async fn test_branch_info_partial_eq() {
    // Assert: PartialEq works correctly
}
```

### Frontend Tests (vitest + @testing-library/svelte)

```typescript
describe('CreateWorkspaceDialog', () => {
  // Focus management
  it('focuses name input when dialog opens');
  it('traps focus within dialog');
  it('returns focus to trigger element on close');

  // Keyboard navigation
  it('Tab cycles through Name → Branch → Cancel → OK');
  it('Escape closes dialog when dropdown is closed');
  it('Escape closes dropdown first when open');
  it('Enter on name input submits form when valid');
  it('Enter on name input does nothing when invalid');

  // Validation
  it('disables OK when name is empty');
  it('disables OK when name fails regex');
  it('shows error for path traversal (..)');
  it('shows error when name matches existing local branch');
  it('shows error when name matches existing remote branch');
  it('shows error when name matches existing workspace');
  it('enables OK when all conditions met');
  it('clears backend error when inputs change');

  // Auto-select
  it('auto-selects remote branch when name matches');

  // Loading states
  it('shows spinner while fetching branches');
  it('shows spinner while creating workspace');
  it('disables form during creation');

  // Error handling
  it('shows user-friendly error for BranchNotFound');
  it('shows user-friendly error for WorkspaceAlreadyExists');
  it('shows generic error for unknown errors');

  // Accessibility
  it('has correct ARIA attributes');
  it('announces errors via role="alert"');
});
```

### Manual Testing

- Open dialog, verify branches load (local + remote)
- Verify spinner shows while fetching remotes
- Type invalid name, verify error shown, OK disabled
- Type name with `..`, verify security error
- Type name matching existing branch, verify specific error message
- Type valid unique name, verify OK enabled
- Create from local branch
- Create from remote branch
- Verify new workspace appears in sidebar
- Verify new workspace is selected/active
- Verify worktree exists in filesystem at correct path
- Test all keyboard shortcuts (Tab, Enter, Escape)
- Test focus returns to "+" button after close
- Close dialog during fetch, verify no errors

---

## Technical Notes

### git2 API Details

**`repo.branch()` signature:**

```rust
pub fn branch(&self, branch_name: &str, target: &Commit<'_>, force: bool) -> Result<Branch<'_>, Error>
```

Requires a `&Commit`, not a branch name. Must resolve base branch to commit first.

**`WorktreeAddOptions` available methods:**

- `lock(bool)` - creates worktree in locked state
- `reference(Option<&Reference>)` - sets branch for worktree HEAD

**Important:** All git2 types are `!Send`. All git2 operations must be in a single `spawn_blocking` block.

### Rollback Strategy

When worktree creation fails after branch creation:

1. Delete the orphan branch (best effort)
2. Remove any partial directory (best effort)
3. Return the worktree creation error

### vscode-elements Component

Using `vscode-single-select` with combobox mode:

```html
<vscode-single-select combobox filter="contains">
  <vscode-option value="main">main</vscode-option>
  <vscode-option value="origin/main">origin/main</vscode-option>
</vscode-single-select>
```

**Event handling in Svelte 5:**
Web components emit CustomEvents. Use `$effect` with addEventListener for proper cleanup:

```svelte
$effect(() => {
  if (selectRef) {
    const handler = (e: Event) => { ... };
    selectRef.addEventListener('change', handler);
    return () => selectRef.removeEventListener('change', handler);
  }
});
```

### Svelte 5 Syntax

Use Svelte 5 runes and event attributes:

- `$state()` instead of `let x = ...`
- `$derived()` instead of `$: x = ...`
- `$effect()` instead of `$: { ... }`
- `onclick` instead of `on:click`
- `$props()` for component props

---

**Document Version:** 2.0  
**Last Updated:** 2025-11-23
