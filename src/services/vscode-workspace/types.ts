/**
 * Types for WorkspaceFileService.
 *
 * WorkspaceFileService creates and manages .code-workspace files for
 * per-workspace VS Code settings.
 */

import type { Path } from "../platform/path";

/**
 * VS Code workspace file structure.
 * @see https://code.visualstudio.com/docs/editor/multi-root-workspaces#_workspace-file-schema
 */
export interface CodeWorkspaceFile {
  readonly folders: readonly WorkspaceFolder[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly extensions?: WorkspaceExtensions;
  readonly launch?: unknown;
  readonly tasks?: unknown;
}

/**
 * Folder entry in a workspace file.
 */
export interface WorkspaceFolder {
  /** Relative or absolute path to the folder */
  readonly path: string;
  /** Optional display name */
  readonly name?: string;
}

/**
 * Extension recommendations for a workspace.
 */
export interface WorkspaceExtensions {
  readonly recommendations?: readonly string[];
  readonly unwantedRecommendations?: readonly string[];
}

/**
 * Configuration for workspace file generation.
 */
export interface WorkspaceFileConfig {
  /** Default settings to include in new workspace files */
  readonly defaultSettings: Readonly<Record<string, unknown>>;
  /** Extension recommendations */
  readonly recommendedExtensions?: readonly string[];
}

/**
 * Service for managing .code-workspace files.
 */
export interface IWorkspaceFileService {
  /**
   * Ensure a workspace file exists for a workspace.
   * Creates one with defaults if missing.
   *
   * @param workspacePath - Absolute path to the workspace folder
   * @param projectWorkspacesDir - Directory containing all workspace folders and files
   * @param agentSettings - Agent-specific settings to include
   * @returns Path to the .code-workspace file
   */
  ensureWorkspaceFile(
    workspacePath: Path,
    projectWorkspacesDir: Path,
    agentSettings?: Readonly<Record<string, unknown>>
  ): Promise<Path>;

  /**
   * Create a new workspace file.
   *
   * @param workspacePath - Absolute path to the workspace folder
   * @param projectWorkspacesDir - Directory containing all workspace folders and files
   * @param agentSettings - Agent-specific settings to include
   * @returns Path to the created .code-workspace file
   */
  createWorkspaceFile(
    workspacePath: Path,
    projectWorkspacesDir: Path,
    agentSettings?: Readonly<Record<string, unknown>>
  ): Promise<Path>;

  /**
   * Get the path where a workspace file would be created.
   *
   * @param workspaceName - Name of the workspace
   * @param projectWorkspacesDir - Directory containing all workspace folders and files
   * @returns Path to the .code-workspace file
   */
  getWorkspaceFilePath(workspaceName: string, projectWorkspacesDir: Path): Path;
}
