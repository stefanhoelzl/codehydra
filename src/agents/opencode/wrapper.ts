/**
 * OpenCode CLI wrapper script.
 *
 * This script is compiled to CJS by Vite and runs in Node.js when the user
 * invokes `opencode` from a CodeHydra workspace terminal.
 *
 * It:
 * 1. Reads environment variables for configuration
 * 2. Spawns the opencode binary with the session ID from environment
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { request } from "node:http";

// Exit codes
const EXIT_ENV_ERROR = 1;
const EXIT_SPAWN_FAILED = 2;

/**
 * Send a hook notification to the bridge server.
 * Fire-and-forget: does not wait for response.
 * Silent on error - bridge server may not be available.
 *
 * @param hookName - Name of the hook
 */
async function notifyHook(hookName: "WrapperStart"): Promise<void> {
  const bridgePort = process.env.CODEHYDRA_BRIDGE_PORT;
  const workspacePath = process.env.CODEHYDRA_WORKSPACE_PATH;

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
        timeout: 2000,
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
  // 1. Read and validate CODEHYDRA_OPENCODE_PORT
  const portStr = process.env.CODEHYDRA_OPENCODE_PORT;
  if (!portStr) {
    console.error("Error: CODEHYDRA_OPENCODE_PORT not set.");
    console.error("Make sure you're in a CodeHydra workspace terminal.");
    process.exit(EXIT_ENV_ERROR);
  }

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    console.error(`Error: Invalid CODEHYDRA_OPENCODE_PORT: ${portStr}`);
    process.exit(EXIT_ENV_ERROR);
  }

  // 2. Read and validate CODEHYDRA_OPENCODE_DIR
  const opencodeDir = process.env.CODEHYDRA_OPENCODE_DIR;
  if (!opencodeDir) {
    console.error("Error: CODEHYDRA_OPENCODE_DIR not set.");
    console.error("Make sure you're in a CodeHydra workspace terminal.");
    process.exit(EXIT_ENV_ERROR);
  }

  // 3. Construct binary path
  const isWindows = process.platform === "win32";
  let binaryPath: string;

  if (isWindows) {
    // On Windows, prefer .exe but fallback to .cmd
    const exePath = join(opencodeDir, "opencode.exe");
    const cmdPath = join(opencodeDir, "opencode.cmd");
    binaryPath = existsSync(exePath) ? exePath : cmdPath;
  } else {
    binaryPath = join(opencodeDir, "opencode");
  }

  // 4. Build base URL
  const baseUrl = `http://127.0.0.1:${port}`;

  // 5. Read session ID from environment (set by sidekick extension)
  const sessionId = process.env.CODEHYDRA_OPENCODE_SESSION_ID;

  // 6. Build spawn arguments
  const args = ["attach", baseUrl];
  if (sessionId) {
    args.push("--session", sessionId);
  }

  // 7. Notify wrapper start (must complete before spawnSync blocks event loop)
  await notifyHook("WrapperStart");

  // 8. Spawn opencode binary
  // Note: .cmd files on Windows require shell:true to execute
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    shell: binaryPath.endsWith(".cmd"),
  });

  // 9. Handle result
  if (result.error) {
    console.error(`Error: Failed to start opencode: ${result.error.message}`);
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

export { notifyHook };
