/**
 * Utility module for generating platform-specific CLI wrapper scripts.
 *
 * This module contains pure functions that generate script content based on:
 * - Target binary paths
 * - Platform information (linux, darwin, win32)
 *
 * The generated scripts allow users to run `code` and `opencode`
 * from the integrated terminal without needing to know the full binary paths.
 */

import type { PlatformInfo } from "../platform/platform-info";
import type { BinTargetPaths, GeneratedScript, ScriptFilename } from "./types";

/**
 * Create a branded ScriptFilename.
 */
function asScriptFilename(name: string): ScriptFilename {
  return name as ScriptFilename;
}

/**
 * Generate Unix (Linux/macOS) wrapper script content.
 * Uses exec to replace the shell process with the target binary.
 * Single quotes around path handle most special characters.
 *
 * @param targetPath - Absolute path to the target binary
 * @returns Shell script content
 */
function generateUnixScript(targetPath: string): string {
  // Escape single quotes in path by ending quote, adding escaped quote, starting new quote
  const escapedPath = targetPath.replace(/'/g, "'\\''");
  return `#!/bin/sh
exec '${escapedPath}' "$@"
`;
}

/**
 * Generate Windows wrapper script content (.cmd).
 * Uses double quotes around path for proper handling.
 *
 * @param targetPath - Absolute path to the target binary
 * @returns CMD script content
 */
function generateWindowsScript(targetPath: string): string {
  // Convert forward slashes to backslashes for Windows paths
  const windowsPath = targetPath.replace(/\//g, "\\");
  return `@echo off
"${windowsPath}" %*
`;
}

/**
 * Generate a single wrapper script for a given tool.
 *
 * @param name - Script name without extension (e.g., "code")
 * @param targetPath - Absolute path to the target binary
 * @param isWindows - Whether generating for Windows platform
 * @returns Generated script with filename, content, and executable flag
 */
export function generateScript(
  name: string,
  targetPath: string,
  isWindows: boolean
): GeneratedScript {
  if (isWindows) {
    return {
      filename: asScriptFilename(`${name}.cmd`),
      content: generateWindowsScript(targetPath),
      needsExecutable: false, // Windows determines executability by extension
    };
  }

  return {
    filename: asScriptFilename(name),
    content: generateUnixScript(targetPath),
    needsExecutable: true, // Unix needs chmod +x
  };
}

/**
 * Generate all wrapper scripts for the given platform and target paths.
 *
 * Scripts generated:
 * - `code` / `code.cmd` - Wrapper for code-server's remote-cli (VS Code CLI)
 * - `opencode` / `opencode.cmd` - Wrapper for opencode binary (if available)
 *
 * Note: code-server wrapper is not generated because we launch code-server
 * directly with an absolute path.
 *
 * @param platformInfo - Platform information (for determining script type)
 * @param targetPaths - Paths to target binaries
 * @returns Array of generated scripts ready to write to disk
 */
export function generateScripts(
  platformInfo: PlatformInfo,
  targetPaths: BinTargetPaths
): GeneratedScript[] {
  const isWindows = platformInfo.platform === "win32";
  const scripts: GeneratedScript[] = [];

  // Generate code wrapper (for VS Code CLI)
  scripts.push(generateScript("code", targetPaths.codeRemoteCli, isWindows));

  // Generate opencode wrapper only if binary path is available
  if (targetPaths.opencodeBinary !== null) {
    scripts.push(generateScript("opencode", targetPaths.opencodeBinary, isWindows));
  }

  return scripts;
}
