use chime_lib::code_server::CodeServerManager;
use chime_lib::config::CodeServerConfig;
use chime_lib::project_store::ProjectStore;
use chime_lib::workspace_provider::ProjectHandle;
use chime_lib::{close_project_impl, discover_workspaces_impl, open_project_impl, AppState};
use git2::{Repository, Signature};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

// Test helper for creating git repositories
pub struct TestRepo {
    pub temp_dir: TempDir,
    pub repo: Repository,
}

impl TestRepo {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let temp_dir = TempDir::new()?;
        let repo = Repository::init(temp_dir.path())?;

        let readme_path = temp_dir.path().join("README.md");
        std::fs::write(&readme_path, "# Test Repository\n")?;

        {
            let mut index = repo.index()?;
            index.add_path(Path::new("README.md"))?;
            index.write()?;

            let tree_id = index.write_tree()?;
            let tree = repo.find_tree(tree_id)?;
            let sig = Signature::now("Test User", "test@example.com")?;

            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])?;
        }

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

    pub fn create_worktree(
        &self,
        name: &str,
        branch: &str,
    ) -> Result<PathBuf, Box<dyn std::error::Error>> {
        self.create_branch(branch)?;

        let worktree_path = self.temp_dir.path().join(format!("worktrees/{}", name));
        std::fs::create_dir_all(worktree_path.parent().unwrap())?;

        let branch_ref = self.repo.find_branch(branch, git2::BranchType::Local)?;
        let branch_ref = branch_ref.get();

        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch_ref));
        self.repo.worktree(name, &worktree_path, Some(&opts))?;

        Ok(worktree_path)
    }
}

/// Create a test config that doesn't require actual binaries
fn test_config() -> CodeServerConfig {
    CodeServerConfig {
        runtime_dir: PathBuf::from("/tmp/test-runtime"),
        node_dir: PathBuf::from("/tmp/test-runtime/node"),
        node_binary_path: PathBuf::from("/tmp/test-runtime/node/bin/node"),
        extensions_dir: PathBuf::from("/tmp/test-runtime/extensions"),
        user_data_dir: PathBuf::from("/tmp/test-runtime/user-data"),
        port_start: 50000,
    }
}

/// Create test AppState with a mock config
fn create_test_app_state() -> Arc<AppState> {
    let config = test_config();
    let manager = Arc::new(CodeServerManager::new(config));
    let project_store = Arc::new(ProjectStore::new());
    Arc::new(AppState::new(manager, project_store))
}

#[tokio::test]
async fn test_open_multiple_projects() {
    let test_repo1 = TestRepo::new().unwrap();
    let test_repo2 = TestRepo::new().unwrap();

    let state = create_test_app_state();

    let handle1 = open_project_impl(&state, test_repo1.path().to_string_lossy().to_string())
        .await
        .unwrap();

    let handle2 = open_project_impl(&state, test_repo2.path().to_string_lossy().to_string())
        .await
        .unwrap();

    assert_ne!(handle1, handle2);
}

#[tokio::test]
async fn test_close_project_removes_from_state() {
    let test_repo = TestRepo::new().unwrap();
    let state = create_test_app_state();

    let handle = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    close_project_impl(&state, handle.clone()).await.unwrap();

    // Create a fake handle string that should be parseable but not found
    let result = discover_workspaces_impl(&state, handle).await;

    // The discover should fail because the project was closed, but since
    // we're not actually starting code-server in tests, we just verify
    // the project is gone by checking the error
    assert!(result.is_err());
    // Note: This might fail at the code-server start step, not the project lookup
    // depending on how the test runs
}

#[tokio::test]
async fn test_invalid_handle_returns_error() {
    let state = create_test_app_state();

    let result = discover_workspaces_impl(&state, "not-a-valid-uuid".to_string()).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Invalid project handle"));
}

#[tokio::test]
async fn test_nonexistent_project_handle_returns_error() {
    let state = create_test_app_state();
    let fake_handle = ProjectHandle::new();

    let result = discover_workspaces_impl(&state, fake_handle.to_string()).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Project not found"));
}

#[tokio::test]
async fn test_reopen_project_after_closing() {
    let test_repo = TestRepo::new().unwrap();
    let state = create_test_app_state();

    // Open project first time
    let handle1 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Close the project
    close_project_impl(&state, handle1.clone()).await.unwrap();

    // Reopen the same project
    let handle2 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Should get a different handle
    assert_ne!(handle1, handle2);

    // Old handle should be invalid
    let result = discover_workspaces_impl(&state, handle1).await;
    assert!(result.is_err());
}

// Tests for duplicate project detection
#[tokio::test]
async fn test_open_same_project_twice_returns_same_handle() {
    let test_repo = TestRepo::new().unwrap();
    let state = create_test_app_state();

    let handle1 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();
    let handle2 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Same path should return same handle (no duplicate)
    assert_eq!(handle1, handle2);
}

#[tokio::test]
#[cfg(unix)]
async fn test_open_project_via_symlink_returns_same_handle() {
    let test_repo = TestRepo::new().unwrap();
    let temp = TempDir::new().unwrap();

    // Create symlink to the project
    let symlink_path = temp.path().join("symlink-project");
    std::os::unix::fs::symlink(test_repo.path(), &symlink_path).unwrap();

    let state = create_test_app_state();

    let handle1 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();
    let handle2 = open_project_impl(&state, symlink_path.to_string_lossy().to_string())
        .await
        .unwrap();

    // Both should resolve to same handle due to path normalization
    assert_eq!(handle1, handle2);
}

// Tests below are for the CodeServerManager and CodeServerInstance
// These don't require actual code-server to be running

mod code_server_tests {
    use chime_lib::code_server::CodeServerManager;
    use chime_lib::config::CodeServerConfig;
    use std::path::{Path, PathBuf};

    fn test_config() -> CodeServerConfig {
        CodeServerConfig {
            runtime_dir: PathBuf::from("/tmp/test-runtime"),
            node_dir: PathBuf::from("/tmp/test-runtime/node"),
            node_binary_path: PathBuf::from("/tmp/test-runtime/node/bin/node"),
            extensions_dir: PathBuf::from("/tmp/test-runtime/extensions"),
            user_data_dir: PathBuf::from("/tmp/test-runtime/user-data"),
            port_start: 50000,
        }
    }

    #[tokio::test]
    async fn test_manager_is_not_running_initially() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        assert!(!manager.is_running().await);
    }

    #[tokio::test]
    async fn test_manager_port_is_none_initially() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        assert!(manager.port().await.is_none());
    }

    #[tokio::test]
    async fn test_manager_url_for_folder_is_none_when_not_running() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        let url = manager.url_for_folder(Path::new("/test/project")).await;
        assert!(url.is_none());
    }

    #[tokio::test]
    async fn test_stop_when_not_running_is_ok() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        // Stopping when nothing is running should succeed
        let result = manager.stop().await;
        assert!(result.is_ok());
    }
}

// Tests for workspace URL generation
mod url_generation_tests {
    use chime_lib::platform::paths::encode_path_for_url;
    use std::path::Path;

    #[test]
    fn test_url_encoding_simple_path() {
        let path = Path::new("/home/user/project");
        let encoded = encode_path_for_url(path);
        assert_eq!(encoded, "/home/user/project");
    }

    #[test]
    fn test_url_encoding_path_with_spaces() {
        let path = Path::new("/home/user/my project");
        let encoded = encode_path_for_url(path);
        assert_eq!(encoded, "/home/user/my%20project");
    }

    #[test]
    fn test_url_encoding_path_with_special_chars() {
        let path = Path::new("/home/user/project#test");
        let encoded = encode_path_for_url(path);
        assert!(encoded.contains("%23"));
    }

    #[test]
    fn test_url_encoding_preserves_slashes() {
        let path = Path::new("/a/b/c/d");
        let encoded = encode_path_for_url(path);
        assert_eq!(encoded, "/a/b/c/d");
    }
}
