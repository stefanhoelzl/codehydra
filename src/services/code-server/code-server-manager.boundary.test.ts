// @vitest-environment node
/**
 * Boundary tests for CodeServerManager.
 * These tests verify the full lifecycle of code-server with real dependencies:
 * - ExecaProcessRunner for process spawning
 * - DefaultNetworkLayer for HTTP and port management
 *
 * Tests interact with the actual code-server binary and verify:
 * - Startup and shutdown
 * - Health check endpoint
 * - PID callbacks
 * - Concurrent access
 * - Environment variable isolation
 * - Restart scenarios
 * - Edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CodeServerManager } from "./code-server-manager";
import { ExecaProcessRunner } from "../platform/process";
import { DefaultNetworkLayer } from "../platform/network";
import { createTempDir } from "../test-utils";
import type { CodeServerConfig } from "./types";

// Platform detection for signal tests
const isWindows = process.platform === "win32";

// Default timeout for boundary tests (code-server startup is typically 1-2s)
const TEST_TIMEOUT = 5000;

// Track spawned PIDs for fallback cleanup
const spawnedPids: number[] = [];

/**
 * Check if a process is running at OS level.
 * Uses signal 0 which doesn't actually send a signal but checks if the process exists.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

/**
 * Create test config with proper typing.
 */
function createTestConfig(baseDir: string): CodeServerConfig {
  return {
    runtimeDir: baseDir,
    extensionsDir: `${baseDir}/extensions`,
    userDataDir: `${baseDir}/user-data`,
    binDir: `${baseDir}/bin`,
  };
}

describe("CodeServerManager (boundary)", () => {
  let manager: CodeServerManager;
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async (): Promise<void> => {
    // Use documented test utility for temp directory
    const temp = await createTempDir();
    tempDir = temp.path;
    cleanup = temp.cleanup;

    // Real dependencies - no mocks
    const runner = new ExecaProcessRunner();
    const { createSilentLogger } = await import("../logging");
    const logger = createSilentLogger();
    const networkLayer = new DefaultNetworkLayer(logger);

    manager = new CodeServerManager(
      createTestConfig(tempDir),
      runner,
      networkLayer,
      networkLayer,
      logger
    );
  });

  afterEach(async (): Promise<void> => {
    // Track PID before stopping for fallback cleanup
    const pid = manager.pid();
    if (pid !== null) {
      spawnedPids.push(pid);
    }

    // Primary cleanup: use manager.stop()
    try {
      await manager.stop();
    } catch {
      // Ignore cleanup errors - process may already be dead
    }

    // Fallback cleanup: force kill any tracked PIDs
    for (const trackedPid of spawnedPids) {
      try {
        process.kill(trackedPid, "SIGKILL");
      } catch {
        // Process already dead - expected
      }
    }
    spawnedPids.length = 0;

    // Remove temp directory
    await cleanup();
  });

  describe("lifecycle", () => {
    it(
      "ensureRunning() starts code-server and returns a port",
      async () => {
        // Arrange: (manager created in beforeEach)

        // Act
        const port = await manager.ensureRunning();

        // Assert
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThanOrEqual(65535);
      },
      TEST_TIMEOUT
    );

    it(
      "isRunning() returns true after startup",
      async () => {
        // Arrange
        await manager.ensureRunning();

        // Act
        const running = manager.isRunning();

        // Assert
        expect(running).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "pid() returns valid PID after startup",
      async () => {
        // Arrange
        await manager.ensureRunning();

        // Act
        const pid = manager.pid();

        // Assert
        expect(pid).not.toBeNull();
        expect(pid).toBeGreaterThan(0);
        // Verify at OS level
        expect(isProcessRunning(pid!)).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "stop() terminates process and isRunning() returns false",
      async () => {
        // Arrange
        await manager.ensureRunning();
        const pid = manager.pid();

        // Act
        await manager.stop();

        // Assert
        expect(manager.isRunning()).toBe(false);
        expect(manager.pid()).toBeNull();
        // Verify at OS level - process should be dead
        if (pid !== null) {
          expect(isProcessRunning(pid)).toBe(false);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe("health check", () => {
    it(
      "port() returns the actual listening port",
      async () => {
        // Arrange
        const returnedPort = await manager.ensureRunning();

        // Act
        const port = manager.port();

        // Assert
        expect(port).toBe(returnedPort);
      },
      TEST_TIMEOUT
    );

    it(
      "direct HTTP GET to /healthz returns 200",
      async () => {
        // Arrange
        const port = await manager.ensureRunning();

        // Act - bypass CodeServerManager, hit endpoint directly
        const response = await fetch(`http://localhost:${port}/healthz`);

        // Assert
        expect(response.status).toBe(200);
      },
      TEST_TIMEOUT
    );
  });

  describe("callbacks", () => {
    it(
      "onPidChanged fires with valid PID on startup",
      async () => {
        // Arrange
        const callback = vi.fn<(pid: number | null) => void>();
        manager.onPidChanged(callback);

        // Act
        await manager.ensureRunning();

        // Assert
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(expect.any(Number));
        const receivedPid = callback.mock.calls[0]?.[0];
        expect(receivedPid).toBeGreaterThan(0);
      },
      TEST_TIMEOUT
    );

    it(
      "onPidChanged fires with null on stop",
      async () => {
        // Arrange
        const callback = vi.fn<(pid: number | null) => void>();
        await manager.ensureRunning();
        manager.onPidChanged(callback);
        callback.mockClear();

        // Act
        await manager.stop();

        // Assert
        expect(callback).toHaveBeenCalledWith(null);
      },
      TEST_TIMEOUT
    );
  });

  describe("concurrent access", () => {
    it(
      "multiple concurrent ensureRunning() calls return same port",
      async () => {
        // Arrange
        const promises: Promise<number>[] = [
          manager.ensureRunning(),
          manager.ensureRunning(),
          manager.ensureRunning(),
        ];

        // Act
        const ports = await Promise.all(promises);

        // Assert - all same port
        expect(new Set(ports).size).toBe(1);
        expect(ports[0]).toBeGreaterThan(0);
        expect(manager.pid()).toBeGreaterThan(0);
      },
      TEST_TIMEOUT
    );
  });

  describe("environment isolation", () => {
    it(
      "starts successfully with VSCODE_* env vars present",
      async () => {
        // Arrange - save original env
        const originalIpcHook = process.env.VSCODE_IPC_HOOK;
        const originalAskpass = process.env.VSCODE_GIT_ASKPASS_MAIN;

        try {
          // Pollute environment
          process.env.VSCODE_IPC_HOOK = "/fake/socket";
          process.env.VSCODE_GIT_ASKPASS_MAIN = "/fake/askpass";

          // Act
          const port = await manager.ensureRunning();

          // Assert
          expect(port).toBeGreaterThan(0);
          expect(manager.isRunning()).toBe(true);
        } finally {
          // Restore original env
          if (originalIpcHook === undefined) {
            delete process.env.VSCODE_IPC_HOOK;
          } else {
            process.env.VSCODE_IPC_HOOK = originalIpcHook;
          }
          if (originalAskpass === undefined) {
            delete process.env.VSCODE_GIT_ASKPASS_MAIN;
          } else {
            process.env.VSCODE_GIT_ASKPASS_MAIN = originalAskpass;
          }
        }
      },
      TEST_TIMEOUT
    );
  });

  describe("restart", () => {
    it(
      "can call ensureRunning() after stop()",
      async () => {
        // Arrange
        await manager.ensureRunning();
        const firstPid = manager.pid();
        await manager.stop();

        // Act
        const secondPort = await manager.ensureRunning();
        const secondPid = manager.pid();

        // Assert
        expect(secondPort).toBeGreaterThan(0);
        expect(secondPid).toBeGreaterThan(0);
        expect(secondPid).not.toBe(firstPid); // Different PID
      },
      TEST_TIMEOUT
    );

    it(
      "rapid stop-start cycle completes without errors",
      async () => {
        // Arrange & Act
        await manager.ensureRunning();
        await manager.stop();
        await manager.ensureRunning();
        await manager.stop();
        const finalPort = await manager.ensureRunning();

        // Assert
        expect(finalPort).toBeGreaterThan(0);
        expect(manager.isRunning()).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe("edge cases", () => {
    it(
      "stop() without prior ensureRunning() is a no-op",
      async () => {
        // Arrange: manager created but not started

        // Act & Assert - should not throw
        await expect(manager.stop()).resolves.toBeUndefined();
        expect(manager.isRunning()).toBe(false);
      },
      TEST_TIMEOUT
    );

    it.skipIf(isWindows)(
      "after external SIGKILL, manager handles gracefully",
      async () => {
        // Arrange
        await manager.ensureRunning();
        const pid = manager.pid();
        expect(pid).not.toBeNull();

        // Act - kill process externally
        process.kill(pid!, "SIGKILL");
        // Wait for process to die
        await new Promise((r) => setTimeout(r, 100));

        // Assert - calling stop() should handle it gracefully
        await expect(manager.stop()).resolves.toBeUndefined();
      },
      TEST_TIMEOUT
    );
  });
});
