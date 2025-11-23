use crate::platform::paths::get_project_workspaces_dir;
use crate::workspace_provider::{
    BranchInfo, Workspace, WorkspaceError, WorkspaceProvider, DISCOVER_TIMEOUT_SECS,
};
use async_trait::async_trait;
use git2::{BranchType, ErrorCode, Repository, WorktreeAddOptions};
use serde::Serialize;
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

    fn project_root(&self) -> &Path {
        &self.project_root
    }

    /// Create and validate a new provider
    async fn new(project_root: PathBuf) -> Result<Self, WorkspaceError> {
        // Validate path is absolute
        if !project_root.is_absolute() {
            return Err(WorkspaceError::InvalidPath(
                "Path must be absolute".into(),
            ));
        }

        let root = project_root.clone();

        // Validate git repository in spawn_blocking
        tokio::task::spawn_blocking(move || -> Result<(), WorkspaceError> {
            Repository::open(&root).map_err(|e| {
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
        let future =
            tokio::task::spawn_blocking(move || discover_worktrees_blocking(&project_root));

        tokio::time::timeout(Duration::from_secs(DISCOVER_TIMEOUT_SECS), future)
            .await
            .map_err(|_| WorkspaceError::Timeout)?
            .map_err(|_| WorkspaceError::TaskCancelled)?
    }
}

impl GitWorktreeProvider {
    /// List all branches (local and remote) in the repository.
    ///
    /// Remote branches skip `*/HEAD` refs.
    pub async fn list_branches(&self) -> Result<Vec<BranchInfo>, WorkspaceError> {
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

    /// Create a new workspace (git worktree) with a new branch based on the given branch.
    ///
    /// The workspace is created at:
    /// `<app-data>/projects/<project-name>-<hash>/workspaces/<name>/`
    ///
    /// # Arguments
    ///
    /// * `name` - The name for the new workspace and branch
    /// * `base_branch` - The branch to base the new branch on (local or remote)
    ///
    /// # Returns
    ///
    /// The created `GitWorktree` on success.
    pub async fn create_workspace(
        &self,
        name: &str,
        base_branch: &str,
    ) -> Result<GitWorktree, WorkspaceError> {
        let project_root = self.project_root.clone();
        let name = name.to_string();
        let base_branch = base_branch.to_string();

        tokio::task::spawn_blocking(move || {
            let repo = Repository::open(&project_root)?;

            // Build worktree path
            let worktree_path = get_project_workspaces_dir(&project_root).join(&name);

            // Check if path already exists
            if worktree_path.exists() {
                return Err(WorkspaceError::WorkspaceAlreadyExists(worktree_path));
            }

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
            let branch_ref = new_branch.into_reference();
            opts.reference(Some(&branch_ref));

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

    /// Fetch branches from all remotes.
    ///
    /// This is a best-effort operation - if one remote fails, others are still tried.
    pub async fn fetch_branches(&self) -> Result<(), WorkspaceError> {
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
}

/// Helper function to get the current branch (None if detached HEAD)
fn get_current_branch(repo: &Repository) -> Option<String> {
    repo.head().ok().and_then(|head| {
        if head.is_branch() {
            head.shorthand().map(String::from)
        } else {
            None
        }
    })
}

/// Process a single worktree, returning None if it should be skipped
fn process_worktree(
    repo: &Repository,
    wt_name: &str,
    project_root: &Path,
) -> Result<GitWorktree, WorkspaceError> {
    // Read gitdir file to get actual worktree path
    let gitdir_path = repo
        .path()
        .join("worktrees")
        .join(wt_name)
        .join("gitdir");

    let gitdir_content = std::fs::read_to_string(&gitdir_path)
        .map_err(|_| WorkspaceError::InvalidWorkspace("Cannot read gitdir".to_string()))?;

    let wt_path = PathBuf::from(gitdir_content.trim())
        .parent()
        .ok_or_else(|| {
            WorkspaceError::InvalidWorkspace(format!("Invalid gitdir for worktree: {}", wt_name))
        })?
        .to_path_buf();

    // Skip if it's the main worktree
    if wt_path == project_root {
        return Err(WorkspaceError::InvalidWorkspace(
            "Worktree is main repository".to_string(),
        ));
    }

    // Validate worktree exists on disk
    if !wt_path.exists() {
        return Err(WorkspaceError::InvalidWorkspace(
            "Worktree path does not exist".to_string(),
        ));
    }

    // Get branch from worktree repository (None if detached)
    let wt_repo = Repository::open(&wt_path)
        .map_err(|_| WorkspaceError::InvalidWorkspace("Cannot open worktree repo".to_string()))?;
    let branch = get_current_branch(&wt_repo);

    let name = wt_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| {
            WorkspaceError::InvalidWorkspace(format!("Invalid worktree path: {:?}", wt_path))
        })?
        .to_string();

    Ok(GitWorktree {
        name,
        path: wt_path,
        branch,
    })
}

/// Blocking function to discover all worktrees
fn discover_worktrees_blocking(project_root: &Path) -> Result<Vec<GitWorktree>, WorkspaceError> {
    let repo = Repository::open(project_root)?;
    let mut workspaces = Vec::new();

    // 1. Add main worktree
    let main_branch = get_current_branch(&repo);

    let main_name = project_root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| WorkspaceError::InvalidWorkspace("Invalid project path".into()))?
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

    // Process additional worktrees using idiomatic iterator combinators
    let additional_worktrees = worktrees
        .iter()
        .flatten() // Filter out None values
        .filter_map(|wt_name| {
            // Try to process this worktree, returning None to skip on any error
            process_worktree(&repo, wt_name, project_root).ok()
        })
        .collect::<Vec<_>>();

    workspaces.extend(additional_worktrees);

    Ok(workspaces)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;
    use std::sync::Arc;
    use tempfile::TempDir;

    // Phase 3: Unit Tests - Constructor (5 tests)

    #[tokio::test]
    async fn test_project_root_returns_correct_path() {
        let test_repo = TestRepo::new().unwrap();
        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        assert_eq!(provider.project_root(), test_repo.path());
    }

    #[tokio::test]
    async fn test_new_valid_repository() {
        let test_repo = TestRepo::new().unwrap();
        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf()).await;

        assert!(provider.is_ok());
    }

    #[tokio::test]
    async fn test_new_not_a_git_repository() {
        let temp = TempDir::new().unwrap();
        let result = GitWorktreeProvider::new(temp.path().to_path_buf()).await;

        assert!(matches!(
            result,
            Err(WorkspaceError::NotGitRepository(_))
        ));
    }

    #[tokio::test]
    async fn test_new_nonexistent_path() {
        let result = GitWorktreeProvider::new(PathBuf::from("/nonexistent/path")).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_new_relative_path_rejected() {
        let result = GitWorktreeProvider::new(PathBuf::from("relative/path")).await;
        assert!(matches!(result, Err(WorkspaceError::InvalidPath(_))));
    }

    #[tokio::test]
    async fn test_new_file_instead_of_directory() {
        let temp = TempDir::new().unwrap();
        let file_path = temp.path().join("file.txt");
        std::fs::write(&file_path, "test").unwrap();

        let result = GitWorktreeProvider::new(file_path).await;
        assert!(result.is_err());
    }

    // Phase 4: Unit Tests - Basic Discovery (4 tests)

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

    // Phase 5: Unit Tests - Edge Cases (8 tests)

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

    #[tokio::test]
    async fn test_discover_empty_repository() {
        let temp = TempDir::new().unwrap();
        let _repo = Repository::init(temp.path()).unwrap();

        let provider = GitWorktreeProvider::new(temp.path().to_path_buf())
            .await
            .unwrap();

        let workspaces = provider.discover().await.unwrap();
        
        // Empty repository still returns main worktree but with no branch
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].branch(), None);
    }

    #[tokio::test]
    async fn test_discover_with_many_worktrees() {
        let test_repo = TestRepo::new().unwrap();

        for i in 0..10 {
            test_repo
                .create_worktree(&format!("worktree-{}", i), &format!("branch-{}", i))
                .unwrap();
        }

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let workspaces = provider.discover().await.unwrap();

        assert_eq!(workspaces.len(), 11);
    }

    #[tokio::test]
    async fn test_discover_branch_names_with_slashes() {
        let test_repo = TestRepo::new().unwrap();
        test_repo
            .create_worktree("oauth-work", "feature/auth/oauth")
            .unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let workspaces = provider.discover().await.unwrap();
        let wt = workspaces.iter().find(|w| w.name() == "oauth-work").unwrap();

        assert_eq!(wt.branch(), Some("feature/auth/oauth"));
    }

    #[tokio::test]
    async fn test_discover_branch_names_with_special_chars() {
        let test_repo = TestRepo::new().unwrap();
        test_repo
            .create_worktree("bug-fix", "fix-bug-#123")
            .unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let workspaces = provider.discover().await.unwrap();
        let wt = workspaces.iter().find(|w| w.name() == "bug-fix").unwrap();

        assert_eq!(wt.branch(), Some("fix-bug-#123"));
    }

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

    // Phase 6: Unit Tests - Concurrency & Performance (3 tests)

    #[tokio::test]
    async fn test_discover_called_concurrently() {
        let test_repo = TestRepo::new().unwrap();
        test_repo.create_worktree("feature-1", "feat-1").unwrap();
        test_repo.create_worktree("feature-2", "feat-2").unwrap();

        let provider = Arc::new(
            GitWorktreeProvider::new(test_repo.path().to_path_buf())
                .await
                .unwrap(),
        );

        let mut handles = vec![];
        for _ in 0..5 {
            let p = provider.clone();
            handles.push(tokio::spawn(async move { p.discover().await }));
        }

        for handle in handles {
            let result = handle.await.unwrap();
            assert!(result.is_ok());
            assert_eq!(result.unwrap().len(), 3);
        }
    }

    #[tokio::test]
    async fn test_discover_completes_within_timeout() {
        let test_repo = TestRepo::new().unwrap();
        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let result =
            tokio::time::timeout(Duration::from_secs(5), provider.discover()).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_ok());
    }

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

        let detached = workspaces
            .iter()
            .find(|w| w.path() == wt_detached)
            .unwrap();
        assert!(detached.branch().is_none());
        assert!(detached.is_detached());
    }

    // ============================================================
    // Tests for list_branches, create_workspace, fetch_branches
    // ============================================================

    // list_branches tests

    #[tokio::test]
    async fn test_list_branches_returns_local_branches() {
        let test_repo = TestRepo::new().unwrap();
        test_repo.create_branch("feature-1").unwrap();
        test_repo.create_branch("feature-2").unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let branches = provider.list_branches().await.unwrap();

        // Should have at least main/master + the 2 feature branches
        assert!(branches.len() >= 3);

        let local_branches: Vec<_> = branches.iter().filter(|b| !b.is_remote).collect();
        assert!(local_branches.iter().any(|b| b.name == "feature-1"));
        assert!(local_branches.iter().any(|b| b.name == "feature-2"));
    }

    #[tokio::test]
    async fn test_list_branches_handles_no_remotes() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let branches = provider.list_branches().await.unwrap();

        // Should return local branches only, no error
        let remote_branches: Vec<_> = branches.iter().filter(|b| b.is_remote).collect();
        assert!(remote_branches.is_empty());
    }

    #[tokio::test]
    async fn test_list_branches_empty_repository() {
        let temp = TempDir::new().unwrap();
        let _repo = Repository::init(temp.path()).unwrap();

        let provider = GitWorktreeProvider::new(temp.path().to_path_buf())
            .await
            .unwrap();

        let branches = provider.list_branches().await.unwrap();

        // Empty repo has no branches
        assert!(branches.is_empty());
    }

    #[tokio::test]
    async fn test_branch_info_partial_eq() {
        let branch1 = BranchInfo {
            name: "main".to_string(),
            is_remote: false,
        };
        let branch2 = BranchInfo {
            name: "main".to_string(),
            is_remote: false,
        };
        let branch3 = BranchInfo {
            name: "main".to_string(),
            is_remote: true,
        };

        assert_eq!(branch1, branch2);
        assert_ne!(branch1, branch3);
    }

    // create_workspace tests

    #[tokio::test]
    async fn test_create_workspace_success() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        // Get the main branch name
        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        let workspace = provider
            .create_workspace("new-feature", main_branch)
            .await
            .unwrap();

        assert_eq!(workspace.name(), "new-feature");
        assert_eq!(workspace.branch(), Some("new-feature"));
        assert!(workspace.path().exists());
    }

    #[tokio::test]
    async fn test_create_workspace_with_nonexistent_base_branch() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let result = provider
            .create_workspace("new-feature", "nonexistent-branch")
            .await;

        assert!(matches!(result, Err(WorkspaceError::BranchNotFound(_))));
    }

    #[tokio::test]
    async fn test_create_workspace_name_collision_with_branch() {
        let test_repo = TestRepo::new().unwrap();
        test_repo.create_branch("existing-branch").unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        // Get the main branch name for base
        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote && (b.name == "main" || b.name == "master"))
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        // Try to create workspace with name that matches existing branch
        let result = provider
            .create_workspace("existing-branch", main_branch)
            .await;

        assert!(matches!(
            result,
            Err(WorkspaceError::WorkspaceAlreadyExists(_))
        ));
    }

    #[tokio::test]
    async fn test_create_workspace_local_branch_priority_over_remote() {
        let test_repo = TestRepo::new().unwrap();
        // Create a local branch - should be used preferentially over any remote with same name
        test_repo.create_branch("develop").unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let workspace = provider
            .create_workspace("work-on-develop", "develop")
            .await
            .unwrap();

        assert_eq!(workspace.name(), "work-on-develop");
        assert!(workspace.path().exists());
    }

    #[tokio::test]
    async fn test_create_workspace_sets_correct_commit() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        // Get the main branch name and its commit
        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        let main_repo = Repository::open(test_repo.path()).unwrap();
        let main_commit = main_repo
            .find_branch(main_branch, BranchType::Local)
            .unwrap()
            .get()
            .peel_to_commit()
            .unwrap()
            .id();

        let workspace = provider
            .create_workspace("new-feature", main_branch)
            .await
            .unwrap();

        // Verify the worktree HEAD matches base branch commit
        let wt_repo = Repository::open(workspace.path()).unwrap();
        let wt_commit = wt_repo.head().unwrap().peel_to_commit().unwrap().id();

        assert_eq!(wt_commit, main_commit);
    }

    #[tokio::test]
    async fn test_create_workspace_path_already_exists() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        // Get the main branch name
        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        // Manually create the directory where workspace would go
        let workspace_path = get_project_workspaces_dir(test_repo.path()).join("pre-existing");
        std::fs::create_dir_all(&workspace_path).unwrap();

        let result = provider
            .create_workspace("pre-existing", main_branch)
            .await;

        assert!(matches!(
            result,
            Err(WorkspaceError::WorkspaceAlreadyExists(_))
        ));
    }

    #[tokio::test]
    async fn test_create_workspace_name_empty_string() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        // Empty name should fail (git doesn't allow empty branch names)
        let result = provider.create_workspace("", main_branch).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_workspace_name_with_slashes_fails() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        // Names with slashes fail because git's worktree storage uses the name as directory
        // The frontend validates names to prevent slashes that would cause directory issues
        let result = provider
            .create_workspace("feature/auth/oauth", main_branch)
            .await;

        // This should fail with WorktreeCreationFailed due to nested directory issue
        assert!(
            matches!(result, Err(WorkspaceError::WorktreeCreationFailed(_))),
            "Expected WorktreeCreationFailed, got {:?}",
            result
        );
    }

    #[tokio::test]
    async fn test_create_workspace_valid_name_with_hyphens() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .unwrap_or("main");

        // Names with hyphens and underscores are valid
        let workspace = provider
            .create_workspace("feature-auth-oauth", main_branch)
            .await
            .unwrap();

        assert_eq!(workspace.name(), "feature-auth-oauth");
        assert_eq!(workspace.branch(), Some("feature-auth-oauth"));
        assert!(workspace.path().exists());
    }

    // fetch_branches tests

    #[tokio::test]
    async fn test_fetch_branches_no_remotes_succeeds() {
        let test_repo = TestRepo::new().unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        // Should succeed even with no remotes (best effort)
        let result = provider.fetch_branches().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_fetch_branches_returns_ok_on_unreachable_remote() {
        let test_repo = TestRepo::new().unwrap();

        // Add an unreachable remote
        let repo = Repository::open(test_repo.path()).unwrap();
        repo.remote("fake-remote", "https://invalid.example.com/repo.git")
            .unwrap();

        let provider = GitWorktreeProvider::new(test_repo.path().to_path_buf())
            .await
            .unwrap();

        // Should return Ok (best effort - ignores failures)
        let result = provider.fetch_branches().await;
        assert!(result.is_ok());
    }

    // Concurrent creation test
    #[tokio::test]
    async fn test_create_workspace_concurrent_same_name() {
        let test_repo = TestRepo::new().unwrap();

        let provider = Arc::new(
            GitWorktreeProvider::new(test_repo.path().to_path_buf())
                .await
                .unwrap(),
        );

        let branches = provider.list_branches().await.unwrap();
        let main_branch = branches
            .iter()
            .find(|b| !b.is_remote)
            .map(|b| b.name.clone())
            .unwrap_or_else(|| "main".to_string());

        // Launch two concurrent create_workspace calls with same name
        let p1 = provider.clone();
        let p2 = provider.clone();
        let branch1 = main_branch.clone();
        let branch2 = main_branch;

        let (result1, result2) = tokio::join!(
            async move { p1.create_workspace("concurrent-ws", &branch1).await },
            async move { p2.create_workspace("concurrent-ws", &branch2).await }
        );

        // One should succeed, one should fail
        let successes = [result1.is_ok(), result2.is_ok()]
            .iter()
            .filter(|&&x| x)
            .count();
        let failures = [result1.is_err(), result2.is_err()]
            .iter()
            .filter(|&&x| x)
            .count();

        // Due to race conditions, we might get both failing or one of each
        // The key is that we don't get both succeeding
        assert!(successes <= 1, "Both concurrent creations succeeded!");

        // At least one should have an error
        if failures > 0 {
            // Check that the error is the expected type
            let error = if result1.is_err() {
                result1.unwrap_err()
            } else {
                result2.unwrap_err()
            };
            assert!(
                matches!(
                    error,
                    WorkspaceError::WorkspaceAlreadyExists(_)
                        | WorkspaceError::WorktreeCreationFailed(_)
                        | WorkspaceError::GitError(_)
                ),
                "Unexpected error type: {:?}",
                error
            );
        }
    }
}
