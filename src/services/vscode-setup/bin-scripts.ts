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
 * 1. Finds git root using execSync
 * 2. Reads and parses ports.json
 * 3. Looks up the port for the current workspace
 * 4. Spawns opencode attach with the server URL
 * 5. Propagates the exit code
 *
 * Uses CommonJS (.cjs) for explicit format and compatibility.
 *
 * @param opencodeVersion - Version of opencode binary (e.g., "1.0.163")
 * @returns Generated Node.js script content
 */
export function generateOpencodeNodeScript(opencodeVersion: string): string {
  // Note: We escape $ to prevent template literal interpolation in the generated script
  return `// opencode.cjs - Generated CommonJS script
const { execSync, spawnSync } = require("child_process");
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");

const OPENCODE_VERSION = "${opencodeVersion}";
const isWindows = process.platform === "win32";

// Paths relative to bin/ directory using path.join for cross-platform
const PORTS_FILE = join(__dirname, "..", "opencode", "ports.json");
const OPENCODE_BIN = join(
  __dirname,
  "..",
  "opencode",
  OPENCODE_VERSION,
  isWindows ? "opencode.exe" : "opencode"
);

// 1. Find git root
let gitRoot;
try {
  gitRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"], // Capture stderr
  }).trim();
} catch {
  console.error("Error: Not in a git repository");
  process.exit(1);
}

// 2. Read ports.json
if (!existsSync(PORTS_FILE)) {
  console.error("Error: No opencode servers are running");
  process.exit(1);
}

let ports;
try {
  const content = readFileSync(PORTS_FILE, "utf8");
  ports = JSON.parse(content);
} catch {
  console.error("Error: Failed to read ports.json");
  process.exit(1);
}

// 3. Look up port for workspace
const workspaceInfo = ports.workspaces?.[gitRoot];
if (!workspaceInfo?.port) {
  console.error("Error: No opencode server found for workspace: " + gitRoot);
  console.error("Make sure the workspace is open in CodeHydra.");
  process.exit(1);
}

// 4. Spawn opencode attach
const url = "http://127.0.0.1:" + workspaceInfo.port;
const result = spawnSync(OPENCODE_BIN, ["attach", url], { stdio: "inherit" });

// 5. Exit with child's exit code
if (result.error) {
  console.error("Error: Failed to start opencode: " + result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
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
 * OpenCode MCP configuration structure.
 */
interface McpConfig {
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
 * Generate MCP configuration content for OpenCode.
 *
 * The config uses environment variable substitution:
 * - `{env:CODEHYDRA_MCP_PORT}` - Resolved to the actual port at runtime
 * - `{env:CODEHYDRA_WORKSPACE_PATH}` - Resolved to the workspace path at runtime
 *
 * This is a static config file written during setup. OpenCode reads these
 * env var references and substitutes them when connecting to the MCP server.
 *
 * @returns JSON string for the config file
 */
export function generateMcpConfigContent(): string {
  const config: McpConfig = {
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
