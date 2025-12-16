/**
 * GitWorktreeProvider - Implementation of IWorkspaceProvider using git worktrees.
 */

import path from "path";
import type { IGitClient } from "./git-client";
import type { IWorkspaceProvider } from "./workspace-provider";
import type { BaseInfo, CleanupResult, RemovalResult, UpdateBasesResult, Workspace } from "./types";
import { WorkspaceError } from "../errors";
import { sanitizeWorkspaceName } from "../platform/paths";
import { isValidMetadataKey } from "../../shared/api/types";
import type { FileSystemLayer } from "../platform/filesystem";
import type { IKeepFilesService } from "../keepfiles";

/**
 * Options for GitWorktreeProvider.
 */
export interface GitWorktreeProviderOptions {
  /**
   * Optional service for copying .keepfiles-configured files to new workspaces.
   * If not provided, no files are copied on workspace creation.
   */
  readonly keepFilesService?: IKeepFilesService;
}

/**
 * Implementation of IWorkspaceProvider using git worktrees.
 * Each workspace is a git worktree, allowing parallel work on different branches.
 */
export class GitWorktreeProvider implements IWorkspaceProvider {
  /** Git config prefix for workspace metadata */
  private static readonly METADATA_CONFIG_PREFIX = "codehydra";

  readonly projectRoot: string;
  private readonly gitClient: IGitClient;
  private readonly workspacesDir: string;
  private readonly fileSystemLayer: FileSystemLayer;
  private readonly keepFilesService: IKeepFilesService | undefined;
  private cleanupInProgress = false;

  /**
   * Apply base fallback to metadata if not present.
   * Fallback priority: config > branch > name
   */
  private applyBaseFallback(
    metadata: Record<string, string>,
    branch: string | null,
    name: string
  ): Record<string, string> {
    if (!metadata.base) {
      return { ...metadata, base: branch ?? name };
    }
    return metadata;
  }

  private constructor(
    projectRoot: string,
    gitClient: IGitClient,
    workspacesDir: string,
    fileSystemLayer: FileSystemLayer,
    options?: GitWorktreeProviderOptions
  ) {
    this.projectRoot = projectRoot;
    this.gitClient = gitClient;
    this.workspacesDir = workspacesDir;
    this.fileSystemLayer = fileSystemLayer;
    this.keepFilesService = options?.keepFilesService;
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
   * Check if a branch is currently checked out in any worktree.
   * @param branchName Name of the branch to check
   * @returns Object with checkedOut status and worktree path if found
   */
  private async isBranchCheckedOut(
    branchName: string
  ): Promise<{ checkedOut: boolean; worktreePath: string | null }> {
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);
    const worktree = worktrees.find((wt) => wt.branch === branchName);
    return {
      checkedOut: !!worktree,
      worktreePath: worktree?.path ?? null,
    };
  }

  /**
   * Factory method to create a GitWorktreeProvider.
   * Validates that the path is an absolute path to a git repository.
   *
   * @param projectRoot Absolute path to the git repository
   * @param gitClient Git client to use for operations
   * @param workspacesDir Directory where worktrees will be created (from PathProvider.getProjectWorkspacesDir)
   * @param fileSystemLayer FileSystemLayer for cleanup operations
   * @param options Optional configuration including keepFilesService
   * @returns Promise resolving to a new GitWorktreeProvider
   * @throws WorkspaceError if path is invalid or not a git repository
   */
  static async create(
    projectRoot: string,
    gitClient: IGitClient,
    workspacesDir: string,
    fileSystemLayer: FileSystemLayer,
    options?: GitWorktreeProviderOptions
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

    return new GitWorktreeProvider(projectRoot, gitClient, workspacesDir, fileSystemLayer, options);
  }

  async discover(): Promise<readonly Workspace[]> {
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);

    // Filter out the main worktree and map to Workspace objects with metadata
    const workspaces: Workspace[] = [];
    for (const wt of worktrees) {
      if (wt.isMain) continue;

      // Try to get metadata from git config, with fallback for base key
      let metadata: Record<string, string>;
      try {
        const configs = wt.branch
          ? await this.gitClient.getBranchConfigsByPrefix(
              this.projectRoot,
              wt.branch,
              GitWorktreeProvider.METADATA_CONFIG_PREFIX
            )
          : {};
        // Apply base fallback: config > branch > name
        metadata = this.applyBaseFallback({ ...configs }, wt.branch, wt.name);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.warn(`Failed to get metadata config for ${wt.name}: ${message}`);
        // Use fallback on error - only base key
        metadata = { base: wt.branch ?? wt.name };
      }

      workspaces.push({
        name: wt.name,
        path: wt.path,
        branch: wt.branch,
        metadata,
      });
    }
    return workspaces;
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

    // Check if branch already exists (local branches only)
    const branches = await this.gitClient.listBranches(this.projectRoot);
    const branchExists = branches.some((b) => b.name === name && !b.isRemote);

    let createdBranch = false;

    if (branchExists) {
      // Branch exists - baseBranch must match the branch name
      if (baseBranch !== name) {
        throw new WorkspaceError(
          `Branch '${name}' already exists. To create a workspace for it, select '${name}' as the base branch.`
        );
      }

      // Check if branch is already checked out in a worktree
      const { checkedOut, worktreePath: existingPath } = await this.isBranchCheckedOut(name);
      if (checkedOut) {
        throw new WorkspaceError(
          `Branch '${name}' is already checked out in worktree at '${existingPath}'`
        );
      }
      // Branch exists and not checked out - will use existing branch
    } else {
      // Branch doesn't exist - create it
      try {
        await this.gitClient.createBranch(this.projectRoot, name, baseBranch);
        createdBranch = true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error creating branch";
        throw new WorkspaceError(`Failed to create branch: ${message}`);
      }
    }

    // Create the worktree
    try {
      await this.gitClient.addWorktree(this.projectRoot, worktreePath, name);
    } catch (error: unknown) {
      // Rollback: only delete branch if we created it
      if (createdBranch) {
        try {
          await this.gitClient.deleteBranch(this.projectRoot, name);
        } catch {
          // Ignore rollback errors
        }
      }

      const message = error instanceof Error ? error.message : "Unknown error creating worktree";
      throw new WorkspaceError(`Failed to create worktree: ${message}`);
    }

    // Save base branch in git config (non-critical - log warning on failure)
    try {
      await this.gitClient.setBranchConfig(
        this.projectRoot,
        name,
        `${GitWorktreeProvider.METADATA_CONFIG_PREFIX}.base`,
        baseBranch
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.warn(`Failed to save base branch config for ${name}: ${message}`);
    }

    // Copy keep files from project root to new workspace (if service configured)
    // Note: Logging is handled by KeepFilesService via [keepfiles] logger
    if (this.keepFilesService) {
      try {
        await this.keepFilesService.copyToWorkspace(this.projectRoot, worktreePath);
      } catch {
        // Copy errors shouldn't fail workspace creation - already logged by KeepFilesService
      }
    }

    return {
      name,
      path: worktreePath,
      branch: name,
      metadata: { base: baseBranch },
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

    // Get the branch name before removal (also checks if worktree exists)
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);
    const worktree = worktrees.find(
      (wt) => this.normalizeWorktreePath(wt.path) === normalizedWorkspacePath
    );
    const branchName = worktree?.branch;

    // Idempotent: skip worktree removal if not registered
    if (worktree) {
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
    } else {
      // Worktree already removed - log and continue (idempotent)
      console.warn(`Worktree already removed, skipping: ${workspacePath}`);
    }

    // Optionally delete the branch (idempotent - check if exists first)
    let baseDeleted = false;
    if (deleteBase && branchName) {
      // Check if branch exists before attempting deletion
      const branches = await this.gitClient.listBranches(this.projectRoot);
      const branchExists = branches.some((b) => b.name === branchName && !b.isRemote);

      if (branchExists) {
        try {
          await this.gitClient.deleteBranch(this.projectRoot, branchName);
          baseDeleted = true;
        } catch {
          // Branch deletion can fail (e.g., if branch is checked out elsewhere)
          // This is not a critical error
          baseDeleted = false;
        }
      } else {
        // Branch already deleted - treat as success (idempotent)
        console.warn(`Branch already deleted, skipping: ${branchName}`);
        baseDeleted = true;
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

  /**
   * Get the branch name for a workspace path.
   * @throws WorkspaceError if workspace not found
   */
  private async getBranchForWorkspace(workspacePath: string): Promise<string> {
    const normalizedPath = this.normalizeWorktreePath(workspacePath);
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);
    const worktree = worktrees.find((wt) => this.normalizeWorktreePath(wt.path) === normalizedPath);

    if (!worktree) {
      throw new WorkspaceError(`Workspace not found: ${workspacePath}`, "WORKSPACE_NOT_FOUND");
    }

    if (!worktree.branch) {
      throw new WorkspaceError(
        `Cannot manage metadata for detached HEAD workspace: ${workspacePath}`,
        "DETACHED_HEAD"
      );
    }

    return worktree.branch;
  }

  /**
   * Set a metadata value for a workspace.
   * @param workspacePath Absolute path to the workspace
   * @param key Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
   * @param value Value to set, or null to delete the key
   * @throws WorkspaceError with code "INVALID_METADATA_KEY" if key format invalid
   */
  async setMetadata(workspacePath: string, key: string, value: string | null): Promise<void> {
    // Validate key format
    if (!isValidMetadataKey(key)) {
      throw new WorkspaceError(
        `Invalid metadata key '${key}': must start with a letter, contain only letters, digits, and hyphens, and not end with a hyphen`,
        "INVALID_METADATA_KEY"
      );
    }

    const branch = await this.getBranchForWorkspace(workspacePath);
    const configKey = `${GitWorktreeProvider.METADATA_CONFIG_PREFIX}.${key}`;

    if (value === null) {
      await this.gitClient.unsetBranchConfig(this.projectRoot, branch, configKey);
    } else {
      await this.gitClient.setBranchConfig(this.projectRoot, branch, configKey, value);
    }
  }

  /**
   * Get all metadata for a workspace.
   * Always includes `base` key (with fallback if not in config).
   * @param workspacePath Absolute path to the workspace
   * @returns Metadata record with at least `base` key
   */
  async getMetadata(workspacePath: string): Promise<Readonly<Record<string, string>>> {
    const normalizedPath = this.normalizeWorktreePath(workspacePath);
    const worktrees = await this.gitClient.listWorktrees(this.projectRoot);
    const worktree = worktrees.find((wt) => this.normalizeWorktreePath(wt.path) === normalizedPath);

    if (!worktree) {
      throw new WorkspaceError(`Workspace not found: ${workspacePath}`, "WORKSPACE_NOT_FOUND");
    }

    let metadata: Record<string, string>;
    if (worktree.branch) {
      const configs = await this.gitClient.getBranchConfigsByPrefix(
        this.projectRoot,
        worktree.branch,
        GitWorktreeProvider.METADATA_CONFIG_PREFIX
      );
      metadata = this.applyBaseFallback({ ...configs }, worktree.branch, worktree.name);
    } else {
      // Detached HEAD - only fallback base
      metadata = { base: worktree.name };
    }

    return metadata;
  }
}
