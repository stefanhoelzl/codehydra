use crate::workspace_provider::{Workspace, WorkspaceError, WorkspaceProvider, DISCOVER_TIMEOUT_SECS};
use async_trait::async_trait;
use git2::{ErrorCode, Repository};
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
}
