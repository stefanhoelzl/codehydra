// @vitest-environment node
/**
 * Boundary tests for bin-scripts opencode wrapper.
 * Tests with real filesystem and Node.js execution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { generateOpencodeNodeScript } from "./bin-scripts";
import { createTempDir } from "../test-utils";

const TEST_VERSION = "1.0.163";
const isWindows = process.platform === "win32";

/**
 * Create the directory structure for testing the opencode script.
 * Creates:
 * - bin/opencode.cjs
 * - opencode/<version>/opencode (fake binary)
 *
 * @param basePath Base directory to create structure in
 */
async function createOpencodeTestStructure(basePath: string): Promise<{
  binDir: string;
  scriptPath: string;
  opencodeDir: string;
  fakeOpencodePath: string;
}> {
  const binDir = join(basePath, "bin");
  const opencodeVersionDir = join(basePath, "opencode", TEST_VERSION);

  await mkdir(binDir, { recursive: true });
  await mkdir(opencodeVersionDir, { recursive: true });

  // Write the Node.js script
  const scriptPath = join(binDir, "opencode.cjs");
  await writeFile(scriptPath, generateOpencodeNodeScript(TEST_VERSION));

  // Create a fake opencode binary that just exits with the first arg as exit code
  // or 0 if no args. This lets us test exit code propagation.
  const fakeOpencodePath = join(opencodeVersionDir, isWindows ? "opencode.exe" : "opencode");

  if (isWindows) {
    // Windows batch script that echoes args and exits with code from env
    const batchContent = `@echo off
echo ATTACH_CALLED %*
exit /b %OPENCODE_EXIT_CODE%
`;
    await writeFile(fakeOpencodePath, batchContent);
    // Windows needs a .cmd extension for the script to be executable
    const cmdPath = fakeOpencodePath.replace(".exe", ".cmd");
    await writeFile(cmdPath, batchContent);
  } else {
    // Unix shell script
    const shellContent = `#!/bin/sh
echo "ATTACH_CALLED $*"
exit \${OPENCODE_EXIT_CODE:-0}
`;
    await writeFile(fakeOpencodePath, shellContent);
    await chmod(fakeOpencodePath, 0o755);
  }

  return { binDir, scriptPath, opencodeDir: join(basePath, "opencode"), fakeOpencodePath };
}

/**
 * Execute the opencode.cjs script and capture output.
 *
 * @param scriptPath - Path to the opencode.cjs script
 * @param opencodePort - Value for CODEHYDRA_OPENCODE_PORT env var (or undefined to not set it)
 * @param exitCode - Exit code for fake opencode binary to return
 */
function executeScript(
  scriptPath: string,
  opencodePort?: string,
  exitCode = 0
): { stdout: string; stderr: string; status: number | null } {
  // Build a clean env without the CODEHYDRA_OPENCODE_PORT if not provided
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "CODEHYDRA_OPENCODE_PORT") {
      baseEnv[key] = value;
    }
  }

  const env: Record<string, string> = {
    ...baseEnv,
    OPENCODE_EXIT_CODE: String(exitCode),
  };

  if (opencodePort !== undefined) {
    env.CODEHYDRA_OPENCODE_PORT = opencodePort;
  }

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("opencode.cjs boundary tests", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let testStructure: Awaited<ReturnType<typeof createOpencodeTestStructure>>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    testStructure = await createOpencodeTestStructure(tempDir.path);
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("error cases", () => {
    it("errors when CODEHYDRA_OPENCODE_PORT is not set", async () => {
      const result = executeScript(testStructure.scriptPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: CODEHYDRA_OPENCODE_PORT not set.");
      expect(result.stderr).toContain("Make sure you're in a CodeHydra workspace terminal.");
    });

    it("errors when port is not a number", async () => {
      const result = executeScript(testStructure.scriptPath, "not-a-number");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT:");
    });

    it("errors when port is zero", async () => {
      const result = executeScript(testStructure.scriptPath, "0");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT:");
    });

    it("errors when port is negative", async () => {
      const result = executeScript(testStructure.scriptPath, "-100");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT:");
    });

    it("errors when port is above 65535", async () => {
      const result = executeScript(testStructure.scriptPath, "70000");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT:");
    });

    it("errors when opencode binary does not exist", async () => {
      // Create a separate test structure without the fake binary
      const noBinaryDir = join(tempDir.path, "no-binary");
      await mkdir(noBinaryDir, { recursive: true });

      // Create only the bin directory with the script
      const binDir = join(noBinaryDir, "bin");
      await mkdir(binDir, { recursive: true });
      const scriptPath = join(binDir, "opencode.cjs");
      await writeFile(scriptPath, generateOpencodeNodeScript(TEST_VERSION));

      // Do NOT create the opencode/<version>/opencode binary
      // This will cause spawnSync to fail with ENOENT

      const result = executeScript(scriptPath, "14001");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: Failed to start opencode:");
    });
  });

  describe("success cases", () => {
    it("spawns opencode attach with correct URL when env var is set", async () => {
      const result = executeScript(testStructure.scriptPath, "14001");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ATTACH_CALLED");
      expect(result.stdout).toContain("attach");
      expect(result.stdout).toContain("http://127.0.0.1:14001");
    });

    it("handles maximum valid port", async () => {
      const result = executeScript(testStructure.scriptPath, "65535");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("http://127.0.0.1:65535");
    });

    it("handles minimum valid port", async () => {
      const result = executeScript(testStructure.scriptPath, "1");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("http://127.0.0.1:1");
    });

    it("propagates exit code 0 on success", async () => {
      const result = executeScript(testStructure.scriptPath, "14001", 0);

      expect(result.status).toBe(0);
    });

    it("propagates non-zero exit code", async () => {
      const result = executeScript(testStructure.scriptPath, "14001", 42);

      expect(result.status).toBe(42);
    });
  });
});
