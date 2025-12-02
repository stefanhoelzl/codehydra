//! Project persistence storage.
//!
//! This module provides functionality to persist open projects so they can be
//! restored when the app restarts. Projects are stored in a version-independent
//! directory so they persist across app updates.
//!
//! ## Directory Structure
//!
//! ```text
//! <data-root>/projects/
//! ├── codehydra-a1b2c3d4/
//! │   └── config.json       # { "version": 1, "path": "/path/to/codehydra" }
//! └── my-app-f8e9d0c1/
//!     └── config.json
//! ```
//!
//! Project directory names are formatted as `<project-name>-<8-char-hash>` where
//! the hash is derived from the full project path for uniqueness.

use crate::error::ProjectStoreError;
use crate::platform::paths::get_data_projects_dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Current config version for forward compatibility
const CONFIG_VERSION: u32 = 1;

/// Configuration stored for each persisted project
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    /// Schema version for future migrations
    pub version: u32,
    /// Absolute path to the project directory
    pub path: String,
}

/// Store for persisting project data to disk
pub struct ProjectStore {
    projects_dir: PathBuf,
}

impl ProjectStore {
    /// Create a new ProjectStore using the default projects directory
    pub fn new() -> Self {
        Self {
            projects_dir: get_data_projects_dir(),
        }
    }

    /// Create a ProjectStore with a custom directory (for testing)
    ///
    /// This is available in debug builds for integration tests.
    #[cfg(debug_assertions)]
    pub fn with_dir(projects_dir: PathBuf) -> Self {
        Self { projects_dir }
    }

    /// Generate directory name: "<project-name>-<8-char-hash>"
    ///
    /// The hash is deterministic based on the full path, ensuring the same
    /// project always maps to the same directory.
    fn project_dir_name(path: &Path) -> String {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".to_string());

        let mut hasher = Sha256::new();
        hasher.update(path.to_string_lossy().as_bytes());
        let hash = hasher.finalize();
        let hash_hex = format!("{hash:x}");

        format!("{}-{}", name, &hash_hex[..8])
    }

    /// Save a project to disk
    ///
    /// Creates the project directory and writes the config.json file.
    /// If the project already exists, it will be overwritten.
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

    /// Load all saved project paths
    ///
    /// Returns paths that still exist on disk. Silently skips:
    /// - Projects whose paths no longer exist
    /// - Malformed config.json files
    /// - Entries without config.json
    ///
    /// The returned paths are unsorted - UI handles ordering.
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

    /// Remove a project from persistence
    ///
    /// Removes the project's config.json file and deletes the project directory only if it becomes empty.
    /// Returns Ok even if the project was not persisted.
    pub async fn remove_project(&self, project_path: &Path) -> Result<(), ProjectStoreError> {
        let dir_name = Self::project_dir_name(project_path);
        let project_dir = self.projects_dir.join(&dir_name);
        let config_path = project_dir.join("config.json");

        // Remove only the config.json file
        match tokio::fs::remove_file(&config_path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(ProjectStoreError::IoError(e)),
        }

        // Only remove directory if it's now empty
        match tokio::fs::remove_dir(&project_dir).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()), // Keep directory if not empty
            Err(e) => Err(ProjectStoreError::IoError(e)),
        }
    }
}

impl Default for ProjectStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
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

    #[test]
    fn test_project_dir_name_same_name_different_parent() {
        // Two projects with same name but different paths should have different hashes
        let path1 = Path::new("/home/user1/project");
        let path2 = Path::new("/home/user2/project");
        let name1 = ProjectStore::project_dir_name(path1);
        let name2 = ProjectStore::project_dir_name(path2);
        assert_ne!(name1, name2);
        // Both should start with "project-"
        assert!(name1.starts_with("project-"));
        assert!(name2.starts_with("project-"));
    }

    #[test]
    fn test_project_dir_name_root_path() {
        // Edge case: root path
        let path = Path::new("/");
        let name = ProjectStore::project_dir_name(path);
        // Should use fallback name "project"
        assert!(name.starts_with("project-"));
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
    async fn test_save_overwrites_existing() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("my-project");
        std::fs::create_dir(&project_path).unwrap();

        // Save twice
        store.save_project(&project_path).await.unwrap();
        store.save_project(&project_path).await.unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
    }

    #[tokio::test]
    async fn test_load_ignores_nonexistent_paths() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_dir = temp.path().join("fake-project-12345678");
        std::fs::create_dir(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("config.json"),
            r#"{"version": 1, "path": "/nonexistent/path"}"#,
        )
        .unwrap();

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
        std::fs::write(project_dir.join("config.json"), "not valid json{").unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_load_skips_missing_config() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        // Create a directory without config.json
        let project_dir = temp.path().join("no-config-12345678");
        std::fs::create_dir(&project_dir).unwrap();

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
    async fn test_multiple_projects() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project1 = temp.path().join("project-1");
        let project2 = temp.path().join("project-2");
        let project3 = temp.path().join("project-3");

        std::fs::create_dir(&project1).unwrap();
        std::fs::create_dir(&project2).unwrap();
        std::fs::create_dir(&project3).unwrap();

        store.save_project(&project1).await.unwrap();
        store.save_project(&project2).await.unwrap();
        store.save_project(&project3).await.unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 3);

        // All projects should be present (order not guaranteed)
        assert!(projects.contains(&project1));
        assert!(projects.contains(&project2));
        assert!(projects.contains(&project3));
    }

    #[tokio::test]
    async fn test_remove_project() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("my-project");
        std::fs::create_dir(&project_path).unwrap();

        store.save_project(&project_path).await.unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 1);

        store.remove_project(&project_path).await.unwrap();

        let projects = store.load_all_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_project() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("never-saved");

        // Should not error
        store.remove_project(&project_path).await.unwrap();
    }

    #[tokio::test]
    async fn test_remove_project_conservative_deletion() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("my-project");
        std::fs::create_dir(&project_path).unwrap();

        // Save the project to create config.json
        store.save_project(&project_path).await.unwrap();

        // Add an extra file to the project directory (simulating user data)
        let dir_name = ProjectStore::project_dir_name(&project_path);
        let extra_file = store.projects_dir.join(dir_name).join("user-data.txt");
        tokio::fs::write(&extra_file, "important user data")
            .await
            .unwrap();

        // Verify setup
        let projects_before = store.load_all_projects().await.unwrap();
        assert_eq!(projects_before.len(), 1);
        assert!(extra_file.exists());

        // Remove project
        store.remove_project(&project_path).await.unwrap();

        // Verify config.json is gone but directory and extra file remain
        let projects_after = store.load_all_projects().await.unwrap();
        assert!(projects_after.is_empty());
        assert!(extra_file.exists()); // Extra file should still exist
        assert!(extra_file.parent().unwrap().exists()); // Directory should still exist
    }

    #[tokio::test]
    async fn test_concurrent_saves() {
        let temp = tempdir().unwrap();
        let store = Arc::new(ProjectStore::with_dir(temp.path().to_path_buf()));

        let mut handles = Vec::new();

        for i in 0..10 {
            let project_path = temp.path().join(format!("project-{i}"));
            std::fs::create_dir(&project_path).unwrap();

            let store_clone = store.clone();
            let handle = tokio::spawn(async move { store_clone.save_project(&project_path).await });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 10);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_symlink_paths() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().join("store"));

        // Create real project dir
        let real_path = temp.path().join("real-project");
        std::fs::create_dir(&real_path).unwrap();

        // Create symlink to it
        let symlink_path = temp.path().join("symlink-project");
        std::os::unix::fs::symlink(&real_path, &symlink_path).unwrap();

        // Save via symlink
        store.save_project(&symlink_path).await.unwrap();
        let projects = store.load_all_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn test_default_trait() {
        let store = ProjectStore::default();
        // Should use the default projects directory
        assert!(store.projects_dir.ends_with("projects"));
    }

    #[tokio::test]
    async fn test_config_json_format() {
        let temp = tempdir().unwrap();
        let store = ProjectStore::with_dir(temp.path().to_path_buf());

        let project_path = temp.path().join("my-project");
        std::fs::create_dir(&project_path).unwrap();

        store.save_project(&project_path).await.unwrap();

        // Find the config file
        let dir_name = ProjectStore::project_dir_name(&project_path);
        let config_path = temp.path().join(&dir_name).join("config.json");

        let content = std::fs::read_to_string(&config_path).unwrap();
        let config: ProjectConfig = serde_json::from_str(&content).unwrap();

        assert_eq!(config.version, CONFIG_VERSION);
        assert_eq!(config.path, project_path.to_string_lossy());
    }
}
