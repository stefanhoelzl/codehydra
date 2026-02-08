/**
 * ProjectScopedWorkspaceProvider - Adapter that wraps the global GitWorktreeProvider
 * to implement IWorkspaceProvider for backwards compatibility.
 *
 * Each instance is bound to a specific project. On construction, registers the project
 * with the global provider. dispose() unregisters it.
 *
 * This is a drop-in replacement for existing code that expects IWorkspaceProvider.
 */

import type { IWorkspaceProvider } from "./workspace-provider";
import type { GitWorktreeProvider } from "./git-worktree-provider";
import type { BaseInfo, CleanupResult, RemovalResult, UpdateBasesResult, Workspace } from "./types";
import type { Path } from "../platform/path";

/**
 * Per-project adapter that implements IWorkspaceProvider by delegating
 * all methods to a global GitWorktreeProvider with a bound projectRoot.
 *
 * Lifecycle:
 * - Construction: registers project with global provider
 * - dispose(): unregisters project from global provider
 */
export class ProjectScopedWorkspaceProvider implements IWorkspaceProvider {
  readonly projectRoot: Path;
  private readonly globalProvider: GitWorktreeProvider;
  private disposed = false;

  constructor(globalProvider: GitWorktreeProvider, projectRoot: Path, workspacesDir: Path) {
    this.globalProvider = globalProvider;
    this.projectRoot = projectRoot;

    // Register project with global provider on creation
    globalProvider.registerProject(projectRoot, workspacesDir);
  }

  /**
   * Unregister this project from the global provider.
   * After disposal, methods on this adapter should not be called.
   */
  dispose(): void {
    if (!this.disposed) {
      this.globalProvider.unregisterProject(this.projectRoot);
      this.disposed = true;
    }
  }

  async discover(): Promise<readonly Workspace[]> {
    return this.globalProvider.discover(this.projectRoot);
  }

  async listBases(): Promise<readonly BaseInfo[]> {
    return this.globalProvider.listBases(this.projectRoot);
  }

  async updateBases(): Promise<UpdateBasesResult> {
    return this.globalProvider.updateBases(this.projectRoot);
  }

  async createWorkspace(name: string, baseBranch: string): Promise<Workspace> {
    return this.globalProvider.createWorkspace(this.projectRoot, name, baseBranch);
  }

  async removeWorkspace(workspacePath: Path, deleteBase: boolean): Promise<RemovalResult> {
    return this.globalProvider.removeWorkspace(this.projectRoot, workspacePath, deleteBase);
  }

  async isDirty(workspacePath: Path): Promise<boolean> {
    return this.globalProvider.isDirty(workspacePath);
  }

  isMainWorkspace(workspacePath: Path): boolean {
    return this.globalProvider.isMainWorkspace(this.projectRoot, workspacePath);
  }

  async cleanupOrphanedWorkspaces(): Promise<CleanupResult> {
    return this.globalProvider.cleanupOrphanedWorkspaces(this.projectRoot);
  }

  async defaultBase(): Promise<string | undefined> {
    return this.globalProvider.defaultBase(this.projectRoot);
  }

  async setMetadata(workspacePath: Path, key: string, value: string | null): Promise<void> {
    // Ensure workspace is registered for metadata resolution (only if not disposed).
    // This handles cases where workspaces exist in git state but discover() hasn't been called yet.
    if (!this.disposed) {
      this.globalProvider.ensureWorkspaceRegistered(workspacePath, this.projectRoot);
    }
    return this.globalProvider.setMetadata(workspacePath, key, value);
  }

  async getMetadata(workspacePath: Path): Promise<Readonly<Record<string, string>>> {
    // Ensure workspace is registered for metadata resolution (only if not disposed).
    if (!this.disposed) {
      this.globalProvider.ensureWorkspaceRegistered(workspacePath, this.projectRoot);
    }
    return this.globalProvider.getMetadata(workspacePath);
  }
}
