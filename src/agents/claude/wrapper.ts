/**
 * Claude CLI wrapper script.
 *
 * This script is compiled to CJS by Vite and runs in Node.js when the user
 * invokes `claude` from a CodeHydra workspace terminal.
 *
 * It:
 * 1. Reads environment variables for configuration
 * 2. Finds the system-installed claude binary
 * 3. Reads and deletes initial prompt file if present
 * 4. Spawns claude with CodeHydra config flags injected
 *
 * Environment variables (set by sidekick extension):
 * - CODEHYDRA_CLAUDE_SETTINGS: Path to codehydra-hooks.json
 * - CODEHYDRA_CLAUDE_MCP_CONFIG: Path to codehydra-mcp.json
 * - CODEHYDRA_BRIDGE_PORT: Bridge server port (for hook notifications)
 * - CODEHYDRA_MCP_PORT: Main MCP server port
 * - CODEHYDRA_WORKSPACE_PATH: Workspace path for MCP header
 * - CODEHYDRA_INITIAL_PROMPT_FILE: Path to initial prompt JSON file (optional)
 */

import { spawnSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:http";

/**
 * Config read from initial-prompt.json file.
 * Model is stored as just the modelID string (not full PromptModel).
 */
export interface InitialPromptConfig {
  readonly prompt: string;
  readonly model?: string;
  readonly agent?: string;
}

/**
 * Read initial prompt config from file and delete it.
 * Returns undefined if no initial prompt file is set or if reading fails.
 *
 * Uses synchronous Node.js APIs to match wrapper's sync execution model.
 * Deletes the file and temp directory before returning to ensure one-time use.
 */
function getInitialPromptConfig(): InitialPromptConfig | undefined {
  const filePath = process.env.CODEHYDRA_INITIAL_PROMPT_FILE;

  // No initial prompt file configured
  if (!filePath) {
    return undefined;
  }

  try {
    // Read the file
    const content = readFileSync(filePath, "utf-8");

    // Delete the file first (before parsing, to ensure one-time use)
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore deletion errors - file might already be gone
    }

    // Delete the parent temp directory
    try {
      rmdirSync(dirname(filePath));
    } catch {
      // Ignore - directory might not be empty or already gone
    }

    // Parse JSON
    const config = JSON.parse(content) as InitialPromptConfig;
    return config;
  } catch (error) {
    // Log warning but don't fail - initial prompt is optional
    console.warn(
      `Warning: Failed to read initial prompt file: ${error instanceof Error ? error.message : String(error)}`
    );

    // Try to clean up anyway
    try {
      unlinkSync(filePath);
      rmdirSync(dirname(filePath));
    } catch {
      // Ignore cleanup errors
    }

    return undefined;
  }
}

/**
 * Build CLI arguments from initial prompt config.
 * Returns array of arguments to prepend to claude command.
 *
 * @param config - The initial prompt configuration
 * @returns Array of CLI arguments (prompt, --model, --agent flags as needed)
 */
function buildInitialPromptArgs(config: InitialPromptConfig): string[] {
  const args: string[] = [config.prompt];

  if (config.model !== undefined) {
    args.push("--model", config.model);
  }

  if (config.agent !== undefined) {
    args.push("--agent", config.agent);
  }

  return args;
}

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
 * Find the system-installed claude binary.
 * First tries PATH lookup, then falls back to common installation locations.
 */
function findSystemClaude(): string | null {
  const isWindows = process.platform === "win32";

  // 1. Try PATH lookup using which/where
  try {
    const cmd = isWindows ? "where claude.cmd" : "which claude";
    const result = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const path = result.trim().split("\n")[0]?.trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Send a hook notification to the bridge server.
 * Waits for request to complete (or timeout) before returning.
 * Silent on error - fallback to 10-second timeout works.
 *
 * @param hookName - Name of the hook (WrapperStart or WrapperEnd)
 */
async function notifyHook(hookName: "WrapperStart" | "WrapperEnd"): Promise<void> {
  const bridgePort = process.env.CODEHYDRA_BRIDGE_PORT;
  const workspacePath = process.env.CODEHYDRA_WORKSPACE_PATH;

  // Not in CodeHydra context
  if (!bridgePort || !workspacePath) {
    return;
  }

  const payload = JSON.stringify({ workspacePath });

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: parseInt(bridgePort, 10),
        path: `/hook/${hookName}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 2000, // 2 second timeout
      },
      () => {
        resolve();
      }
    );

    req.on("error", () => {
      resolve(); // Silent failure
    });

    req.on("timeout", () => {
      req.destroy();
      resolve();
    });

    req.write(payload);
    req.end();
  });
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
    console.error("  npm install -g @anthropic-ai/claude");
    console.error("  or see: https://docs.anthropic.com/claude/installation");
    process.exit(EXIT_NOT_FOUND);
  }

  // 3. Check for initial prompt (read and delete file before Claude starts)
  const initialPromptConfig = getInitialPromptConfig();
  const initialPromptArgs = initialPromptConfig ? buildInitialPromptArgs(initialPromptConfig) : [];

  // 4. Build arguments
  // --ide: Enable IDE-specific features
  // --settings: Our hooks config (merges with user's)
  // --mcp-config: Our MCP config (merges with user's)
  // Initial prompt args come first (prompt as positional, then --model/--agent)
  // User args can override these if they come after
  const isWindows = process.platform === "win32";
  const args = [
    ...initialPromptArgs,
    "--allow-dangerously-skip-permissions",
    "--ide",
    "--settings",
    settingsPath,
    "--mcp-config",
    mcpConfigPath,
    ...getUserArgs(), // Auto-detect user args for both terminal and panel modes
  ];

  // 5. Notify wrapper start (clears loading screen before Claude shows dialogs)
  await notifyHook("WrapperStart");

  // 6. Spawn Claude
  const result = spawnSync(claudeBinary, args, {
    stdio: "inherit",
    shell: isWindows && claudeBinary.endsWith(".cmd"),
  });

  // 7. Notify wrapper end (Claude has exited)
  await notifyHook("WrapperEnd");

  // 8. Handle result
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
export { findSystemClaude, notifyHook, getInitialPromptConfig, buildInitialPromptArgs };
