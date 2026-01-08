/**
 * Claude Code CLI wrapper script.
 *
 * This script is compiled to CJS by Vite and runs in Node.js when the user
 * invokes `claude` from a CodeHydra workspace terminal.
 *
 * It:
 * 1. Reads environment variables for configuration
 * 2. Finds the system-installed claude binary
 * 3. Spawns claude with CodeHydra config flags injected
 *
 * Environment variables (set by sidekick extension):
 * - CODEHYDRA_CLAUDE_SETTINGS: Path to codehydra-hooks.json
 * - CODEHYDRA_CLAUDE_MCP_CONFIG: Path to codehydra-mcp.json
 * - CODEHYDRA_BRIDGE_PORT: Bridge server port (for hook notifications)
 * - CODEHYDRA_MCP_PORT: Main MCP server port
 * - CODEHYDRA_WORKSPACE_PATH: Workspace path for MCP header
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Exit codes
const EXIT_ENV_ERROR = 1;
const EXIT_SPAWN_FAILED = 2;
const EXIT_NOT_FOUND = 3;

/**
 * Get user arguments from process.argv.
 * Auto-detects the start of user flags to handle both terminal and panel modes.
 * In terminal mode: argv = [node, script, ...flags]
 * In panel mode: argv = [node, script, command, ...flags]
 */
function getUserArgs(): string[] {
  // Find the first argument that looks like a flag (starts with --)
  const firstFlagIndex = process.argv.findIndex((arg, i) => i >= 2 && arg.startsWith("--"));

  if (firstFlagIndex === -1) {
    // No flags found, return empty
    return [];
  }

  return process.argv.slice(firstFlagIndex);
}

/**
 * Common installation paths for Claude CLI.
 */
const COMMON_PATHS_UNIX = [
  "/usr/local/bin/claude",
  "/usr/bin/claude",
  join(process.env.HOME ?? "", ".local/bin/claude"),
  join(process.env.HOME ?? "", ".npm-global/bin/claude"),
];

const COMMON_PATHS_WINDOWS = [
  join(process.env.LOCALAPPDATA ?? "", "Programs\\Anthropic\\claude.exe"),
  join(process.env.APPDATA ?? "", "npm\\claude.cmd"),
  join(process.env.PROGRAMFILES ?? "", "Anthropic\\claude.exe"),
];

/**
 * Find the system-installed claude binary.
 * First tries PATH lookup, then falls back to common installation locations.
 */
function findSystemClaude(): string | null {
  const isWindows = process.platform === "win32";

  // 1. Try PATH lookup using which/where
  try {
    const cmd = isWindows ? "where claude" : "which claude";
    const result = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const path = result.trim().split("\n")[0]?.trim();

    // On Windows, 'where' might return our wrapper - skip if it's in CodeHydra's bin dir
    if (path && existsSync(path)) {
      // Check if this is our own wrapper by looking for CODEHYDRA in the path
      // The wrapper is installed at <dataRoot>/bin/claude(.cmd)
      if (!path.includes("codehydra") || !path.includes("bin")) {
        return path;
      }
    }
  } catch {
    // which/where failed, try common paths
  }

  // 2. Try common installation paths
  const commonPaths = isWindows ? COMMON_PATHS_WINDOWS : COMMON_PATHS_UNIX;
  for (const path of commonPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Main entry point for the wrapper script.
 */
async function main(): Promise<never> {
  // 1. Validate required environment variables
  const settingsPath = process.env.CODEHYDRA_CLAUDE_SETTINGS;
  const mcpConfigPath = process.env.CODEHYDRA_CLAUDE_MCP_CONFIG;

  if (!settingsPath || !mcpConfigPath) {
    console.error("Error: CodeHydra Claude configuration not set.");
    console.error("Make sure you're in a CodeHydra workspace terminal.");
    process.exit(EXIT_ENV_ERROR);
  }

  // 2. Find the system claude binary
  const claudeBinary = findSystemClaude();
  if (!claudeBinary) {
    console.error("Error: Claude CLI not found.");
    console.error("");
    console.error("Please install Claude CLI:");
    console.error("  npm install -g @anthropic-ai/claude-code");
    console.error("  or see: https://docs.anthropic.com/claude-code/installation");
    process.exit(EXIT_NOT_FOUND);
  }

  // 3. Build arguments
  // --ide: Enable IDE-specific features
  // --settings: Our hooks config (merges with user's)
  // --mcp-config: Our MCP config (merges with user's)
  // User args can override these if they come after
  const isWindows = process.platform === "win32";
  const args = [
    "--ide",
    "--settings",
    settingsPath,
    "--mcp-config",
    mcpConfigPath,
    ...getUserArgs(), // Auto-detect user args for both terminal and panel modes
  ];

  // 4. Spawn Claude
  const result = spawnSync(claudeBinary, args, {
    stdio: "inherit",
    shell: isWindows && claudeBinary.endsWith(".cmd"),
  });

  // 5. Handle result
  if (result.error) {
    console.error(`Error: Failed to start Claude: ${result.error.message}`);
    process.exit(EXIT_SPAWN_FAILED);
  }

  process.exit(result.status ?? EXIT_SPAWN_FAILED);
}

// Run main and handle any uncaught errors
// Skip when running in test environment (Vitest sets VITEST env var)
if (!process.env.VITEST) {
  main().catch((error: unknown) => {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(EXIT_ENV_ERROR);
  });
}

// Export for testing
export { findSystemClaude };
