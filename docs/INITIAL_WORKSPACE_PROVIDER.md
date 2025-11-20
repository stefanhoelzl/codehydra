# WorkspaceProvider Implementation Plan

**Status:** Implementation Phase  
**Created:** 2025-11-20  
**Last Updated:** 2025-11-20  
**Version:** 2.0 (Incorporates Rust Expert Review Fixes)

---

## Overview

This document outlines the initial implementation of the **WorkspaceProvider** system for Chime. The WorkspaceProvider is responsible for discovering and managing isolated workspace directories where agents operate.

**Scope of Initial Implementation:**

- ✅ Discover existing git worktrees
- ✅ Open projects with validation
- ✅ Support multiple projects simultaneously
- ✅ Async validation to avoid blocking
- ✅ Proper error handling with type-safe conversions
- ✅ Concurrent access with RwLock
- ✅ Comprehensive test coverage (31+ tests)
- ❌ Create new worktrees (future)
- ❌ Delete worktrees (future)

---

## Architecture Summary

### Core Concepts

1. **Workspace** - A filesystem location containing code (main repo or git worktree)
2. **WorkspaceProvider** - Trait that abstracts workspace discovery
3. **GitWorktreeProvider** - Initial implementation using git worktrees
4. **Project Handle** - Type-safe UUID newtype identifying an open project

### Key Design Decisions

| Decision                 | Choice                   | Rationale                                |
| ------------------------ | ------------------------ | ---------------------------------------- |
| **Workspace Identity**   | Path (not ID)            | Path is unique, stable, and what we need |
| **Main worktree**        | Include in discovery     | User can work on main repo               |
| **Branch detection**     | Read actual HEAD         | Don't assume "main" branch               |
| **Detached HEAD**        | `Option<String>`         | Type-safe, idiomatic Rust                |
| **Project handles**      | ProjectHandle newtype    | Type-safe, prevents UUID misuse          |
| **Associated types**     | Yes                      | Avoid boxing overhead, type safety       |
| **Async trait**          | Use `async-trait`        | Standard solution, simple                |
| **Constructor**          | Async `new()`            | Avoid blocking I/O on async runtime      |
| **Error mapping**        | Extension trait          | Reduce boilerplate                       |
| **Error conversions**    | `#[from]` derives        | Automatic error type conversion          |
| **State management**     | `RwLock` not `Mutex`     | Better concurrent read performance       |
| **Repository lifecycle** | Open/close per operation | No file handle issues (~10ms cost)       |
| **Timeouts**             | 30 second limit          | Prevent hanging operations               |

---

## Data Structures

### Traits

```rust
// workspace_provider.rs

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Trait representing a workspace (directory containing code)
pub trait Workspace {
    fn name(&self) -> &str;
    fn path(&self) -> &Path;
}

/// Trait for discovering and managing workspaces
#[async_trait]
pub trait WorkspaceProvider: Send + Sync {
    type Workspace: Workspace + Serialize + Send;

    /// Create a new provider and validate the project root
    /// This is async to avoid blocking the async runtime with I/O
    async fn new(project_root: PathBuf) -> Result<Self, WorkspaceError>
    where
        Self: Sized;

    /// Discover all workspaces in this project
    async fn discover(&self) -> Result<Vec<Self::Workspace>, WorkspaceError>;
}
```

### Error Types

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("Not a git repository: {0}")]
    NotGitRepository(PathBuf),

    #[error("Git operation failed: {0}")]
    GitError(#[from] git2::Error),  // Automatic conversion from git2::Error

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Invalid workspace: {0}")]
    InvalidWorkspace(String),

    #[error("Task cancelled or panicked")]
    TaskCancelled,

    #[error("Invalid project handle: {0}")]
    InvalidHandle(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Project not found")]
    ProjectNotFound,

    #[error("Operation timed out")]
    Timeout,
}
```

### Extension Trait for Tauri Commands

```rust
pub trait ToTauriResult<T> {
    fn to_tauri(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> ToTauriResult<T> for Result<T, E> {
    fn to_tauri(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

// Usage
#[tauri::command]
async fn open_project(path: String) -> Result<String, String> {
    let provider = GitWorktreeProvider::new(path.into()).await.to_tauri()?;
    // ...
}
```

### ProjectHandle Newtype

```rust
use uuid::Uuid;

/// Type-safe project handle (newtype pattern)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectHandle(Uuid);

impl ProjectHandle {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ProjectHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl std::str::FromStr for ProjectHandle {
    type Err = WorkspaceError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(s)
            .map(ProjectHandle)
            .map_err(|e| WorkspaceError::InvalidHandle(e.to_string()))
    }
}

impl std::fmt::Display for ProjectHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
```

### GitWorktreeProvider

```rust
// git_worktree_provider.rs

use git2::{Repository, ErrorCode};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Represents a git worktree (main repo or additional worktree)
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitWorktree {
    name: String,
    path: PathBuf,
    /// Current branch name, or None if HEAD is detached
    branch: Option<String>,
}

impl Workspace for GitWorktree {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl GitWorktree {
    /// Returns the branch name if on a branch, None if detached
    pub fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }

    /// Returns true if HEAD is detached
    pub fn is_detached(&self) -> bool {
        self.branch.is_none()
    }
}

/// Provider for git worktree-based workspaces
#[derive(Debug, Clone)]
pub struct GitWorktreeProvider {
    project_root: PathBuf,
}

#[async_trait]
impl WorkspaceProvider for GitWorktreeProvider {
    type Workspace = GitWorktree;

    /// Create and validate a new provider
    async fn new(project_root: PathBuf) -> Result<Self, WorkspaceError> {
        // Validate path is absolute
        if !project_root.is_absolute() {
            return Err(WorkspaceError::InvalidPath(
                "Path must be absolute".into()
            ));
        }

        let root = project_root.clone();

        // Validate git repository in spawn_blocking
        tokio::task::spawn_blocking(move || {
            Repository::open(&root)
                .map_err(|e| {
                    if e.code() == ErrorCode::NotFound {
                        WorkspaceError::NotGitRepository(root.clone())
                    } else {
                        WorkspaceError::GitError(e)
                    }
                })?;
            Ok(())
        })
        .await
        .map_err(|_| WorkspaceError::TaskCancelled)??;

        Ok(Self { project_root })
    }

    /// Discover all worktrees (main + additional)
    async fn discover(&self) -> Result<Vec<GitWorktree>, WorkspaceError> {
        let project_root = self.project_root.clone();

        // Add timeout to prevent hanging
        let future = tokio::task::spawn_blocking(move || {
            discover_worktrees_blocking(&project_root)
        });

        tokio::time::timeout(Duration::from_secs(30), future)
            .await
            .map_err(|_| WorkspaceError::Timeout)?
            .map_err(|_| WorkspaceError::TaskCancelled)?
    }
}

/// Blocking function to discover all worktrees
fn discover_worktrees_blocking(project_root: &Path) -> Result<Vec<GitWorktree>, WorkspaceError> {
    let repo = Repository::open(project_root)?;
    let mut workspaces = Vec::new();

    // 1. Add main worktree
    let main_branch = repo.head()
        .ok()
        .and_then(|head| head.shorthand().map(String::from));

    let main_name = project_root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| WorkspaceError::InvalidWorkspace(
            "Invalid project path".into()
        ))?
        .to_string();

    workspaces.push(GitWorktree {
        name: main_name,
        path: project_root.to_path_buf(),
        branch: main_branch,
    });

    // 2. Add additional worktrees
    let worktrees = match repo.worktrees() {
        Ok(wt) => wt,
        Err(e) if e.code() == ErrorCode::NotFound => {
            // No worktrees dir - only main worktree exists
            return Ok(workspaces);
        }
        Err(e) => return Err(WorkspaceError::GitError(e)),
    };

    for wt_name in worktrees.iter() {
        let wt_name = match wt_name {
            Some(name) => name,
            None => continue,  // Skip invalid entries
        };

        // Read gitdir file to get actual worktree path
        let gitdir_path = repo.path()
            .join("worktrees")
            .join(wt_name)
            .join("gitdir");

        let wt_path = match std::fs::read_to_string(&gitdir_path) {
            Ok(content) => {
                PathBuf::from(content.trim())
                    .parent()
                    .ok_or_else(|| WorkspaceError::InvalidWorkspace(
                        format!("Invalid gitdir for worktree: {}", wt_name)
                    ))?
                    .to_path_buf()
            }
            Err(_) => {
                // Skip worktrees we can't read (might be deleted)
                continue;
            }
        };

        // Skip if it's the main worktree
        if wt_path == project_root {
            continue;
        }

        // Validate worktree exists on disk
        if !wt_path.exists() {
            // Skip stale worktrees
            continue;
        }

        // Get branch from worktree repository (None if detached)
        let branch = match Repository::open(&wt_path) {
            Ok(wt_repo) => wt_repo.head()
                .ok()
                .and_then(|head| head.shorthand().map(String::from)),
            Err(_) => {
                // Skip worktrees we can't open
                continue;
            }
        };

        let name = wt_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| WorkspaceError::InvalidWorkspace(
                format!("Invalid worktree path: {:?}", wt_path)
            ))?
            .to_string();

        workspaces.push(GitWorktree {
            name,
            path: wt_path,
            branch,
        });
    }

    Ok(workspaces)
}
```

### Application State

```rust
// lib.rs

use tokio::sync::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<code_server::ProcessManager>,
}

pub struct ProjectContext {
    handle: ProjectHandle,
    path: PathBuf,
    provider: Arc<GitWorktreeProvider>,
}

impl AppState {
    pub fn new(code_server_manager: Arc<code_server::ProcessManager>) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            code_server_manager,
        }
    }
}
```

### Tauri Commands

```rust
use tauri::State;

#[tauri::command]
async fn open_project(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let path_buf = PathBuf::from(path);

    // Async new() to avoid blocking
    let provider = GitWorktreeProvider::new(path_buf.clone())
        .await
        .to_tauri()?;

    let handle = ProjectHandle::new();
    let context = ProjectContext {
        handle,
        path: path_buf,
        provider: Arc::new(provider),
    };

    // Using write lock
    let mut projects = state.projects.write().await;
    projects.insert(handle, context);
    drop(projects);  // Release lock

    Ok(handle.to_string())
}

#[tauri::command]
async fn discover_workspaces(
    state: State<'_, AppState>,
    handle: String,
) -> Result<Vec<GitWorktree>, String> {
    // Proper handle parsing with error conversion
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    // Using read lock for better concurrency
    let projects = state.projects.read().await;
    let context = projects.get(&handle)
        .ok_or_else(|| WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);  // Release lock before long operation

    provider.discover().await.to_tauri()
}

#[tauri::command]
async fn close_project(
    state: State<'_, AppState>,
    handle: String,
) -> Result<(), String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let mut projects = state.projects.write().await;
    projects.remove(&handle)
        .ok_or_else(|| WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    Ok(())
}
```

---

## Implementation Tasks

### Phase 1: Dependencies (2 tasks)

**Task 1:** Install Rust dependencies

```bash
cd src-tauri
cargo add git2
cargo add async-trait
cargo add thiserror
cargo add tokio --features full
cargo add --dev tempfile
```

**Task 2:** Verify dependencies installed

```bash
cargo build
```

---

### Phase 2: Core Infrastructure (7 tasks)

**Task 3:** Create `src-tauri/src/workspace_provider.rs`

- Add module to `src-tauri/src/lib.rs`: `mod workspace_provider;`
- Implement `Workspace` trait
- Implement `WorkspaceProvider` trait (with async new())
- Implement `WorkspaceError` enum with all error types and `#[from]` derives
- Implement `ToTauriResult` extension trait
- Implement `ProjectHandle` newtype with all traits
- Run `cargo check` to verify

**Task 4:** Create `src-tauri/src/git_worktree_provider.rs`

- Add module to `src-tauri/src/lib.rs`: `mod git_worktree_provider;`
- Implement `GitWorktree` struct with `Option<String>` for branch
- Add `Debug, Clone, Serialize, PartialEq, Eq` derives
- Implement `Workspace` trait for `GitWorktree`
- Add `branch()` and `is_detached()` helper methods
- Run `cargo check` to verify

**Task 5:** Implement `GitWorktreeProvider::new()` (async)

- Validate path is absolute
- Spawn blocking task for Repository::open
- Handle NotFound vs other git errors
- Add proper error conversion with `?` operator
- Run `cargo test --lib` to verify compilation

**Task 6:** Implement `discover_worktrees_blocking()` helper

- Open main repository
- Get HEAD branch as `Option<String>` (None if detached)
- Add main worktree to results
- List worktrees from .git/worktrees
- For each worktree:
  - Read gitdir file to get actual path
  - Skip if doesn't exist on disk
  - Skip if same as main
  - Open worktree repo
  - Get branch as `Option<String>`
  - Add to results
- Run `cargo check`

**Task 7:** Implement `GitWorktreeProvider::discover()`

- Spawn blocking task
- Call `discover_worktrees_blocking`
- Wrap in 30s timeout with `tokio::time::timeout`
- Handle JoinError with `map_err(|_| TaskCancelled)`
- Handle both outer and inner errors with `??`
- Run `cargo check`

**Task 8:** Create test utilities module

- Create `src-tauri/src/test_utils.rs`
- Add `#[cfg(test)]` module guard
- Implement `TestRepo` struct
- Implement `TestRepo::new()` with initial commit
- Implement helper methods:
  - `create_branch()`
  - `create_worktree()`
  - `checkout()`
  - `detach_head()`
- Run `cargo test --lib` to verify

**Task 9:** Update `AppState` in `lib.rs`

- Import `tokio::sync::RwLock`
- Change `Mutex<HashMap<Uuid, ...>>` to `RwLock<HashMap<ProjectHandle, ...>>`
- Use `ProjectHandle` instead of raw `Uuid`
- Add `AppState::new()` constructor
- Export necessary types (`pub use workspace_provider::*;`)
- Update command registrations
- Run `cargo check`

---

### Phase 3: Unit Tests - Constructor (5 tasks)

**Task 10:** Test: `test_new_valid_repository`

```rust
#[tokio::test]
async fn test_new_valid_repository() {
    let test_repo = TestRepo::new().unwrap();
    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await;

    assert!(provider.is_ok());
}
```

- Run `cargo test test_new_valid_repository`

**Task 11:** Test: `test_new_not_a_git_repository`

```rust
#[tokio::test]
async fn test_new_not_a_git_repository() {
    let temp = TempDir::new().unwrap();
    let result = GitWorktreeProvider::new(temp.path().to_path_buf()).await;

    assert!(matches!(result, Err(WorkspaceError::NotGitRepository(_))));
}
```

- Run test

**Task 12:** Test: `test_new_nonexistent_path`

```rust
#[tokio::test]
async fn test_new_nonexistent_path() {
    let result = GitWorktreeProvider::new(PathBuf::from("/nonexistent/path")).await;
    assert!(result.is_err());
}
```

- Run test

**Task 13:** Test: `test_new_relative_path_rejected`

```rust
#[tokio::test]
async fn test_new_relative_path_rejected() {
    let result = GitWorktreeProvider::new(PathBuf::from("relative/path")).await;
    assert!(matches!(result, Err(WorkspaceError::InvalidPath(_))));
}
```

- Run test

**Task 14:** Test: `test_new_file_instead_of_directory`

```rust
#[tokio::test]
async fn test_new_file_instead_of_directory() {
    let temp = TempDir::new().unwrap();
    let file_path = temp.path().join("file.txt");
    std::fs::write(&file_path, "test").unwrap();

    let result = GitWorktreeProvider::new(file_path).await;
    assert!(result.is_err());
}
```

- Run test

---

### Phase 4: Unit Tests - Basic Discovery (4 tasks)

**Task 15:** Test: `test_discover_main_worktree_only`

```rust
#[tokio::test]
async fn test_discover_main_worktree_only() {
    let test_repo = TestRepo::new().unwrap();
    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].path(), test_repo.path());

    let branch = workspaces[0].branch();
    assert!(branch.is_some());
    assert!(branch.unwrap() == "master" || branch.unwrap() == "main");
}
```

- Run test

**Task 16:** Test: `test_discover_with_additional_worktrees`

```rust
#[tokio::test]
async fn test_discover_with_additional_worktrees() {
    let test_repo = TestRepo::new().unwrap();

    let wt1_path = test_repo.create_worktree("feature-1", "feat-1").unwrap();
    let wt2_path = test_repo.create_worktree("feature-2", "feat-2").unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    assert_eq!(workspaces.len(), 3);

    let wt1 = workspaces.iter().find(|w| w.path() == wt1_path).unwrap();
    let wt2 = workspaces.iter().find(|w| w.path() == wt2_path).unwrap();

    assert_eq!(wt1.branch(), Some("feat-1"));
    assert_eq!(wt2.branch(), Some("feat-2"));
}
```

- Run test

**Task 17:** Test: `test_discover_preserves_worktree_names`

```rust
#[tokio::test]
async fn test_discover_preserves_worktree_names() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("my-feature", "branch").unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();
    let feature_wt = workspaces.iter().find(|w| w.name() == "my-feature");

    assert!(feature_wt.is_some());
}
```

- Run test

**Task 18:** Test: `test_discover_worktree_paths_are_absolute`

```rust
#[tokio::test]
async fn test_discover_worktree_paths_are_absolute() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature", "branch").unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    for workspace in workspaces {
        assert!(workspace.path().is_absolute());
    }
}
```

- Run test

---

### Phase 5: Unit Tests - Edge Cases (8 tasks)

**Task 19:** Test: `test_discover_detached_head_main_worktree`

```rust
#[tokio::test]
async fn test_discover_detached_head_main_worktree() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.detach_head().unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].branch(), None);
    assert!(workspaces[0].is_detached());
}
```

- Run test

**Task 20:** Test: `test_discover_detached_head_in_worktree`

```rust
#[tokio::test]
async fn test_discover_detached_head_in_worktree() {
    let test_repo = TestRepo::new().unwrap();
    let wt_path = test_repo.create_worktree("feature", "feat").unwrap();

    // Detach HEAD in the worktree
    let wt_repo = Repository::open(&wt_path).unwrap();
    let commit = wt_repo.head().unwrap().peel_to_commit().unwrap();
    wt_repo.set_head_detached(commit.id()).unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();
    let wt = workspaces.iter().find(|w| w.path() == wt_path).unwrap();

    assert_eq!(wt.branch(), None);
    assert!(wt.is_detached());
}
```

- Run test

**Task 21:** Test: `test_discover_skips_deleted_worktrees`

```rust
#[tokio::test]
async fn test_discover_skips_deleted_worktrees() {
    let test_repo = TestRepo::new().unwrap();
    let wt_path = test_repo.create_worktree("temp", "branch").unwrap();

    // Delete the worktree directory
    std::fs::remove_dir_all(&wt_path).unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].path(), test_repo.path());
}
```

- Run test

**Task 22:** Test: `test_discover_empty_repository`

```rust
#[tokio::test]
async fn test_discover_empty_repository() {
    let temp = TempDir::new().unwrap();
    let _repo = Repository::init(temp.path()).unwrap();

    let result = GitWorktreeProvider::new(temp.path().to_path_buf()).await;
    assert!(result.is_err());  // No HEAD in empty repo
}
```

- Run test

**Task 23:** Test: `test_discover_with_many_worktrees`

```rust
#[tokio::test]
async fn test_discover_with_many_worktrees() {
    let test_repo = TestRepo::new().unwrap();

    for i in 0..10 {
        test_repo.create_worktree(
            &format!("worktree-{}", i),
            &format!("branch-{}", i)
        ).unwrap();
    }

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    assert_eq!(workspaces.len(), 11);
}
```

- Run test

**Task 24:** Test: `test_discover_branch_names_with_slashes`

```rust
#[tokio::test]
async fn test_discover_branch_names_with_slashes() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature", "feature/auth/oauth").unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();
    let wt = workspaces.iter().find(|w| w.name() == "feature").unwrap();

    assert_eq!(wt.branch(), Some("feature/auth/oauth"));
}
```

- Run test

**Task 25:** Test: `test_discover_branch_names_with_special_chars`

```rust
#[tokio::test]
async fn test_discover_branch_names_with_special_chars() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature", "fix-bug-#123").unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();
    let wt = workspaces.iter().find(|w| w.name() == "feature").unwrap();

    assert_eq!(wt.branch(), Some("fix-bug-#123"));
}
```

- Run test

**Task 26:** Test: `test_discover_worktree_paths_exist`

```rust
#[tokio::test]
async fn test_discover_worktree_paths_exist() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature", "branch").unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    for workspace in workspaces {
        assert!(workspace.path().exists());
    }
}
```

- Run test

---

### Phase 6: Unit Tests - Concurrency & Performance (3 tasks)

**Task 27:** Test: `test_discover_called_concurrently`

```rust
#[tokio::test]
async fn test_discover_called_concurrently() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature-1", "feat-1").unwrap();
    test_repo.create_worktree("feature-2", "feat-2").unwrap();

    let provider = Arc::new(
        GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap()
    );

    let mut handles = vec![];
    for _ in 0..5 {
        let p = provider.clone();
        handles.push(tokio::spawn(async move {
            p.discover().await
        }));
    }

    for handle in handles {
        let result = handle.await.unwrap();
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 3);
    }
}
```

- Run test

**Task 28:** Test: `test_discover_completes_within_timeout`

```rust
#[tokio::test]
async fn test_discover_completes_within_timeout() {
    let test_repo = TestRepo::new().unwrap();
    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        provider.discover()
    ).await;

    assert!(result.is_ok());
    assert!(result.unwrap().is_ok());
}
```

- Run test

**Task 29:** Test: `test_branch_option_semantics`

```rust
#[tokio::test]
async fn test_branch_option_semantics() {
    let test_repo = TestRepo::new().unwrap();

    let wt_normal = test_repo.create_worktree("normal", "branch-1").unwrap();
    let wt_detached = test_repo.create_worktree("detached", "branch-2").unwrap();

    // Detach HEAD in second worktree
    let detached_repo = Repository::open(&wt_detached).unwrap();
    let commit = detached_repo.head().unwrap().peel_to_commit().unwrap();
    detached_repo.set_head_detached(commit.id()).unwrap();

    let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
        .await
        .unwrap();

    let workspaces = provider.discover().await.unwrap();

    let normal = workspaces.iter().find(|w| w.path() == wt_normal).unwrap();
    assert!(normal.branch().is_some());
    assert!(!normal.is_detached());
    assert_eq!(normal.branch(), Some("branch-1"));

    let detached = workspaces.iter().find(|w| w.path() == wt_detached).unwrap();
    assert!(detached.branch().is_none());
    assert!(detached.is_detached());
}
```

- Run test

**Task 30:** Run all unit tests

```bash
cargo test --lib
```

- Fix any failures
- Ensure 100% pass rate

---

### Phase 7: Tauri Commands (3 tasks)

**Task 31:** Implement `open_project` command (see code above)

- Add to lib.rs tauri::Builder
- Run `cargo check`

**Task 32:** Implement `discover_workspaces` command (see code above)

- Add to lib.rs tauri::Builder
- Run `cargo check`

**Task 33:** Implement `close_project` command (see code above)

- Add to lib.rs tauri::Builder
- Run `cargo check`

---

### Phase 8: Integration Tests (7 tasks)

**Task 34:** Create `src-tauri/tests/integration_test.rs`

**Task 35:** Test: `test_open_multiple_projects`

```rust
#[tokio::test]
async fn test_open_multiple_projects() {
    let test_repo1 = TestRepo::new().unwrap();
    let test_repo2 = TestRepo::new().unwrap();

    let state = AppState::new(Arc::new(ProcessManager::new()));

    let handle1 = open_project(
        State::from(Arc::new(state.clone())),
        test_repo1.path().to_string_lossy().to_string()
    ).await.unwrap();

    let handle2 = open_project(
        State::from(Arc::new(state.clone())),
        test_repo2.path().to_string_lossy().to_string()
    ).await.unwrap();

    assert_ne!(handle1, handle2);

    let workspaces1 = discover_workspaces(
        State::from(Arc::new(state.clone())),
        handle1
    ).await.unwrap();

    let workspaces2 = discover_workspaces(
        State::from(Arc::new(state.clone())),
        handle2
    ).await.unwrap();

    assert_eq!(workspaces1.len(), 1);
    assert_eq!(workspaces2.len(), 1);
}
```

- Run test

**Task 36:** Test: `test_close_project_removes_from_state`

```rust
#[tokio::test]
async fn test_close_project_removes_from_state() {
    let test_repo = TestRepo::new().unwrap();
    let state = AppState::new(Arc::new(ProcessManager::new()));

    let handle = open_project(
        State::from(Arc::new(state.clone())),
        test_repo.path().to_string_lossy().to_string()
    ).await.unwrap();

    close_project(
        State::from(Arc::new(state.clone())),
        handle.clone()
    ).await.unwrap();

    let result = discover_workspaces(
        State::from(Arc::new(state.clone())),
        handle
    ).await;

    assert!(result.is_err());
}
```

- Run test

**Task 37:** Test: `test_concurrent_operations_on_different_projects`

```rust
#[tokio::test]
async fn test_concurrent_operations_on_different_projects() {
    let test_repo1 = TestRepo::new().unwrap();
    let test_repo2 = TestRepo::new().unwrap();

    test_repo1.create_worktree("feature-1", "feat-1").unwrap();
    test_repo2.create_worktree("feature-2", "feat-2").unwrap();

    let state = Arc::new(AppState::new(Arc::new(ProcessManager::new())));

    let handle1 = open_project(
        State::from(state.clone()),
        test_repo1.path().to_string_lossy().to_string()
    ).await.unwrap();

    let handle2 = open_project(
        State::from(state.clone()),
        test_repo2.path().to_string_lossy().to_string()
    ).await.unwrap();

    let s1 = state.clone();
    let s2 = state.clone();
    let h1 = handle1.clone();
    let h2 = handle2.clone();

    let (result1, result2) = tokio::join!(
        discover_workspaces(State::from(s1), h1),
        discover_workspaces(State::from(s2), h2)
    );

    assert!(result1.is_ok());
    assert!(result2.is_ok());
    assert_eq!(result1.unwrap().len(), 2);
    assert_eq!(result2.unwrap().len(), 2);
}
```

- Run test

**Task 38:** Test: `test_invalid_handle_returns_error`

```rust
#[tokio::test]
async fn test_invalid_handle_returns_error() {
    let state = AppState::new(Arc::new(ProcessManager::new()));

    let result = discover_workspaces(
        State::from(Arc::new(state)),
        "not-a-valid-uuid".to_string()
    ).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Invalid project handle"));
}
```

- Run test

**Task 39:** Test: `test_nonexistent_project_handle_returns_error`

```rust
#[tokio::test]
async fn test_nonexistent_project_handle_returns_error() {
    let state = AppState::new(Arc::new(ProcessManager::new()));
    let fake_handle = ProjectHandle::new();

    let result = discover_workspaces(
        State::from(Arc::new(state)),
        fake_handle.to_string()
    ).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Project not found"));
}
```

- Run test

**Task 40:** Run all integration tests

```bash
cargo test --test integration_test
```

- Fix any failures
- Ensure 100% pass rate

---

### Phase 9: Frontend Types (3 tasks)

**Task 41:** Update `src/lib/types/project.ts`

```typescript
export type ProjectHandle = string;

export interface Workspace {
  name: string;
  path: string;
  /** Current branch name, or null if HEAD is detached */
  branch: string | null;
}

export interface Project {
  handle: ProjectHandle;
  path: string;
  workspaces: Workspace[];
}
```

- Run `pnpm check`

**Task 42:** Update `src/lib/api/tauri.ts`

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { ProjectHandle, Workspace } from '../types/project';

export async function openProject(path: string): Promise<ProjectHandle> {
  return await invoke('open_project', { path });
}

export async function discoverWorkspaces(handle: ProjectHandle): Promise<Workspace[]> {
  return await invoke('discover_workspaces', { handle });
}

export async function closeProject(handle: ProjectHandle): Promise<void> {
  await invoke('close_project', { handle });
}
```

- Run `pnpm check`

**Task 43:** Verify TypeScript compilation

```bash
pnpm check
```

- Fix any type errors

---

### Phase 10: Quality Checks (5 tasks)

**Task 44:** Run Rust Clippy

```bash
pnpm rust:clippy
```

- Fix all warnings (NO exceptions)

**Task 45:** Run Rust formatting

```bash
pnpm rust:fmt:check
# If fails: pnpm rust:fmt
```

**Task 46:** Run TypeScript checks

```bash
pnpm check
```

**Task 47:** Run all tests

```bash
pnpm rust:test
```

**Task 48:** Run full validation

```bash
pnpm validate:full
```

---

### Phase 11: Manual Testing (6 tasks)

**Task 49:** Test: Open Chime project itself

- Start `pnpm tauri dev`
- Open Chime project
- Verify success

**Task 50:** Test: Discover Chime worktrees

- Trigger workspace discovery
- Verify worktrees shown

**Task 51:** Test: Open multiple projects

- Open 2-3 different git projects
- Verify no conflicts

**Task 52:** Test: Non-git directory error

- Try opening non-git directory
- Verify clear error message

**Task 53:** Test: Create and discover new worktree

- Create worktree via git CLI
- Refresh discovery
- Verify new worktree appears

**Task 54:** Test: Detached HEAD handling

- Checkout detached HEAD
- Verify shows null/no branch

---

### Phase 12: Documentation (3 tasks)

**Task 55:** Add rustdoc comments

- Document all public APIs
- Include examples
- Run `cargo doc`

**Task 56:** Update CHANGELOG

- Document all changes
- Note critical fixes

**Task 57:** Final verification

```bash
pnpm validate:full && cargo test && pnpm tauri dev
```

---

## Total: 57 Tasks

---

## Testing Strategy

### Test Setup Helper

```rust
// src-tauri/src/test_utils.rs

use git2::{Repository, Signature};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub struct TestRepo {
    pub temp_dir: TempDir,
    pub repo: Repository,
}

impl TestRepo {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let temp_dir = TempDir::new()?;
        let repo = Repository::init(temp_dir.path())?;

        // Create file for initial commit
        let readme_path = temp_dir.path().join("README.md");
        std::fs::write(&readme_path, "# Test Repository\n")?;

        let mut index = repo.index()?;
        index.add_path(Path::new("README.md"))?;
        index.write()?;

        let tree_id = index.write_tree()?;
        let tree = repo.find_tree(tree_id)?;
        let sig = Signature::now("Test User", "test@example.com")?;

        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "Initial commit",
            &tree,
            &[],
        )?;

        Ok(Self { temp_dir, repo })
    }

    pub fn path(&self) -> &Path {
        self.temp_dir.path()
    }

    pub fn create_branch(&self, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let head = self.repo.head()?;
        let commit = head.peel_to_commit()?;
        self.repo.branch(name, &commit, false)?;
        Ok(())
    }

    pub fn create_worktree(&self, name: &str, branch: &str)
        -> Result<PathBuf, Box<dyn std::error::Error>>
    {
        self.create_branch(branch)?;

        let worktree_path = self.temp_dir.path().parent().unwrap().join(name);

        self.repo.worktree(name, &worktree_path, Some(
            git2::WorktreeAddOptions::new()
        ))?;

        Ok(worktree_path)
    }

    pub fn detach_head(&self) -> Result<(), Box<dyn std::error::Error>> {
        let head = self.repo.head()?;
        let commit = head.peel_to_commit()?;
        self.repo.set_head_detached(commit.id())?;
        Ok(())
    }
}
```

---

## UI Flow

### Opening a Project

```
User clicks "Open Project"
     ↓
Frontend: const handle = await openProject('/path/to/project')
     ↓
Backend:
  1. Validate path is absolute
  2. GitWorktreeProvider::new(path).await → validates git repo (async)
  3. Generate ProjectHandle
  4. Store in AppState (RwLock write)
  5. Return handle string
     ↓
Frontend: Store handle, display project in sidebar
```

### Discovering Workspaces

```
Frontend: const workspaces = await discoverWorkspaces(handle)
     ↓
Backend:
  1. Parse handle to ProjectHandle
  2. Get provider from state (RwLock read)
  3. Release lock
  4. provider.discover().await (with 30s timeout)
  5. Return Vec<GitWorktree>
     ↓
Frontend: Display workspaces
  📁 project-name (main)
    └─ 📂 feature-auth (feat-auth)
    └─ 📂 detached-work (detached HEAD) ⚠️
```

### UI Display Example

```typescript
function displayBranch(workspace: Workspace): string {
  return workspace.branch ?? '(detached HEAD)';
}

function getBranchIcon(workspace: Workspace): string {
  return workspace.branch === null ? '⚠️' : '🌿';
}
```

---

## Performance Characteristics

| Operation                 | Time         | Frequency              |
| ------------------------- | ------------ | ---------------------- |
| `Repository::open()`      | ~1-5ms       | Per operation          |
| Worktree list             | ~5-10ms      | Per discover call      |
| `spawn_blocking` overhead | ~0.1ms       | Per async call         |
| RwLock read               | ~0.01ms      | Per read operation     |
| **Total per discover**    | **~10-15ms** | **Not in hot path** ✅ |

---

## Success Criteria

Implementation is complete when:

- ✅ All 57 tasks completed
- ✅ All unit tests pass (29+ tests)
- ✅ All integration tests pass (6+ tests)
- ✅ `pnpm validate:full` passes with zero warnings
- ✅ `cargo clippy` passes with zero warnings
- ✅ `cargo test` passes with 100% success rate
- ✅ Manual testing shows stable behavior
- ✅ Async `new()` implemented (no blocking I/O)
- ✅ Correct git2 API usage (gitdir file reading)
- ✅ `Option<String>` for branch (type-safe detached HEAD)
- ✅ RwLock for concurrent access
- ✅ ProjectHandle newtype for type safety
- ✅ All error types with `#[from]` conversions
- ✅ 30s timeout on operations
- ✅ Proper lock release before long operations
- ✅ Stale worktree handling

---

## Dependencies

### Rust (Cargo)

```toml
[dependencies]
git2 = "0.20"
async-trait = "0.1"
thiserror = "2.0"
uuid = { version = "1.18", features = ["v4", "serde"] }
tokio = { version = "1.48", features = ["full"] }

[dev-dependencies]
tempfile = "3.13"
```

### TypeScript (pnpm)

No new frontend dependencies required.

---

## Future Enhancements

**Not in this initial implementation:**

- Create new worktrees
- Delete worktrees
- Rename worktrees
- Worktree status (dirty, ahead/behind)
- Automatic cleanup of orphaned worktrees
- Progress indicators for slow operations
- Workspace metadata persistence
- Worktree locking detection

---

## Key Improvements from v1.0

1. ✅ **Async Constructor**: Avoid blocking async runtime
2. ✅ **Correct git2 API**: Read gitdir file for worktree paths
3. ✅ **RwLock**: Better concurrency for reads
4. ✅ **ProjectHandle newtype**: Type-safe handles
5. ✅ **Error conversions**: `#[from]` for automatic conversion
6. ✅ **Option<String> for branch**: Type-safe, idiomatic
7. ✅ **Timeouts**: 30s limit on operations
8. ✅ **Path validation**: Reject relative paths
9. ✅ **Comprehensive tests**: 35+ tests covering edge cases
10. ✅ **Stale worktree handling**: Skip deleted worktrees

---

## References

- See `docs/ARCHITECTURE.md` for detailed architecture diagrams
- See `docs/INITIAL_CONCEPT.md` for overall project vision
- See `AGENTS.md` for development workflow and quality standards
- See Rust Expert Review for detailed analysis of design decisions

---

**Document Version:** 2.0  
**Next Review:** After implementation completion
