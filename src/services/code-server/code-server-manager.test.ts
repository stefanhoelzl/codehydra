// @vitest-environment node
/**
 * Unit tests for CodeServerManager.
 * Uses mocked dependencies for process spawning and network tests.
 */

import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CodeServerManager,
  urlForFolder,
  CODE_SERVER_PORT,
  getCodeServerPort,
} from "./code-server-manager";
import { createMockProcessRunner, type MockProcessRunner } from "../platform/process.state-mock";
import { createPortManagerMock } from "../platform/network.test-utils";
import { createMockHttpClient } from "../platform/http-client.state-mock";
import type { HttpClient, PortManager } from "../platform/network";
import { SILENT_LOGGER } from "../logging";
import { createMockBuildInfo } from "../platform/build-info.test-utils";

const testLogger = SILENT_LOGGER;

describe("urlForFolder", () => {
  it("generates correct URL with folder path", () => {
    const url = urlForFolder(8080, "/home/user/projects/my-repo");

    expect(url).toBe("http://127.0.0.1:8080/?folder=/home/user/projects/my-repo");
  });

  it("encodes spaces in folder path", () => {
    const url = urlForFolder(8080, "/home/user/My Projects/repo");

    expect(url).toBe("http://127.0.0.1:8080/?folder=/home/user/My%20Projects/repo");
  });

  it("encodes special characters in path", () => {
    const url = urlForFolder(8080, "/home/user/project#1");

    expect(url).toBe("http://127.0.0.1:8080/?folder=/home/user/project%231");
  });

  it("handles Windows paths", () => {
    // Windows paths need to be converted for URL
    const url = urlForFolder(8080, "C:/Users/user/projects/repo");

    expect(url).toBe("http://127.0.0.1:8080/?folder=/C:/Users/user/projects/repo");
  });

  it("handles unicode characters", () => {
    const url = urlForFolder(8080, "/home/user/cafe");

    expect(url).toBe("http://127.0.0.1:8080/?folder=/home/user/cafe");
  });
});

describe("CodeServerManager", () => {
  let manager: CodeServerManager;
  let mockProcessRunner: MockProcessRunner;
  let mockHttpClient: HttpClient;
  let mockPortManager: PortManager;

  const defaultConfig = {
    port: CODE_SERVER_PORT,
    binaryPath: "/usr/bin/code-server",
    runtimeDir: "/tmp/code-server-runtime",
    extensionsDir: "/tmp/code-server-extensions",
    userDataDir: "/tmp/code-server-user-data",
    binDir: "/app/bin",
    codeServerDir: "/app/code-server-dir",
    opencodeDir: "/app/opencode-dir",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Process mock returns running: true so health check sees process is still alive
    mockProcessRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });
    // Mock HttpClient that returns 200 for health checks
    mockHttpClient = createMockHttpClient({
      defaultResponse: { status: 200 },
    });
    mockPortManager = createPortManagerMock([8080]);
    manager = new CodeServerManager(
      defaultConfig,
      mockProcessRunner,
      mockHttpClient,
      mockPortManager,
      testLogger
    );
  });

  afterEach(async () => {
    // Ensure cleanup
    try {
      await manager.stop();
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe("constructor", () => {
    it("accepts HttpClient and PortManager", () => {
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock();
      const processRunner = createMockProcessRunner();
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/usr/bin/code-server",
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server-dir",
        opencodeDir: "/app/opencode-dir",
      };

      const instance = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );

      expect(instance).toBeInstanceOf(CodeServerManager);
    });
  });

  describe("initial state", () => {
    it("starts in stopped state", () => {
      expect(manager.isRunning()).toBe(false);
    });

    it("has no port initially", () => {
      expect(manager.port()).toBeNull();
    });

    it("has no pid initially", () => {
      expect(manager.pid()).toBeNull();
    });
  });

  describe("isRunning", () => {
    it("returns false when stopped", () => {
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("port", () => {
    it("returns null when not running", () => {
      expect(manager.port()).toBeNull();
    });
  });

  describe("pid", () => {
    it("returns null when not running", () => {
      expect(manager.pid()).toBeNull();
    });
  });

  describe("getState", () => {
    it("returns stopped initially", () => {
      expect(manager.getState()).toBe("stopped");
    });
  });

  describe("ensureRunning", () => {
    it("uses fixed CODE_SERVER_PORT for consistent IndexedDB storage", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      mockHttpClient = { fetch: fetchMock };
      manager = new CodeServerManager(
        {
          port: CODE_SERVER_PORT,
          binaryPath: "/usr/bin/code-server",
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
          codeServerDir: "/app/code-server-dir",
          opencodeDir: "/app/opencode-dir",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      const port = await manager.ensureRunning();

      expect(port).toBe(CODE_SERVER_PORT);
    });

    it("returns same port when already running", async () => {
      // First call starts the server
      const port1 = await manager.ensureRunning();

      // Second call should return same port without starting again
      const port2 = await manager.ensureRunning();

      expect(port1).toBe(port2);
      expect(manager.isRunning()).toBe(true);
    });

    it("returns same port for concurrent calls", async () => {
      // Start two concurrent calls
      const [port1, port2] = await Promise.all([manager.ensureRunning(), manager.ensureRunning()]);

      expect(port1).toBe(port2);
      // Verify only one spawn occurred
      expect(mockProcessRunner).toHaveSpawned([{ command: "/usr/bin/code-server" }]);
    });
  });

  describe("health check", () => {
    it("uses httpClient.fetch() with 1s timeout", async () => {
      const mock = createMockHttpClient({
        defaultResponse: { status: 200 },
      });
      mockHttpClient = mock;
      manager = new CodeServerManager(
        {
          port: CODE_SERVER_PORT,
          binaryPath: "/usr/bin/code-server",
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
          codeServerDir: "/app/code-server-dir",
          opencodeDir: "/app/opencode-dir",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      await manager.ensureRunning();

      // Check captured options from mock state
      expect(mock.$.requests.length).toBeGreaterThan(0);
      expect(mock.$.requests[0]?.options?.timeout).toBe(1000);
    });

    it("returns true on 200 status", async () => {
      mockHttpClient = createMockHttpClient({
        defaultResponse: { status: 200 },
      });
      manager = new CodeServerManager(
        {
          port: CODE_SERVER_PORT,
          binaryPath: "/usr/bin/code-server",
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
          codeServerDir: "/app/code-server-dir",
          opencodeDir: "/app/opencode-dir",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      // Should complete successfully (health check passed)
      const port = await manager.ensureRunning();

      expect(port).toBe(CODE_SERVER_PORT);
      expect(manager.isRunning()).toBe(true);
    });

    it("returns false on non-200 status (retries until success)", async () => {
      // Use vi.fn() for stateful behavior: first returns 503, then 200
      let callCount = 0;
      const fetchMock = vi.fn(async () => {
        callCount++;
        // First few calls return 503, then 200
        if (callCount < 3) {
          return new Response("", { status: 503 });
        }
        return new Response("", { status: 200 });
      });
      mockHttpClient = { fetch: fetchMock };
      manager = new CodeServerManager(
        {
          port: CODE_SERVER_PORT,
          binaryPath: "/usr/bin/code-server",
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
          codeServerDir: "/app/code-server-dir",
          opencodeDir: "/app/opencode-dir",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      const port = await manager.ensureRunning();

      expect(port).toBe(CODE_SERVER_PORT);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it("returns false on network error", async () => {
      // Use vi.fn() for stateful behavior: first throws, then succeeds
      let callCount = 0;
      const fetchMock = vi.fn(async () => {
        callCount++;
        // First few calls throw, then succeed
        if (callCount < 3) {
          throw new Error("Connection refused");
        }
        return new Response("", { status: 200 });
      });
      mockHttpClient = { fetch: fetchMock };
      manager = new CodeServerManager(
        {
          port: CODE_SERVER_PORT,
          binaryPath: "/usr/bin/code-server",
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
          codeServerDir: "/app/code-server-dir",
          opencodeDir: "/app/opencode-dir",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      const port = await manager.ensureRunning();

      expect(port).toBe(CODE_SERVER_PORT);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe("onPidChanged", () => {
    it("calls callback when PID changes during startup", async () => {
      const callback = vi.fn();
      manager.onPidChanged(callback);

      await manager.ensureRunning();

      expect(callback).toHaveBeenCalledWith(12345);
    });

    it("calls callback with null when server stops", async () => {
      const callback = vi.fn();
      manager.onPidChanged(callback);

      await manager.ensureRunning();
      callback.mockClear(); // Clear the startup call

      await manager.stop();

      expect(callback).toHaveBeenCalledWith(null);
    });

    it("returns unsubscribe function", async () => {
      const callback = vi.fn();
      const unsubscribe = manager.onPidChanged(callback);

      // Unsubscribe before starting
      unsubscribe();

      await manager.ensureRunning();

      expect(callback).not.toHaveBeenCalled();
    });

    it("supports multiple listeners", async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      manager.onPidChanged(callback1);
      manager.onPidChanged(callback2);

      await manager.ensureRunning();

      expect(callback1).toHaveBeenCalledWith(12345);
      expect(callback2).toHaveBeenCalledWith(12345);
    });
  });

  describe("stop", () => {
    it("transitions state correctly", async () => {
      // Start the server
      await manager.ensureRunning();
      expect(manager.getState()).toBe("running");
      expect(manager.isRunning()).toBe(true);

      // Stop the server
      await manager.stop();
      expect(manager.getState()).toBe("stopped");
      expect(manager.isRunning()).toBe(false);
      expect(manager.port()).toBeNull();
      expect(manager.pid()).toBeNull();
    });

    it("is idempotent when already stopped", async () => {
      expect(manager.getState()).toBe("stopped");

      // Should not throw when already stopped
      await expect(manager.stop()).resolves.toBeUndefined();

      expect(manager.getState()).toBe("stopped");
    });
  });
});

/**
 * Tests for CodeServerManager with ProcessRunner DI.
 * These tests verify the new interface using dependency injection.
 */
describe("CodeServerManager (with full DI)", () => {
  describe("constructor", () => {
    it("accepts all four dependencies", () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock();
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/usr/bin/code-server",
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server-dir",
        opencodeDir: "/app/opencode-dir",
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );

      expect(manager).toBeInstanceOf(CodeServerManager);
    });

    it("uses provided ProcessRunner for spawning processes", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 99999, running: true }),
      });
      const httpClient = createMockHttpClient({
        defaultResponse: { status: 200 },
      });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/usr/bin/code-server",
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server-dir",
        opencodeDir: "/app/opencode-dir",
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );

      await manager.ensureRunning();

      expect(processRunner).toHaveSpawned([
        {
          command: config.binaryPath,
          args: expect.arrayContaining([
            "--port",
            String(CODE_SERVER_PORT),
            "--auth",
            "none",
          ]) as unknown as string[],
          cwd: config.runtimeDir,
        },
      ]);
      expect(manager.pid()).toBe(99999);
    });
  });

  describe("stop with timeout escalation", () => {
    it("calls kill with graceful shutdown timeouts", async () => {
      // Process exits cleanly after SIGTERM
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 12345,
          running: true,
          killResult: { success: true, reason: "SIGTERM" },
        }),
      });
      const httpClient = createMockHttpClient({
        defaultResponse: { status: 200 },
      });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/usr/bin/code-server",
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server-dir",
        opencodeDir: "/app/opencode-dir",
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );

      await manager.ensureRunning();
      await manager.stop();

      // Should call kill with graceful shutdown timeouts (1s SIGTERM, 1s SIGKILL)
      expect(processRunner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
    });

    it("handles SIGKILL escalation result", async () => {
      // Process needed SIGKILL (didn't respond to SIGTERM)
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 12345,
          running: true,
          signal: "SIGKILL",
          killResult: { success: true, reason: "SIGKILL" },
        }),
      });
      const httpClient = createMockHttpClient({
        defaultResponse: { status: 200 },
      });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/usr/bin/code-server",
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server-dir",
        opencodeDir: "/app/opencode-dir",
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );

      await manager.ensureRunning();
      await manager.stop();

      // Should call kill with graceful shutdown timeouts (1s SIGTERM, 1s SIGKILL)
      // The new kill() API handles SIGTERM→SIGKILL escalation internally
      expect(processRunner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
    });
  });
});

describe("CodeServerManager (PATH and EDITOR)", () => {
  it("uses correct PATH separator for current platform", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    // Set up a known PATH value using the platform's delimiter
    process.env.PATH = `/usr/bin${path.delimiter}/usr/local/bin`;

    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // Restore original values
    process.env.PATH = originalPath;

    // Verify PATH uses platform's separator (path.delimiter)
    // This test validates that the code correctly uses path.delimiter
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.PATH).toBe(
      `/app/bin${path.delimiter}/usr/bin${path.delimiter}/usr/local/bin`
    );
  });

  it("prepends binDir to PATH correctly", async () => {
    // Store original values
    const originalPath = process.env.PATH;

    // Use platform-appropriate delimiter in test data
    // Note: On Windows, env vars are case-insensitive, so we only set PATH (not Path)
    process.env.PATH = `/existing/path${path.delimiter}/another/path`;

    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // Restore original values
    process.env.PATH = originalPath;

    // Verify binDir is prepended correctly
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.PATH).toContain("/app/bin");
    expect(spawned.$.env?.PATH?.indexOf("/app/bin")).toBe(0);
    // Verify original PATH entries are preserved
    expect(spawned.$.env?.PATH).toContain("/existing/path");
    expect(spawned.$.env?.PATH).toContain("/another/path");
  });

  it("reads from env.Path when env.PATH is undefined (Windows case sensitivity)", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;

    // Simulate Windows where only Path exists (lowercase 'a')
    // Use platform-appropriate delimiter
    delete process.env.PATH;
    process.env.Path = `/usr/bin${path.delimiter}/usr/local/bin`;

    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // Restore original values
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    } else {
      delete process.env.PATH;
    }
    if (originalWindowsPath !== undefined) {
      process.env.Path = originalWindowsPath;
    } else {
      delete process.env.Path;
    }

    // Verify PATH contains original Path entries (was read correctly)
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.PATH).toContain("/usr/bin");
    expect(spawned.$.env?.PATH).toContain("/usr/local/bin");
    // Verify binDir is prepended
    expect(spawned.$.env?.PATH?.indexOf("/app/bin")).toBe(0);
    // Verify Path was removed to avoid duplicates
    expect(spawned.$.env?.Path).toBeUndefined();
  });

  it("sets binDir as PATH when both PATH and Path are undefined", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;

    // Remove both PATH and Path
    delete process.env.PATH;
    delete process.env.Path;

    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // Restore original values
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (originalWindowsPath !== undefined) {
      process.env.Path = originalWindowsPath;
    }

    // Verify PATH starts with binDir followed by delimiter (and empty string from the original undefined PATH)
    // Use path.delimiter to build the expected pattern for the current platform
    const expectedStart = `/app/bin${path.delimiter}`;
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.PATH?.startsWith(expectedStart)).toBe(true);
  });

  it("prepends binDir to PATH", async () => {
    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.PATH).toMatch(/^\/app\/bin/);
  });

  it("preserves existing PATH entries", async () => {
    // Store original PATH
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/usr/local/bin";

    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // Restore original PATH
    process.env.PATH = originalPath;

    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.PATH).toContain("/usr/bin");
    expect(spawned.$.env?.PATH).toContain("/usr/local/bin");
  });

  it("sets EDITOR with absolute path", async () => {
    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // On Windows, the path uses backslashes and .cmd extension
    // On Unix, it uses forward slashes without extension
    const isWindows = process.platform === "win32";
    const expectedCodePath = isWindows
      ? path.join("/app/bin", "code.cmd")
      : path.join("/app/bin", "code");
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.EDITOR).toContain(expectedCodePath);
  });

  it("EDITOR includes --wait flag", async () => {
    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.EDITOR).toContain("--wait");
  });

  it("EDITOR includes --reuse-window flag", async () => {
    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.EDITOR).toContain("--reuse-window");
  });

  it("sets GIT_SEQUENCE_EDITOR same as EDITOR", async () => {
    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.GIT_SEQUENCE_EDITOR).toBe(spawned.$.env?.EDITOR);
  });

  it("sets VSCODE_PROXY_URI to empty string to disable localhost URL rewriting", async () => {
    const processRunner = createMockProcessRunner({
      onSpawn: () => ({ pid: 12345, running: true }),
    });

    const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
    const portManager = createPortManagerMock([8080]);
    const config = {
      port: CODE_SERVER_PORT,
      binaryPath: "/usr/bin/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const manager = new CodeServerManager(
      config,
      processRunner,
      httpClient,
      portManager,
      testLogger
    );
    await manager.ensureRunning();

    // VSCODE_PROXY_URI should be empty to disable code-server's localhost URL rewriting.
    // Without this, code-server rewrites localhost URLs to go through /proxy/<port>/
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.env?.VSCODE_PROXY_URI).toBe("");
  });
});

describe("getCodeServerPort", () => {
  it("returns fixed port when packaged", () => {
    const buildInfo = createMockBuildInfo({ isDevelopment: false, isPackaged: true });

    const port = getCodeServerPort(buildInfo);

    expect(port).toBe(CODE_SERVER_PORT);
  });

  it("returns derived port in development mode", () => {
    const buildInfo = createMockBuildInfo({
      isDevelopment: true,
      gitBranch: "feature/test-branch",
    });

    const port = getCodeServerPort(buildInfo);

    // Port should be in the range 30000-65000
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(65000);
    // Port should NOT be the production port
    expect(port).not.toBe(CODE_SERVER_PORT);
  });

  it("returns consistent port for same branch name", () => {
    const buildInfo1 = createMockBuildInfo({
      isDevelopment: true,
      gitBranch: "feature/my-feature",
    });
    const buildInfo2 = createMockBuildInfo({
      isDevelopment: true,
      gitBranch: "feature/my-feature",
    });

    const port1 = getCodeServerPort(buildInfo1);
    const port2 = getCodeServerPort(buildInfo2);

    expect(port1).toBe(port2);
  });

  it("returns different ports for different branch names", () => {
    const buildInfo1 = createMockBuildInfo({
      isDevelopment: true,
      gitBranch: "feature/branch-a",
    });
    const buildInfo2 = createMockBuildInfo({
      isDevelopment: true,
      gitBranch: "feature/branch-b",
    });

    const port1 = getCodeServerPort(buildInfo1);
    const port2 = getCodeServerPort(buildInfo2);

    expect(port1).not.toBe(port2);
  });

  it("uses 'development' fallback when gitBranch is not set", () => {
    const buildInfo = createMockBuildInfo({
      isDevelopment: true,
      // gitBranch not set - should use "development" fallback
    });

    const port = getCodeServerPort(buildInfo);

    // Should get a port in the valid range (using "development" as input)
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(65000);
  });

  it("returns fixed port even when gitBranch is set when packaged", () => {
    const buildInfo = createMockBuildInfo({
      isDevelopment: false,
      isPackaged: true,
      gitBranch: "should-be-ignored",
    });

    const port = getCodeServerPort(buildInfo);

    expect(port).toBe(CODE_SERVER_PORT);
  });
});
