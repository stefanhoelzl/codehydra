/**
 * OpenCode CLI wrapper script.
 *
 * This script is compiled to CJS by Vite and runs in Node.js when the user
 * invokes `opencode` from a CodeHydra workspace terminal.
 *
 * It:
 * 1. Reads environment variables for configuration
 * 2. Spawns `opencode attach` with the session ID from environment, followed by
 *    any arguments `ch opencode` was given
 */

import { spawnSync } from "node:child_process";

// Exit codes
const EXIT_ENV_ERROR = 1;
const EXIT_SPAWN_FAILED = 2;

/**
 * Main entry point for the wrapper script.
 *
 * Agent status (the old WrapperStart notification) is driven by the sidekick via
 * the agent terminal's open/close — this wrapper no longer posts hooks.
 */
function main(userArgs: readonly string[]): never {
  // 1. Read and validate _CH_OPENCODE_PORT
  const portStr = process.env._CH_OPENCODE_PORT;
  if (!portStr) {
    console.error("Error: _CH_OPENCODE_PORT not set.");
    console.error("Make sure you're in a CodeHydra workspace terminal.");
    process.exit(EXIT_ENV_ERROR);
  }

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    console.error(`Error: Invalid _CH_OPENCODE_PORT: ${portStr}`);
    process.exit(EXIT_ENV_ERROR);
  }

  // 2. The opencode binary CodeHydra resolved for this workspace (system
  //    install or download) — the same one its server runs.
  const binaryPath = process.env._CH_OPENCODE_BIN;
  if (!binaryPath) {
    console.error("Error: _CH_OPENCODE_BIN not set.");
    console.error("Make sure you're in a CodeHydra workspace terminal.");
    process.exit(EXIT_ENV_ERROR);
  }
  // A Windows .cmd shim requires shell:true, and the shell then needs the
  // path quoted.
  const useShell = process.platform === "win32" && binaryPath.toLowerCase().endsWith(".cmd");

  // 4. Build base URL
  const baseUrl = `http://127.0.0.1:${port}`;

  // 5. Read session ID from environment (set by sidekick extension)
  const sessionId = process.env._CH_OPENCODE_SESSION_ID;

  // 6. Build spawn arguments
  const args = ["attach", baseUrl];
  if (sessionId) {
    args.push("--session", sessionId);
  }
  args.push(...userArgs);

  // 7. Spawn opencode binary
  const result = spawnSync(useShell ? `"${binaryPath}"` : binaryPath, args, {
    stdio: "inherit",
    shell: useShell,
  });

  // 8. Handle result
  if (result.error) {
    console.error(`Error: Failed to start opencode: ${result.error.message}`);
    process.exit(EXIT_SPAWN_FAILED);
  }

  process.exit(result.status ?? EXIT_SPAWN_FAILED);
}

/**
 * Launch OpenCode, reporting a failure the way a shell wrapper should.
 *
 * Exported because `ch opencode` is the entry point — the sidekick types that
 * into the agent terminal. There is no separate script on disk.
 *
 * `userArgs` are what followed `ch opencode`; they are passed on to
 * `opencode attach`.
 */
export function runOpencodeWrapper(userArgs: readonly string[]): never {
  try {
    main(userArgs);
  } catch (error: unknown) {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(EXIT_ENV_ERROR);
  }
  process.exit(EXIT_ENV_ERROR);
}
