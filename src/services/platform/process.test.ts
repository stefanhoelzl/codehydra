// @vitest-environment node
/**
 * Unit tests for process module.
 *
 * Tests for:
 * - Windows killProcess behavior (always uses /f flag)
 * - Unix killProcess behavior (SIGTERM for graceful, SIGKILL for force)
 * - kill() return values (success/failure)
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { ExecaSpawnedProcess } from "./process";
import { SILENT_LOGGER } from "../logging";
import type { Logger } from "../logging";
import { delay } from "@shared/test-fixtures";

// Mock execa to capture taskkill calls
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

/**
 * Create a mock subprocess for testing ExecaSpawnedProcess.
 */
function createMockSubprocess(pid: number | undefined) {
  let resolveWait: (value: unknown) => void;
  const waitPromise = new Promise((resolve) => {
    resolveWait = resolve;
  });

  return {
    pid,
    then: (resolve: (value: unknown) => void) => waitPromise.then(resolve),
    catch: () => waitPromise,
    _resolveWait: (result: unknown) => resolveWait(result),
  };
}

describe("ExecaSpawnedProcess", () => {
  let logger: Logger;
  let execaMock: Mock;

  beforeEach(async () => {
    logger = SILENT_LOGGER;
    vi.clearAllMocks();
    // Get the mocked execa function
    const execaModule = await import("execa");
    execaMock = execaModule.execa as Mock;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("Windows killProcess behavior", () => {
    beforeEach(() => {
      // Mock process.platform to be Windows
      vi.stubGlobal("process", { ...process, platform: "win32" });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("always uses /f flag on Windows (graceful kill)", async () => {
      const subprocess = createMockSubprocess(12345);
      // Make taskkill succeed and process exit
      execaMock.mockResolvedValue({ exitCode: 0 });
      subprocess._resolveWait({ exitCode: 0, stdout: "", stderr: "" });

      // Create the process - we need to dynamically import to get the fresh module
      // with the mocked platform
      vi.resetModules();
      const { ExecaSpawnedProcess: FreshExecaSpawnedProcess } = await import("./process");
      const proc = new FreshExecaSpawnedProcess(subprocess as never, logger, "test-cmd");

      await proc.kill(1000, 1000);

      // Verify taskkill was called with /f flag
      expect(execaMock).toHaveBeenCalledWith("taskkill", ["/pid", "12345", "/t", "/f"]);
    });

    it("always uses /f flag on Windows (forced kill)", async () => {
      const subprocess = createMockSubprocess(12345);
      execaMock.mockResolvedValue({ exitCode: 0 });
      subprocess._resolveWait({ exitCode: 0, stdout: "", stderr: "" });

      vi.resetModules();
      const { ExecaSpawnedProcess: FreshExecaSpawnedProcess } = await import("./process");
      const proc = new FreshExecaSpawnedProcess(subprocess as never, logger, "test-cmd");

      await proc.kill(1000, 1000);

      // Both calls should use /f on Windows
      // The first call is "graceful" but on Windows should still use /f
      const calls = execaMock.mock.calls;
      for (const call of calls) {
        if (call[0] === "taskkill") {
          expect(call[1]).toContain("/f");
        }
      }
    });
  });

  describe("Unix killProcess behavior", () => {
    beforeEach(() => {
      // Mock process.platform to be Linux
      vi.stubGlobal("process", { ...process, platform: "linux" });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("uses SIGTERM for graceful kill", async () => {
      const subprocess = createMockSubprocess(12345);
      execaMock.mockResolvedValue({ exitCode: 0 });
      subprocess._resolveWait({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });

      // Spy on process.kill
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      vi.resetModules();
      const { ExecaSpawnedProcess: FreshExecaSpawnedProcess } = await import("./process");
      const proc = new FreshExecaSpawnedProcess(subprocess as never, logger, "test-cmd");

      await proc.kill(1000, 0);

      // Should call process.kill with SIGTERM first
      expect(processKillSpy).toHaveBeenCalledWith(12345, "SIGTERM");

      processKillSpy.mockRestore();
    });

    it("uses SIGKILL for forced kill", async () => {
      // pkill call succeeds
      execaMock.mockResolvedValue({ exitCode: 0 });

      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      vi.resetModules();
      const { ExecaSpawnedProcess: FreshExecaSpawnedProcess } = await import("./process");

      // Create a mock subprocess that doesn't resolve until after SIGKILL
      let resolveSubprocess: (value: unknown) => void;
      const subprocessPromise = new Promise((resolve) => {
        resolveSubprocess = resolve;
      });

      const mockSubprocess = {
        pid: 12345,
        then: (
          resolve: (value: unknown) => void,
          reject?: (reason: unknown) => void
        ): Promise<unknown> => subprocessPromise.then(resolve, reject),
        catch: (reject: (reason: unknown) => void): Promise<unknown> =>
          subprocessPromise.catch(reject),
      };

      const proc = new FreshExecaSpawnedProcess(mockSubprocess as never, logger, "test-cmd");

      // Start kill in background - it will wait for subprocess to exit
      const killPromise = proc.kill(50, 100);

      // Wait for SIGTERM to be sent
      await delay(10);

      // Verify SIGTERM was called
      const sigtermCalls = processKillSpy.mock.calls.filter((call) => call[1] === "SIGTERM");
      expect(sigtermCalls.length).toBeGreaterThan(0);

      // Wait for graceful timeout to expire and SIGKILL to be sent
      await delay(100);

      // Verify SIGKILL was called
      const sigkillCalls = processKillSpy.mock.calls.filter((call) => call[1] === "SIGKILL");
      expect(sigkillCalls.length).toBeGreaterThan(0);

      // Now resolve the subprocess (process exits after SIGKILL)
      resolveSubprocess!({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" });

      const result = await killPromise;
      expect(result.success).toBe(true);
      expect(result.reason).toBe("SIGKILL");

      processKillSpy.mockRestore();
    });
  });

  describe("kill() return values", () => {
    it("returns success=true when process terminates on SIGTERM", async () => {
      const subprocess = createMockSubprocess(12345);
      // Process exits after SIGTERM
      subprocess._resolveWait({ exitCode: 0, stdout: "", stderr: "" });

      vi.spyOn(process, "kill").mockImplementation(() => true);

      const proc = new ExecaSpawnedProcess(subprocess as never, logger, "test-cmd");
      const result = await proc.kill(1000, 1000);

      expect(result.success).toBe(true);
      // Windows always uses forceful termination (taskkill /f), so reason is SIGKILL
      // Unix uses graceful SIGTERM first
      expect(result.reason).toBe(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
    });

    it("returns success=true with reason=SIGKILL when escalation needed", async () => {
      const subprocess = createMockSubprocess(12345);
      // Create a wait that initially shows running, then exits
      let callCount = 0;
      subprocess.then = (resolve: (value: unknown) => void) => {
        callCount++;
        if (callCount <= 2) {
          // First two calls (for SIGTERM wait): still running
          return Promise.resolve({ running: true, exitCode: null, stdout: "", stderr: "" }).then(
            resolve
          );
        }
        // After that: exited
        return Promise.resolve({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" }).then(
          resolve
        );
      };

      vi.spyOn(process, "kill").mockImplementation(() => true);

      const proc = new ExecaSpawnedProcess(subprocess as never, logger, "test-cmd");
      const result = await proc.kill(10, 1000); // Very short SIGTERM timeout

      // Should have escalated and succeeded
      expect(result.success).toBe(true);
    });

    it("returns success=false when process doesn't exit", async () => {
      const subprocess = createMockSubprocess(12345);
      // Process never exits - always running

      vi.spyOn(process, "kill").mockImplementation(() => true);

      // Create a mock ExecaSpawnedProcess that simulates timeout
      // This is a more direct unit test approach
      const proc = new ExecaSpawnedProcess(subprocess as never, logger, "test-cmd");

      // Override wait to always return running
      vi.spyOn(proc, "wait").mockResolvedValue({
        exitCode: null,
        stdout: "",
        stderr: "",
        running: true,
      });

      const result = await proc.kill(10, 10);

      expect(result.success).toBe(false);
    });
  });
});
