/**
 * ProjectStore - Persists project configurations across sessions.
 *
 * Paths are normalized to canonical format (POSIX separators, lowercase on Windows)
 * both on save and on load. This auto-migrates old configs with native paths.
 */

import nodePath from "path";
import type { ProjectConfig } from "./types";
import { CURRENT_PROJECT_VERSION } from "./types";
import { ProjectStoreError, getErrorMessage } from "../errors";
import { projectDirName } from "../platform/paths";
import type { FileSystemLayer } from "../platform/filesystem";
import { Path } from "../platform/path";
import { normalizeGitUrl } from "./url-utils";

/**
 * Store for persisting project configurations.
 * Each project is stored in its own directory with a config.json file.
 */
export class ProjectStore {
  private readonly projectsDir: string;
  private readonly fs: FileSystemLayer;

  /**
   * Create a new ProjectStore.
   * @param projectsDir Directory to store project configurations
   * @param fs FileSystemLayer for filesystem operations
   */
  constructor(projectsDir: string, fs: FileSystemLayer) {
    this.projectsDir = projectsDir;
    this.fs = fs;
  }

  /**
   * Save a project configuration.
   * Creates or overwrites the config.json for the project.
   *
   * @param projectPath Absolute path to the project
   * @param options Optional save options (remoteUrl for cloned projects, configDir for custom config location)
   * @throws ProjectStoreError if save fails
   */
  async saveProject(projectPath: string, options?: SaveProjectOptions): Promise<void> {
    // Normalize the path to canonical format for consistent storage
    const normalizedPath = new Path(projectPath).toString();

    // Use custom configDir if provided (for cloned projects),
    // otherwise use path-based hash directory
    const projectDir = options?.configDir
      ? nodePath.join(this.projectsDir, options.configDir)
      : nodePath.join(this.projectsDir, projectDirName(normalizedPath));
    const configPath = nodePath.join(projectDir, "config.json");

    const config: ProjectConfig = {
      version: CURRENT_PROJECT_VERSION,
      path: normalizedPath,
      ...(options?.remoteUrl !== undefined && { remoteUrl: options.remoteUrl }),
    };

    try {
      // Ensure the directory exists (recursive is default)
      await this.fs.mkdir(projectDir);

      // Write the config file
      await this.fs.writeFile(configPath, JSON.stringify(config, null, 2));
    } catch (error: unknown) {
      throw new ProjectStoreError(`Failed to save project: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Load all saved projects.
   * Skips invalid entries (missing config.json, malformed JSON, etc.).
   *
   * @returns Array of project paths
   */
  async loadAllProjects(): Promise<readonly string[]> {
    const configs = await this.loadAllProjectConfigs();
    return configs.map((c) => c.path);
  }

  /**
   * Load all saved project configurations.
   * Skips invalid entries (missing config.json, malformed JSON, etc.).
   *
   * @returns Array of project configurations
   */
  async loadAllProjectConfigs(): Promise<readonly ProjectConfig[]> {
    const configs: ProjectConfig[] = [];

    try {
      // readdir throws ENOENT if directory doesn't exist
      const entries = await this.fs.readdir(this.projectsDir);

      for (const entry of entries) {
        if (!entry.isDirectory) {
          continue;
        }

        const configPath = nodePath.join(this.projectsDir, entry.name, "config.json");

        try {
          const content = await this.fs.readFile(configPath);
          const parsed: unknown = JSON.parse(content);

          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "path" in parsed &&
            typeof (parsed as Record<string, unknown>).path === "string"
          ) {
            // Normalize path on load - auto-migrates old native paths to canonical format
            const rawPath = (parsed as { path: string }).path;
            try {
              const normalizedPath = new Path(rawPath).toString();
              const rawRemoteUrl = (parsed as { remoteUrl?: string }).remoteUrl;

              const config: ProjectConfig = {
                version: (parsed as { version?: number }).version ?? 1,
                path: normalizedPath,
                ...(rawRemoteUrl !== undefined && { remoteUrl: rawRemoteUrl }),
              };
              configs.push(config);
            } catch {
              // Invalid path format - skip this entry
              continue;
            }
          }
        } catch {
          // Skip invalid entries (ENOENT, malformed JSON, etc.)
          continue;
        }
      }
    } catch {
      // Directory doesn't exist or other error - return empty array
      return [];
    }

    return configs;
  }

  /**
   * Find a project by its remote URL.
   * Uses URL normalization to match equivalent URLs.
   *
   * @param url Remote URL to search for
   * @returns Project path if found, undefined otherwise
   */
  async findByRemoteUrl(url: string): Promise<string | undefined> {
    const normalizedUrl = normalizeGitUrl(url);
    const configs = await this.loadAllProjectConfigs();

    for (const config of configs) {
      if (config.remoteUrl) {
        const configNormalizedUrl = normalizeGitUrl(config.remoteUrl);
        if (configNormalizedUrl === normalizedUrl) {
          return config.path;
        }
      }
    }

    return undefined;
  }

  /**
   * Remove a project configuration.
   * Removes config.json and the directory if empty.
   * Does not throw if project was not saved.
   *
   * @param projectPath Absolute path to the project
   */
  async removeProject(projectPath: string): Promise<void> {
    const dirName = projectDirName(projectPath);
    const projectDir = nodePath.join(this.projectsDir, dirName);
    const configPath = nodePath.join(projectDir, "config.json");

    try {
      // Remove config.json
      await this.fs.unlink(configPath);
    } catch {
      // Ignore if file doesn't exist
      return;
    }

    // Try to remove the workspaces subdirectory (only succeeds if empty)
    const workspacesDir = nodePath.join(projectDir, "workspaces");
    try {
      await this.fs.rm(workspacesDir);
    } catch {
      // ENOTEMPTY (workspaces exist) or ENOENT (doesn't exist) - that's fine
    }

    // Try to remove the project directory (only succeeds if empty)
    try {
      await this.fs.rm(projectDir);
    } catch {
      // ENOTEMPTY or ENOENT - that's fine
    }
  }

  /**
   * Completely remove a project directory including all contents.
   * Used for cloned projects when user wants to delete the local repository.
   *
   * For cloned projects (with remoteUrl), deletes the parent directory that
   * contains both the config.json and the git subdirectory.
   *
   * @param projectPath Absolute path to the project (gitPath for cloned projects)
   * @param options Optional deletion options
   * @param options.isClonedProject If true, treat as cloned project and delete parent directory
   * @throws ProjectStoreError if deletion fails
   */
  async deleteProjectDirectory(
    projectPath: string,
    options?: { isClonedProject?: boolean }
  ): Promise<void> {
    // Check if this is a cloned project either from options or by looking for config
    let isCloned = options?.isClonedProject;
    if (isCloned === undefined) {
      const config = await this.getProjectConfig(projectPath);
      isCloned = config?.remoteUrl !== undefined;
    }

    let dirToDelete: string;
    if (isCloned) {
      // Cloned project: config is in parent directory (URL-hashed directory)
      // projectPath is the gitPath like /projects/repo-abc123/repo/
      // We need to delete /projects/repo-abc123/
      const normalizedPath = new Path(projectPath).toString();
      dirToDelete = nodePath.dirname(normalizedPath);
    } else {
      // Local project: use path-hashed directory
      const dirName = projectDirName(projectPath);
      dirToDelete = nodePath.join(this.projectsDir, dirName);
    }

    try {
      await this.fs.rm(dirToDelete, { recursive: true, force: true });
    } catch (error: unknown) {
      throw new ProjectStoreError(`Failed to delete project directory: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Get the project configuration for a project path.
   * Returns undefined if no config exists.
   *
   * First tries the path-hashed directory (for local projects),
   * then scans all configs to find a matching path (for cloned projects
   * where config is stored in URL-hashed directory).
   *
   * @param projectPath Absolute path to the project
   * @returns Project configuration or undefined
   */
  async getProjectConfig(projectPath: string): Promise<ProjectConfig | undefined> {
    const normalizedPath = new Path(projectPath).toString();

    // First, try the standard path-hashed location (most common case)
    const dirName = projectDirName(normalizedPath);
    const projectDir = nodePath.join(this.projectsDir, dirName);
    const configPath = nodePath.join(projectDir, "config.json");

    try {
      const content = await this.fs.readFile(configPath);
      const parsed: unknown = JSON.parse(content);

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "path" in parsed &&
        typeof (parsed as Record<string, unknown>).path === "string"
      ) {
        const rawPath = (parsed as { path: string }).path;
        const rawRemoteUrl = (parsed as { remoteUrl?: string }).remoteUrl;

        const config: ProjectConfig = {
          version: (parsed as { version?: number }).version ?? 1,
          path: new Path(rawPath).toString(),
          ...(rawRemoteUrl !== undefined && { remoteUrl: rawRemoteUrl }),
        };
        return config;
      }
    } catch {
      // Config not found in standard location - try scanning all configs
    }

    // Fallback: scan all configs to find one with matching path
    // This handles cloned projects where config is in URL-hashed directory
    const allConfigs = await this.loadAllProjectConfigs();
    for (const config of allConfigs) {
      if (config.path === normalizedPath) {
        return config;
      }
    }

    return undefined;
  }
}

/**
 * Options for saving a project.
 */
export interface SaveProjectOptions {
  /** Remote URL if project was cloned from URL */
  remoteUrl?: string;
  /**
   * Custom config directory name (relative to projectsDir).
   * Used for cloned projects to store config inside the URL-hashed directory
   * instead of the default path-hashed directory.
   */
  configDir?: string;
}
