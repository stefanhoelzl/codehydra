use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

/// Timeout duration for workspace discovery operations (30 seconds)
pub const DISCOVER_TIMEOUT_SECS: u64 = 30;

/// Error types for workspace operations
#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("Not a git repository: {0}")]
    NotGitRepository(PathBuf),

    #[error("Git operation failed: {0}")]
    GitError(#[from] git2::Error),

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

    #[error("Branch not found: {0}")]
    BranchNotFound(String),

    #[error("Workspace already exists at: {0}")]
    WorkspaceAlreadyExists(PathBuf),

    #[error("Worktree creation failed: {0}")]
    WorktreeCreationFailed(String),
}

/// Information about a git branch
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
}

/// Extension trait for converting Result to Tauri-compatible Result
pub trait ToTauriResult<T> {
    fn to_tauri(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> ToTauriResult<T> for Result<T, E> {
    fn to_tauri(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

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

    /// Get the project root path
    fn project_root(&self) -> &Path;
}
