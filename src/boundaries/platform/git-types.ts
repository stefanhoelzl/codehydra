/**
 * Git-related type definitions.
 * All properties are readonly for immutability.
 */

import type { Path } from "../../utils/path/path";

/**
 * Information about a git worktree.
 */
export interface WorktreeInfo {
  /** Worktree name (derived from directory name) */
  readonly name: string;
  /** Absolute path to the worktree directory (normalized Path) */
  readonly path: Path;
  /** Branch checked out in worktree, null if detached HEAD */
  readonly branch: string | null;
  /** Whether this is the main worktree */
  readonly isMain: boolean;
  /** Whether git considers this worktree prunable (directory missing or corrupt) */
  readonly prunable: boolean;
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
  /** Absolute path to the workspace directory (normalized Path) */
  readonly path: Path;
  /** Branch checked out in workspace, null if detached HEAD */
  readonly branch: string | null;
  /**
   * The workspace's metadata, every tier included (see `utils/metadata-tier.ts`).
   * Stored in the worktree's metadata file (`workspace-metadata-store.ts`).
   */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * A worktree of the project that CodeHydra does not manage — neither created by it
 * nor adopted by the user. Offered in the add-project picker.
 */
export interface UnmanagedWorktree {
  /** The name the workspace takes if adopted: its branch, else the directory name */
  readonly name: string;
  /** Absolute path to the worktree directory (normalized Path) */
  readonly path: Path;
  /** Branch checked out in the worktree, null if detached HEAD */
  readonly branch: string | null;
}

/**
 * A branch a workspace can be created from (or named after). Git's own: core
 * sees these only as the git module's dynamic choices and name suggestions.
 */
export interface BaseInfo {
  /** Full branch reference (e.g., "main" or "origin/main"). */
  readonly name: string;
  /** Whether this is a remote-tracking branch. */
  readonly isRemote: boolean;
  /** Suggested base branch for creating a workspace from this branch. */
  readonly base?: string;
  /** Derivable workspace name if a workspace can be created from this branch. */
  readonly derives?: string;
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
