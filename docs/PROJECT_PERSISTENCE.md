# Project Persistence Implementation Plan

**Document Version:** 1.1  
**Last Updated:** 2025-11-22

This document describes the plan for implementing project persistence in Chime.

---

## Overview

Persist open projects so they are automatically restored when the app restarts. Projects are stored in a version-independent directory so they persist across app updates.

---

## Directory Structure

```
<data-dir>/
├── 0.1.0/                    # Version-specific runtime
│   ├── node/
│   ├── node_modules/
│   ├── extensions/
│   └── user-data/
├── 0.2.0/                    # Another version
│   └── ...
└── projects/                 # SHARED across all versions
    ├── codehydra-a1b2c3d4/
    │   └── config.json       # { "version": 1, "path": "/path/to/codehydra" }
    └── my-app-f8e9d0c1/
        └── config.json
```

### Project Directory Naming

Format: `<project-name>-<8-char-hash>`

- **project-name**: Last component of the project path
- **hash**: First 8 hex characters of SHA256 hash of the full path (deterministic)

Examples:

- `/home/user/projects/codehydra` → `codehydra-a1b2c3d4`
- `/home/user/work/my-app` → `my-app-f8e9d0c1`

### config.json Format

```json
{
  "version": 1,
  "path": "/absolute/path/to/project"
}
```

The `version` field allows for future schema migrations.

---

## Path Function Naming Convention

```rust
// src-tauri/src/platform/paths.rs

/// Get the root data directory (e.g., ~/.local/share/codehydra or ./app-data)
pub fn get_data_root_dir() -> PathBuf;

/// Get the versioned data directory (e.g., <root>/0.1.0/)
pub fn get_data_version_dir(app_version: &str) -> PathBuf;

/// Get the projects directory (e.g., <root>/projects/)
pub fn get_data_projects_dir() -> PathBuf;
```

---

## Implementation Details

### Backend: Error Type

```rust
// In src-tauri/src/project_store.rs or src-tauri/src/error.rs

#[derive(Debug, thiserror::Error)]
pub enum ProjectStoreError {
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Failed to serialize/deserialize project config: {0}")]
    SerializationError(#[from] serde_json::Error),
}
```

### Backend: `project_store.rs` (New Module)

```rust
use crate::platform::paths::get_data_projects_dir;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::path::{Path, PathBuf};

/// Current config version for forward compatibility
const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub version: u32,
    pub path: String,
}

pub struct ProjectStore {
    projects_dir: PathBuf,
}

impl ProjectStore {
    pub fn new() -> Self {
        Self {
            projects_dir: get_data_projects_dir(),
        }
    }

    #[cfg(test)]
    pub fn with_dir(projects_dir: PathBuf) -> Self {
        Self { projects_dir }
    }

    /// Generate directory name: "<project-name>-<8-char-hash>"
    fn project_dir_name(path: &Path) -> String {
        let name = path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".to_string());

        let mut hasher = Sha256::new();
        hasher.update(path.to_string_lossy().as_bytes());
        let hash = hasher.finalize();
        let hash_hex = format!("{:x}", hash);

        format!("{}-{}", name, &hash_hex[..8])
    }

    /// Save project to disk (async)
    pub async fn save_project(&self, project_path: &Path) -> Result<(), ProjectStoreError> {
        let dir_name = Self::project_dir_name(project_path);
        let project_dir = self.projects_dir.join(&dir_name);

        tokio::fs::create_dir_all(&project_dir).await?;

        let config = ProjectConfig {
            version: CONFIG_VERSION,
            path: project_path.to_string_lossy().to_string(),
        };
        let content = serde_json::to_string_pretty(&config)?;
        tokio::fs::write(project_dir.join("config.json"), content).await?;

        Ok(())
    }

    /// Load all saved project paths (async, unsorted - UI handles ordering)
    /// Returns paths that still exist on disk. Silently skips invalid entries.
    pub async fn load_all_projects(&self) -> Result<Vec<PathBuf>, ProjectStoreError> {
        let mut projects = Vec::new();

        let mut entries = match tokio::fs::read_dir(&self.projects_dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(projects),
            Err(e) => return Err(e.into()),
        };

        while let Some(entry) = entries.next_entry().await? {
            let config_path = entry.path().join("config.json");

            // Skip entries that fail to read or parse
            let content = match tokio::fs::read_to_string(&config_path).await {
                Ok(c) => c,
                Err(_) => continue,
            };

            let config: ProjectConfig = match serde_json::from_str(&content) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let path = PathBuf::from(&config.path);

            // Only include if path still exists
            if path.exists() {
                projects.push(path);
            }
        }

        Ok(projects)
    }
}

impl Default for ProjectStore {
    fn default() -> Self {
        Self::new()
    }
}
```

### Backend: `workspace_provider.rs` Changes

Add `project_root()` getter to the `WorkspaceProvider` trait:

```rust
pub trait WorkspaceProvider: Send + Sync {
    type Workspace: Workspace + Serialize + Clone + Send;

    fn new(project_root: PathBuf) -> impl Future<Output = Result<Self, WorkspaceError>> + Send
    where
        Self: Sized;

    fn discover(&self) -> impl Future<Output = Result<Vec<Self::Workspace>, WorkspaceError>> + Send;

    /// Get the project root path
    fn project_root(&self) -> &Path;  // NEW
}
```

Implement in `GitWorktreeProvider`:

```rust
impl WorkspaceProvider for GitWorktreeProvider {
    // ... existing methods ...

    fn project_root(&self) -> &Path {
        &self.project_root
    }
}
```

### Backend: `lib.rs` Changes

**AppState modification:**

```rust
pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<CodeServerManager>,
    project_store: Arc<ProjectStore>,  // NEW - Arc for sharing across async calls
}

pub struct ProjectContext {
    provider: Arc<GitWorktreeProvider>,
    // No need for separate path field - use provider.project_root()
}
```

**Duplicate detection in `open_project_impl`:**

```rust
pub async fn open_project_impl(state: &AppState, path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    let normalized_path = normalize_path(&path_buf).to_tauri()?;

    // Check if already open - return existing handle
    {
        let projects = state.projects.read().await;
        for (handle, ctx) in projects.iter() {
            if ctx.provider.project_root() == normalized_path {
                return Ok(handle.to_string());
            }
        }
    }

    // Create provider (validates git repo)
    let provider = GitWorktreeProvider::new(normalized_path.clone())
        .await
        .to_tauri()?;

    let handle = ProjectHandle::new();
    let context = ProjectContext {
        provider: Arc::new(provider),
    };

    let mut projects = state.projects.write().await;
    projects.insert(handle, context);
    drop(projects);

    // Persist to disk (non-fatal if fails)
    if let Err(e) = state.project_store.save_project(&normalized_path).await {
        eprintln!("Failed to persist project: {}", e);
    }

    Ok(handle.to_string())
}
```

**New Tauri command:**

```rust
#[tauri::command]
async fn load_persisted_projects(
    state: tauri::State<'_, AppState>
) -> Result<Vec<String>, String> {
    let paths = state.project_store.load_all_projects().await.to_tauri()?;
    Ok(paths.iter().map(|p| p.to_string_lossy().to_string()).collect())
}
```

### Frontend: `tauri.ts` Addition

```typescript
export async function loadPersistedProjects(): Promise<string[]> {
  return await invoke<string[]>('load_persisted_projects');
}
```

### Frontend: `projectManager.ts` Addition

```typescript
export async function restorePersistedProjects(): Promise<void> {
  try {
    const paths = await loadPersistedProjects();

    let firstHandle: ProjectHandle | null = null;

    for (const path of paths) {
      try {
        const handle = await openProjectByPath(path);
        if (!firstHandle) {
          firstHandle = handle;
        }
      } catch (error) {
        console.warn(`Failed to restore project at ${path}:`, error);
      }
    }

    // Auto-select first project and its first workspace
    if (firstHandle) {
      setActiveProject(firstHandle);

      const allProjects = get(projects);
      const firstProject = allProjects.find((p) => p.handle === firstHandle);
      if (firstProject && firstProject.workspaces.length > 0) {
        activeWorkspace.set({
          projectHandle: firstHandle,
          workspacePath: firstProject.workspaces[0].path,
        });
      }
    }
  } catch (error) {
    console.error('Failed to load persisted projects:', error);
  }
}

async function openProjectByPath(path: string): Promise<ProjectHandle> {
  const handle = await openProjectBackend(path);
  const workspaces = await discoverWorkspaces(handle);

  const project: Project = { handle, path, workspaces };
  addProject(project);

  return handle;
}
```

### Frontend: `+layout.svelte` Modification

```typescript
onMount(async () => {
  try {
    const ready = await checkRuntimeReady();
    needsSetup = !ready;
  } catch (err) {
    console.error('Failed to check runtime status:', err);
    needsSetup = true;
  } finally {
    isChecking = false;
  }

  // Load persisted projects ALWAYS (regardless of setup state)
  await restorePersistedProjects();

  invoke('show_window');
});
```

---

## Edge Cases

| Case                          | Behavior                                   |
| ----------------------------- | ------------------------------------------ |
| Project path no longer exists | Skip silently                              |
| Project no longer a git repo  | Skip silently (provider fails)             |
| Same project opened twice     | Return existing handle                     |
| Projects dir doesn't exist    | Create on first save, return empty on load |
| Malformed config.json         | Skip silently                              |
| Non-UTF8 paths                | Handled via `to_string_lossy()`            |

---

## Path Normalization

All paths entering the app must be normalized at entry points:

1. **Dialog selection** (`open_directory` → `open_project`)
2. **Config.json loading** (`load_all_projects`)

This ensures consistent path comparison for duplicate detection.

---

## Testing Strategy

### Unit Tests for `project_store.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_project_dir_name_generates_consistent_hash() {
        let path = Path::new("/home/user/my-project");
        let name1 = ProjectStore::project_dir_name(path);
        let name2 = ProjectStore::project_dir_name(path);
        assert_eq!(name1, name2);
        assert!(name1.starts_with("my-project-"));
        assert_eq!(name1.len(), "my-project-".len() + 8);
    }

    #[test]
    fn test_project_dir_name_different_paths_different_hashes() {
        let path1 = Path::new("/home/user/project-a");
        let path2 = Path::new("/home/user/project-b");
        let name1 = ProjectStore::project_dir_name(path1);
        let name2 = ProjectStore::project_dir_name(path2);
        assert_ne!(name1, name2);
    }

    #[tokio::test]
    async fn test_save_and_load_project() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("my-project");
        std::fs::create_dir(&project_path).unwrap();

        store.save_project(&project_path).await.unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0], project_path);
    }

    #[tokio::test]
    async fn test_load_ignores_nonexistent_paths() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_dir = temp.path().join("fake-project-12345678");
        std::fs::create_dir(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("config.json"),
            r#"{"version": 1, "path": "/nonexistent/path"}"#
        ).unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_load_empty_dir() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());
        let projects = store.load_all_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_load_nonexistent_dir() {
        let store = ProjectStore::with_dir(PathBuf::from("/nonexistent/dir"));
        let projects = store.load_all_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_load_skips_malformed_json() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_dir = temp.path().join("bad-project-12345678");
        std::fs::create_dir(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("config.json"),
            "not valid json{"
        ).unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_unicode_paths() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("проект-日本語");
        std::fs::create_dir(&project_path).unwrap();

        store.save_project(&project_path).await.unwrap();
        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0], project_path);
    }

    #[tokio::test]
    async fn test_symlink_paths_normalized() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        // Create real project dir
        let real_path = temp.path().join("real-project");
        std::fs::create_dir(&real_path).unwrap();

        // Create symlink to it
        let symlink_path = temp.path().join("symlink-project");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_path, &symlink_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real_path, &symlink_path).unwrap();

        // Save via symlink (should be normalized to real path in actual usage)
        // This test verifies the store handles the path as given
        store.save_project(&symlink_path).await.unwrap();
        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
    }

    #[tokio::test]
    async fn test_concurrent_saves() {
        let temp = tempdir().unwrap();
        let store = Arc::new(ProjectStore::with_dir(temp.path().to_path_buf()));

        let mut handles = Vec::new();

        for i in 0..10 {
            let project_path = temp.path().join(format!("project-{}", i));
            std::fs::create_dir(&project_path).unwrap();

            let store_clone = store.clone();
            let handle = tokio::spawn(async move {
                store_clone.save_project(&project_path).await
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 10);
    }
}
```

### Unit Tests for `paths.rs`

```rust
#[test]
fn test_get_data_root_dir_not_empty() {
    let root = get_data_root_dir();
    assert!(!root.as_os_str().is_empty());
}

#[test]
fn test_get_data_version_dir_includes_version() {
    let version = "1.2.3";
    let dir = get_data_version_dir(version);
    assert!(dir.to_string_lossy().contains(version));
    assert!(dir.starts_with(get_data_root_dir()));
}

#[test]
fn test_get_data_projects_dir() {
    let dir = get_data_projects_dir();
    assert!(dir.ends_with("projects"));
    assert!(dir.starts_with(get_data_root_dir()));
}
```

### Integration Test

```rust
#[tokio::test]
async fn test_open_same_project_twice_returns_same_handle() {
    let temp = tempdir().unwrap();
    let project_path = temp.path().join("test-project");
    std::fs::create_dir(&project_path).unwrap();
    git2::Repository::init(&project_path).unwrap();

    let app_state = create_test_app_state(temp.path()).await;

    let handle1 = open_project_impl(&app_state, project_path.to_string_lossy().to_string())
        .await.unwrap();
    let handle2 = open_project_impl(&app_state, project_path.to_string_lossy().to_string())
        .await.unwrap();

    assert_eq!(handle1, handle2);
}

#[tokio::test]
async fn test_open_project_via_symlink_returns_same_handle() {
    let temp = tempdir().unwrap();

    // Create real project dir with git
    let real_path = temp.path().join("real-project");
    std::fs::create_dir(&real_path).unwrap();
    git2::Repository::init(&real_path).unwrap();

    // Create symlink
    let symlink_path = temp.path().join("symlink-project");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real_path, &symlink_path).unwrap();

    let app_state = create_test_app_state(temp.path()).await;

    let handle1 = open_project_impl(&app_state, real_path.to_string_lossy().to_string())
        .await.unwrap();
    let handle2 = open_project_impl(&app_state, symlink_path.to_string_lossy().to_string())
        .await.unwrap();

    // Both should resolve to same handle due to path normalization
    assert_eq!(handle1, handle2);
}
```

---

## File Changes Summary

| File                                     | Change Type | Description                                                            |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `src-tauri/src/project_store.rs`         | **NEW**     | Project persistence + `ProjectStoreError` + tests                      |
| `src-tauri/src/platform/paths.rs`        | Modify      | Rename functions, add `get_data_projects_dir()`                        |
| `src-tauri/src/config.rs`                | Modify      | Update to use renamed `get_data_version_dir()`                         |
| `src-tauri/src/workspace_provider.rs`    | Modify      | Add `project_root()` getter to trait                                   |
| `src-tauri/src/git_worktree_provider.rs` | Modify      | Implement `project_root()` getter                                      |
| `src-tauri/src/lib.rs`                   | Modify      | Add module, ProjectStore in AppState, duplicate detection, new command |
| `src/lib/api/tauri.ts`                   | Modify      | Add `loadPersistedProjects()`                                          |
| `src/lib/services/projectManager.ts`     | Modify      | Add `restorePersistedProjects()`, `openProjectByPath()`                |
| `src/routes/+layout.svelte`              | Modify      | Call restore on mount, auto-select first                               |

---

## Future Considerations

- **Remove project from persistence** - When UI for removing projects is added
- **Recent projects list** - Could be separate from "open" projects
- **Project metadata** - Store additional info like last opened timestamp
- **Workspace persistence** - Remember which workspace was selected per project

---

**Document Version:** 1.1  
**Last Updated:** 2025-11-22
