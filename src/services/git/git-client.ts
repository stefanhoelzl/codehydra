/**
 * Abstract interface for git operations.
 * This abstraction allows swapping the underlying git implementation
 * (e.g., simple-git, nodegit, isomorphic-git).
 */

import type { Path } from "../platform/path";
import type { BranchInfo, StatusResult, WorktreeInfo } from "./types";

/**
 * Interface for git operations.
 * All methods use git terminology (worktree, branch, etc.).
 * All path parameters use Path class for normalized, cross-platform handling.
 */
export interface IGitClient {
  /**
   * Check if path is the root of a git repository.
   * Returns true only if the path is exactly the repository root,
   * not a subdirectory within a repository.
   * @param path Absolute path to check
   * @returns Promise resolving to true if path is a git repository root
   * @throws GitError if path doesn't exist or is inaccessible
   */
  isRepositoryRoot(path: Path): Promise<boolean>;

  /**
   * List all worktrees in repository.
   * @param repoPath Absolute path to the git repository
   * @returns Promise resolving to array of worktree information
   * @throws GitError if not a git repository
   */
  listWorktrees(repoPath: Path): Promise<readonly WorktreeInfo[]>;

  /**
   * Add a new worktree to the repository.
   * @param repoPath Absolute path to the git repository
   * @param worktreePath Absolute path where worktree will be created
   * @param branch Branch to check out in the worktree
   * @returns Promise resolving when worktree is created
   * @throws GitError if branch doesn't exist, path already exists, or not a git repository
   */
  addWorktree(repoPath: Path, worktreePath: Path, branch: string): Promise<void>;

  /**
   * Remove a worktree from the repository.
   * @param repoPath Absolute path to the git repository
   * @param worktreePath Absolute path to the worktree to remove
   * @returns Promise resolving when worktree is removed
   * @throws GitError if worktree doesn't exist or not a git repository
   */
  removeWorktree(repoPath: Path, worktreePath: Path): Promise<void>;

  /**
   * Prune stale worktree information.
   * Removes worktree entries where the working tree directory no longer exists.
   * @param repoPath Absolute path to the git repository
   * @returns Promise resolving when pruning is complete
   * @throws GitError if not a git repository
   */
  pruneWorktrees(repoPath: Path): Promise<void>;

  /**
   * List all branches in repository.
   * @param repoPath Absolute path to the git repository
   * @returns Promise resolving to array of branch information (local and remote)
   * @throws GitError if not a git repository
   */
  listBranches(repoPath: Path): Promise<readonly BranchInfo[]>;

  /**
   * Create a new branch.
   * @param repoPath Absolute path to the git repository
   * @param name Name for the new branch
   * @param startPoint Commit, branch, or tag to start from
   * @returns Promise resolving when branch is created
   * @throws GitError if branch already exists, start point doesn't exist, or not a git repository
   */
  createBranch(repoPath: Path, name: string, startPoint: string): Promise<void>;

  /**
   * Delete a branch.
   * @param repoPath Absolute path to the git repository
   * @param name Name of the branch to delete
   * @returns Promise resolving when branch is deleted
   * @throws GitError if branch doesn't exist, is checked out, or not a git repository
   */
  deleteBranch(repoPath: Path, name: string): Promise<void>;

  /**
   * Get the current branch name.
   * @param path Absolute path to the repository or worktree
   * @returns Promise resolving to branch name, or null if HEAD is detached
   * @throws GitError if path is not a git repository or worktree
   */
  getCurrentBranch(path: Path): Promise<string | null>;

  /**
   * Get the status of a repository or worktree.
   * @param path Absolute path to the repository or worktree
   * @returns Promise resolving to status information
   * @throws GitError if path is not a git repository or worktree
   */
  getStatus(path: Path): Promise<StatusResult>;

  /**
   * Fetch from a remote.
   * @param repoPath Absolute path to the git repository
   * @param remote Optional remote name (defaults to all remotes)
   * @returns Promise resolving when fetch is complete
   * @throws GitError if remote doesn't exist or network error
   */
  fetch(repoPath: Path, remote?: string): Promise<void>;

  /**
   * List all remotes in repository.
   * @param repoPath Absolute path to the git repository
   * @returns Promise resolving to array of remote names
   * @throws GitError if not a git repository
   */
  listRemotes(repoPath: Path): Promise<readonly string[]>;

  /**
   * Get a branch-specific configuration value.
   * @param repoPath Absolute path to the git repository
   * @param branch Name of the branch
   * @param key Configuration key (without the branch prefix)
   * @returns Promise resolving to the config value, or null if not set
   * @throws GitError if not a git repository
   */
  getBranchConfig(repoPath: Path, branch: string, key: string): Promise<string | null>;

  /**
   * Set a branch-specific configuration value.
   * @param repoPath Absolute path to the git repository
   * @param branch Name of the branch
   * @param key Configuration key (without the branch prefix)
   * @param value Value to set
   * @returns Promise resolving when config is set
   * @throws GitError if not a git repository
   */
  setBranchConfig(repoPath: Path, branch: string, key: string, value: string): Promise<void>;

  /**
   * Get all branch configuration values under a prefix.
   * Returns config values under `branch.<branch>.<prefix>.*` with the prefix stripped.
   *
   * @example
   * // Git config has:
   * // branch.main.codehydra.base = develop
   * // branch.main.codehydra.note = WIP feature
   * const configs = await client.getBranchConfigsByPrefix(repoPath, "main", "codehydra");
   * // Returns: { base: "develop", note: "WIP feature" }
   *
   * @param repoPath Absolute path to the git repository
   * @param branch Name of the branch
   * @param prefix Configuration key prefix (e.g., "codehydra")
   * @returns Promise resolving to a record of key-value pairs (keys have prefix stripped)
   * @throws GitError if not a git repository
   */
  getBranchConfigsByPrefix(
    repoPath: Path,
    branch: string,
    prefix: string
  ): Promise<Readonly<Record<string, string>>>;

  /**
   * Remove a branch-specific configuration value.
   * Does not throw if the key does not exist.
   *
   * @param repoPath Absolute path to the git repository
   * @param branch Name of the branch
   * @param key Configuration key (without the branch prefix)
   * @returns Promise resolving when config is unset
   * @throws GitError if not a git repository
   */
  unsetBranchConfig(repoPath: Path, branch: string, key: string): Promise<void>;
}
