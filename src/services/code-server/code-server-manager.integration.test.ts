// @vitest-environment node
/**
 * Integration tests for CodeServerManager.
 * Tests the actual environment configuration passed to spawned processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, delimiter } from "node:path";
import { CodeServerManager } from "./code-server-manager";
import { createMockProcessRunner } from "../platform/process.state-mock";
import { createPortManagerMock } from "../platform/network.test-utils";
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

      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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

    it("includes CODEHYDRA_PLUGIN_PORT when pluginPort configured", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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

      // Verify CODEHYDRA_PLUGIN_PORT is set
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.CODEHYDRA_PLUGIN_PORT).toBe("9876");
    });

    it("omits CODEHYDRA_PLUGIN_PORT when pluginPort undefined", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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

      // Verify CODEHYDRA_PLUGIN_PORT is NOT set
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.CODEHYDRA_PLUGIN_PORT).toBeUndefined();
    });

    it("includes CODEHYDRA_CODE_SERVER_DIR and CODEHYDRA_OPENCODE_DIR", async () => {
      const processRunner = createMockProcessRunner({
        onSpawn: () => ({ pid: 12345 }),
      });

      const httpClient = createMockHttpClient({ defaultResponse: { status: 200 } });
      const portManager = createPortManagerMock([8080]);
      const config = {
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

      // Verify CODEHYDRA_CODE_SERVER_DIR and CODEHYDRA_OPENCODE_DIR are set
      const spawned = processRunner.$.spawned(0);
      expect(spawned.$.env?.CODEHYDRA_CODE_SERVER_DIR).toBe("/app/code-server/4.106.3");
      expect(spawned.$.env?.CODEHYDRA_OPENCODE_DIR).toBe("/app/opencode/1.0.163");
    });
  });
});
