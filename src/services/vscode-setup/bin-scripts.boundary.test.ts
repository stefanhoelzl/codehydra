// @vitest-environment node
/**
 * Boundary tests for the compiled opencode wrapper (dist/bin/opencode.cjs).
 *
 * Tests the script with real Node.js execution and mock HTTP server.
 * These tests verify:
 * - Environment variable validation (PORT, DIR)
 * - Session fetching from OpenCode API
 * - Binary path construction and spawning
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { writeFile, mkdir, chmod, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createTempDir } from "../test-utils";

const isWindows = process.platform === "win32";

/**
 * Path to the compiled opencode.cjs script.
 * This is built by `pnpm build:wrappers` before running tests.
 */
const COMPILED_SCRIPT_PATH = resolve(__dirname, "../../../dist/bin/opencode.cjs");

/**
 * Output from the fake opencode binary.
 * Used for structured assertions in tests.
 */
interface FakeOpencodeOutput {
  args: string[];
}

/**
 * Parse the JSON output from the fake opencode binary.
 *
 * @param stdout - stdout from the script execution
 * @returns Parsed output or null if parsing fails
 */
function parseFakeOpencodeOutput(stdout: string): FakeOpencodeOutput | null {
  try {
    return JSON.parse(stdout.trim()) as FakeOpencodeOutput;
  } catch {
    return null;
  }
}

/**
 * Create a fake opencode binary for testing.
 * The fake binary outputs JSON with the args it received and exits with a configurable code.
 *
 * @param opencodeDir Directory to create the fake binary in
 */
async function createFakeOpencodeBinary(opencodeDir: string): Promise<string> {
  await mkdir(opencodeDir, { recursive: true });

  // Create a cross-platform Node.js fake binary that outputs JSON
  const fakeScriptPath = join(opencodeDir, "opencode-fake.cjs");
  const fakeNodeContent = `#!/usr/bin/env node
// Fake opencode binary for testing - outputs JSON for structured assertions
const output = {
  args: process.argv.slice(2)
};
console.log(JSON.stringify(output));
const exitCode = parseInt(process.env.OPENCODE_EXIT_CODE || "0", 10);
process.exit(isNaN(exitCode) ? 0 : exitCode);
`;
  await writeFile(fakeScriptPath, fakeNodeContent);

  // Create platform-specific wrapper
  const fakeOpencodePath = join(opencodeDir, isWindows ? "opencode.cmd" : "opencode");

  if (isWindows) {
    // Windows: batch wrapper calling node with absolute path
    const nodePath = process.execPath;
    const batchContent = `@echo off
"${nodePath}" "%~dp0opencode-fake.cjs" %*
exit /b %ERRORLEVEL%
`;
    await writeFile(fakeOpencodePath, batchContent);
  } else {
    // Unix: shell wrapper calling node
    const shellContent = `#!/bin/sh
exec node "$(dirname "$0")/opencode-fake.cjs" "$@"
`;
    await writeFile(fakeOpencodePath, shellContent);
    await chmod(fakeOpencodePath, 0o755);
  }

  return opencodeDir;
}

/**
 * Execute the compiled opencode.cjs script and capture output.
 * Uses async spawn to allow mock servers to respond.
 */
async function executeScript(
  env: Record<string, string | undefined>,
  cwd: string
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  // Build clean env without CodeHydra vars and test framework vars, then add specified ones
  const baseEnv: Record<string, string> = {};
  const excludedPrefixes = ["CODEHYDRA_", "VITEST", "TEST"];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !excludedPrefixes.some((prefix) => key.startsWith(prefix))) {
      baseEnv[key] = value;
    }
  }

  const finalEnv: Record<string, string> = { ...baseEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      finalEnv[key] = value;
    }
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPILED_SCRIPT_PATH], {
      env: finalEnv,
      cwd,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, status: code });
    });
  });
}

describe("opencode.cjs boundary tests", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let opencodeDir: string;

  // Check if the compiled script exists before running tests
  beforeAll(async () => {
    try {
      await access(COMPILED_SCRIPT_PATH, constants.R_OK);
    } catch {
      throw new Error(
        `Compiled script not found at ${COMPILED_SCRIPT_PATH}. Run 'pnpm build:wrappers' first.`
      );
    }
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    opencodeDir = await createFakeOpencodeBinary(join(tempDir.path, "opencode", "1.0.0"));
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("environment variable validation", () => {
    it("errors when CODEHYDRA_OPENCODE_PORT is not set", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
          // CODEHYDRA_OPENCODE_PORT not set
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: CODEHYDRA_OPENCODE_PORT not set");
      expect(result.stderr).toContain("Make sure you're in a CodeHydra workspace terminal");
    });

    it("errors when port is not a number", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "not-a-number",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT");
    });

    it("errors when port is zero", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "0",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT");
    });

    it("errors when port is negative", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "-100",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT");
    });

    it("errors when port is above 65535", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "70000",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT");
    });

    it("errors when CODEHYDRA_OPENCODE_DIR is not set", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          // CODEHYDRA_OPENCODE_DIR not set
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: CODEHYDRA_OPENCODE_DIR not set");
      expect(result.stderr).toContain("Make sure you're in a CodeHydra workspace terminal");
    });
  });

  describe("binary spawning", () => {
    // Note: Wrapper no longer queries the SDK for sessions.
    // It just reads CODEHYDRA_OPENCODE_SESSION_ID from the environment.

    it("spawns opencode attach with correct URL", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeOpencodeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("attach");
      expect(output!.args).toContain("http://127.0.0.1:14001");
    });

    it("uses 127.0.0.1 (not localhost) in URL", async () => {
      // This test verifies the URL format uses 127.0.0.1
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeOpencodeOutput(result.stdout);
      expect(output).not.toBeNull();
      // Verify URL uses 127.0.0.1, not localhost
      expect(output!.args).toContain("http://127.0.0.1:14001");
    });

    it("propagates exit code from opencode binary", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
          OPENCODE_EXIT_CODE: "42",
        },
        tempDir.path
      );

      expect(result.status).toBe(42);
    });
  });

  describe("session restoration", () => {
    // Session restoration now uses CODEHYDRA_OPENCODE_SESSION_ID env var
    // The wrapper no longer queries the SDK for sessions

    it("includes --session flag when CODEHYDRA_OPENCODE_SESSION_ID is set", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
          CODEHYDRA_OPENCODE_SESSION_ID: "ses-abc123",
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeOpencodeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("--session");
      expect(output!.args).toContain("ses-abc123");
    });

    it("does not include --session when CODEHYDRA_OPENCODE_SESSION_ID is not set", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
          // CODEHYDRA_OPENCODE_SESSION_ID not set
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeOpencodeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).not.toContain("--session");
    });

    it("does not include --session when CODEHYDRA_OPENCODE_SESSION_ID is empty", async () => {
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "14001",
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
          CODEHYDRA_OPENCODE_SESSION_ID: "",
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeOpencodeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).not.toContain("--session");
    });

    // Note: Session selection logic (filtering by directory, excluding sub-agents,
    // selecting most recent) is now handled by OpenCodeProvider, not the wrapper.
    // Those behaviors are tested in session-utils.test.ts and agent-status-manager.test.ts.

    it("handles connection refused gracefully (still spawns opencode)", async () => {
      // Even if the server isn't running, the wrapper should still spawn opencode
      // The session ID comes from the environment, not from querying the server
      const result = await executeScript(
        {
          CODEHYDRA_OPENCODE_PORT: "59999", // Unlikely to be in use
          CODEHYDRA_OPENCODE_DIR: opencodeDir,
          CODEHYDRA_OPENCODE_SESSION_ID: "ses-123",
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeOpencodeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("attach");
      expect(output!.args).toContain("http://127.0.0.1:59999");
      expect(output!.args).toContain("--session");
      expect(output!.args).toContain("ses-123");
    });
  });
});
