// @vitest-environment node
/**
 * Tests for ExecaSpawnedProcess class.
 * These tests verify the SpawnedProcess interface implementation.
 *
 * All tests use Node.js commands for cross-platform compatibility.
 * This ensures identical behavior on Windows, macOS, and Linux.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, writeFile, chmod, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ExecaSpawnedProcess } from "./process";
import type { ProcessTreeProvider } from "./process-tree";
import { createSilentLogger, type Logger } from "../logging";

/** Create a mock ProcessTreeProvider for tests */
function createMockProcessTree(): ProcessTreeProvider {
  return {
    getDescendantPids: vi.fn().mockResolvedValue(new Set<number>()),
  };
}

/** Create a long-running Node.js process (cross-platform alternative to `sleep`) */
const longRunningScript = "setTimeout(() => {}, 10000)";

/** Create a quick Node.js process that outputs to stdout */
const echoScript = (text: string) => `console.log('${text}')`;

/** Create a quick Node.js process that outputs to stderr */
const stderrScript = (text: string) => `console.error('${text}')`;

/** Create a Node.js process that exits with a specific code */
const exitScript = (code: number) => `process.exit(${code})`;

/** Shared test dependencies */
let mockProcessTree: ProcessTreeProvider;
let logger: Logger;

/**
 * Type alias for execa subprocess - using the type from process.ts.
 * We cast execa results to this type because execa's ResultPromise type
 * has issues with exactOptionalPropertyTypes when specific options are provided.
 */
type ExecaSubprocess = ReturnType<typeof execa>;

/**
 * Helper to create ExecaSpawnedProcess with proper dependencies.
 * Expects the subprocess to be cast to ExecaSubprocess at the call site.
 */
function createSpawned(subprocess: ExecaSubprocess, command = "node"): ExecaSpawnedProcess {
  return new ExecaSpawnedProcess(subprocess, mockProcessTree, logger, command);
}

/**
 * Helper to create execa subprocess with standard test options.
 * Returns the subprocess cast to ExecaSubprocess to work around type issues.
 */
function createExecaProcess(command: string, args: string[]): ExecaSubprocess {
  return execa(command, args, {
    cleanup: true,
    encoding: "utf8",
    reject: false,
  }) as unknown as ExecaSubprocess;
}

describe("ExecaSpawnedProcess", () => {
  // Track spawned processes for cleanup
  const runningProcesses: ExecaSpawnedProcess[] = [];

  // Initialize shared dependencies before each test
  beforeEach(() => {
    mockProcessTree = createMockProcessTree();
    logger = createSilentLogger();
  });

  afterEach(async () => {
    // Clean up any running processes
    for (const proc of runningProcesses) {
      try {
        await proc.kill(0, 100);
      } catch {
        // Ignore cleanup errors
      }
    }
    runningProcesses.length = 0;
  });

  describe("pid", () => {
    it("returns process ID", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      expect(spawned.pid).toBeGreaterThan(0);

      // Cleanup
      await spawned.kill(0, 100);
    });

    it("handles spawn failure for nonexistent binary", async () => {
      const subprocess = createExecaProcess("nonexistent-binary-12345", []);
      const spawned = createSpawned(subprocess, "nonexistent-binary-12345");

      // Platform-specific behavior:
      // - Unix: spawn fails immediately, pid is undefined
      // - Windows: shell spawns first (pid defined), then command lookup fails
      if (process.platform === "win32") {
        const result = await spawned.wait();
        expect(result.exitCode).not.toBe(0);
      } else {
        expect(spawned.pid).toBeUndefined();
        const result = await spawned.wait();
        expect(result.exitCode).toBeNull();
      }
    });
  });

  describe("kill", () => {
    it("kill() with SIGTERM timeout terminates responsive process", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      // kill(5000, 0) - wait up to 5s for SIGTERM, don't wait for SIGKILL
      const result = await spawned.kill(5000, 0);

      expect(result.success).toBe(true);
      expect(result.reason).toBe("SIGTERM");
    });

    it("kill() on dead process returns success", async () => {
      const subprocess = createExecaProcess("node", ["-e", echoScript("hello")]);
      const spawned = createSpawned(subprocess);

      // Wait for process to complete
      await spawned.wait();

      // Now try to kill it - should succeed (nothing to do)
      const result = await spawned.kill(100, 100);

      expect(result.success).toBe(true);
      expect(result.reason).toBe("SIGTERM");
    });

    it("kill() without timeouts sends signals immediately", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      // kill() with no timeouts - sends SIGTERM then SIGKILL, no wait
      const result = await spawned.kill();

      // Since we don't wait, success is false
      expect(result.success).toBe(false);

      // But the process should be killed - wait for it
      const waitResult = await spawned.wait(1000);
      expect(waitResult.exitCode).toBeNull(); // Killed by signal
    });
  });

  describe("wait", () => {
    it("returns result on normal exit (exit 0)", async () => {
      const subprocess = createExecaProcess("node", ["-e", echoScript("hello")]);
      const spawned = createSpawned(subprocess);

      const result = await spawned.wait();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello");
      expect(result.stderr).toBe("");
      expect(result.running).toBeUndefined();
    });

    it("returns result on non-zero exit (no throw)", async () => {
      const subprocess = createExecaProcess("node", ["-e", exitScript(42)]);
      const spawned = createSpawned(subprocess);

      const result = await spawned.wait();

      expect(result.exitCode).toBe(42);
      expect(result.running).toBeUndefined();
    });

    it("returns signal when killed via kill()", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      await spawned.kill(5000, 0);
      const result = await spawned.wait();

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe("SIGTERM");
      expect(result.running).toBeUndefined();
    });

    it("returns running:true on timeout", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      const result = await spawned.wait(50); // 50ms timeout

      expect(result.running).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeUndefined();

      // Cleanup
      await spawned.kill(0, 100);
    });

    it("returns result if process exits before timeout", async () => {
      const subprocess = createExecaProcess("node", ["-e", echoScript("fast")]);
      const spawned = createSpawned(subprocess);

      const result = await spawned.wait(5000); // 5s timeout

      expect(result.running).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fast");
    });

    it("can be called multiple times with same result", async () => {
      const subprocess = createExecaProcess("node", ["-e", echoScript("test")]);
      const spawned = createSpawned(subprocess);

      const result1 = await spawned.wait();
      const result2 = await spawned.wait();

      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      expect(result1.stdout).toEqual(result2.stdout);
    });

    it("handles different timeouts on subsequent calls", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      // First call with short timeout
      const result1 = await spawned.wait(50);
      expect(result1.running).toBe(true);

      // Second call with no timeout after killing
      await spawned.kill(5000, 0);
      const result2 = await spawned.wait();
      expect(result2.running).toBeUndefined();
      expect(result2.signal).toBe("SIGTERM");
    });

    it("resolves with signal when killed during wait", async () => {
      const subprocess = createExecaProcess("node", ["-e", longRunningScript]);
      const spawned = createSpawned(subprocess);
      runningProcesses.push(spawned);

      // Start waiting
      const waitPromise = spawned.wait();

      // Kill after a small delay
      setTimeout(() => void spawned.kill(5000, 0), 10);

      const result = await waitPromise;

      expect(result.signal).toBe("SIGTERM");
    });

    it("captures stdout", async () => {
      const subprocess = createExecaProcess("node", ["-e", echoScript("output text")]);
      const spawned = createSpawned(subprocess);

      const result = await spawned.wait();

      expect(result.stdout).toContain("output text");
    });

    it("captures stderr", async () => {
      const subprocess = createExecaProcess("node", ["-e", stderrScript("error message")]);
      const spawned = createSpawned(subprocess);

      const result = await spawned.wait();

      expect(result.stderr).toContain("error message");
    });
  });

  describe("error handling", () => {
    it("handles nonexistent binary", async () => {
      const subprocess = createExecaProcess("nonexistent-binary-xyz-123", []);
      const spawned = createSpawned(subprocess, "nonexistent-binary-xyz-123");

      const result = await spawned.wait();

      // Platform-specific behavior:
      // - Unix: exitCode is null, stderr contains ENOENT
      // - Windows: exitCode is non-zero, stderr contains error message
      if (process.platform === "win32") {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.length).toBeGreaterThan(0);
      } else {
        expect(result.exitCode).toBeNull();
        expect(result.stderr).toContain("ENOENT");
      }
    });

    // Skip on Windows: Windows doesn't have Unix-style execute permissions.
    // Executability is determined by file extension (.exe, .bat, .cmd), not permissions.
    // Running a .txt file on Windows may hang or behave unpredictably.
    it.skipIf(process.platform === "win32")("handles non-executable file", async () => {
      // Create a temp file that exists but isn't executable
      const tempDir = await mkdtemp(join(tmpdir(), "process-test-"));
      const tempFile = join(tempDir, "not-executable.txt");
      await writeFile(tempFile, "just text, not executable code");

      // Ensure no execute permission on Unix
      await chmod(tempFile, 0o644);

      try {
        const subprocess = createExecaProcess(tempFile, []);
        const spawned = createSpawned(subprocess, tempFile);

        const result = await spawned.wait();

        // Unix: fails with EACCES (no execute permission)
        expect(result.exitCode).toBeNull();
        expect(result.stderr.toLowerCase()).toMatch(/eacces|permission/);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles ENOTDIR (not a directory)", async () => {
      // Try to run a command with a file as cwd - but we can't test cwd here
      // since ExecaSpawnedProcess takes an already-spawned subprocess.
      // This test would need to be at ProcessRunner level.
      // For now, skip this as it's tested at ExecaProcessRunner level.
    });
  });
});
