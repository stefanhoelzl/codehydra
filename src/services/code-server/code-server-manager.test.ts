// @vitest-environment node
/**
 * Unit tests for CodeServerManager.
 * Uses mocked execa for process spawning tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeServerManager, urlForFolder } from "./code-server-manager";

// Mock the process module
vi.mock("../platform/process", () => ({
  findAvailablePort: vi.fn().mockResolvedValue(8080),
  spawnProcess: vi.fn(),
}));

// Mock http module for health checks
vi.mock("http", () => ({
  get: vi.fn(),
}));

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

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CodeServerManager({
      runtimeDir: "/tmp/code-server-runtime",
      extensionsDir: "/tmp/code-server-extensions",
      userDataDir: "/tmp/code-server-user-data",
    });
  });

  afterEach(async () => {
    // Ensure cleanup
    try {
      await manager.stop();
    } catch {
      // Ignore errors during cleanup
    }
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
    it("returns same port when already running", async () => {
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockReturnThis(),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock successful health check
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 0);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

      // First call starts the server
      const port1 = await manager.ensureRunning();

      // Second call should return same port without starting again
      const port2 = await manager.ensureRunning();

      expect(port1).toBe(port2);
      expect(manager.isRunning()).toBe(true);
    });

    it("returns same port for concurrent calls", async () => {
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn with delay
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockReturnThis(),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock health check with delay to simulate startup time
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 50);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

      // Start two concurrent calls
      const [port1, port2] = await Promise.all([manager.ensureRunning(), manager.ensureRunning()]);

      expect(port1).toBe(port2);
      // spawnProcess should only be called once
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    });
  });

  describe("onPidChanged", () => {
    it("calls callback when PID changes during startup", async () => {
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockReturnThis(),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock successful health check
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 0);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

      const callback = vi.fn();
      manager.onPidChanged(callback);

      await manager.ensureRunning();

      expect(callback).toHaveBeenCalledWith(12345);
    });

    it("calls callback with null when server stops", async () => {
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock successful health check
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 0);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

      const callback = vi.fn();
      manager.onPidChanged(callback);

      await manager.ensureRunning();
      callback.mockClear(); // Clear the startup call

      await manager.stop();

      expect(callback).toHaveBeenCalledWith(null);
    });

    it("returns unsubscribe function", async () => {
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockReturnThis(),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock successful health check
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 0);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

      const callback = vi.fn();
      const unsubscribe = manager.onPidChanged(callback);

      // Unsubscribe before starting
      unsubscribe();

      await manager.ensureRunning();

      expect(callback).not.toHaveBeenCalled();
    });

    it("supports multiple listeners", async () => {
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockReturnThis(),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock successful health check
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 0);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

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
      const { spawnProcess } = await import("../platform/process");
      const { get } = await import("http");

      // Mock successful spawn
      const mockProcess = {
        pid: 12345,
        kill: vi.fn(),
        catch: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(spawnProcess).mockReturnValue(mockProcess as never);

      // Mock successful health check
      vi.mocked(get).mockImplementation((_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        setTimeout(() => cb({ statusCode: 200 }), 0);
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
        } as never;
      });

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
