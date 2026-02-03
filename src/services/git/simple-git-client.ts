/**
 * SimpleGitClient implementation using the simple-git library.
 */

import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import { GitError, getErrorMessage } from "../errors";
import type { IGitClient } from "./git-client";
import type { BranchInfo, StatusResult, WorktreeInfo } from "./types";
import type { Logger } from "../logging";
import { Path } from "../platform/path";

/**
 * Implementation of IGitClient using the simple-git library.
 * Wraps simple-git calls and maps errors to GitError.
 *
 * All path parameters use the Path class for normalized, cross-platform handling.
 * Internally converts to native format when calling simple-git.
 */
export class SimpleGitClient implements IGitClient {
  constructor(private readonly logger: Logger) {}

  /**
   * Create a simple-git instance for a given path.
   * Accepts Path and converts to native format for simple-git.
   */
  private getGit(basePath: Path): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: basePath.toNative(),
      binary: "git",
      maxConcurrentProcesses: 6,
      trimmed: true,
      config: process.platform === "win32" ? ["core.longpaths=true"] : [],
    };
    return simpleGit(options);
  }

  /**
   * Wrap a simple-git operation and convert errors to GitError.
   * Logs errors at WARN level.
   */
  private async wrapGitOperation<T>(
    operation: () => Promise<T>,
    opName: string,
    repoPath: Path,
    errorMessage: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error);
      this.logger.warn("Git error", { op: opName, path: repoPath.toString(), error: errMsg });
      throw new GitError(`${errorMessage}: ${errMsg}`);
    }
  }

  /**
   * Check if path is inside a git repository.
   * Used internally for pre-validation in config operations.
   */
  private async isInsideRepository(repoPath: Path): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      const result = await git.checkIsRepo();
      return result;
    } catch {
      return false;
    }
  }

  async isRepositoryRoot(repoPath: Path): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);

      // Check if this is a bare repository first
      // Note: We can't use checkIsRepo() first because it uses --is-inside-work-tree
      // which returns false for bare repos (they have no working tree)
      let isBare = false;
      try {
        const isBareResult = await git.revparse(["--is-bare-repository"]);
        isBare = isBareResult.trim() === "true";
      } catch {
        // revparse fails for non-git directories - this is expected, return false
        this.logger.debug("IsRepositoryRoot", {
          path: repoPath.toString(),
          result: false,
          reason: "not a repo (revparse failed)",
        });
        return false;
      }

      if (isBare) {
        // For bare repos, check if --git-dir returns "." (meaning we're at the root)
        const gitDir = await git.revparse(["--git-dir"]);
        const isRoot = gitDir.trim() === ".";
        this.logger.debug("IsRepositoryRoot (bare)", {
          path: repoPath.toString(),
          gitDir: gitDir.trim(),
          result: isRoot,
        });
        return isRoot;
      }

      // For non-bare repos, first verify we're inside a git repo
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        this.logger.debug("IsRepositoryRoot", {
          path: repoPath.toString(),
          result: false,
          reason: "not a repo",
        });
        return false;
      }

      // Get the actual repository root - git returns POSIX paths
      const root = await git.revparse(["--show-toplevel"]);
      // Wrap git output directly with Path (git returns POSIX format)
      const rootPath = new Path(root.trim());

      // Compare normalized paths
      const isRoot = rootPath.equals(repoPath);
      this.logger.debug("IsRepositoryRoot", {
        path: repoPath.toString(),
        root: rootPath.toString(),
        result: isRoot,
      });
      return isRoot;
    } catch (error: unknown) {
      // If the path doesn't exist or is inaccessible, throw GitError
      const errMsg = getErrorMessage(error);
      this.logger.warn("Git error", {
        op: "isRepositoryRoot",
        path: repoPath.toString(),
        error: errMsg,
      });
      throw new GitError(`Failed to check repository root: ${errMsg}`);
    }
  }

  async listWorktrees(repoPath: Path): Promise<readonly WorktreeInfo[]> {
    const worktrees = await this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);

        // Get raw worktree list output
        const result = await git.raw(["worktree", "list", "--porcelain"]);

        const worktreesResult: WorktreeInfo[] = [];
        const entries = result.split("\n\n").filter((entry) => entry.trim());

        for (const entry of entries) {
          const lines = entry.split("\n");
          let worktreePath: Path | null = null;
          let branch: string | null = null;
          let isMain = false;

          for (const line of lines) {
            if (line.startsWith("worktree ")) {
              // Git on all platforms outputs POSIX paths (C:/Users/...)
              // Wrap directly with Path - no conversion needed!
              // This is the KEY FIX: don't use path.normalize() which
              // would convert to native format (backslashes on Windows)
              worktreePath = new Path(line.substring("worktree ".length));
            } else if (line.startsWith("branch ")) {
              // Branch format is "refs/heads/branch-name"
              const ref = line.substring("branch ".length);
              branch = ref.replace("refs/heads/", "");
            } else if (line === "detached") {
              branch = null;
            } else if (line === "bare") {
              // Skip bare repository entries
              continue;
            }
          }

          // First worktree is the main one
          isMain = worktreesResult.length === 0;

          if (worktreePath) {
            const name = worktreePath.basename;
            worktreesResult.push({
              name,
              path: worktreePath,
              branch,
              isMain,
            });
          }
        }

        return worktreesResult;
      },
      "listWorktrees",
      repoPath,
      "Failed to list worktrees"
    );

    this.logger.debug("ListWorktrees", { path: repoPath.toString(), count: worktrees.length });
    return worktrees;
  }

  async addWorktree(repoPath: Path, worktreePath: Path, branch: string): Promise<void> {
    await this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        // Pass native path to git command
        await git.raw(["worktree", "add", worktreePath.toNative(), branch]);
      },
      "addWorktree",
      repoPath,
      `Failed to add worktree at ${worktreePath.toString()}`
    );
    this.logger.debug("AddWorktree", { path: worktreePath.toString(), branch });
  }

  async removeWorktree(repoPath: Path, worktreePath: Path): Promise<void> {
    await this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        // Pass native path to git command
        await git.raw(["worktree", "remove", worktreePath.toNative(), "--force"]);
      },
      "removeWorktree",
      repoPath,
      `Failed to remove worktree at ${worktreePath.toString()}`
    );
    this.logger.debug("RemoveWorktree", { path: worktreePath.toString() });
  }

  async pruneWorktrees(repoPath: Path): Promise<void> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        await git.raw(["worktree", "prune"]);
      },
      "pruneWorktrees",
      repoPath,
      "Failed to prune worktrees"
    );
  }

  async listBranches(repoPath: Path): Promise<readonly BranchInfo[]> {
    const branches = await this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        const summary = await git.branch(["-a"]);

        const branchesResult: BranchInfo[] = [];

        for (const branchName of Object.keys(summary.branches)) {
          const isRemote = branchName.startsWith("remotes/");

          // Clean up the name for remote branches
          let name = branchName;
          if (isRemote) {
            // Remove "remotes/" prefix and skip HEAD references
            name = branchName.replace("remotes/", "");
            if (name.endsWith("/HEAD")) {
              continue;
            }
          }

          branchesResult.push({
            name,
            isRemote,
          });
        }

        return branchesResult;
      },
      "listBranches",
      repoPath,
      "Failed to list branches"
    );

    const localCount = branches.filter((b) => !b.isRemote).length;
    const remoteCount = branches.filter((b) => b.isRemote).length;
    this.logger.debug("ListBranches", {
      path: repoPath.toString(),
      local: localCount,
      remote: remoteCount,
    });
    return branches;
  }

  async createBranch(repoPath: Path, name: string, startPoint: string): Promise<void> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        await git.branch([name, startPoint]);
      },
      "createBranch",
      repoPath,
      `Failed to create branch ${name}`
    );
  }

  async deleteBranch(repoPath: Path, name: string): Promise<void> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        // Use -D to force delete (handles unmerged branches)
        await git.branch(["-D", name]);
      },
      "deleteBranch",
      repoPath,
      `Failed to delete branch ${name}`
    );
  }

  async getCurrentBranch(repoPath: Path): Promise<string | null> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        const result = await git.revparse(["--abbrev-ref", "HEAD"]);

        // "HEAD" is returned when in detached HEAD state
        if (result === "HEAD") {
          return null;
        }

        return result;
      },
      "getCurrentBranch",
      repoPath,
      "Failed to get current branch"
    );
  }

  async getStatus(repoPath: Path): Promise<StatusResult> {
    const status = await this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        const gitStatus = await git.status();

        // Modified files that are not staged
        const modifiedCount = gitStatus.modified.length + gitStatus.deleted.length;
        // Staged files (created/added files that are staged)
        const stagedCount = gitStatus.staged.length;
        // Untracked files (not_added means not tracked by git)
        const untrackedCount = gitStatus.not_added.length;

        const isDirty = modifiedCount > 0 || stagedCount > 0 || untrackedCount > 0;

        return {
          isDirty,
          modifiedCount,
          stagedCount,
          untrackedCount,
        };
      },
      "getStatus",
      repoPath,
      "Failed to get status"
    );

    this.logger.debug("GetStatus", { path: repoPath.toString(), dirty: status.isDirty });
    return status;
  }

  async fetch(repoPath: Path, remote?: string): Promise<void> {
    await this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        if (remote) {
          // Use array format to ensure remote is treated as remote name, not refspec
          // Include --prune to remove stale remote-tracking branches
          await git.fetch([remote, "--prune"]);
        } else {
          // Fetch all remotes with pruning
          await git.fetch(["--all", "--prune"]);
        }
      },
      "fetch",
      repoPath,
      `Failed to fetch${remote ? ` from ${remote}` : ""}`
    );
    this.logger.debug("Fetch", { path: repoPath.toString(), remote: remote ?? "all" });
  }

  async listRemotes(repoPath: Path): Promise<readonly string[]> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        const remotes = await git.getRemotes();
        return remotes.map((r) => r.name);
      },
      "listRemotes",
      repoPath,
      "Failed to list remotes"
    );
  }

  async getBranchConfig(repoPath: Path, branch: string, key: string): Promise<string | null> {
    // First, verify it's a git repository
    const isRepo = await this.isInsideRepository(repoPath);
    if (!isRepo) {
      throw new GitError(`Not a git repository: ${repoPath.toString()}`);
    }

    try {
      const git = this.getGit(repoPath);
      const configKey = `branch.${branch}.${key}`;
      const value = await git.raw(["config", "--get", configKey]);
      return value.trim() || null;
    } catch (error: unknown) {
      // Exit code 1 means key not found - return null
      // Exit code 128 or other errors mean git error
      if (error instanceof Error && error.message.includes("exit code 1")) {
        return null;
      }
      const errMsg = getErrorMessage(error);
      this.logger.warn("Git error", {
        op: "getBranchConfig",
        path: repoPath.toString(),
        error: errMsg,
      });
      throw new GitError(`Failed to get branch config: ${errMsg}`);
    }
  }

  async setBranchConfig(repoPath: Path, branch: string, key: string, value: string): Promise<void> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        const configKey = `branch.${branch}.${key}`;
        await git.raw(["config", configKey, value]);
      },
      "setBranchConfig",
      repoPath,
      `Failed to set branch config branch.${branch}.${key}`
    );
  }

  async getBranchConfigsByPrefix(
    repoPath: Path,
    branch: string,
    prefix: string
  ): Promise<Readonly<Record<string, string>>> {
    // First, verify it's a git repository
    const isRepo = await this.isInsideRepository(repoPath);
    if (!isRepo) {
      throw new GitError(`Not a git repository: ${repoPath.toString()}`);
    }

    try {
      const git = this.getGit(repoPath);
      // Pattern: branch.<branch>.<prefix>.*
      const pattern = `^branch\\.${branch}\\.${prefix}\\.`;
      const output = await git.raw(["config", "--get-regexp", pattern]);

      const result: Record<string, string> = {};

      // Parse output: each line is "key value" where value is everything after first space
      // Example: "branch.main.codehydra.base develop"
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;

        // Find first space - everything before is key, everything after is value
        const spaceIndex = line.indexOf(" ");
        if (spaceIndex === -1) continue;

        const fullKey = line.substring(0, spaceIndex);
        const configValue = line.substring(spaceIndex + 1);

        // Extract the key after the prefix (branch.<branch>.<prefix>.<key>)
        const prefixPattern = `branch.${branch}.${prefix}.`;
        if (fullKey.startsWith(prefixPattern)) {
          const configKeyName = fullKey.substring(prefixPattern.length);
          result[configKeyName] = configValue;
        }
      }

      return result;
    } catch (error: unknown) {
      // Exit code 1 means no matching keys - return empty object
      if (error instanceof Error && error.message.includes("exit code 1")) {
        return {};
      }
      const errMsg = getErrorMessage(error);
      this.logger.warn("Git error", {
        op: "getBranchConfigsByPrefix",
        path: repoPath.toString(),
        error: errMsg,
      });
      throw new GitError(`Failed to get branch configs: ${errMsg}`);
    }
  }

  async unsetBranchConfig(repoPath: Path, branch: string, key: string): Promise<void> {
    // First, verify it's a git repository
    const isRepo = await this.isInsideRepository(repoPath);
    if (!isRepo) {
      throw new GitError(`Not a git repository: ${repoPath.toString()}`);
    }

    try {
      const git = this.getGit(repoPath);
      const configKey = `branch.${branch}.${key}`;
      await git.raw(["config", "--unset", configKey]);
    } catch (error: unknown) {
      // Exit code 5 means key doesn't exist - that's OK for unset
      if (error instanceof Error && error.message.includes("exit code 5")) {
        return;
      }
      const errMsg = getErrorMessage(error);
      this.logger.warn("Git error", {
        op: "unsetBranchConfig",
        path: repoPath.toString(),
        error: errMsg,
      });
      throw new GitError(`Failed to unset branch config: ${errMsg}`);
    }
  }

  async clone(url: string, targetPath: Path): Promise<void> {
    return this.wrapGitOperation(
      async () => {
        // Use simple-git's clone with bare option
        // Create git instance at the parent directory to run clone command
        const git = simpleGit();
        await git.clone(url, targetPath.toNative(), ["--bare"]);

        // Set up remote tracking for the bare clone
        // By default, bare clones don't have remote-tracking branches (refs/remotes/origin/*)
        // We configure fetch to create them so branches show up under "Remote Branches" in UI
        const bareGit = this.getGit(targetPath);
        await bareGit.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        await bareGit.fetch(["origin"]);

        // Delete local branches - only keep remote-tracking branches
        // This prevents confusion: branches show under "Remote Branches" header in UI
        // Without this, git clone --bare creates local branches (refs/heads/*) not remote-tracking ones
        const branches = await bareGit.branch(["-l"]);
        for (const branchName of Object.keys(branches.branches)) {
          await bareGit.branch(["-D", branchName]);
        }
      },
      "clone",
      targetPath,
      `Failed to clone repository from ${url}`
    );
  }

  async isBare(repoPath: Path): Promise<boolean> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        const result = await git.revparse(["--is-bare-repository"]);
        return result.trim() === "true";
      },
      "isBare",
      repoPath,
      "Failed to check if repository is bare"
    );
  }
}
