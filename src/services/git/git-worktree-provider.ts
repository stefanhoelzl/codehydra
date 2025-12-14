/**
 * GitWorktreeProvider - Implementation of IWorkspaceProvider using git worktrees.
 */

import path from "path";
import type { IGitClient } from "./git-client";
import type { IWorkspaceProvider } from "./workspace-provider";
import type { BaseInfo, CleanupResult, RemovalResult, UpdateBasesResult, Workspace } from "./types";
import { WorkspaceError } from "../errors";
import { sanitizeWorkspaceName } from "../platform/paths";
import type { FileSystemLayer } from "../platform/filesystem";

/**
 * Implementation of IWorkspaceProvider using git worktrees.
 * Each workspace is a git worktree, allowing parallel work on different branches.
 */
export class GitWorktreeProvider implements IWorkspaceProvider {
  readonly projectRoot: string;
  private readonly gitClient: IGitClient;
  private readonly workspacesDir: string;
  private readonly fileSystemLayer: FileSystemLayer;
  private cleanupInProgress = false;

  private constructor(
    projectRoot: string,
    gitClient: IGitClient,
    workspacesDir: string,
    fileSystemLayer: FileSystemLayer
  ) {
    this.projectRoot = projectRoot;
    this.gitClient = gitClient;
    this.workspacesDir = workspacesDir;
    this.fileSystemLayer = fileSystemLayer;
  }

  /**
   * Normalize a worktree path for consistent comparison.
   * - Resolves . and .. components
   * - Removes trailing slashes
   */
  private normalizeWorktreePath(p: string): string {
    return path.normalize(p).replace(/[/\\]$/, "");
  }

  /**
   * Factory method to create a GitWorktreeProvider.
   * Validates that the path is an absolute path to a git repository.
   *
   * @param projectRoot Absolute path to the git repository
   * @param gitClient Git client to use for operations
   * @param workspacesDir Directory where worktrees will be created (from PathProvider.getProjectWorkspacesDir)
   * @param fileSystemLayer FileSystemLayer for cleanup operations
   * @returns Promise resolving to a new GitWorktreeProvider
   * @throws WorkspaceError if path is invalid or not a git repository
   */
  static async create(
    projectRoot: string,
    gitClient: IGitClient,
    workspacesDir: string,
    fileSystemLayer: FileSystemLayer
  ): Promise<GitWorktreeProvider> {
    // Validate absolute path
    if (!path.isAbsolute(projectRoot)) {
      throw new WorkspaceError(`Path must be absolute: ${projectRoot}`);
    }

    // Validate workspacesDir is absolute
    if (!path.isAbsolute(workspacesDir)) {
      throw new WorkspaceError(`workspacesDir must be absolute: ${workspacesDir}`);
    }

    // Validate it's a git repository
    try {
      const isRepo = await gitClient.isGitRepository(projectRoot);
      if (!isRepo) {
        throw new WorkspaceError(`Path is not a git repository: ${projectRoot}`);
      }
    } catch (error: unknown) {
      if (error instanceof WorkspaceError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error checking repository";
      throw new WorkspaceError(`Failed to validate repository: ${message}`);
    }

    return new GitWorktreeProvider(projectRoot, gitClient, workspacesDir, fileSystemLayer);
  }

  async discover(): Promise<readonly Workspace[]> {
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);

    // Filter out the main worktree
    return worktrees
      .filter((wt) => !wt.isMain)
      .map((wt) => ({
        name: wt.name,
        path: wt.path,
        branch: wt.branch,
      }));
  }

  async listBases(): Promise<readonly BaseInfo[]> {
    const branches = await this.gitClient.listBranches(this.projectRoot);

    return branches.map((branch) => ({
      name: branch.name,
      isRemote: branch.isRemote,
    }));
  }

  async updateBases(): Promise<UpdateBasesResult> {
    const remotes = await this.gitClient.listRemotes(this.projectRoot);

    const fetchedRemotes: string[] = [];
    const failedRemotes: { remote: string; error: string }[] = [];

    for (const remote of remotes) {
      try {
        await this.gitClient.fetch(this.projectRoot, remote);
        fetchedRemotes.push(remote);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Unknown fetch error";
        failedRemotes.push({ remote, error: errorMessage });
      }
    }

    return { fetchedRemotes, failedRemotes };
  }

  async createWorkspace(name: string, baseBranch: string): Promise<Workspace> {
    // Sanitize the name for filesystem (/ -> %)
    const sanitizedName = sanitizeWorkspaceName(name);

    // Compute the worktree path using the configured workspaces directory
    const worktreePath = path.join(this.workspacesDir, sanitizedName);

    // Create the branch
    try {
      await this.gitClient.createBranch(this.projectRoot, name, baseBranch);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error creating branch";
      throw new WorkspaceError(`Failed to create branch: ${message}`);
    }

    // Create the worktree
    try {
      await this.gitClient.addWorktree(this.projectRoot, worktreePath, name);
    } catch (error: unknown) {
      // Rollback: delete the branch we just created
      try {
        await this.gitClient.deleteBranch(this.projectRoot, name);
      } catch {
        // Ignore rollback errors
      }

      const message = error instanceof Error ? error.message : "Unknown error creating worktree";
      throw new WorkspaceError(`Failed to create worktree: ${message}`);
    }

    return {
      name,
      path: worktreePath,
      branch: name,
    };
  }

  async removeWorkspace(workspacePath: string, deleteBase: boolean): Promise<RemovalResult> {
    // Normalize paths for comparison
    const normalizedWorkspacePath = this.normalizeWorktreePath(workspacePath);
    const normalizedProjectRoot = this.normalizeWorktreePath(this.projectRoot);

    // Cannot remove main worktree
    if (normalizedWorkspacePath === normalizedProjectRoot) {
      throw new WorkspaceError("Cannot remove the main worktree");
    }

    // Get the branch name before removal
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);
    const worktree = worktrees.find(
      (wt) => this.normalizeWorktreePath(wt.path) === normalizedWorkspacePath
    );
    const branchName = worktree?.branch;

    // Remove the worktree - handle partial failures
    try {
      await this.gitClient.removeWorktree(this.projectRoot, workspacePath);
    } catch (error) {
      // Check if worktree was unregistered despite error
      const currentWorktrees = await this.gitClient.listWorktrees(this.projectRoot);
      const stillRegistered = currentWorktrees.some(
        (wt) => this.normalizeWorktreePath(wt.path) === normalizedWorkspacePath
      );

      if (stillRegistered) {
        throw error; // Truly failed - still registered
      }

      // Unregistered but directory remains - log and continue
      console.warn(
        `Worktree unregistered but directory remains: ${workspacePath}. ` +
          `Will be cleaned up on next startup.`
      );
    }

    // Prune stale worktree entries
    await this.gitClient.pruneWorktrees(this.projectRoot);

    // Optionally delete the branch
    let baseDeleted = false;
    if (deleteBase && branchName) {
      try {
        await this.gitClient.deleteBranch(this.projectRoot, branchName);
        baseDeleted = true;
      } catch {
        // Branch deletion can fail (e.g., if branch is checked out elsewhere)
        // This is not a critical error
        baseDeleted = false;
      }
    }

    return {
      workspaceRemoved: true,
      baseDeleted,
    };
  }

  async isDirty(workspacePath: string): Promise<boolean> {
    const status = await this.gitClient.getStatus(workspacePath);
    return status.isDirty;
  }

  isMainWorkspace(workspacePath: string): boolean {
    const normalizedWorkspacePath = this.normalizeWorktreePath(workspacePath);
    const normalizedProjectRoot = this.normalizeWorktreePath(this.projectRoot);
    return normalizedWorkspacePath === normalizedProjectRoot;
  }

  /**
   * Returns the default base branch for creating new workspaces.
   * Checks for "main" first, then "master". Returns undefined if neither exists.
   *
   * @returns Promise resolving to "main", "master", or undefined
   */
  async defaultBase(): Promise<string | undefined> {
    try {
      const bases = await this.listBases();
      const branchNames = bases.map((b) => b.name);

      if (branchNames.includes("main")) {
        return "main";
      }
      if (branchNames.includes("master")) {
        return "master";
      }
      return undefined;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.warn(`Failed to get default base branch: ${message}`);
      return undefined;
    }
  }

  /**
   * Removes workspace directories that are not registered with git.
   * Handles cases where `git worktree remove` unregistered a worktree
   * but failed to delete its directory (e.g., due to locked files).
   *
   * Runs at project startup (non-blocking). Errors are logged but not thrown,
   * allowing cleanup to retry on next startup.
   *
   * Security: Skips symlinks and validates paths stay within workspacesDir.
   *
   * @returns Result indicating how many directories were removed and any failures
   */
  async cleanupOrphanedWorkspaces(): Promise<CleanupResult> {
    const emptyResult: CleanupResult = { removedCount: 0, failedPaths: [] };

    // Concurrency guard - only one cleanup at a time
    if (this.cleanupInProgress) {
      return emptyResult;
    }
    this.cleanupInProgress = true;

    try {
      return await this.doCleanupOrphanedWorkspaces();
    } finally {
      this.cleanupInProgress = false;
    }
  }

  private async doCleanupOrphanedWorkspaces(): Promise<CleanupResult> {
    const emptyResult: CleanupResult = { removedCount: 0, failedPaths: [] };

    // Get registered worktrees
    let worktrees;
    try {
      worktrees = await this.gitClient.listWorktrees(this.projectRoot);
    } catch (error) {
      // Cannot determine registered worktrees - abort cleanup silently
      console.warn("Failed to list worktrees for cleanup:", error);
      return emptyResult;
    }

    // Build normalized path set for fast lookup
    const registeredPaths = new Set(worktrees.map((wt) => this.normalizeWorktreePath(wt.path)));

    // Read workspacesDir
    let entries;
    try {
      entries = await this.fileSystemLayer.readdir(this.workspacesDir);
    } catch {
      // workspacesDir doesn't exist yet or can't be read - nothing to clean
      return emptyResult;
    }

    const failedPaths: Array<{ path: string; error: string }> = [];
    let removedCount = 0;
    const normalizedWorkspacesDir = this.normalizeWorktreePath(this.workspacesDir);

    for (const entry of entries) {
      // Skip non-directories
      if (!entry.isDirectory) {
        continue;
      }

      // Skip symlinks (security)
      if (entry.isSymbolicLink) {
        continue;
      }

      // Build full path
      const fullPath = path.join(this.workspacesDir, entry.name);
      const normalizedFullPath = this.normalizeWorktreePath(fullPath);

      // Validate path stays within workspacesDir (security - path traversal)
      if (!normalizedFullPath.startsWith(normalizedWorkspacesDir)) {
        continue;
      }

      // Skip if registered
      if (registeredPaths.has(normalizedFullPath)) {
        continue;
      }

      // Re-check registration before delete (TOCTOU protection)
      try {
        const currentWorktrees = await this.gitClient.listWorktrees(this.projectRoot);
        const nowRegistered = currentWorktrees.some(
          (wt) => this.normalizeWorktreePath(wt.path) === normalizedFullPath
        );
        if (nowRegistered) {
          // Workspace was created concurrently - skip
          continue;
        }
      } catch {
        // Cannot verify - skip this entry to be safe
        continue;
      }

      // Delete the orphaned directory
      try {
        await this.fileSystemLayer.rm(fullPath, { recursive: true, force: true });
        removedCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to remove orphaned workspace ${fullPath}:`, errorMessage);
        failedPaths.push({ path: fullPath, error: errorMessage });
      }
    }

    return { removedCount, failedPaths };
  }
}
