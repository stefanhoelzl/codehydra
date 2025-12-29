/**
 * Abstract interface for workspace operations.
 * This abstraction allows different workspace strategies
 * (e.g., git worktrees, plain directories, docker containers).
 */

import type { Path } from "../platform/path";
import type { BaseInfo, CleanupResult, RemovalResult, UpdateBasesResult, Workspace } from "./types";

/**
 * Interface for workspace operations.
 * Uses domain terms (workspace, base) rather than git-specific terms.
 * All path parameters use the Path class for normalized, cross-platform handling.
 */
export interface IWorkspaceProvider {
  /**
   * The root path of the project (normalized Path).
   */
  readonly projectRoot: Path;

  /**
   * Discover all existing workspaces.
   * @returns Promise resolving to array of workspace information
   * @throws WorkspaceError if discovery fails
   */
  discover(): Promise<readonly Workspace[]>;

  /**
   * List all available bases for creating new workspaces.
   * @returns Promise resolving to array of base information
   * @throws WorkspaceError if listing fails
   */
  listBases(): Promise<readonly BaseInfo[]>;

  /**
   * Update available bases (e.g., fetch from remotes).
   * @returns Promise resolving to update result with success/failure per remote
   */
  updateBases(): Promise<UpdateBasesResult>;

  /**
   * Create a new workspace based on a branch/ref.
   * @param name Name for the new workspace
   * @param baseBranch Branch to base the workspace on
   * @returns Promise resolving to the created workspace
   * @throws WorkspaceError if creation fails
   */
  createWorkspace(name: string, baseBranch: string): Promise<Workspace>;

  /**
   * Remove a workspace.
   * @param workspacePath Absolute path to the workspace
   * @param deleteBase Whether to delete the associated base (branch)
   * @returns Promise resolving to removal result
   * @throws WorkspaceError if removal fails or path is the main workspace
   */
  removeWorkspace(workspacePath: Path, deleteBase: boolean): Promise<RemovalResult>;

  /**
   * Check if a workspace has uncommitted changes.
   * @param workspacePath Absolute path to the workspace
   * @returns Promise resolving to true if workspace has uncommitted changes
   * @throws WorkspaceError if check fails
   */
  isDirty(workspacePath: Path): Promise<boolean>;

  /**
   * Check if a path is the main (non-removable) workspace.
   * @param workspacePath Absolute path to check
   * @returns true if the path is the main workspace
   */
  isMainWorkspace(workspacePath: Path): boolean;

  /**
   * Cleanup orphaned workspace directories (optional).
   * Not all providers need this - only those that can have orphaned directories
   * (e.g., when git worktree remove unregisters but fails to delete the directory).
   *
   * @returns Promise resolving to cleanup result with count and any failures
   */
  cleanupOrphanedWorkspaces?(): Promise<CleanupResult>;

  /**
   * Returns the default base branch for creating new workspaces.
   * Checks for "main" first, then "master". Returns undefined if neither exists.
   *
   * @returns Promise resolving to "main", "master", or undefined
   */
  defaultBase(): Promise<string | undefined>;

  /**
   * Set a metadata value for a workspace.
   * @param workspacePath Absolute path to the workspace
   * @param key Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
   * @param value Value to set, or null to delete the key
   * @throws WorkspaceError with code "INVALID_METADATA_KEY" if key format invalid
   */
  setMetadata(workspacePath: Path, key: string, value: string | null): Promise<void>;

  /**
   * Get all metadata for a workspace.
   * Always includes `base` key (with fallback if not in config).
   * @param workspacePath Absolute path to the workspace
   * @returns Metadata record with at least `base` key
   */
  getMetadata(workspacePath: Path): Promise<Readonly<Record<string, string>>>;
}
