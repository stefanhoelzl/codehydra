/**
 * GitWorktreeProvider - Global singleton managing git worktree operations across all projects.
 *
 * Unlike the per-project pattern, this provider manages multiple projects through internal
 * registries. Methods that previously used a bound projectRoot now accept it as a parameter.
 * Metadata methods resolve projectRoot from the workspace registry automatically.
 *
 * Use ProjectScopedWorkspaceProvider as an adapter to get back the IWorkspaceProvider interface
 * for backwards compatibility with existing call sites.
 */

import type { IGitClient } from "./git-client";
import { ProjectScopedWorkspaceProvider } from "./project-scoped-provider";
import type { BaseInfo, CleanupResult, RemovalResult, UpdateBasesResult, Workspace } from "./types";
import { WorkspaceError, getErrorMessage } from "../errors";
import { sanitizeWorkspaceName } from "../platform/paths";
import { isValidMetadataKey } from "../../shared/api/types";
import type { FileSystemLayer } from "../platform/filesystem";
import type { IKeepFilesService } from "../keepfiles";
import type { Logger } from "../logging";
import { Path } from "../platform/path";

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
 * Internal state for a registered project.
 */
interface ProjectRegistration {
  readonly workspacesDir: Path;
  readonly keepFilesService: IKeepFilesService | undefined;
  cleanupInProgress: boolean;
}

/**
 * Global provider managing git worktree operations across all projects.
 *
 * Maintains two internal registries:
 * - Project registry: Maps projectRoot -> { workspacesDir, keepFilesService }
 * - Workspace registry: Maps workspacePath -> projectRoot (for metadata resolution)
 *
 * Does NOT implement IWorkspaceProvider directly. Use ProjectScopedWorkspaceProvider
 * as an adapter for backwards compatibility.
 *
 * All paths are handled using the Path class for normalized, cross-platform handling.
 */
export class GitWorktreeProvider {
  /** Git config prefix for workspace metadata */
  private static readonly METADATA_CONFIG_PREFIX = "codehydra";

  private readonly gitClient: IGitClient;
  private readonly fileSystemLayer: FileSystemLayer;
  private readonly logger: Logger;

  /** Map of normalized project root strings to project registration data */
  private readonly projectRegistry: Map<string, ProjectRegistration> = new Map();

  /** Map of normalized workspace path strings to project root Path (for metadata resolution) */
  private readonly workspaceRegistry: Map<string, Path> = new Map();

  /**
   * Check if error is a Windows long-path related error from git.
   * These errors occur when git worktree remove can't delete directories
   * with paths > 260 characters.
   */
  private isWindowsLongPathError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes("filename too long") ||
      (message.includes("directory not empty") && message.includes("failed to delete"))
    );
  }

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

  constructor(gitClient: IGitClient, fileSystemLayer: FileSystemLayer, logger: Logger) {
    this.gitClient = gitClient;
    this.fileSystemLayer = fileSystemLayer;
    this.logger = logger;
  }

  /**
   * Factory method for backwards compatibility with existing tests and call sites.
   * Creates a standalone global provider, validates the repository, registers the project,
   * and returns a ProjectScopedWorkspaceProvider adapter implementing IWorkspaceProvider.
   *
   * For production use where a shared global provider is needed, construct
   * GitWorktreeProvider + ProjectScopedWorkspaceProvider directly.
   *
   * @param projectRoot Absolute path to the git repository
   * @param gitClient Git client to use for operations
   * @param workspacesDir Directory where worktrees will be created
   * @param fileSystemLayer FileSystemLayer for cleanup operations
   * @param logger Logger for worktree operations
   * @param options Optional configuration including keepFilesService
   * @returns Promise resolving to a ProjectScopedWorkspaceProvider (implements IWorkspaceProvider)
   * @throws WorkspaceError if path is invalid or not a git repository
   */
  static async create(
    projectRoot: Path,
    gitClient: IGitClient,
    workspacesDir: Path,
    fileSystemLayer: FileSystemLayer,
    logger: Logger,
    options?: GitWorktreeProviderOptions
  ): Promise<ProjectScopedWorkspaceProvider> {
    const globalProvider = new GitWorktreeProvider(gitClient, fileSystemLayer, logger);
    await globalProvider.validateRepository(projectRoot);

    return new ProjectScopedWorkspaceProvider(globalProvider, projectRoot, workspacesDir, options);
  }

  /**
   * Register a project with this global provider.
   * Must be called before any operations on the project.
   *
   * @param projectRoot Absolute path to the git repository
   * @param workspacesDir Directory where worktrees are created
   * @param options Optional configuration including keepFilesService
   */
  registerProject(
    projectRoot: Path,
    workspacesDir: Path,
    options?: GitWorktreeProviderOptions
  ): void {
    this.projectRegistry.set(projectRoot.toString(), {
      workspacesDir,
      keepFilesService: options?.keepFilesService,
      cleanupInProgress: false,
    });
  }

  /**
   * Unregister a project from this global provider.
   * Removes all workspace registry entries for this project.
   *
   * @param projectRoot Absolute path to the git repository
   */
  unregisterProject(projectRoot: Path): void {
    const projectRootStr = projectRoot.toString();
    this.projectRegistry.delete(projectRootStr);

    // Remove all workspace entries for this project
    for (const [workspaceKey, registeredRoot] of this.workspaceRegistry) {
      if (registeredRoot.toString() === projectRootStr) {
        this.workspaceRegistry.delete(workspaceKey);
      }
    }
  }

  /**
   * Get the project registration for a project root.
   * @throws WorkspaceError if project is not registered
   */
  private getProjectRegistration(projectRoot: Path): ProjectRegistration {
    const registration = this.projectRegistry.get(projectRoot.toString());
    if (!registration) {
      throw new WorkspaceError(
        `Project not registered: ${projectRoot.toString()}. Call registerProject() first.`
      );
    }
    return registration;
  }

  /**
   * Resolve project root from workspace path using the workspace registry.
   * @throws WorkspaceError if workspace is not registered
   */
  private resolveProjectRoot(workspacePath: Path): Path {
    const projectRoot = this.workspaceRegistry.get(workspacePath.toString());
    if (!projectRoot) {
      throw new WorkspaceError(
        `Workspace not registered: ${workspacePath.toString()}. ` +
          `The project may not be open or the workspace was not discovered.`
      );
    }
    return projectRoot;
  }

  /**
   * Register a workspace in the workspace registry.
   * Called internally when workspaces are discovered or created, and by
   * ProjectScopedWorkspaceProvider to ensure workspace paths are registered
   * before metadata operations.
   *
   * @param workspacePath Absolute path to the workspace
   * @param projectRoot Project root that owns this workspace
   */
  ensureWorkspaceRegistered(workspacePath: Path, projectRoot: Path): void {
    this.workspaceRegistry.set(workspacePath.toString(), projectRoot);
  }

  /**
   * Validate that a path is a git repository root.
   *
   * @param projectRoot Absolute path to validate
   * @throws WorkspaceError if path is invalid or not a git repository
   */
  async validateRepository(projectRoot: Path): Promise<void> {
    try {
      const isRoot = await this.gitClient.isRepositoryRoot(projectRoot);
      if (!isRoot) {
        throw new WorkspaceError(
          `Path is not a git repository root: ${projectRoot.toString()}. ` +
            `Please select the root directory of your git repository.`
        );
      }
    } catch (error: unknown) {
      if (error instanceof WorkspaceError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error checking repository";
      throw new WorkspaceError(`Failed to validate repository: ${message}`);
    }
  }

  /**
   * Check if a branch is currently checked out in any worktree.
   * @param projectRoot Root of the git repository
   * @param branchName Name of the branch to check
   * @returns Object with checkedOut status and worktree path if found
   */
  private async isBranchCheckedOut(
    projectRoot: Path,
    branchName: string
  ): Promise<{ checkedOut: boolean; worktreePath: Path | null }> {
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const worktree = worktrees.find((wt) => wt.branch === branchName);
    return {
      checkedOut: !!worktree,
      worktreePath: worktree?.path ?? null,
    };
  }

  async discover(projectRoot: Path): Promise<readonly Workspace[]> {
    const worktrees = await this.gitClient.listWorktrees(projectRoot);

    // Filter out the main worktree and map to Workspace objects with metadata
    const workspaces: Workspace[] = [];
    for (const wt of worktrees) {
      if (wt.isMain) continue;

      // Register workspace in the workspace registry for metadata resolution
      this.ensureWorkspaceRegistered(wt.path, projectRoot);

      // Try to get metadata from git config, with fallback for base key
      let metadata: Record<string, string>;
      try {
        const configs = wt.branch
          ? await this.gitClient.getBranchConfigsByPrefix(
              projectRoot,
              wt.branch,
              GitWorktreeProvider.METADATA_CONFIG_PREFIX
            )
          : {};
        // Apply base fallback: config > branch > name
        metadata = this.applyBaseFallback({ ...configs }, wt.branch, wt.name);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        this.logger.warn("Failed to get metadata config", { workspace: wt.name, error: message });
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

  async listBases(projectRoot: Path): Promise<readonly BaseInfo[]> {
    const branches = await this.gitClient.listBranches(projectRoot);
    const worktrees = await this.gitClient.listWorktrees(projectRoot);

    // Build set of branches that have worktrees
    const branchesWithWorktrees = new Set<string>();
    for (const wt of worktrees) {
      if (wt.branch) {
        branchesWithWorktrees.add(wt.branch);
      }
    }

    // Build set of local branch names
    const localBranches = new Set<string>();
    for (const branch of branches) {
      if (!branch.isRemote) {
        localBranches.add(branch.name);
      }
    }

    // Compute derives for remote branches with deduplication
    // For each derivable name, track which remote branch should get the derives field
    // Prefer 'origin' remote, then alphabetically first
    const derivesMap = this.computeRemoteDerives(branches, localBranches);

    // Build result with derives and base
    const result: BaseInfo[] = [];

    for (const branch of branches) {
      if (branch.isRemote) {
        // Remote branch: derives if no local counterpart and we're the preferred remote
        const derives = derivesMap.get(branch.name);
        const baseInfo: BaseInfo = {
          name: branch.name,
          isRemote: true,
          base: branch.name, // Remote's base is itself
        };
        if (derives !== undefined) {
          result.push({ ...baseInfo, derives });
        } else {
          result.push(baseInfo);
        }
      } else {
        // Local branch: derives if no worktree exists
        const hasWorktree = branchesWithWorktrees.has(branch.name);

        // Compute base: codehydra.base config or matching origin/* branch
        let base: string | undefined;
        try {
          const configBase = await this.gitClient.getBranchConfig(
            projectRoot,
            branch.name,
            `${GitWorktreeProvider.METADATA_CONFIG_PREFIX}.base`
          );
          if (configBase) {
            base = configBase;
          } else {
            // Check for matching origin/* branch
            const originBranch = `origin/${branch.name}`;
            const hasOriginBranch = branches.some((b) => b.isRemote && b.name === originBranch);
            if (hasOriginBranch) {
              base = originBranch;
            }
          }
        } catch {
          // Ignore config errors, base stays undefined
        }

        // Build BaseInfo with conditional optional properties
        const baseInfo: BaseInfo = {
          name: branch.name,
          isRemote: false,
        };
        if (base !== undefined) {
          result.push(
            hasWorktree ? { ...baseInfo, base } : { ...baseInfo, base, derives: branch.name }
          );
        } else {
          result.push(hasWorktree ? baseInfo : { ...baseInfo, derives: branch.name });
        }
      }
    }

    return result;
  }

  /**
   * Compute derives for remote branches with deduplication across remotes.
   * For branches that exist on multiple remotes (e.g., origin/feature, upstream/feature),
   * only one should get the derives field. Preference: 'origin' first, then alphabetically.
   *
   * @returns Map from full remote branch name to derives value (or undefined if no derives)
   */
  private computeRemoteDerives(
    branches: readonly { name: string; isRemote: boolean }[],
    localBranches: Set<string>
  ): Map<string, string | undefined> {
    // Map: derivable name -> array of [remote, fullBranchName]
    const derivableToRemotes = new Map<string, Array<[string, string]>>();

    for (const branch of branches) {
      if (!branch.isRemote) continue;

      // Extract remote prefix and branch name
      // e.g., "origin/feature" -> remote="origin", branchName="feature"
      // e.g., "origin/feature/login" -> remote="origin", branchName="feature/login"
      const slashIndex = branch.name.indexOf("/");
      if (slashIndex === -1) continue;

      const remote = branch.name.substring(0, slashIndex);
      const branchName = branch.name.substring(slashIndex + 1);

      // Skip if local branch exists
      if (localBranches.has(branchName)) continue;

      if (!derivableToRemotes.has(branchName)) {
        derivableToRemotes.set(branchName, []);
      }
      derivableToRemotes.get(branchName)!.push([remote, branch.name]);
    }

    // Build result map: prefer 'origin', then alphabetically first
    const result = new Map<string, string | undefined>();

    for (const [branchName, remotes] of derivableToRemotes) {
      // Sort: 'origin' first, then alphabetically
      remotes.sort(([a], [b]) => {
        if (a === "origin") return -1;
        if (b === "origin") return 1;
        return a.localeCompare(b);
      });

      // First one gets derives, others get undefined
      for (let i = 0; i < remotes.length; i++) {
        const [, fullBranchName] = remotes[i]!;
        result.set(fullBranchName, i === 0 ? branchName : undefined);
      }
    }

    return result;
  }

  async updateBases(projectRoot: Path): Promise<UpdateBasesResult> {
    const remotes = await this.gitClient.listRemotes(projectRoot);

    const fetchedRemotes: string[] = [];
    const failedRemotes: { remote: string; error: string }[] = [];

    for (const remote of remotes) {
      try {
        await this.gitClient.fetch(projectRoot, remote);
        fetchedRemotes.push(remote);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Unknown fetch error";
        failedRemotes.push({ remote, error: errorMessage });
      }
    }

    return { fetchedRemotes, failedRemotes };
  }

  async createWorkspace(projectRoot: Path, name: string, baseBranch: string): Promise<Workspace> {
    const registration = this.getProjectRegistration(projectRoot);

    // Sanitize the name for filesystem (/ -> %)
    const sanitizedName = sanitizeWorkspaceName(name);

    // Compute the worktree path using the configured workspaces directory
    const worktreePath = new Path(registration.workspacesDir, sanitizedName);

    // Check if branch already exists (local branches only)
    const branches = await this.gitClient.listBranches(projectRoot);
    const branchExists = branches.some((b) => b.name === name && !b.isRemote);

    let createdBranch = false;

    if (branchExists) {
      // Branch exists - check if already checked out in a worktree
      const { checkedOut, worktreePath: existingPath } = await this.isBranchCheckedOut(
        projectRoot,
        name
      );
      if (checkedOut) {
        throw new WorkspaceError(
          `Branch '${name}' is already checked out in worktree at '${existingPath?.toString()}'`
        );
      }
      // Branch exists and not checked out - will use existing branch
      // The baseBranch is saved in config for tracking purposes regardless of whether it matches
    } else {
      // Branch doesn't exist - create it
      try {
        await this.gitClient.createBranch(projectRoot, name, baseBranch);
        createdBranch = true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error creating branch";
        throw new WorkspaceError(`Failed to create branch: ${message}`);
      }
    }

    // Create the worktree
    try {
      await this.gitClient.addWorktree(projectRoot, worktreePath, name);
    } catch (error: unknown) {
      // Rollback: only delete branch if we created it
      if (createdBranch) {
        try {
          await this.gitClient.deleteBranch(projectRoot, name);
        } catch {
          // Ignore rollback errors
        }
      }

      const message = error instanceof Error ? error.message : "Unknown error creating worktree";
      throw new WorkspaceError(`Failed to create worktree: ${message}`);
    }

    // Register workspace in the workspace registry
    this.ensureWorkspaceRegistered(worktreePath, projectRoot);

    // Save base branch in git config (non-critical - log warning on failure)
    try {
      await this.gitClient.setBranchConfig(
        projectRoot,
        name,
        `${GitWorktreeProvider.METADATA_CONFIG_PREFIX}.base`,
        baseBranch
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn("Failed to save base branch config", { branch: name, error: message });
    }

    // Copy keep files from project root to new workspace (if service configured)
    // Note: Logging is handled by KeepFilesService via [keepfiles] logger
    // TODO: Update IKeepFilesService to accept Path once that service is migrated
    if (registration.keepFilesService) {
      try {
        await registration.keepFilesService.copyToWorkspace(
          projectRoot.toString(),
          worktreePath.toString()
        );
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

  async removeWorkspace(
    projectRoot: Path,
    workspacePath: Path,
    deleteBase: boolean
  ): Promise<RemovalResult> {
    // Cannot remove main worktree - use Path.equals() for proper comparison
    if (workspacePath.equals(projectRoot)) {
      throw new WorkspaceError("Cannot remove the main worktree");
    }

    // Get the branch name before removal (also checks if worktree exists)
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const worktree = worktrees.find((wt) => wt.path.equals(workspacePath));
    // If worktree not found (retry after partial failure), extract branch from path
    // For git worktrees, the last path segment is the branch name
    // Note: Use ternary (not ??) to preserve null for detached HEAD workspaces
    const branchName = worktree ? worktree.branch : workspacePath.basename;

    // Step 1: Try to remove worktree, save error if it fails
    // We save the error to throw later, after attempting branch deletion
    let worktreeError: Error | null = null;
    if (worktree) {
      try {
        await this.gitClient.removeWorktree(projectRoot, workspacePath);
      } catch (error) {
        const err = error as Error;
        // On Windows, git may fail to delete directories with long paths (>260 chars)
        // Error messages: "Filename too long" or "Directory not empty"
        // Fall back to manual deletion + prune
        if (this.isWindowsLongPathError(err)) {
          try {
            await this.fileSystemLayer.rm(workspacePath, { recursive: true, force: true });
            await this.gitClient.pruneWorktrees(projectRoot);
            this.logger.info("Removed workspace via fallback", { path: workspacePath.toString() });
          } catch {
            // Fallback also failed - save original error
            worktreeError = err;
          }
        } else {
          worktreeError = err;
        }
      }
    }

    // Step 2: Delete the branch (always attempt if requested)
    // This ensures branch is deleted even if worktree removal failed
    // (e.g., due to Windows file locks - directory cleanup happens at startup)
    let baseDeleted = false;
    if (deleteBase && branchName) {
      // Check if branch exists before attempting deletion
      const branches = await this.gitClient.listBranches(projectRoot);
      const branchExists = branches.some((b) => b.name === branchName && !b.isRemote);

      if (branchExists) {
        try {
          await this.gitClient.deleteBranch(projectRoot, branchName);
          baseDeleted = true;
        } catch (error) {
          // Only throw branch error if there was no worktree error
          // (worktree error takes precedence)
          if (!worktreeError) {
            throw error;
          }
          baseDeleted = false;
        }
      } else {
        // Branch already deleted - treat as success (idempotent)
        this.logger.debug("Branch already deleted, skipping", { branch: branchName });
        baseDeleted = true;
      }
    }

    // Step 3: Throw saved worktree error (after branch deletion attempted)
    if (worktreeError) {
      throw worktreeError;
    }

    // Prune stale worktree entries
    await this.gitClient.pruneWorktrees(projectRoot);

    // Remove workspace from registry
    this.workspaceRegistry.delete(workspacePath.toString());

    return {
      workspaceRemoved: true,
      baseDeleted,
    };
  }

  async isDirty(workspacePath: Path): Promise<boolean> {
    const status = await this.gitClient.getStatus(workspacePath);
    return status.isDirty;
  }

  isMainWorkspace(projectRoot: Path, workspacePath: Path): boolean {
    // Use Path.equals() for proper normalized comparison
    return workspacePath.equals(projectRoot);
  }

  /**
   * Returns the default base branch for creating new workspaces.
   * Prefers remote branches over local to ensure proper tracking.
   * Check order: origin/main -> main -> origin/master -> master
   *
   * @param projectRoot Root of the git repository
   * @returns Promise resolving to the default base branch, or undefined if none found
   */
  async defaultBase(projectRoot: Path): Promise<string | undefined> {
    try {
      const bases = await this.listBases(projectRoot);
      const branchNames = new Set(bases.map((b) => b.name));

      // Prefer remote branches for proper tracking
      if (branchNames.has("origin/main")) {
        return "origin/main";
      }
      if (branchNames.has("main")) {
        return "main";
      }
      if (branchNames.has("origin/master")) {
        return "origin/master";
      }
      if (branchNames.has("master")) {
        return "master";
      }
      return undefined;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn("Failed to get default base branch", { error: message });
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
   * @param projectRoot Root of the git repository
   * @returns Result indicating how many directories were removed and any failures
   */
  async cleanupOrphanedWorkspaces(projectRoot: Path): Promise<CleanupResult> {
    const emptyResult: CleanupResult = { removedCount: 0, failedPaths: [] };
    const registration = this.projectRegistry.get(projectRoot.toString());
    if (!registration) {
      return emptyResult;
    }

    // Concurrency guard - only one cleanup at a time per project
    if (registration.cleanupInProgress) {
      return emptyResult;
    }
    registration.cleanupInProgress = true;

    try {
      return await this.doCleanupOrphanedWorkspaces(projectRoot, registration.workspacesDir);
    } finally {
      registration.cleanupInProgress = false;
    }
  }

  private async doCleanupOrphanedWorkspaces(
    projectRoot: Path,
    workspacesDir: Path
  ): Promise<CleanupResult> {
    const emptyResult: CleanupResult = { removedCount: 0, failedPaths: [] };

    // Get registered worktrees
    let worktrees;
    try {
      worktrees = await this.gitClient.listWorktrees(projectRoot);
    } catch (error) {
      // Cannot determine registered worktrees - abort cleanup silently
      this.logger.warn("Failed to list worktrees for cleanup", { error: getErrorMessage(error) });
      return emptyResult;
    }

    // Build normalized path set for fast lookup (using Path.toString())
    const registeredPaths = new Set(worktrees.map((wt) => wt.path.toString()));

    // Read workspacesDir
    let entries;
    try {
      entries = await this.fileSystemLayer.readdir(workspacesDir);
    } catch {
      // workspacesDir doesn't exist yet or can't be read - nothing to clean
      return emptyResult;
    }

    const failedPaths: Array<{ path: string; error: string }> = [];
    let removedCount = 0;

    for (const entry of entries) {
      // Skip non-directories
      if (!entry.isDirectory) {
        continue;
      }

      // Skip symlinks (security)
      if (entry.isSymbolicLink) {
        continue;
      }

      // Build full path using Path
      const fullPath = new Path(workspacesDir, entry.name);

      // Validate path stays within workspacesDir (security - path traversal)
      // Use isChildOf for proper containment check
      if (!fullPath.isChildOf(workspacesDir) && !fullPath.equals(workspacesDir)) {
        continue;
      }

      // Skip if registered
      if (registeredPaths.has(fullPath.toString())) {
        continue;
      }

      // Re-check registration before delete (TOCTOU protection)
      try {
        const currentWorktrees = await this.gitClient.listWorktrees(projectRoot);
        const nowRegistered = currentWorktrees.some((wt) => wt.path.equals(fullPath));
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
        this.logger.info("Removed orphaned workspace", { path: fullPath.toString() });
        removedCount++;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        this.logger.warn("Failed to remove orphaned workspace", {
          path: fullPath.toString(),
          error: errorMessage,
        });
        failedPaths.push({ path: fullPath.toString(), error: errorMessage });
      }
    }

    return { removedCount, failedPaths };
  }

  /**
   * Get the branch name for a workspace path.
   * Resolves projectRoot from the workspace registry.
   * @throws WorkspaceError if workspace not found
   */
  private async getBranchForWorkspace(projectRoot: Path, workspacePath: Path): Promise<string> {
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const worktree = worktrees.find((wt) => wt.path.equals(workspacePath));

    if (!worktree) {
      throw new WorkspaceError(
        `Workspace not found: ${workspacePath.toString()}`,
        "WORKSPACE_NOT_FOUND"
      );
    }

    if (!worktree.branch) {
      throw new WorkspaceError(
        `Cannot manage metadata for detached HEAD workspace: ${workspacePath.toString()}`,
        "DETACHED_HEAD"
      );
    }

    return worktree.branch;
  }

  /**
   * Set a metadata value for a workspace.
   * Resolves projectRoot from workspace registry automatically.
   *
   * @param workspacePath Absolute path to the workspace
   * @param key Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
   * @param value Value to set, or null to delete the key
   * @throws WorkspaceError with code "INVALID_METADATA_KEY" if key format invalid
   */
  async setMetadata(workspacePath: Path, key: string, value: string | null): Promise<void> {
    // Validate key format
    if (!isValidMetadataKey(key)) {
      throw new WorkspaceError(
        `Invalid metadata key '${key}': must start with a letter, contain only letters, digits, and hyphens, and not end with a hyphen`,
        "INVALID_METADATA_KEY"
      );
    }

    const projectRoot = this.resolveProjectRoot(workspacePath);
    const branch = await this.getBranchForWorkspace(projectRoot, workspacePath);
    const configKey = `${GitWorktreeProvider.METADATA_CONFIG_PREFIX}.${key}`;

    if (value === null) {
      await this.gitClient.unsetBranchConfig(projectRoot, branch, configKey);
    } else {
      await this.gitClient.setBranchConfig(projectRoot, branch, configKey, value);
    }
  }

  /**
   * Get all metadata for a workspace.
   * Resolves projectRoot from workspace registry automatically.
   * Always includes `base` key (with fallback if not in config).
   *
   * @param workspacePath Absolute path to the workspace
   * @returns Metadata record with at least `base` key
   */
  async getMetadata(workspacePath: Path): Promise<Readonly<Record<string, string>>> {
    const projectRoot = this.resolveProjectRoot(workspacePath);
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const worktree = worktrees.find((wt) => wt.path.equals(workspacePath));

    if (!worktree) {
      throw new WorkspaceError(
        `Workspace not found: ${workspacePath.toString()}`,
        "WORKSPACE_NOT_FOUND"
      );
    }

    let metadata: Record<string, string>;
    if (worktree.branch) {
      const configs = await this.gitClient.getBranchConfigsByPrefix(
        projectRoot,
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
