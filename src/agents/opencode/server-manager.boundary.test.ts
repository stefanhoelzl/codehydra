// @vitest-environment node
/**
 * Boundary tests for OpenCodeServerManager.
 *
 * Tests with real opencode process spawning.
 * Uses ensureBinaryForTests to download opencode if not available.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { OpenCodeServerManager } from "./server-manager";
import { ExecaProcessRunner } from "../../services/platform/process";
import { DefaultNetworkLayer } from "../../services/platform/network";
import { SILENT_LOGGER } from "../../services/logging";
import {
  ensureBinaryForTests,
  getTestPathProvider,
} from "../../services/test-utils/ensure-binaries";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CI_TIMEOUT_MS } from "../../services/platform/network.test-utils";
import { delay } from "@shared/test-fixtures";

import type { PathProvider } from "../../services/platform/path-provider";

describe("OpenCodeServerManager Boundary Tests", () => {
  let testDir: string;
  let manager: OpenCodeServerManager;
  let pathProvider: PathProvider;
  let networkLayer: DefaultNetworkLayer;
  let processRunner: ExecaProcessRunner;

  beforeAll(async () => {
    // Ensure opencode binary is available (downloads if missing)
    await ensureBinaryForTests("opencode");

    // Create test directory
    testDir = join(tmpdir(), `opencode-server-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, "opencode"), { recursive: true });
    await mkdir(join(testDir, "workspace"), { recursive: true });

    // Use test path provider for binary resolution
    pathProvider = getTestPathProvider();

    // Create dependencies using silent loggers (no Electron dependency)
    networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
    processRunner = new ExecaProcessRunner(SILENT_LOGGER);
  });

  afterEach(async () => {
    // Dispose manager to stop any running servers
    if (manager) {
      await manager.dispose();
    }
  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it(
    "opencode serve starts and listens on allocated port",
    async () => {
      manager = new OpenCodeServerManager(
        processRunner,
        networkLayer,
        networkLayer,
        pathProvider,
        SILENT_LOGGER,
        { healthCheckTimeoutMs: CI_TIMEOUT_MS }
      );

      const workspacePath = join(testDir, "workspace");

      const port = await manager.startServer(workspacePath);

      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
      expect(manager.getPort(workspacePath)).toBe(port);
    },
    CI_TIMEOUT_MS
  );

  it(
    "health check to /path succeeds after startup",
    async () => {
      manager = new OpenCodeServerManager(
        processRunner,
        networkLayer,
        networkLayer,
        pathProvider,
        SILENT_LOGGER,
        { healthCheckTimeoutMs: CI_TIMEOUT_MS }
      );

      const workspacePath = join(testDir, "workspace");
      const port = await manager.startServer(workspacePath);

      // Verify health check endpoint works
      const response = await networkLayer.fetch(`http://127.0.0.1:${port}/path`, { timeout: 5000 });
      expect(response.ok).toBe(true);
    },
    CI_TIMEOUT_MS
  );

  it(
    "graceful shutdown terminates process",
    async () => {
      manager = new OpenCodeServerManager(
        processRunner,
        networkLayer,
        networkLayer,
        pathProvider,
        SILENT_LOGGER,
        { healthCheckTimeoutMs: CI_TIMEOUT_MS }
      );

      const workspacePath = join(testDir, "workspace");
      const port = await manager.startServer(workspacePath);

      // Verify server is running
      const runningResponse = await networkLayer.fetch(`http://127.0.0.1:${port}/path`, {
        timeout: 5000,
      });
      expect(runningResponse.ok).toBe(true);

      // Stop the server
      await manager.stopServer(workspacePath);

      // Wait a bit for port to be released
      await delay(1000);

      // Verify server is stopped (connection should fail)
      try {
        await networkLayer.fetch(`http://127.0.0.1:${port}/path`, { timeout: 1000 });
        // If we get here, the server is still running (unexpected)
        expect.fail("Server should have stopped but is still responding");
      } catch {
        // Expected - server should be stopped
      }
    },
    CI_TIMEOUT_MS
  );

  it(
    "port is stored in memory after start",
    async () => {
      manager = new OpenCodeServerManager(
        processRunner,
        networkLayer,
        networkLayer,
        pathProvider,
        SILENT_LOGGER,
        { healthCheckTimeoutMs: CI_TIMEOUT_MS }
      );

      const workspacePath = join(testDir, "workspace");
      const port = await manager.startServer(workspacePath);

      // Port should be retrievable via getPort
      expect(manager.getPort(workspacePath)).toBe(port);

      // Stop server
      await manager.stopServer(workspacePath);

      // Port should no longer be available
      expect(manager.getPort(workspacePath)).toBeUndefined();
    },
    CI_TIMEOUT_MS
  );

  it(
    "no ports.json file is created after server start",
    async () => {
      manager = new OpenCodeServerManager(
        processRunner,
        networkLayer,
        networkLayer,
        pathProvider,
        SILENT_LOGGER,
        { healthCheckTimeoutMs: CI_TIMEOUT_MS }
      );

      const workspacePath = join(testDir, "workspace");
      const portsJsonPath = join(testDir, "opencode", "ports.json");

      // Verify no ports.json exists before starting
      expect(existsSync(portsJsonPath)).toBe(false);

      // Start the server
      await manager.startServer(workspacePath);

      // Verify no ports.json file was created
      // Port is stored in memory only, not written to disk
      expect(existsSync(portsJsonPath)).toBe(false);

      // Stop the server
      await manager.stopServer(workspacePath);

      // Still no ports.json after stopping
      expect(existsSync(portsJsonPath)).toBe(false);
    },
    CI_TIMEOUT_MS
  );
});
