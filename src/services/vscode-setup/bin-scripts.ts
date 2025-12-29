/**
 * Utility module for generating platform-specific CLI wrapper scripts and MCP config.
 *
 * This module contains pure functions that generate script content based on:
 * - Target binary paths
 * - Platform information (linux, darwin, win32)
 *
 * The generated scripts allow users to run `code` and `opencode`
 * from the integrated terminal without needing to know the full binary paths.
 *
 * The opencode wrapper consists of:
 * - A cross-platform Node.js script (opencode.cjs) containing all logic
 * - A thin platform-specific shell wrapper that invokes Node.js with the script
 *
 * The Node.js script checks if CodeHydra is managing a server for the current
 * workspace and attaches to it. Unlike the previous implementation, there is
 * no standalone fallback - the opencode command only works in managed workspaces.
 *
 * The MCP config file is also generated here since it's a static file that uses
 * environment variable substitution (like the wrapper scripts).
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
 * Generate Unix (Linux/macOS) wrapper script content for simple passthrough.
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
 * Generate Windows wrapper script content (.cmd) for simple passthrough.
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
 * Generate Unix thin wrapper that invokes Node.js with the opencode.cjs script.
 *
 * @param bundledNodePath - Absolute path to the bundled Node.js binary
 * @param scriptPath - Absolute path to the opencode.cjs script
 * @returns Shell script content
 */
function generateUnixOpencodeWrapper(bundledNodePath: string, scriptPath: string): string {
  // Escape single quotes in paths
  const escapedNodePath = bundledNodePath.replace(/'/g, "'\\''");
  const escapedScriptPath = scriptPath.replace(/'/g, "'\\''");
  return `#!/bin/sh
exec '${escapedNodePath}' '${escapedScriptPath}'
`;
}

/**
 * Generate Windows thin wrapper that invokes Node.js with the opencode.cjs script.
 *
 * @param bundledNodePath - Absolute path to the bundled Node.js binary
 * @param scriptPath - Absolute path to the opencode.cjs script
 * @returns CMD script content
 */
function generateWindowsOpencodeWrapper(bundledNodePath: string, scriptPath: string): string {
  // Convert forward slashes to backslashes for Windows paths
  const windowsNodePath = bundledNodePath.replace(/\//g, "\\");
  const windowsScriptPath = scriptPath.replace(/\//g, "\\");
  return `@echo off
"${windowsNodePath}" "${windowsScriptPath}" %*
exit /b %ERRORLEVEL%
`;
}

/**
 * Generate the Node.js script that contains all opencode wrapper logic.
 * This script is cross-platform and will be invoked by thin shell wrappers.
 *
 * The script:
 * 1. Reads CODEHYDRA_OPENCODE_PORT environment variable
 * 2. Validates the port number
 * 3. Fetches sessions from OpenCode server to restore state
 * 4. Spawns opencode attach with session flag if available
 * 5. Propagates the exit code
 *
 * Note: Agent restoration was removed because `opencode attach` doesn't support
 * the `--agent` flag. Only session restoration is performed.
 *
 * Uses CommonJS (.cjs) for explicit format and compatibility.
 *
 * @param opencodeVersion - Version of opencode binary (e.g., "1.0.163")
 * @returns Generated Node.js script content
 */
export function generateOpencodeNodeScript(opencodeVersion: string): string {
  // Note: We escape $ to prevent template literal interpolation in the generated script
  return `// opencode.cjs - Generated CommonJS script
const { spawnSync } = require("child_process");
const { join, normalize } = require("path");
const http = require("http");

const OPENCODE_VERSION = "${opencodeVersion}";
const isWindows = process.platform === "win32";

// Timeout constants for HTTP requests
const SESSION_LIST_TIMEOUT_MS = 3000;

// Path to opencode binary relative to bin/ directory
// On Windows, prefer .exe but fallback to .cmd (for testing or alternative installs)
const OPENCODE_BIN = (() => {
  const baseDir = join(__dirname, "..", "opencode", OPENCODE_VERSION);
  if (!isWindows) return join(baseDir, "opencode");
  const exePath = join(baseDir, "opencode.exe");
  const cmdPath = join(baseDir, "opencode.cmd");
  const { existsSync } = require("fs");
  return existsSync(exePath) ? exePath : cmdPath;
})();

/**
 * Make an HTTP GET request and return parsed JSON or null on error.
 * @param {string} url - The URL to fetch
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<any>} Parsed JSON response or null on any error
 */
function httpGet(url, timeout) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Normalize a path for comparison, handling platform differences.
 * On Windows, paths are lowercased for case-insensitive comparison.
 * @param {string} p - Path to normalize
 * @returns {string} Normalized path
 */
function normalizePath(p) {
  const normalized = normalize(p);
  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * Find the most recent session matching the current directory.
 * Excludes sub-agent sessions (those with parentID).
 * @param {Array} sessions - Array of session objects
 * @param {string} directory - Current working directory
 * @returns {Object|null} Most recent matching session or null
 */
function findMatchingSession(sessions, directory) {
  if (!Array.isArray(sessions)) return null;
  
  const normalizedDir = normalizePath(directory);
  
  const matching = sessions.filter((s) => {
    // Exclude sub-agent sessions (have parentID)
    if (s.parentID !== null && s.parentID !== undefined) return false;
    // Match directory
    if (!s.directory) return false;
    return normalizePath(s.directory) === normalizedDir;
  });
  
  if (matching.length === 0) return null;
  
  // Sort by time.updated descending (most recent first)
  matching.sort((a, b) => {
    const timeA = a.time?.updated ?? 0;
    const timeB = b.time?.updated ?? 0;
    return timeB - timeA;
  });
  
  return matching[0];
}

(async () => {
  try {
    // 1. Read env var
    const portStr = process.env.CODEHYDRA_OPENCODE_PORT;
    if (!portStr) {
      console.error("Error: CODEHYDRA_OPENCODE_PORT not set.");
      console.error("Make sure you're in a CodeHydra workspace terminal.");
      process.exit(1);
    }

    // 2. Validate port number
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      console.error("Error: Invalid CODEHYDRA_OPENCODE_PORT: " + portStr);
      process.exit(1);
    }

    const baseUrl = "http://127.0.0.1:" + port;
    const cwd = process.cwd();
    
    // 3. Try to restore session
    let sessionId = null;
    
    // Fetch sessions
    const sessions = await httpGet(baseUrl + "/session", SESSION_LIST_TIMEOUT_MS);
    if (sessions) {
      const session = findMatchingSession(sessions, cwd);
      if (session && session.id) {
        sessionId = session.id;
      }
    }
    
    // 4. Build args
    const args = ["attach", baseUrl];
    if (sessionId) args.push("--session", sessionId);
    
    // 5. Spawn opencode
    // Note: .cmd files on Windows require shell:true to execute
    const result = spawnSync(OPENCODE_BIN, args, {
      stdio: "inherit",
      shell: OPENCODE_BIN.endsWith(".cmd"),
    });

    // 6. Exit with child's exit code
    if (result.error) {
      console.error("Error: Failed to start opencode: " + result.error.message);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();
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
 * Generate the opencode wrapper scripts: a cross-platform Node.js script (.cjs)
 * and a thin platform-specific shell wrapper.
 *
 * @param isWindows - Whether generating for Windows platform
 * @param opencodeVersion - Version of opencode binary (e.g., "1.0.163")
 * @param bundledNodePath - Absolute path to the bundled Node.js binary
 * @param binDir - Absolute path to the bin directory where scripts are stored
 * @returns Array of generated scripts: [opencode.cjs, platform wrapper]
 */
export function generateOpencodeScript(
  isWindows: boolean,
  opencodeVersion: string,
  bundledNodePath: string,
  binDir: string
): GeneratedScript[] {
  const scripts: GeneratedScript[] = [];

  // Generate the Node.js script (shared across platforms)
  scripts.push({
    filename: asScriptFilename("opencode.cjs"),
    content: generateOpencodeNodeScript(opencodeVersion),
    needsExecutable: false, // .cjs files don't need executable flag
  });

  // Generate platform-specific thin wrapper
  const scriptPath = isWindows
    ? `${binDir}\\opencode.cjs`.replace(/\//g, "\\")
    : `${binDir}/opencode.cjs`;

  if (isWindows) {
    scripts.push({
      filename: asScriptFilename("opencode.cmd"),
      content: generateWindowsOpencodeWrapper(bundledNodePath, scriptPath),
      needsExecutable: false,
    });
  } else {
    scripts.push({
      filename: asScriptFilename("opencode"),
      content: generateUnixOpencodeWrapper(bundledNodePath, scriptPath),
      needsExecutable: true,
    });
  }

  return scripts;
}

/**
 * Extract version from opencode binary path.
 *
 * The path format is: <dataRoot>/opencode/<version>/opencode[.exe]
 * For example: /app/opencode/1.0.163/opencode -> "1.0.163"
 *
 * @param opencodePath - Path to opencode binary
 * @returns Version string or null if cannot be extracted
 */
function extractOpencodeVersion(opencodePath: string): string | null {
  // Split path and find version segment (parent directory of the binary)
  // Path format: .../opencode/<version>/opencode[.exe]
  const segments = opencodePath.split(/[/\\]/);
  // Version is the second-to-last segment (parent of the binary file)
  if (segments.length >= 2) {
    return segments[segments.length - 2] ?? null;
  }
  return null;
}

/**
 * Generate all wrapper scripts for the given platform and target paths.
 *
 * Scripts generated:
 * - `code` / `code.cmd` - Wrapper for code-server's remote-cli (VS Code CLI)
 * - `opencode.cjs` - Node.js script with all opencode logic
 * - `opencode` / `opencode.cmd` - Thin wrapper that invokes Node.js with opencode.cjs
 *
 * Note: code-server wrapper is not generated because we launch code-server
 * directly with an absolute path.
 *
 * @param platformInfo - Platform information (for determining script type)
 * @param targetPaths - Paths to target binaries
 * @param binDir - Absolute path to the bin directory where scripts are stored
 * @returns Array of generated scripts ready to write to disk
 */
export function generateScripts(
  platformInfo: PlatformInfo,
  targetPaths: BinTargetPaths,
  binDir: string
): GeneratedScript[] {
  const isWindows = platformInfo.platform === "win32";
  const scripts: GeneratedScript[] = [];

  // Generate code wrapper (for VS Code CLI)
  scripts.push(generateScript("code", targetPaths.codeRemoteCli, isWindows));

  // Generate opencode scripts (Node.js script + thin wrapper)
  if (targetPaths.opencodeBinary !== null) {
    const version = extractOpencodeVersion(targetPaths.opencodeBinary);
    if (version !== null) {
      scripts.push(
        ...generateOpencodeScript(isWindows, version, targetPaths.bundledNodePath, binDir)
      );
    }
  }

  return scripts;
}

/**
 * OpenCode configuration structure.
 * Includes MCP server configuration for the CodeHydra MCP server.
 */
interface OpencodeConfig {
  $schema: string;
  mcp: {
    codehydra: {
      type: "remote";
      url: string;
      headers: {
        "X-Workspace-Path": string;
      };
      enabled: boolean;
    };
  };
}

/**
 * Generate OpenCode configuration content.
 *
 * The config includes MCP server configuration with environment variable substitution:
 * - `{env:CODEHYDRA_MCP_PORT}` - Resolved to the actual port at runtime
 * - `{env:CODEHYDRA_WORKSPACE_PATH}` - Resolved to the workspace path at runtime
 *
 * This is a static config file written during setup. OpenCode reads these
 * env var references and substitutes them when connecting to the MCP server.
 *
 * Note: default_agent is intentionally NOT set here. This config is passed via
 * OPENCODE_CONFIG which takes precedence over project configs. By omitting
 * default_agent, users can set their preferred agent in their project's
 * opencode.jsonc or global config.
 *
 * @returns JSON string for the config file
 */
export function generateOpencodeConfigContent(): string {
  const config: OpencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      codehydra: {
        type: "remote",
        url: "http://127.0.0.1:{env:CODEHYDRA_MCP_PORT}/mcp",
        headers: {
          "X-Workspace-Path": "{env:CODEHYDRA_WORKSPACE_PATH}",
        },
        enabled: true,
      },
    },
  };

  return JSON.stringify(config, null, 2);
}
