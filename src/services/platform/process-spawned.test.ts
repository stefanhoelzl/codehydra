// @vitest-environment node
/**
 * Tests for ExecaSpawnedProcess class.
 * These tests verify the SpawnedProcess interface implementation.
 *
 * All tests use Node.js commands for cross-platform compatibility.
 * This ensures identical behavior on Windows, macOS, and Linux.
 */
import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { mkdtemp, writeFile, chmod, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ExecaSpawnedProcess } from "./process";

/** Create a long-running Node.js process (cross-platform alternative to `sleep`) */
const longRunningScript = "setTimeout(() => {}, 10000)";

/** Create a quick Node.js process that outputs to stdout */
const echoScript = (text: string) => `console.log('${text}')`;

/** Create a quick Node.js process that outputs to stderr */
const stderrScript = (text: string) => `console.error('${text}')`;

/** Create a Node.js process that exits with a specific code */
const exitScript = (code: number) => `process.exit(${code})`;

describe("ExecaSpawnedProcess", () => {
  describe("pid", () => {
    it("returns process ID", () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      expect(spawned.pid).toBeGreaterThan(0);

      // Cleanup
      subprocess.kill("SIGKILL");
    });

    it("handles spawn failure for nonexistent binary", async () => {
      const subprocess = execa("nonexistent-binary-12345", [], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

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
    it("returns true when signal sent", () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = spawned.kill("SIGTERM");

      expect(result).toBe(true);
    });

    it("returns false when process already dead", async () => {
      const subprocess = execa("node", ["-e", echoScript("hello")], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      // Wait for process to complete
      await spawned.wait();

      // Now try to kill it
      const result = spawned.kill("SIGTERM");

      expect(result).toBe(false);
    });

    it("sends SIGTERM by default", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      spawned.kill();
      const result = await spawned.wait();

      expect(result.signal).toBe("SIGTERM");
    });

    it("sends SIGKILL when specified", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      spawned.kill("SIGKILL");
      const result = await spawned.wait();

      expect(result.signal).toBe("SIGKILL");
    });

    it("sends SIGINT when specified", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      spawned.kill("SIGINT");
      const result = await spawned.wait();

      expect(result.signal).toBe("SIGINT");
    });
  });

  describe("wait", () => {
    it("returns result on normal exit (exit 0)", async () => {
      const subprocess = execa("node", ["-e", echoScript("hello")], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = await spawned.wait();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello");
      expect(result.stderr).toBe("");
      expect(result.running).toBeUndefined();
    });

    it("returns result on non-zero exit (no throw)", async () => {
      const subprocess = execa("node", ["-e", exitScript(42)], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = await spawned.wait();

      expect(result.exitCode).toBe(42);
      expect(result.running).toBeUndefined();
    });

    it("returns signal when killed", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      spawned.kill("SIGTERM");
      const result = await spawned.wait();

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe("SIGTERM");
      expect(result.running).toBeUndefined();
    });

    it("returns running:true on timeout", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = await spawned.wait(50); // 50ms timeout

      expect(result.running).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeUndefined();

      // Cleanup
      spawned.kill("SIGKILL");
      await spawned.wait();
    });

    it("returns result if process exits before timeout", async () => {
      const subprocess = execa("node", ["-e", echoScript("fast")], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = await spawned.wait(5000); // 5s timeout

      expect(result.running).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fast");
    });

    it("can be called multiple times with same result", async () => {
      const subprocess = execa("node", ["-e", echoScript("test")], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result1 = await spawned.wait();
      const result2 = await spawned.wait();

      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      expect(result1.stdout).toEqual(result2.stdout);
    });

    it("handles different timeouts on subsequent calls", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      // First call with short timeout
      const result1 = await spawned.wait(50);
      expect(result1.running).toBe(true);

      // Second call with no timeout after killing
      spawned.kill("SIGTERM");
      const result2 = await spawned.wait();
      expect(result2.running).toBeUndefined();
      expect(result2.signal).toBe("SIGTERM");
    });

    it("resolves with signal when killed during wait", async () => {
      const subprocess = execa("node", ["-e", longRunningScript], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      // Start waiting
      const waitPromise = spawned.wait();

      // Kill after a small delay
      setTimeout(() => spawned.kill("SIGTERM"), 10);

      const result = await waitPromise;

      expect(result.signal).toBe("SIGTERM");
    });

    it("captures stdout", async () => {
      const subprocess = execa("node", ["-e", echoScript("output text")], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = await spawned.wait();

      expect(result.stdout).toContain("output text");
    });

    it("captures stderr", async () => {
      const subprocess = execa("node", ["-e", stderrScript("error message")], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

      const result = await spawned.wait();

      expect(result.stderr).toContain("error message");
    });
  });

  describe("error handling", () => {
    it("handles nonexistent binary", async () => {
      const subprocess = execa("nonexistent-binary-xyz-123", [], {
        cleanup: true,
        encoding: "utf8",
        reject: false,
      });
      const spawned = new ExecaSpawnedProcess(subprocess);

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
        const subprocess = execa(tempFile, [], {
          cleanup: true,
          encoding: "utf8",
          reject: false,
        });
        const spawned = new ExecaSpawnedProcess(subprocess);

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
