/**
 * ProjectStore - Persists project configurations across sessions.
 *
 * Paths are normalized to canonical format (POSIX separators, lowercase on Windows)
 * both on save and on load. This auto-migrates old configs with native paths.
 */

import path from "path";
import type { ProjectConfig } from "./types";
import { CURRENT_PROJECT_VERSION } from "./types";
import { ProjectStoreError, getErrorMessage } from "../errors";
import { projectDirName } from "../platform/paths";
import type { FileSystemLayer } from "../platform/filesystem";
import { Path } from "../platform/path";

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
   * @throws ProjectStoreError if save fails
   */
  async saveProject(projectPath: string): Promise<void> {
    // Normalize the path to canonical format for consistent storage
    const normalizedPath = new Path(projectPath).toString();
    const dirName = projectDirName(normalizedPath);
    const projectDir = path.join(this.projectsDir, dirName);
    const configPath = path.join(projectDir, "config.json");

    const config: ProjectConfig = {
      version: CURRENT_PROJECT_VERSION,
      path: normalizedPath,
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
    const projects: string[] = [];

    try {
      // readdir throws ENOENT if directory doesn't exist
      const entries = await this.fs.readdir(this.projectsDir);

      for (const entry of entries) {
        if (!entry.isDirectory) {
          continue;
        }

        const configPath = path.join(this.projectsDir, entry.name, "config.json");

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
              projects.push(normalizedPath);
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

    return projects;
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
    const projectDir = path.join(this.projectsDir, dirName);
    const configPath = path.join(projectDir, "config.json");

    try {
      // Remove config.json
      await this.fs.unlink(configPath);
    } catch {
      // Ignore if file doesn't exist
      return;
    }

    // Try to remove the workspaces subdirectory (only succeeds if empty)
    const workspacesDir = path.join(projectDir, "workspaces");
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
}
