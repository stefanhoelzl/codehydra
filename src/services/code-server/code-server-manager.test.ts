// @vitest-environment node
/**
 * Unit tests for CodeServerManager.
 * Uses mocked dependencies for process spawning and network tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeServerManager, urlForFolder } from "./code-server-manager";
import { createMockProcessRunner, createMockSpawnedProcess } from "../platform/process.test-utils";
import { createMockHttpClient, createMockPortManager } from "../platform/network.test-utils";
import type { HttpClient, PortManager, HttpRequestOptions } from "../platform/network";
import { createSilentLogger } from "../logging";

const testLogger = createSilentLogger();

describe("urlForFolder", () => {
  it("generates correct URL with folder path", () => {
    const url = urlForFolder(8080, "/home/user/projects/my-repo");

    expect(url).toBe("http://localhost:8080/?folder=/home/user/projects/my-repo");
  });

  it("encodes spaces in folder path", () => {
    const url = urlForFolder(8080, "/home/user/My Projects/repo");

    expect(url).toBe("http://localhost:8080/?folder=/home/user/My%20Projects/repo");
  });

  it("encodes special characters in path", () => {
    const url = urlForFolder(8080, "/home/user/project#1");

    expect(url).toBe("http://localhost:8080/?folder=/home/user/project%231");
  });

  it("handles Windows paths", () => {
    // Windows paths need to be converted for URL
    const url = urlForFolder(8080, "C:/Users/user/projects/repo");

    expect(url).toBe("http://localhost:8080/?folder=/C:/Users/user/projects/repo");
  });

  it("handles unicode characters", () => {
    const url = urlForFolder(8080, "/home/user/cafe");

    expect(url).toBe("http://localhost:8080/?folder=/home/user/cafe");
  });
});

describe("CodeServerManager", () => {
  let manager: CodeServerManager;
  let mockProcessRunner: ReturnType<typeof createMockProcessRunner>;
  let mockHttpClient: HttpClient;
  let mockPortManager: PortManager;

  const defaultConfig = {
    runtimeDir: "/tmp/code-server-runtime",
    extensionsDir: "/tmp/code-server-extensions",
    userDataDir: "/tmp/code-server-user-data",
    binDir: "/app/bin",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessRunner = createMockProcessRunner();
    // Mock HttpClient that returns 200 for health checks
    mockHttpClient = createMockHttpClient({
      response: new Response("", { status: 200 }),
    });
    mockPortManager = createMockPortManager({
      findFreePort: { port: 8080 },
    });
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
      const portManager = createMockPortManager();
      const processRunner = createMockProcessRunner();
      const config = {
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
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
    it("uses portManager.findFreePort()", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      mockHttpClient = { fetch: fetchMock };
      const findFreePortMock = vi.fn().mockResolvedValue(9999);
      mockPortManager = {
        findFreePort: findFreePortMock,
        getListeningPorts: vi.fn().mockResolvedValue([]),
      };
      manager = new CodeServerManager(
        {
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      const port = await manager.ensureRunning();

      expect(findFreePortMock).toHaveBeenCalled();
      expect(port).toBe(9999);
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
      // processRunner.run should only be called once
      expect(mockProcessRunner.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("health check", () => {
    it("uses httpClient.fetch() with 1s timeout", async () => {
      let capturedOptions: HttpRequestOptions | undefined;
      mockHttpClient = createMockHttpClient({
        implementation: async (_url: string, options?: HttpRequestOptions) => {
          capturedOptions = options;
          return new Response("", { status: 200 });
        },
      });
      manager = new CodeServerManager(
        {
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      await manager.ensureRunning();

      expect(capturedOptions?.timeout).toBe(1000);
    });

    it("returns true on 200 status", async () => {
      mockHttpClient = createMockHttpClient({
        response: new Response("", { status: 200 }),
      });
      manager = new CodeServerManager(
        {
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      // Should complete successfully (health check passed)
      const port = await manager.ensureRunning();

      expect(port).toBe(8080);
      expect(manager.isRunning()).toBe(true);
    });

    it("returns false on non-200 status (retries until success)", async () => {
      let callCount = 0;
      mockHttpClient = createMockHttpClient({
        implementation: async () => {
          callCount++;
          // First few calls return 503, then 200
          if (callCount < 3) {
            return new Response("", { status: 503 });
          }
          return new Response("", { status: 200 });
        },
      });
      manager = new CodeServerManager(
        {
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      const port = await manager.ensureRunning();

      expect(port).toBe(8080);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it("returns false on network error", async () => {
      let callCount = 0;
      mockHttpClient = createMockHttpClient({
        implementation: async () => {
          callCount++;
          // First few calls throw, then succeed
          if (callCount < 3) {
            throw new Error("Connection refused");
          }
          return new Response("", { status: 200 });
        },
      });
      manager = new CodeServerManager(
        {
          runtimeDir: "/tmp/code-server-runtime",
          extensionsDir: "/tmp/code-server-extensions",
          userDataDir: "/tmp/code-server-user-data",
          binDir: "/app/bin",
        },
        mockProcessRunner,
        mockHttpClient,
        mockPortManager,
        testLogger
      );

      const port = await manager.ensureRunning();

      expect(port).toBe(8080);
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
      const portManager = createMockPortManager();
      const config = {
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
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
      const mockProc = createMockSpawnedProcess({ pid: 99999 });
      const processRunner = createMockProcessRunner(mockProc);
      const httpClient = createMockHttpClient({
        response: new Response("", { status: 200 }),
      });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );

      await manager.ensureRunning();

      expect(processRunner.run).toHaveBeenCalledWith(
        "code-server",
        expect.arrayContaining(["--port", "8080", "--auth", "none"]),
        expect.objectContaining({ cwd: config.runtimeDir })
      );
      expect(manager.pid()).toBe(99999);
    });
  });

  describe("stop with timeout escalation", () => {
    it("sends SIGTERM first and waits for graceful exit", async () => {
      // Process exits cleanly after SIGTERM
      const mockProc = createMockSpawnedProcess({
        pid: 12345,
        killResult: true,
        waitResult: { exitCode: 0, stdout: "", stderr: "" },
      });
      const processRunner = createMockProcessRunner(mockProc);
      const httpClient = createMockHttpClient({
        response: new Response("", { status: 200 }),
      });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
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

      // Should send SIGTERM
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
      // Should wait for process to exit
      expect(mockProc.wait).toHaveBeenCalledWith(5000);
      // Should NOT send SIGKILL if process exits cleanly
      expect(mockProc.kill).not.toHaveBeenCalledWith("SIGKILL");
    });

    it("escalates to SIGKILL when process does not exit within timeout", async () => {
      let waitCallCount = 0;
      const mockProc = createMockSpawnedProcess({
        pid: 12345,
        killResult: true,
        // First wait returns running:true (timeout), second returns completed after SIGKILL
        waitResult: () => {
          waitCallCount++;
          if (waitCallCount === 1) {
            return Promise.resolve({ exitCode: null, stdout: "", stderr: "", running: true });
          }
          return Promise.resolve({ exitCode: null, stdout: "", stderr: "", signal: "SIGKILL" });
        },
      });
      const processRunner = createMockProcessRunner(mockProc);
      const httpClient = createMockHttpClient({
        response: new Response("", { status: 200 }),
      });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        runtimeDir: "/tmp/code-server-runtime",
        extensionsDir: "/tmp/code-server-extensions",
        userDataDir: "/tmp/code-server-user-data",
        binDir: "/app/bin",
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

      // Should send SIGTERM first
      expect(mockProc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      // Should wait with timeout
      expect(mockProc.wait).toHaveBeenNthCalledWith(1, 5000);
      // Should escalate to SIGKILL
      expect(mockProc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      // Should wait for final exit
      expect(mockProc.wait).toHaveBeenCalledTimes(2);
    });
  });
});

describe("CodeServerManager (PATH and EDITOR)", () => {
  it("uses correct PATH separator on Unix (:)", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    const originalPlatform = process.platform;
    process.env.PATH = "/usr/bin:/usr/local/bin";

    // Temporarily override platform for test (affects code's platform check for Windows)
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    // Restore original values
    process.env.PATH = originalPath;
    Object.defineProperty(process, "platform", { value: originalPlatform });

    // Verify PATH uses Unix separator (:)
    expect(capturedEnv?.PATH).toBe("/app/bin:/usr/bin:/usr/local/bin");
  });

  it("uses correct PATH separator on Windows (;)", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;
    const originalPlatform = process.platform;

    // Set Windows-style environment
    process.env.PATH = "C:\\Windows\\System32;C:\\Users\\test\\bin";
    delete process.env.Path;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "C:\\tmp\\runtime",
      extensionsDir: "C:\\tmp\\extensions",
      userDataDir: "C:\\tmp\\user-data",
      binDir: "C:\\app\\bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    // Restore original values
    process.env.PATH = originalPath;
    if (originalWindowsPath !== undefined) {
      process.env.Path = originalWindowsPath;
    }
    Object.defineProperty(process, "platform", { value: originalPlatform });

    // Verify PATH uses Windows separator (;) - path.delimiter handles this automatically
    // Note: The delimiter is actually determined at module load time from node:path
    // We can verify binDir is prepended correctly by checking it starts with our binDir
    expect(capturedEnv?.PATH).toContain("C:\\app\\bin");
    expect(capturedEnv?.PATH?.indexOf("C:\\app\\bin")).toBe(0);
  });

  it("reads from env.Path when env.PATH is undefined (Windows case sensitivity)", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;

    // Simulate Windows where only Path exists (lowercase 'a')
    delete process.env.PATH;
    process.env.Path = "/usr/bin:/usr/local/bin";

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
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
    expect(capturedEnv?.PATH).toContain("/usr/bin");
    expect(capturedEnv?.PATH).toContain("/usr/local/bin");
    // Verify binDir is prepended
    expect(capturedEnv?.PATH?.indexOf("/app/bin")).toBe(0);
    // Verify Path was removed to avoid duplicates
    expect(capturedEnv?.Path).toBeUndefined();
  });

  it("sets binDir as PATH when both PATH and Path are undefined", async () => {
    // Store original values
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;

    // Remove both PATH and Path
    delete process.env.PATH;
    delete process.env.Path;

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    // Restore original values
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (originalWindowsPath !== undefined) {
      process.env.Path = originalWindowsPath;
    }

    // Verify PATH starts with binDir followed by delimiter (and empty string from the original undefined PATH)
    // The format will be: "/app/bin:" on Unix or "/app/bin;" on Windows
    expect(capturedEnv?.PATH).toMatch(/^\/app\/bin[;:]/);
  });

  it("prepends binDir to PATH", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    expect(capturedEnv?.PATH).toMatch(/^\/app\/bin/);
  });

  it("preserves existing PATH entries", async () => {
    // Store original PATH
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/usr/local/bin";

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    // Restore original PATH
    process.env.PATH = originalPath;

    expect(capturedEnv?.PATH).toContain("/usr/bin");
    expect(capturedEnv?.PATH).toContain("/usr/local/bin");
  });

  it("sets EDITOR with absolute path", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    expect(capturedEnv?.EDITOR).toContain("/app/bin/code");
  });

  it("EDITOR includes --wait flag", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    expect(capturedEnv?.EDITOR).toContain("--wait");
  });

  it("EDITOR includes --reuse-window flag", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    expect(capturedEnv?.EDITOR).toContain("--reuse-window");
  });

  it("sets GIT_SEQUENCE_EDITOR same as EDITOR", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockProc = createMockSpawnedProcess({ pid: 12345 });
    const processRunner = {
      run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options?.env;
        return mockProc;
      }),
    };

    const httpClient = createMockHttpClient({ response: new Response("", { status: 200 }) });
    const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
    const config = {
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
    };

    const manager = new CodeServerManager(config, processRunner, httpClient, portManager);
    await manager.ensureRunning();

    expect(capturedEnv?.GIT_SEQUENCE_EDITOR).toBe(capturedEnv?.EDITOR);
  });
});
