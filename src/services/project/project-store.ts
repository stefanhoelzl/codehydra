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
  private readonly remotesDir: string | undefined;

  /**
   * Create a new ProjectStore.
   * @param projectsDir Directory to store project configurations
   * @param fs FileSystemLayer for filesystem operations
   * @param remotesDir Optional directory for cloned remote repositories
   */
  constructor(projectsDir: string, fs: FileSystemLayer, remotesDir?: string) {
    this.projectsDir = projectsDir;
    this.fs = fs;
    this.remotesDir = remotesDir;
  }

  /**
   * Save a project configuration.
   * Creates or overwrites the config.json for the project.
   *
   * @param projectPath Absolute path to the project
   * @param options Optional save options (remoteUrl for cloned projects)
   * @throws ProjectStoreError if save fails
   */
  async saveProject(projectPath: string, options?: SaveProjectOptions): Promise<void> {
    // Normalize the path to canonical format for consistent storage
    const normalizedPath = new Path(projectPath).toString();

    // Always use path-based hash directory
    const projectDir = nodePath.join(this.projectsDir, projectDirName(normalizedPath));
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
   * Runs migration for old cloned projects on first call, then loads configs.
   * Skips invalid entries (missing config.json, malformed JSON, etc.).
   *
   * @returns Array of project paths
   */
  async loadAllProjects(): Promise<readonly string[]> {
    // TODO: Remove migration after sufficient rollout period
    await this.migrateClonedProjects();
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
    const internal = await this.internalLoadAllProjectConfigs();
    return internal.map((entry) => entry.config);
  }

  /**
   * Internal: load all project configs with their directory entry names.
   * Used by both loadAllProjectConfigs (public) and migration logic.
   */
  private async internalLoadAllProjectConfigs(): Promise<
    readonly { config: ProjectConfig; entryName: string }[]
  > {
    const results: { config: ProjectConfig; entryName: string }[] = [];

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
              results.push({ config, entryName: entry.name });
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

    return results;
  }

  /**
   * Migrate old-layout cloned projects from projects/ to remotes/.
   *
   * Old layout: projects/<url-hash>/config.json + projects/<url-hash>/repo/
   * New layout: remotes/<url-hash>/repo/ + projects/<path-hash>/config.json
   *
   * TODO: Remove after sufficient migration period
   */
  private async migrateClonedProjects(): Promise<void> {
    if (!this.remotesDir) return;

    const entries = await this.internalLoadAllProjectConfigs();
    for (const { config, entryName } of entries) {
      if (!config.remoteUrl) continue;

      // Detect old layout: entry dir name doesn't match path-hashed dir name
      const expectedDirName = projectDirName(config.path);
      if (entryName === expectedDirName) continue; // Already in new layout

      const oldDir = nodePath.join(this.projectsDir, entryName);
      const newDir = nodePath.join(this.remotesDir, entryName);

      try {
        await this.fs.mkdir(this.remotesDir);
        await this.fs.rename(oldDir, newDir);

        // Compute new project path (under remotes/)
        const repoName = new Path(config.path).basename;
        const newProjectPath = new Path(newDir, repoName).toString();

        // Save config at path-hashed location
        await this.saveProject(newProjectPath, { remoteUrl: config.remoteUrl });

        // Remove old config.json that moved with the directory
        const movedConfig = nodePath.join(newDir, "config.json");
        try {
          await this.fs.unlink(movedConfig);
        } catch {
          /* ignore */
        }
      } catch {
        // Migration is best-effort — skip on failure
      }
    }
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
   * For cloned projects (with remoteUrl), deletes both the clone directory
   * in remotes/ and the config+workspaces directory in projects/.
   *
   * @param projectPath Absolute path to the project (gitPath for cloned projects)
   * @param options Optional deletion options
   * @param options.isClonedProject If true, treat as cloned project and delete both directories
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

    try {
      if (isCloned) {
        // 1. Delete clone dir (dirname of gitPath, e.g. remotes/repo-abc123/)
        const normalizedPath = new Path(projectPath).toString();
        const cloneDir = nodePath.dirname(normalizedPath);
        await this.fs.rm(cloneDir, { recursive: true, force: true });

        // 2. Delete config+workspaces dir in projects/
        const configDir = nodePath.join(this.projectsDir, projectDirName(projectPath));
        await this.fs.rm(configDir, { recursive: true, force: true });
      } else {
        // Local project: use path-hashed directory
        const dirName = projectDirName(projectPath);
        const dirToDelete = nodePath.join(this.projectsDir, dirName);
        await this.fs.rm(dirToDelete, { recursive: true, force: true });
      }
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
}
