// @vitest-environment node
/**
 * Integration tests for CodeServerManager.
 * Tests the actual environment configuration passed to spawned processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, delimiter } from "node:path";
import { CodeServerManager } from "./code-server-manager";
import { createMockSpawnedProcess } from "../platform/process.test-utils";
import { createMockPortManager } from "../platform/network.test-utils";
import { createMockHttpClient } from "../platform/http-client.state-mock";
import { SILENT_LOGGER } from "../logging";

const testLogger = SILENT_LOGGER;

describe("CodeServerManager Integration", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Remove CODEHYDRA_PLUGIN_PORT to ensure test isolation
    // (may be set by other tests running in parallel)
    delete process.env.CODEHYDRA_PLUGIN_PORT;
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

      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
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

      // Verify binDir is prepended with correct delimiter
      expect(capturedEnv?.PATH).toBe(`/app/bin${delimiter}/usr/bin:/usr/local/bin`);
    });

    it("includes EDITOR with absolute path and flags", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
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

      // Verify EDITOR has absolute path and required flags
      const isWindows = process.platform === "win32";
      const expectedCodeCmd = isWindows
        ? `"${join("/app/bin", "code.cmd")}"`
        : join("/app/bin", "code");
      const expectedEditor = `${expectedCodeCmd} --wait --reuse-window`;

      expect(capturedEnv?.EDITOR).toBe(expectedEditor);
    });

    it("includes GIT_SEQUENCE_EDITOR same as EDITOR", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
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

      // Verify GIT_SEQUENCE_EDITOR matches EDITOR
      expect(capturedEnv?.GIT_SEQUENCE_EDITOR).toBe(capturedEnv?.EDITOR);
      expect(capturedEnv?.GIT_SEQUENCE_EDITOR).toBeTruthy();
    });

    it("removes VSCODE_* environment variables", async () => {
      // Set some VS Code env vars that should be removed
      process.env.VSCODE_IPC_HOOK = "/some/ipc/hook";
      process.env.VSCODE_NLS_CONFIG = "{}";
      process.env.VSCODE_CODE_CACHE_PATH = "/some/cache";

      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
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

      // Verify VSCODE_* vars are removed
      expect(capturedEnv?.VSCODE_IPC_HOOK).toBeUndefined();
      expect(capturedEnv?.VSCODE_NLS_CONFIG).toBeUndefined();
      expect(capturedEnv?.VSCODE_CODE_CACHE_PATH).toBeUndefined();
    });

    it("preserves non-VSCODE environment variables", async () => {
      // Set some env vars that should be preserved
      process.env.HOME = "/home/user";
      process.env.LANG = "en_US.UTF-8";
      process.env.MY_CUSTOM_VAR = "custom-value";

      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
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

      // Verify other vars are preserved
      expect(capturedEnv?.HOME).toBe("/home/user");
      expect(capturedEnv?.LANG).toBe("en_US.UTF-8");
      expect(capturedEnv?.MY_CUSTOM_VAR).toBe("custom-value");
    });

    it("includes CODEHYDRA_PLUGIN_PORT when pluginPort configured", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
        binDir: "/app/bin",
        pluginPort: 9876,
      };

      const manager = new CodeServerManager(
        config,
        processRunner,
        httpClient,
        portManager,
        testLogger
      );
      await manager.ensureRunning();

      // Verify CODEHYDRA_PLUGIN_PORT is set
      expect(capturedEnv?.CODEHYDRA_PLUGIN_PORT).toBe("9876");
    });

    it("omits CODEHYDRA_PLUGIN_PORT when pluginPort undefined", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const mockProc = createMockSpawnedProcess({ pid: 12345 });
      const processRunner = {
        run: vi.fn((_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = options?.env;
          return mockProc;
        }),
      };

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createMockPortManager({ findFreePort: { port: 8080 } });
      const config = {
        binaryPath: "/app/code-server",
        runtimeDir: "/tmp/runtime",
        extensionsDir: "/tmp/extensions",
        userDataDir: "/tmp/user-data",
        binDir: "/app/bin",
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

      // Verify CODEHYDRA_PLUGIN_PORT is NOT set
      expect(capturedEnv?.CODEHYDRA_PLUGIN_PORT).toBeUndefined();
    });
  });
});
