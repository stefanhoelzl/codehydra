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
 * - _CH_CLAUDE_SETTINGS: Path to codehydra-hooks.json
 * - _CH_CLAUDE_MCP_CONFIG: Path to codehydra-mcp.json
 * - _CH_MCP_PORT: Main MCP server port
 * - _CH_WORKSPACE_PATH: Workspace path for MCP header
 * - _CH_INITIAL_PROMPT_FILE: Path to initial prompt JSON file (optional)
 * - _CH_CLAUDE_NO_SESSION_MARKER_PATH: Path to no-session marker (optional, new workspaces only)
 */

import { spawnSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Config read from initial-prompt.json file.
 * Model is stored as just the modelID string (not full PromptModel).
 */
export interface InitialPromptConfig {
  readonly prompt: string;
  readonly model?: string;
  /** Claude permission mode (e.g. "plan"). Omitted = let Claude decide. */
  readonly permissionMode?: string;
  /** Named agent/persona passed to --agent. */
  readonly agentName?: string;
}

/**
 * Read initial prompt config from file and delete it.
 * Returns undefined if no initial prompt file is set or if reading fails.
 *
 * Uses synchronous Node.js APIs to match wrapper's sync execution model.
 * Deletes the file and temp directory before returning to ensure one-time use.
 */
function getInitialPromptConfig(): InitialPromptConfig | undefined {
  const filePath = process.env._CH_INITIAL_PROMPT_FILE;

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
    // File not found is expected on restart (consumed on first launch)
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }

    // Log warning for unexpected errors but don't fail
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
 * Build permission flags from the selected permission mode.
 *
 * Always passes --allow-dangerously-skip-permissions so bypass stays reachable
 * via Shift+Tab without forcing it. The starting mode is set with
 * --permission-mode when a mode is chosen; omitting it lets Claude use its
 * default (normal prompting). On resume (no initial-prompt config) the mode is
 * not re-applied — Claude does not restore --permission-mode across --continue.
 *
 * @param permissionMode - The permission mode from initial prompt config
 * @returns Array of CLI permission flags
 */
function buildPermissionArgs(permissionMode?: string): string[] {
  const args = ["--allow-dangerously-skip-permissions"];
  if (permissionMode !== undefined && permissionMode !== "") {
    args.push("--permission-mode", permissionMode);
  }
  return args;
}

/**
 * Build CLI arguments from initial prompt config.
 * Returns array of arguments to prepend to claude command.
 *
 * @param config - The initial prompt configuration
 * @returns Array of CLI arguments (prompt, --model, --agent flags as needed)
 */
function buildInitialPromptArgs(config: InitialPromptConfig): string[] {
  const args: string[] = [];
  if (config.prompt) {
    args.push(config.prompt);
  }

  if (config.model !== undefined) {
    args.push("--model", config.model);
  }

  if (config.agentName !== undefined && config.agentName !== "") {
    args.push("--agent", config.agentName);
  }

  return args;
}

// Exit codes
const EXIT_ENV_ERROR = 1;
const EXIT_SPAWN_FAILED = 2;
const EXIT_NOT_FOUND = 3;

/**
 * Result of spawning Claude CLI.
 */
export interface SpawnResult {
  exitCode: number | null;
  error: Error | undefined;
}

/**
 * Options for running Claude.
 */
export interface RunClaudeOptions {
  /** Skip the automatic --continue attempt (new workspace with no prior session) */
  skipContinue?: boolean;
  /** Spawn through a shell (required on Windows when invoking .cmd/.bat shims) */
  useShell?: boolean;
}

/**
 * Result type returned by spawnSync for testing purposes.
 */
interface SpawnSyncResult {
  status: number | null;
  error: Error | undefined;
}

/**
 * Dependencies for runClaude that can be injected for testing.
 */
export interface RunClaudeDeps {
  spawnSync: (
    command: string,
    args: string[],
    options: { stdio: "inherit"; shell: boolean }
  ) => SpawnSyncResult;
}

/**
 * Quote an argument for cmd.exe. Wraps in double quotes and doubles any
 * embedded quotes so cmd.exe parses it as a single token. Used together
 * with windowsVerbatimArguments to bypass Node's arg mangling.
 */
function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Default dependencies using real implementations.
 *
 * Node's `shell: true` joins the file + args with single spaces and wraps the
 * whole line in one outer pair of quotes — it does NOT quote individual args.
 * Args containing spaces (like a prompt "hello world") therefore get split
 * by cmd.exe's tokenizer. Pre-quote each arg ourselves so the inner tokens
 * survive cmd.exe's parse after /S strips the outer pair.
 */
const defaultDeps: RunClaudeDeps = {
  spawnSync: (command, args, options) => {
    if (options.shell && process.platform === "win32") {
      const quotedCommand = quoteForCmd(command);
      const quotedArgs = args.map(quoteForCmd);
      const result = spawnSync(quotedCommand, quotedArgs, {
        stdio: "inherit",
        shell: true,
      });
      return { status: result.status, error: result.error };
    }
    const result = spawnSync(command, args, options);
    return { status: result.status, error: result.error };
  },
};

/**
 * Check if user args contain session resume flags.
 * Returns true if user explicitly passed --continue, -c, or --resume.
 */
function hasUserResumeFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--continue" || arg === "-c" || arg === "--resume") {
      return true;
    }
  }
  return false;
}

/**
 * Run Claude CLI with automatic session resume.
 *
 * If user hasn't passed explicit resume flags (--continue, -c, --resume),
 * first attempts to resume with --continue. If that fails (exit code non-zero),
 * retries without --continue.
 *
 * @param claudeBinary - The claude binary name (resolved via PATH)
 * @param baseArgs - Arguments to pass to Claude
 * @param options - Spawn options
 * @param deps - Injectable dependencies for testing
 * @returns SpawnResult with exit code and optional error
 */
export function runClaude(
  claudeBinary: string,
  baseArgs: string[],
  options: RunClaudeOptions,
  deps: RunClaudeDeps = defaultDeps
): SpawnResult {
  const shell = options.useShell ?? false;

  // Check if user already passed resume flags or skipContinue is set
  if (hasUserResumeFlag(baseArgs) || options.skipContinue) {
    const result = deps.spawnSync(claudeBinary, baseArgs, {
      stdio: "inherit",
      shell,
    });
    return {
      exitCode: result.status,
      error: result.error,
    };
  }

  // First attempt: try with --continue to resume session
  const continueArgs = ["--continue", ...baseArgs];
  const firstResult = deps.spawnSync(claudeBinary, continueArgs, {
    stdio: "inherit",
    shell,
  });

  // If successful, return
  if (firstResult.status === 0) {
    return {
      exitCode: 0,
      error: firstResult.error,
    };
  }

  // Retry without --continue
  const retryResult = deps.spawnSync(claudeBinary, baseArgs, {
    stdio: "inherit",
    shell,
  });

  return {
    exitCode: retryResult.status,
    error: retryResult.error,
  };
}

/**
 * Consume the no-session marker file if present.
 * Returns true when the marker exists (new workspace, no prior session),
 * meaning --continue should be skipped. Deletes the marker so subsequent
 * runs will attempt --continue.
 */
function consumeNoSessionMarker(): boolean {
  const markerPath = process.env._CH_CLAUDE_NO_SESSION_MARKER_PATH;
  if (!markerPath) return false;
  if (!existsSync(markerPath)) return false;
  try {
    unlinkSync(markerPath);
  } catch {
    // Ignore deletion errors
  }
  return true;
}

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
 *
 * On Windows we probe explicit extensions because npm-installed claude only
 * drops a `claude.cmd` shim (no `.exe`), and `.cmd` files require `shell: true`
 * for spawnSync (Node refuses direct execution since CVE-2024-27980).
 *
 * Returns the command name and whether spawn must go through a shell, or null
 * when no working binary is found on PATH.
 */
function findSystemClaude(): { command: string; useShell: boolean } | null {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "claude.exe", useShell: false },
          { command: "claude.cmd", useShell: true },
        ]
      : [{ command: "claude", useShell: false }];

  for (const candidate of candidates) {
    try {
      execSync(`${candidate.command} --version`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/**
 * Main entry point for the wrapper script.
 */
async function main(): Promise<never> {
  // 1. Validate required environment variables
  const settingsPath = process.env._CH_CLAUDE_SETTINGS;
  const mcpConfigPath = process.env._CH_CLAUDE_MCP_CONFIG;

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
  const args = [
    ...initialPromptArgs,
    ...buildPermissionArgs(initialPromptConfig?.permissionMode),
    "--ide",
    "--settings",
    settingsPath,
    "--mcp-config",
    mcpConfigPath,
    ...getUserArgs(), // Auto-detect user args for both terminal and panel modes
  ];

  // 5. Clear CLAUDECODE to allow nested Claude Code sessions inside CodeHydra
  delete process.env.CLAUDECODE;

  // 6. Spawn Claude with automatic session resume.
  // Skip --continue attempt for new workspaces (no prior session to resume).
  // Agent status (WrapperStart/WrapperEnd) is driven by the sidekick via the
  // agent terminal's open/close — this wrapper no longer posts hooks.
  const result = runClaude(claudeBinary.command, args, {
    skipContinue: consumeNoSessionMarker(),
    useShell: claudeBinary.useShell,
  });

  // 7. Handle result
  if (result.error) {
    console.error(`Error: Failed to start Claude: ${result.error.message}`);
    process.exit(EXIT_SPAWN_FAILED);
  }

  process.exit(result.exitCode ?? EXIT_SPAWN_FAILED);
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
export {
  findSystemClaude,
  getInitialPromptConfig,
  buildInitialPromptArgs,
  buildPermissionArgs,
  consumeNoSessionMarker,
};
