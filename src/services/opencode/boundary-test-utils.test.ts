/**
 * Tests for boundary test utilities.
 */

import { describe, it, expect } from "vitest";
import { createMockProcessRunner, createMockSpawnedProcess } from "../platform/process.test-utils";
import { checkOpencodeAvailable, startOpencode } from "./boundary-test-utils";
import { createTestGitRepo } from "../test-utils";

describe("checkOpencodeAvailable", () => {
  it("returns available:true when opencode binary is found", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: 12345,
      waitResult: { exitCode: 0, stdout: "opencode version 1.2.3", stderr: "" },
    });
    const runner = createMockProcessRunner(mockProc);

    const result = await checkOpencodeAvailable(runner);

    expect(result.available).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.error).toBeUndefined();
  });

  it("returns available:false when binary not found (ENOENT)", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: null, // null means undefined (spawn failure)
      waitResult: { exitCode: null, stdout: "", stderr: "spawn opencode ENOENT" },
    });
    const runner = createMockProcessRunner(mockProc);

    const result = await checkOpencodeAvailable(runner);

    expect(result.available).toBe(false);
    expect(result.error).toBe("opencode binary not found in PATH");
    expect(result.version).toBeUndefined();
  });

  it("returns available:false when binary exits with error", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: 12345,
      waitResult: { exitCode: 1, stdout: "", stderr: "unknown command" },
    });
    const runner = createMockProcessRunner(mockProc);

    const result = await checkOpencodeAvailable(runner);

    expect(result.available).toBe(false);
    expect(result.error).toContain("exit code 1");
    expect(result.version).toBeUndefined();
  });

  it("returns available:false when command times out", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: 12345,
      waitResult: { exitCode: null, stdout: "", stderr: "", running: true },
    });
    const runner = createMockProcessRunner(mockProc);

    const result = await checkOpencodeAvailable(runner);

    expect(result.available).toBe(false);
    expect(result.error).toBe("opencode --version timed out");
    // kill() is called fire-and-forget style (no args) to terminate the timed-out process
    expect(mockProc.kill).toHaveBeenCalled();
  });

  it("parses version from 'v' prefixed output", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: 12345,
      waitResult: { exitCode: 0, stdout: "v2.0.0", stderr: "" },
    });
    const runner = createMockProcessRunner(mockProc);

    const result = await checkOpencodeAvailable(runner);

    expect(result.available).toBe(true);
    expect(result.version).toBe("2.0.0");
  });
});

describe("startOpencode", () => {
  it("starts opencode with correct arguments and environment", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: 12345,
      waitResult: { exitCode: 0, stdout: "", stderr: "" },
    });
    const runner = createMockProcessRunner(mockProc);
    const { path: cwd, cleanup } = await createTestGitRepo();

    try {
      const config = {
        port: 14096,
        cwd,
        config: {
          provider: { mock: { test: true } },
          model: "mock/test",
          permission: { bash: "ask" as const, edit: "allow" as const, webfetch: "allow" as const },
        },
      };

      const proc = await startOpencode(config, runner);

      expect(proc.pid).toBe(12345);
      expect(runner.run).toHaveBeenCalledWith(
        "opencode",
        ["serve", "--port", "14096"],
        expect.objectContaining({
          cwd,
          env: expect.objectContaining({
            NO_COLOR: "1",
          }),
        })
      );

      // Verify config file was written to the cwd
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const configPath = join(cwd, "opencode.jsonc");
      expect(existsSync(configPath)).toBe(true);

      const configContent = readFileSync(configPath, "utf-8");
      const parsedConfig = JSON.parse(configContent) as Record<string, unknown>;
      expect((parsedConfig.provider as Record<string, unknown>).mock).toEqual({ test: true });
      expect(parsedConfig.model).toBe("mock/test");
      expect((parsedConfig.permission as Record<string, unknown>).bash).toBe("ask");
    } finally {
      await cleanup();
    }
  });

  it("throws when process fails to spawn", async () => {
    const mockProc = createMockSpawnedProcess({
      pid: null, // null means undefined (spawn failure)
      waitResult: { exitCode: null, stdout: "", stderr: "spawn opencode ENOENT" },
    });
    const runner = createMockProcessRunner(mockProc);
    const { path: cwd, cleanup } = await createTestGitRepo();

    try {
      const config = {
        port: 14096,
        cwd,
        config: {
          provider: {},
          model: "mock/test",
          permission: { bash: "ask" as const, edit: "allow" as const, webfetch: "allow" as const },
        },
      };

      await expect(startOpencode(config, runner)).rejects.toThrow("Failed to start opencode");
    } finally {
      await cleanup();
    }
  });

  it("stop() uses graceful shutdown with timeouts", async () => {
    // Mock process with graceful shutdown result
    const mockProc = createMockSpawnedProcess({
      pid: 12345,
      killResult: { success: true, reason: "SIGTERM" },
      waitResult: { exitCode: 0, stdout: "", stderr: "" },
    });

    const runner = createMockProcessRunner(mockProc);
    const { path: cwd, cleanup } = await createTestGitRepo();

    try {
      const config = {
        port: 14096,
        cwd,
        config: {
          provider: {},
          model: "mock/test",
          permission: { bash: "ask" as const, edit: "allow" as const, webfetch: "allow" as const },
        },
      };

      const proc = await startOpencode(config, runner);
      await proc.stop();

      // stop() uses kill(5000, 1000) for graceful shutdown
      expect(mockProc.kill).toHaveBeenCalledWith(5000, 1000);
      expect(mockProc.kill).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });
});
