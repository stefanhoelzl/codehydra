// @vitest-environment node
/**
 * Boundary tests for bin-scripts opencode wrapper.
 * Tests with real filesystem and Node.js execution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { generateOpencodeNodeScript } from "./bin-scripts";
import { createTempDir } from "../test-utils";
import {
  createMockOpencodeServer,
  type MockOpencodeServer,
  type MockSession,
} from "./bin-scripts.boundary-test-utils";

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
  // On Windows, use .cmd extension (batch scripts can't run as .exe files).
  // The generated script has fallback logic to find .cmd when .exe doesn't exist.
  const fakeOpencodePath = join(opencodeVersionDir, isWindows ? "opencode.cmd" : "opencode");

  if (isWindows) {
    // Windows batch script that echoes args and exits with code from env
    const batchContent = `@echo off
echo ATTACH_CALLED %*
exit /b %OPENCODE_EXIT_CODE%
`;
    await writeFile(fakeOpencodePath, batchContent);
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

describe("session restoration boundary tests", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let testStructure: Awaited<ReturnType<typeof createOpencodeTestStructure>>;
  let mockServer: MockOpencodeServer;

  beforeEach(async () => {
    tempDir = await createTempDir();
    testStructure = await createOpencodeTestStructure(tempDir.path);
  });

  afterEach(async () => {
    if (mockServer) {
      await mockServer.stop();
    }
    await tempDir.cleanup();
  });

  /**
   * Execute script with mock server running.
   * Uses async spawn to allow the mock server to respond to HTTP requests.
   * (spawnSync would block the event loop and prevent the server from responding)
   */
  async function executeWithMockServer(
    workspaceDir: string
  ): Promise<{ stdout: string; stderr: string; status: number | null }> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "CODEHYDRA_OPENCODE_PORT") {
        baseEnv[key] = value;
      }
    }

    const env: Record<string, string> = {
      ...baseEnv,
      CODEHYDRA_OPENCODE_PORT: String(mockServer.port),
      OPENCODE_EXIT_CODE: "0",
    };

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [testStructure.scriptPath], {
        env,
        cwd: workspaceDir,
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
        resolve({
          stdout,
          stderr,
          status: code,
        });
      });
    });
  }

  describe("session fetching", () => {
    it("fetches sessions and restores with --session flag", async () => {
      const workspaceDir = tempDir.path;
      const sessions: MockSession[] = [
        { id: "ses-1", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
      ];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--session");
      expect(result.stdout).toContain("ses-1");
      // Note: --agent flag is not used since opencode attach doesn't support it
      expect(result.stdout).not.toContain("--agent");

      // Verify the expected endpoints were called
      expect(mockServer.requests).toContainEqual({ method: "GET", url: "/session" });
      // Message endpoint should NOT be called since agent restoration was removed
      expect(mockServer.requests).not.toContainEqual(
        expect.objectContaining({ url: expect.stringContaining("/message") })
      );
    });

    it("handles session fetch timeout gracefully", async () => {
      const workspaceDir = tempDir.path;
      const sessions: MockSession[] = [
        { id: "ses-1", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
      ];

      // Set delay to 5000ms, beyond the 3000ms timeout
      mockServer = createMockOpencodeServer({ sessions, sessionDelay: 5000 });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      // Should fall back to no flags when session fetch times out
      expect(result.stdout).not.toContain("--session");
    }, 10000); // Increase test timeout to allow for the delay

    it("handles empty sessions array", async () => {
      const workspaceDir = tempDir.path;

      mockServer = createMockOpencodeServer({ sessions: [] });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      // Should still work but without --session flag
      expect(result.stdout).not.toContain("--session");
    });

    it("handles HTTP 404 from /session endpoint", async () => {
      const workspaceDir = tempDir.path;

      mockServer = createMockOpencodeServer({ sessions: [], sessionStatusCode: 404 });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("--session");
    });

    it("handles HTTP 500 from /session endpoint", async () => {
      const workspaceDir = tempDir.path;

      mockServer = createMockOpencodeServer({ sessions: [], sessionStatusCode: 500 });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("--session");
    });

    it("handles connection refused gracefully", async () => {
      // Don't start the mock server - port will refuse connections
      mockServer = createMockOpencodeServer({});
      // Get a port but then stop the server
      await mockServer.start();
      const port = mockServer.port;
      await mockServer.stop();

      // Execute with the closed port - use spawn instead of spawnSync
      const baseEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEHYDRA_OPENCODE_PORT") {
          baseEnv[key] = value;
        }
      }

      const env: Record<string, string> = {
        ...baseEnv,
        CODEHYDRA_OPENCODE_PORT: String(port),
        OPENCODE_EXIT_CODE: "0",
      };

      // spawnSync is OK here since no server needs to respond
      const result = spawnSync(process.execPath, [testStructure.scriptPath], {
        encoding: "utf8",
        env,
        cwd: tempDir.path,
      });

      // Should still work but without session/agent flags
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("--session");
    });
  });

  describe("session filtering", () => {
    it("excludes sessions with parentID (sub-agents)", async () => {
      const workspaceDir = tempDir.path;
      const sessions: MockSession[] = [
        { id: "ses-parent", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
        {
          id: "ses-child",
          directory: workspaceDir,
          parentID: "ses-parent",
          time: { updated: 2000 },
        },
      ];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ses-parent");
      expect(result.stdout).not.toContain("ses-child");
    });

    it("handles all sessions having parentID - no root sessions", async () => {
      const workspaceDir = tempDir.path;
      const sessions: MockSession[] = [
        { id: "ses-1", directory: workspaceDir, parentID: "other", time: { updated: 1000 } },
        { id: "ses-2", directory: workspaceDir, parentID: "other", time: { updated: 2000 } },
      ];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("--session");
    });

    it("filters by matching directory", async () => {
      const workspaceDir = tempDir.path;
      const otherDir = "/some/other/directory";
      const sessions: MockSession[] = [
        { id: "ses-other", directory: otherDir, parentID: null, time: { updated: 2000 } },
        { id: "ses-match", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
      ];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ses-match");
      expect(result.stdout).not.toContain("ses-other");
    });

    it("selects most recently updated session", async () => {
      const workspaceDir = tempDir.path;
      const sessions: MockSession[] = [
        { id: "ses-old", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
        { id: "ses-new", directory: workspaceDir, parentID: null, time: { updated: 3000 } },
        { id: "ses-mid", directory: workspaceDir, parentID: null, time: { updated: 2000 } },
      ];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ses-new");
    });

    it("handles malformed session (missing time.updated)", async () => {
      const workspaceDir = tempDir.path;
      // Sessions with missing time.updated should be treated as 0
      const sessions = [
        { id: "ses-no-time", directory: workspaceDir, parentID: null },
        { id: "ses-with-time", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
      ] as MockSession[];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const result = await executeWithMockServer(workspaceDir);

      expect(result.status).toBe(0);
      // Should select the one with time.updated since the other is treated as 0
      expect(result.stdout).toContain("ses-with-time");
    });
  });

  describe("performance", () => {
    it("completes within acceptable latency (<500ms with mock server)", async () => {
      const workspaceDir = tempDir.path;
      const sessions: MockSession[] = [
        { id: "ses-1", directory: workspaceDir, parentID: null, time: { updated: 1000 } },
      ];

      mockServer = createMockOpencodeServer({ sessions });
      await mockServer.start();

      const startTime = Date.now();
      const result = await executeWithMockServer(workspaceDir);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe(0);
      expect(elapsed).toBeLessThan(500);
    });
  });
});
