// @vitest-environment node
/**
 * Integration tests for CodeServerManager.
 * Tests the actual environment configuration passed to spawned processes.
 *
 * Test plan items covered:
 * #8: CodeServerManager.preflight detects missing binary
 * #15: Preflight detects outdated binaries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join, delimiter } from "node:path";
import { CodeServerManager, CODE_SERVER_PORT } from "./code-server-manager";
import { createMockProcessRunner } from "../platform/process.state-mock";
import { createPortManagerMock } from "../platform/network.test-utils";
import { createMockHttpClient } from "../platform/http-client.state-mock";
import { SILENT_LOGGER } from "../logging";
import type { BinaryDownloadService, DownloadRequest } from "../binary-download";

const testLogger = SILENT_LOGGER;

describe("CodeServerManager Integration", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Remove _CH_PLUGIN_PORT to ensure test isolation
    // (may be set by other tests running in parallel)
    delete process.env._CH_PLUGIN_PORT;
  });

  afterEach(() => {
    // Restore original environment
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  describe("spawns with modified PATH environment", () => {
    it("includes binDir prepended to PATH", async () => {
      // Set a known PATH value
      process.env.PATH = "/usr/bin:/usr/local/bin";

      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
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

      // Verify binDir is prepended with correct delimiter
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.PATH).toBe(`/app/bin${delimiter}/usr/bin:/usr/local/bin`);
    });

    it("includes EDITOR with absolute path and flags", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
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

      // Verify EDITOR has absolute path and required flags
      const isWindows = process.platform === "win32";
      const expectedCodeCmd = isWindows
        ? `"${join("/app/bin", "code.cmd")}"`
        : join("/app/bin", "code");
      const expectedEditor = `${expectedCodeCmd} --wait --reuse-window`;

      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.EDITOR).toBe(expectedEditor);
    });

    it("includes GIT_SEQUENCE_EDITOR same as EDITOR", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
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

      // Verify GIT_SEQUENCE_EDITOR matches EDITOR
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.GIT_SEQUENCE_EDITOR).toBe(spawned.$.env?.EDITOR);
      expect(spawned.$.env?.GIT_SEQUENCE_EDITOR).toBeTruthy();
    });

    it("removes VSCODE_* environment variables", async () => {
      // Set some VS Code env vars that should be removed
      process.env.VSCODE_IPC_HOOK = "/some/ipc/hook";
      process.env.VSCODE_NLS_CONFIG = "{}";
      process.env.VSCODE_CODE_CACHE_PATH = "/some/cache";

      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
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

      // Verify VSCODE_* vars are removed
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.VSCODE_IPC_HOOK).toBeUndefined();
      expect(spawned.$.env?.VSCODE_NLS_CONFIG).toBeUndefined();
      expect(spawned.$.env?.VSCODE_CODE_CACHE_PATH).toBeUndefined();
    });

    it("preserves non-VSCODE environment variables", async () => {
      // Set some env vars that should be preserved
      process.env.HOME = "/home/user";
      process.env.LANG = "en_US.UTF-8";
      process.env.MY_CUSTOM_VAR = "custom-value";

      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
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

      // Verify other vars are preserved
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.HOME).toBe("/home/user");
      expect(spawned.$.env?.LANG).toBe("en_US.UTF-8");
      expect(spawned.$.env?.MY_CUSTOM_VAR).toBe("custom-value");
    });

    it("includes _CH_PLUGIN_PORT when pluginPort configured", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
        binDir: "/app/bin",
        pluginPort: 9876,
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

      // Verify _CH_PLUGIN_PORT is set
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?._CH_PLUGIN_PORT).toBe("9876");
    });

    it("omits _CH_PLUGIN_PORT when pluginPort undefined", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server-dir",
        opencodeDir: "/app/opencode-dir",
        // Note: pluginPort not set
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );
      await manager.ensureRunning();

      // Verify _CH_PLUGIN_PORT is NOT set
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?._CH_PLUGIN_PORT).toBeUndefined();
    });

    it("includes _CH_CODE_SERVER_DIR and _CH_OPENCODE_DIR", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
        binDir: "/app/bin",
        codeServerDir: "/app/code-server/4.106.3",
        opencodeDir: "/app/opencode/1.0.163",
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );
      await manager.ensureRunning();

      // Verify _CH_CODE_SERVER_DIR and _CH_OPENCODE_DIR are set
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?._CH_CODE_SERVER_DIR).toBe("/app/code-server/4.106.3");
      expect(spawned.$.env?._CH_OPENCODE_DIR).toBe("/app/opencode/1.0.163");
    });
  });

  describe("preflight", () => {
    const baseConfig = {
      port: CODE_SERVER_PORT,
      binaryPath: "/app/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const testRequest: DownloadRequest = {
      name: "code-server",
      url: "https://example.com/code-server.tar.gz",
      destDir: "/app-data/code-server/4.109.2",
      executablePath: "bin/code-server",
    };

    it("returns needsDownload: true when binary is not installed (#8)", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);
      const binaryService: BinaryDownloadService = {
        isInstalled: vi.fn().mockResolvedValue(false),
        download: vi.fn(),
      };

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger,
        { service: binaryService, request: testRequest }
      );

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(true);
      }
      expect(binaryService.isInstalled).toHaveBeenCalledWith(testRequest.destDir);
    });

    it("returns needsDownload: false when binary is installed (#15)", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);
      const binaryService: BinaryDownloadService = {
        isInstalled: vi.fn().mockResolvedValue(true),
        download: vi.fn(),
      };

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger,
        { service: binaryService, request: testRequest }
      );

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(false);
      }
    });

    it("returns success when no BinaryDownloadService available", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger
        // Note: no binaryDownload
      );

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(false);
      }
    });

    it("returns error on exception", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);
      const binaryService: BinaryDownloadService = {
        isInstalled: vi.fn().mockRejectedValue(new Error("Permission denied")),
        download: vi.fn(),
      };

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger,
        { service: binaryService, request: testRequest }
      );

      const result = await manager.preflight();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("Permission denied");
      }
    });
  });

  describe("downloadBinary", () => {
    const baseConfig = {
      port: CODE_SERVER_PORT,
      binaryPath: "/app/code-server",
      runtimeDir: "/tmp/runtime",
      extensionsDir: "/tmp/extensions",
      userDataDir: "/tmp/user-data",
      binDir: "/app/bin",
      codeServerDir: "/app/code-server-dir",
      opencodeDir: "/app/opencode-dir",
    };

    const testRequest: DownloadRequest = {
      name: "code-server",
      url: "https://example.com/code-server.tar.gz",
      destDir: "/app-data/code-server/4.109.2",
      executablePath: "bin/code-server",
    };

    it("downloads binary via BinaryDownloadService", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);
      const onProgress = vi.fn();
      const binaryService: BinaryDownloadService = {
        isInstalled: vi.fn(),
        download: vi.fn().mockResolvedValue(undefined),
      };

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger,
        { service: binaryService, request: testRequest }
      );

      await manager.downloadBinary(onProgress);

      expect(binaryService.download).toHaveBeenCalledWith(testRequest, onProgress);
    });

    it("throws CodeServerError when no BinaryDownloadService available", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger
        // Note: no binaryDownload
      );

      await expect(manager.downloadBinary()).rejects.toThrow("BinaryDownloadService not available");
    });

    it("throws CodeServerError on download failure", async () => {
      const processRunner = createMockProcessRunner();
      const httpClient = createMockHttpClient();
      const portManager = createPortManagerMock([8080]);
      const binaryService: BinaryDownloadService = {
        isInstalled: vi.fn(),
        download: vi.fn().mockRejectedValue(new Error("Network timeout")),
      };

      const manager = new CodeServerManager(
        baseConfig,
        processRunner,
        httpClient,
        portManager,
        testLogger,
        { service: binaryService, request: testRequest }
      );

      await expect(manager.downloadBinary()).rejects.toThrow("Failed to download code-server");
    });
  });

  describe("start failure cleanup", () => {
    it("kills the spawned process when health check times out", async () => {
      vi.useFakeTimers();

      try {
        const processRunner = createMockProcessRunner({
          onSpawn: () => ({ pid: 99999, running: true }),
        });

        // Health check always returns non-200, so it never becomes healthy
        const httpClient = createMockHttpClient({ defaultResponse: { status: 503 } });
        const portManager = createPortManagerMock([8080]);
        const config = {
          port: CODE_SERVER_PORT,
          binaryPath: "/app/code-server",
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

        // Start ensureRunning (will block on health check).
        // Attach a catch handler immediately to prevent unhandled rejection warnings,
        // since the rejection fires before the await in ensureRunning handles it.
        let caughtError: unknown;
        const startPromise = manager.ensureRunning().catch((err: unknown) => {
          caughtError = err;
        });

        // Advance past the 30s health check timeout
        await vi.advanceTimersByTimeAsync(31_000);

        await startPromise;

        // Verify the start failed with a timeout error
        expect(caughtError).toBeDefined();
        expect(String(caughtError)).toContain("Failed to start code-server");

        // Verify the spawned process was killed to avoid orphaning
        const spawned = processRunner.$.spawned(0);
        expect(spawned).toHaveBeenKilled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("setCodeServerVersion", () => {
    it("updates binaryPath, codeServerDir, and download request", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345, running: true }),
      });
      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const binaryService: BinaryDownloadService = {
        isInstalled: vi.fn().mockResolvedValue(true),
        download: vi.fn(),
      };
      const originalRequest: DownloadRequest = {
        name: "code-server",
        url: "https://example.com/old.tar.gz",
        destDir: "/old/dir",
        executablePath: "bin/code-server",
      };
      const config = {
        port: CODE_SERVER_PORT,
        binaryPath: "/old/binary",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
        binDir: "/app/bin",
        codeServerDir: "/old/dir",
        opencodeDir: "/app/opencode-dir",
      };
      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger,
        { service: binaryService, request: originalRequest }
      );

      const newRequest: DownloadRequest = {
        name: "code-server",
        url: "https://example.com/new.tar.gz",
        destDir: "/new/dir",
        executablePath: "bin/code-server",
      };
      manager.setCodeServerVersion("/new/binary", "/new/dir", newRequest);

      expect(manager.getConfig().binaryPath).toBe("/new/binary");
      expect(manager.getConfig().codeServerDir).toBe("/new/dir");

      // Verify download uses new request by triggering preflight
      await manager.preflight();
      expect(binaryService.isInstalled).toHaveBeenCalledWith("/new/dir");
    });
  });
});
