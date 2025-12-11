/**
 * SimpleGitClient implementation using the simple-git library.
 */

import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import path from "path";
import { GitError } from "../errors";
import type { IGitClient } from "./git-client";
import type { BranchInfo, StatusResult, WorktreeInfo } from "./types";

/**
 * Implementation of IGitClient using the simple-git library.
 * Wraps simple-git calls and maps errors to GitError.
 */
export class SimpleGitClient implements IGitClient {
  /**
   * Create a simple-git instance for a given path.
   */
  private getGit(basePath: string): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: basePath,
      binary: "git",
      maxConcurrentProcesses: 6,
      trimmed: true,
    };
    return simpleGit(options);
  }

  /**
   * Wrap a simple-git operation and convert errors to GitError.
   */
  private async wrapGitOperation<T>(operation: () => Promise<T>, errorMessage: string): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      const message = error instanceof Error ? `${errorMessage}: ${error.message}` : errorMessage;
      throw new GitError(message);
    }
  }

  async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      const result = await git.checkIsRepo();
      return result;
    } catch (error: unknown) {
      // If the path doesn't exist or is inaccessible, throw GitError
      const message =
        error instanceof Error
          ? `Failed to check repository: ${error.message}`
          : "Failed to check repository";
      throw new GitError(message);
    }
  }

  async listWorktrees(repoPath: string): Promise<readonly WorktreeInfo[]> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);

      // Get raw worktree list output
      const result = await git.raw(["worktree", "list", "--porcelain"]);

      const worktrees: WorktreeInfo[] = [];
      const entries = result.split("\n\n").filter((entry) => entry.trim());

      for (const entry of entries) {
        const lines = entry.split("\n");
        let worktreePath = "";
        let branch: string | null = null;
        let isMain = false;

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            worktreePath = line.substring("worktree ".length);
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
        isMain = worktrees.length === 0;

        if (worktreePath) {
          const name = path.basename(worktreePath);
          worktrees.push({
            name,
            path: worktreePath,
            branch,
            isMain,
          });
        }
      }

      return worktrees;
    }, "Failed to list worktrees");
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.raw(["worktree", "add", worktreePath, branch]);
    }, `Failed to add worktree at ${worktreePath}`);
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.raw(["worktree", "remove", worktreePath, "--force"]);
    }, `Failed to remove worktree at ${worktreePath}`);
  }

  async pruneWorktrees(repoPath: string): Promise<void> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.raw(["worktree", "prune"]);
    }, "Failed to prune worktrees");
  }

  async listBranches(repoPath: string): Promise<readonly BranchInfo[]> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const summary = await git.branch(["-a"]);

      const branches: BranchInfo[] = [];

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

        branches.push({
          name,
          isRemote,
        });
      }

      return branches;
    }, "Failed to list branches");
  }

  async createBranch(repoPath: string, name: string, startPoint: string): Promise<void> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.branch([name, startPoint]);
    }, `Failed to create branch ${name}`);
  }

  async deleteBranch(repoPath: string, name: string): Promise<void> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      // Use -D to force delete (handles unmerged branches)
      await git.branch(["-d", name]);
    }, `Failed to delete branch ${name}`);
  }

  async getCurrentBranch(repoPath: string): Promise<string | null> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const result = await git.revparse(["--abbrev-ref", "HEAD"]);

      // "HEAD" is returned when in detached HEAD state
      if (result === "HEAD") {
        return null;
      }

      return result;
    }, "Failed to get current branch");
  }

  async getStatus(repoPath: string): Promise<StatusResult> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const status = await git.status();

      // Modified files that are not staged
      const modifiedCount = status.modified.length + status.deleted.length;
      // Staged files (created/added files that are staged)
      const stagedCount = status.staged.length;
      // Untracked files (not_added means not tracked by git)
      const untrackedCount = status.not_added.length;

      const isDirty = modifiedCount > 0 || stagedCount > 0 || untrackedCount > 0;

      return {
        isDirty,
        modifiedCount,
        stagedCount,
        untrackedCount,
      };
    }, "Failed to get status");
  }

  async fetch(repoPath: string, remote?: string): Promise<void> {
    return this.wrapGitOperation(
      async () => {
        const git = this.getGit(repoPath);
        if (remote) {
          // Use array format to ensure remote is treated as remote name, not refspec
          await git.fetch([remote]);
        } else {
          await git.fetch();
        }
      },
      `Failed to fetch${remote ? ` from ${remote}` : ""}`
    );
  }

  async listRemotes(repoPath: string): Promise<readonly string[]> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const remotes = await git.getRemotes();
      return remotes.map((r) => r.name);
    }, "Failed to list remotes");
  }
}
