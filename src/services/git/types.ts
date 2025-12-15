/**
 * Git-related type definitions.
 * All properties are readonly for immutability.
 */

/**
 * Information about a git worktree.
 */
export interface WorktreeInfo {
  /** Worktree name (derived from directory name) */
  readonly name: string;
  /** Absolute path to the worktree directory */
  readonly path: string;
  /** Branch checked out in worktree, null if detached HEAD */
  readonly branch: string | null;
  /** Whether this is the main worktree */
  readonly isMain: boolean;
}

/**
 * Information about a git branch.
 */
export interface BranchInfo {
  /** Branch name (without refs/heads/ or refs/remotes/ prefix) */
  readonly name: string;
  /** Whether this is a remote-tracking branch */
  readonly isRemote: boolean;
}

/**
 * Result of git status check.
 */
export interface StatusResult {
  /** Whether the working directory has uncommitted changes */
  readonly isDirty: boolean;
  /** Number of modified files (tracked, unstaged) */
  readonly modifiedCount: number;
  /** Number of staged files */
  readonly stagedCount: number;
  /** Number of untracked files */
  readonly untrackedCount: number;
}

/**
 * Workspace representation for the application.
 */
export interface Workspace {
  /** Workspace name */
  readonly name: string;
  /** Absolute path to the workspace directory */
  readonly path: string;
  /** Branch checked out in workspace, null if detached HEAD */
  readonly branch: string | null;
  /** Base branch the workspace was created from (fallback: branch ?? name) */
  readonly baseBranch: string;
}

/**
 * Base (branch) information for workspace creation.
 */
export interface BaseInfo {
  /** Branch name */
  readonly name: string;
  /** Whether this is a remote branch */
  readonly isRemote: boolean;
}

/**
 * Result of workspace removal operation.
 */
export interface RemovalResult {
  /** Whether the workspace was successfully removed */
  readonly workspaceRemoved: boolean;
  /** Whether the base branch was deleted (if requested) */
  readonly baseDeleted: boolean;
}

/**
 * Result of updating bases (fetching from remotes).
 */
export interface UpdateBasesResult {
  /** Remotes that were successfully fetched */
  readonly fetchedRemotes: readonly string[];
  /** Remotes that failed to fetch with error messages */
  readonly failedRemotes: readonly { remote: string; error: string }[];
}

/**
 * Result of cleanup operation for orphaned workspace directories.
 */
export interface CleanupResult {
  /** Number of directories successfully removed */
  readonly removedCount: number;
  /** Directories that failed to remove with error messages */
  readonly failedPaths: ReadonlyArray<{ path: string; error: string }>;
}
