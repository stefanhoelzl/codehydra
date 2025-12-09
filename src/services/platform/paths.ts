/**
 * Platform-specific path utilities for the application.
 */

import { createHash } from "crypto";
import { join, basename } from "path";

/**
 * Get the root directory for application data.
 *
 * - Development: `./app-data/` relative to process.cwd()
 * - Production Linux: `~/.local/share/codehydra/`
 * - Production macOS: `~/Library/Application Support/Codehydra/`
 * - Production Windows: `%APPDATA%\Codehydra\`
 */
export function getDataRootDir(): string {
  if (process.env.NODE_ENV !== "production") {
    return join(process.cwd(), "app-data");
  }

  switch (process.platform) {
    case "darwin": {
      const home = process.env.HOME;
      if (!home) throw new Error("HOME environment variable not set");
      return join(home, "Library", "Application Support", "Codehydra");
    }
    case "win32": {
      const appData = process.env.APPDATA;
      if (!appData) throw new Error("APPDATA environment variable not set");
      return join(appData, "Codehydra");
    }
    case "linux":
    default: {
      const home = process.env.HOME;
      if (!home) throw new Error("HOME environment variable not set");
      return join(home, ".local", "share", "codehydra");
    }
  }
}

/**
 * Get the directory where project data is stored.
 * @returns `<dataRoot>/projects/`
 */
export function getDataProjectsDir(): string {
  return join(getDataRootDir(), "projects");
}

/**
 * Get the directory for VS Code configuration and extensions.
 * @returns `<dataRoot>/vscode/`
 */
export function getVscodeDir(): string {
  return join(getDataRootDir(), "vscode");
}

/**
 * Get the directory for VS Code extensions.
 * @returns `<dataRoot>/vscode/extensions/`
 */
export function getVscodeExtensionsDir(): string {
  return join(getVscodeDir(), "extensions");
}

/**
 * Get the directory for VS Code user data.
 * @returns `<dataRoot>/vscode/user-data/`
 */
export function getVscodeUserDataDir(): string {
  return join(getVscodeDir(), "user-data");
}

/**
 * Get the path to the VS Code setup completion marker file.
 * @returns `<dataRoot>/vscode/.setup-completed`
 */
export function getVscodeSetupMarkerPath(): string {
  return join(getVscodeDir(), ".setup-completed");
}

/**
 * Generate a directory name for a project based on its path.
 * Format: `<folder-name>-<8-char-sha256-hash>`
 *
 * @param projectPath Absolute path to the project
 * @returns Deterministic directory name
 */
export function projectDirName(projectPath: string): string {
  const folderName = basename(projectPath);
  const hash = createHash("sha256").update(projectPath).digest("hex").substring(0, 8);
  return `${folderName}-${hash}`;
}

/**
 * Get the workspaces directory for a project.
 * @param projectPath Absolute path to the project
 * @returns `<projectsDir>/<name>-<hash>/workspaces/`
 */
export function getProjectWorkspacesDir(projectPath: string): string {
  return join(getDataProjectsDir(), projectDirName(projectPath), "workspaces");
}

/**
 * Sanitize a workspace name for filesystem use.
 * Replaces `/` with `%` to allow branch names like `feature/my-feature`.
 *
 * @param name Workspace or branch name
 * @returns Filesystem-safe name
 */
export function sanitizeWorkspaceName(name: string): string {
  return name.replace(/\//g, "%");
}

/**
 * Unsanitize a workspace name back to original form.
 * Replaces `%` with `/`.
 *
 * @param sanitized Sanitized name
 * @returns Original workspace or branch name
 */
export function unsanitizeWorkspaceName(sanitized: string): string {
  return sanitized.replace(/%/g, "/");
}

/**
 * Encode a file path for use in URLs.
 * Percent-encodes special characters while preserving path structure.
 *
 * @param path File path to encode
 * @returns URL-safe path
 */
export function encodePathForUrl(path: string): string {
  // Split by path separators, encode each segment, rejoin
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
