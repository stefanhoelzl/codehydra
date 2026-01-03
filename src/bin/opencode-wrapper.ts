/**
 * OpenCode CLI wrapper script.
 *
 * This script is compiled to CJS by Vite and runs in Node.js when the user
 * invokes `opencode` from a CodeHydra workspace terminal.
 *
 * It:
 * 1. Reads environment variables for configuration
 * 2. Queries the OpenCode server for existing sessions
 * 3. Finds a matching session for the current directory
 * 4. Spawns the opencode binary with appropriate arguments
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { Path } from "../services/platform/path";

// Exit codes
const EXIT_ENV_ERROR = 1;
const EXIT_SPAWN_FAILED = 2;

/**
 * Session data from OpenCode API.
 */
export interface OpenCodeSession {
  id: string;
  directory: string;
  parentID?: string | null;
  time?: { updated: number };
}

/**
 * Find the most recent matching session for a directory.
 *
 * Filters by:
 * - Directory match (using Path comparison for cross-platform)
 * - Excludes sub-agent sessions (those with parentID)
 * - Returns most recently updated session
 *
 * @param sessions - Array of sessions from OpenCode API
 * @param directory - Current working directory to match
 * @returns Most recent matching session or null
 */
export function findMatchingSession(
  sessions: OpenCodeSession[],
  directory: string
): OpenCodeSession | null {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  // Create a Path object for the target directory
  let targetPath: Path;
  try {
    targetPath = new Path(directory);
  } catch {
    // Invalid directory path - no match possible
    return null;
  }

  // Filter and find matching sessions
  const matching = sessions.filter((session) => {
    // Exclude sub-agent sessions (have parentID)
    if (session.parentID !== null && session.parentID !== undefined) {
      return false;
    }

    // Match directory using Path.equals() for cross-platform comparison
    if (!session.directory) {
      return false;
    }

    return targetPath.equals(session.directory);
  });

  if (matching.length === 0) {
    return null;
  }

  // Sort by time.updated descending (most recent first)
  // Missing time.updated is treated as 0
  matching.sort((a, b) => {
    const timeA = a.time?.updated ?? 0;
    const timeB = b.time?.updated ?? 0;
    return timeB - timeA;
  });

  return matching[0] ?? null;
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

  // 4. Build base URL and get current directory
  const baseUrl = `http://127.0.0.1:${port}`;
  const cwd = process.cwd();

  // 5. Try to find a matching session
  let sessionId: string | null = null;

  try {
    const client = createOpencodeClient({ baseUrl });
    const response = await client.session.list();
    if (response.data) {
      const sessions = response.data as unknown as OpenCodeSession[];
      const matchingSession = findMatchingSession(sessions, cwd);
      if (matchingSession) {
        sessionId = matchingSession.id;
      }
    }
  } catch {
    // Session fetch failed - continue without session restoration
  }

  // 6. Build spawn arguments
  const args = ["attach", baseUrl];
  if (sessionId) {
    args.push("--session", sessionId);
  }

  // 7. Spawn opencode binary
  // Note: .cmd files on Windows require shell:true to execute
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    shell: binaryPath.endsWith(".cmd"),
  });

  // 8. Handle result
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
