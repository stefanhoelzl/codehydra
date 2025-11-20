use chime_lib::code_server::{cleanup_all_servers_internal, ProcessManager};
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

#[tokio::test]
async fn test_open_multiple_projects() {
    let test_repo1 = TestRepo::new().unwrap();
    let test_repo2 = TestRepo::new().unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    let handle1 = open_project_impl(&state, test_repo1.path().to_string_lossy().to_string())
        .await
        .unwrap();

    let handle2 = open_project_impl(&state, test_repo2.path().to_string_lossy().to_string())
        .await
        .unwrap();

    assert_ne!(handle1, handle2);

    let workspaces1 = discover_workspaces_impl(&state, handle1).await.unwrap();

    let workspaces2 = discover_workspaces_impl(&state, handle2).await.unwrap();

    assert_eq!(workspaces1.len(), 1);
    assert_eq!(workspaces2.len(), 1);
}

#[tokio::test]
async fn test_close_project_removes_from_state() {
    let test_repo = TestRepo::new().unwrap();
    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    let handle = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    close_project_impl(&state, handle.clone())
        .await
        .unwrap();

    let result = discover_workspaces_impl(&state, handle).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Project not found"));
}

#[tokio::test]
async fn test_concurrent_operations_on_different_projects() {
    let test_repo1 = TestRepo::new().unwrap();
    let test_repo2 = TestRepo::new().unwrap();

    test_repo1.create_worktree("feature-1", "feat-1").unwrap();
    test_repo2.create_worktree("feature-2", "feat-2").unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    let handle1 = open_project_impl(&state, test_repo1.path().to_string_lossy().to_string())
        .await
        .unwrap();

    let handle2 = open_project_impl(&state, test_repo2.path().to_string_lossy().to_string())
        .await
        .unwrap();

    let h1 = handle1.clone();
    let h2 = handle2.clone();

    let state1 = state.clone();
    let state2 = state.clone();

    let (result1, result2) = tokio::join!(
        discover_workspaces_impl(&state1, h1),
        discover_workspaces_impl(&state2, h2)
    );

    assert!(result1.is_ok());
    assert!(result2.is_ok());
    assert_eq!(result1.unwrap().len(), 2);
    assert_eq!(result2.unwrap().len(), 2);
}

#[tokio::test]
async fn test_invalid_handle_returns_error() {
    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    let result = discover_workspaces_impl(&state, "not-a-valid-uuid".to_string()).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Invalid project handle"));
}

#[tokio::test]
async fn test_nonexistent_project_handle_returns_error() {
    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));
    let fake_handle = ProjectHandle::new();

    let result = discover_workspaces_impl(&state, fake_handle.to_string()).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Project not found"));
}

#[tokio::test]
async fn test_reopen_project_after_closing() {
    let test_repo = TestRepo::new().unwrap();
    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    // Open project first time
    let handle1 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Discover workspaces to verify it's working
    let workspaces1 = discover_workspaces_impl(&state, handle1.clone())
        .await
        .unwrap();
    assert_eq!(workspaces1.len(), 1);

    // Close the project
    close_project_impl(&state, handle1.clone())
        .await
        .unwrap();

    // Reopen the same project
    let handle2 = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Should get a different handle
    assert_ne!(handle1, handle2);

    // Discover workspaces again
    let workspaces2 = discover_workspaces_impl(&state, handle2).await.unwrap();
    assert_eq!(workspaces2.len(), 1);

    // Old handle should still be invalid
    let result = discover_workspaces_impl(&state, handle1).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_discover_multiple_times_same_project() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature-1", "feat-1").unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    let handle = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Discover workspaces first time
    let workspaces1 = discover_workspaces_impl(&state, handle.clone())
        .await
        .unwrap();
    assert_eq!(workspaces1.len(), 2);

    // Discover workspaces second time - should work and return same count
    let workspaces2 = discover_workspaces_impl(&state, handle.clone())
        .await
        .unwrap();
    assert_eq!(workspaces2.len(), 2);

    // Both discoveries should find the same workspaces
    assert_eq!(workspaces1.len(), workspaces2.len());
}

#[tokio::test]
async fn test_parallel_code_server_startup_unique_ports() {
    let test_repo = TestRepo::new().unwrap();
    
    // Create multiple worktrees to test parallel startup
    test_repo.create_worktree("feature-1", "feat-1").unwrap();
    test_repo.create_worktree("feature-2", "feat-2").unwrap();
    test_repo.create_worktree("feature-3", "feat-3").unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager));

    let handle = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Discover workspaces - this triggers parallel code-server startup
    let workspaces = discover_workspaces_impl(&state, handle.clone())
        .await
        .unwrap();

    // Should have 4 workspaces (main + 3 worktrees)
    assert_eq!(workspaces.len(), 4);

    // Collect all ports
    let ports: Vec<u16> = workspaces.iter().map(|w| w.port).collect();

    // All ports should be unique (no duplicates due to race condition)
    let mut unique_ports = ports.clone();
    unique_ports.sort();
    unique_ports.dedup();
    assert_eq!(
        ports.len(),
        unique_ports.len(),
        "Found duplicate ports! Ports: {:?}",
        ports
    );

    // All ports should be in valid range
    for port in &ports {
        assert!(
            *port >= 7000 && *port <= 7100,
            "Port {} outside valid range 7000-7100",
            port
        );
    }

    // All URLs should be unique
    let urls: Vec<String> = workspaces.iter().map(|w| w.url.clone()).collect();
    let mut unique_urls = urls.clone();
    unique_urls.sort();
    unique_urls.dedup();
    assert_eq!(
        urls.len(),
        unique_urls.len(),
        "Found duplicate URLs! URLs: {:?}",
        urls
    );
}

#[tokio::test]
async fn test_cleanup_all_servers_stops_all_processes() {
    let test_repo = TestRepo::new().unwrap();
    
    // Create worktrees to have multiple code-servers
    test_repo.create_worktree("feature-1", "feat-1").unwrap();
    test_repo.create_worktree("feature-2", "feat-2").unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager.clone()));

    let handle = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Start code-servers
    let workspaces = discover_workspaces_impl(&state, handle.clone())
        .await
        .unwrap();

    // Should have 3 workspaces (main + 2 worktrees)
    assert_eq!(workspaces.len(), 3);

    // Verify 3 processes are being managed
    assert_eq!(
        process_manager.process_count().await,
        3,
        "Should have 3 managed processes"
    );

    // Cleanup all servers
    cleanup_all_servers_internal(&process_manager)
        .await
        .unwrap();

    // Verify all processes have been cleaned up
    assert_eq!(
        process_manager.process_count().await,
        0,
        "All processes should be cleaned up"
    );
}

#[tokio::test]
async fn test_close_project_stops_code_servers() {
    let test_repo = TestRepo::new().unwrap();
    test_repo.create_worktree("feature-1", "feat-1").unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager.clone()));

    let handle = open_project_impl(&state, test_repo.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Start code-servers
    let workspaces = discover_workspaces_impl(&state, handle.clone())
        .await
        .unwrap();

    assert_eq!(workspaces.len(), 2);

    // Verify 2 processes are running
    assert_eq!(
        process_manager.process_count().await,
        2,
        "Should have 2 managed processes"
    );

    // Close project - should stop all code-servers
    close_project_impl(&state, handle.clone())
        .await
        .unwrap();

    // Verify all processes have been stopped
    assert_eq!(
        process_manager.process_count().await,
        0,
        "All processes should be stopped after closing project"
    );
}

#[tokio::test]
async fn test_cleanup_multiple_projects_independently() {
    let test_repo1 = TestRepo::new().unwrap();
    let test_repo2 = TestRepo::new().unwrap();

    let process_manager = Arc::new(ProcessManager::new());
    let state = Arc::new(AppState::new(process_manager.clone()));

    // Open both projects
    let handle1 = open_project_impl(&state, test_repo1.path().to_string_lossy().to_string())
        .await
        .unwrap();

    let handle2 = open_project_impl(&state, test_repo2.path().to_string_lossy().to_string())
        .await
        .unwrap();

    // Start code-servers for both
    let _workspaces1 = discover_workspaces_impl(&state, handle1.clone())
        .await
        .unwrap();

    let _workspaces2 = discover_workspaces_impl(&state, handle2.clone())
        .await
        .unwrap();

    // Should have 2 processes total (one per project)
    assert_eq!(
        process_manager.process_count().await,
        2,
        "Should have 2 managed processes"
    );

    // Close only project 1
    close_project_impl(&state, handle1).await.unwrap();

    // Should now have only 1 process (project 2 still running)
    assert_eq!(
        process_manager.process_count().await,
        1,
        "Should have 1 managed process after closing project 1"
    );

    // Close project 2
    close_project_impl(&state, handle2).await.unwrap();

    // All processes should be cleaned up
    assert_eq!(
        process_manager.process_count().await,
        0,
        "All processes should be cleaned up"
    );
}
