// @vitest-environment node
/**
 * Integration tests for VS Code setup service.
 * Tests full workflows with real filesystem operations.
 *
 * Note: Tests marked with .skip require network access or real code-server binary
 * and are intended for manual verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VscodeSetupService } from "./vscode-setup-service";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import {
  CURRENT_SETUP_VERSION,
  type SetupMarker,
  type ProcessRunner,
  type ProcessResult,
} from "./types";
import type { SpawnedProcess } from "../platform/process";
import type { PathProvider } from "../platform/path-provider";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import {
  createMockSetupState,
  verifySetupCompleted,
  createPartialSetupState,
  cleanupTestDir,
  getCodeServerTestPath,
} from "./test-utils";

describe("VscodeSetupService Integration", () => {
  let tempDir: string;
  let testPathProvider: PathProvider;
  let fsLayer: DefaultFileSystemLayer;
  let mockPaths: {
    vscodeDir: string;
    extensionsDir: string;
    userDataDir: string;
    markerPath: string;
  };

  /**
   * Creates a unique temp directory for each test.
   */
  async function createTestDir(): Promise<string> {
    const dir = join(
      tmpdir(),
      `codehydra-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Creates a mock SpawnedProcess with controllable wait() result.
   */
  function createMockSpawnedProcess(result: ProcessResult): SpawnedProcess {
    return {
      pid: 12345,
      kill: vi.fn().mockReturnValue(true),
      wait: vi.fn().mockResolvedValue(result),
    };
  }

  /**
   * Creates a mock ProcessRunner that simulates code-server.
   */
  function createMockProcessRunner(exitCode = 0, stderr = ""): ProcessRunner {
    return {
      run(): SpawnedProcess {
        return createMockSpawnedProcess({
          stdout: exitCode === 0 ? "Extension 'sst-dev.opencode' was successfully installed." : "",
          stderr,
          exitCode,
        });
      },
    };
  }

  beforeEach(async () => {
    tempDir = await createTestDir();
    fsLayer = new DefaultFileSystemLayer();

    // Set up mock paths pointing to our temp directory
    mockPaths = {
      vscodeDir: join(tempDir, "vscode"),
      extensionsDir: join(tempDir, "vscode", "extensions"),
      userDataDir: join(tempDir, "vscode", "user-data"),
      markerPath: join(tempDir, "vscode", ".setup-completed"),
    };

    // Create PathProvider pointing to our temp directory
    testPathProvider = createMockPathProvider({
      dataRootDir: tempDir,
      vscodeDir: mockPaths.vscodeDir,
      vscodeExtensionsDir: mockPaths.extensionsDir,
      vscodeUserDataDir: mockPaths.userDataDir,
      vscodeSetupMarkerPath: mockPaths.markerPath,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("Full setup flow", () => {
    it("creates all required files in correct locations", async () => {
      const processRunner = createMockProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      // Run setup
      const result = await service.setup();

      expect(result.success).toBe(true);

      // Verify codehydra extension files
      const extensionDir = join(mockPaths.extensionsDir, "codehydra.vscode-0.0.1-universal");
      const packageJson = JSON.parse(await readFile(join(extensionDir, "package.json"), "utf-8"));
      expect(packageJson.name).toBe("codehydra");
      expect(packageJson.version).toBe("0.0.1");

      const extensionJs = await readFile(join(extensionDir, "extension.js"), "utf-8");
      expect(extensionJs).toContain("function activate");
      expect(extensionJs).toContain("opencode.openTerminal");

      // Verify config files
      const userDir = join(mockPaths.userDataDir, "User");
      const settings = JSON.parse(await readFile(join(userDir, "settings.json"), "utf-8"));
      expect(settings["workbench.colorTheme"]).toBe("Default Dark+");
      expect(settings["workbench.startupEditor"]).toBe("none");
      expect(settings["telemetry.telemetryLevel"]).toBe("off");
      // Verify auto-detect system theme settings
      expect(settings["window.autoDetectColorScheme"]).toBe(true);
      expect(settings["workbench.preferredDarkColorTheme"]).toBe("Default Dark+");
      expect(settings["workbench.preferredLightColorTheme"]).toBe("Default Light+");

      const keybindings = JSON.parse(await readFile(join(userDir, "keybindings.json"), "utf-8"));
      expect(keybindings).toEqual([
        { key: "ctrl+j", command: "-workbench.action.togglePanel" },
        { key: "alt+t", command: "workbench.action.togglePanel" },
      ]);

      // Verify marker file
      const marker = JSON.parse(await readFile(mockPaths.markerPath, "utf-8")) as SetupMarker;
      expect(marker.version).toBe(CURRENT_SETUP_VERSION);
      expect(marker.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("emits progress callbacks in correct order", async () => {
      const processRunner = createMockProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      const progressMessages: string[] = [];
      const result = await service.setup((progress) => {
        progressMessages.push(progress.message);
      });

      expect(result.success).toBe(true);
      expect(progressMessages).toContain("Installing codehydra extension...");
      expect(progressMessages).toContain("Installing OpenCode extension...");
      expect(progressMessages).toContain("Writing configuration...");
      expect(progressMessages).toContain("Finalizing setup...");

      // Verify order
      const codehydraIndex = progressMessages.indexOf("Installing codehydra extension...");
      const opencodeIndex = progressMessages.indexOf("Installing OpenCode extension...");
      const configIndex = progressMessages.indexOf("Writing configuration...");
      const finalizeIndex = progressMessages.indexOf("Finalizing setup...");

      expect(codehydraIndex).toBeLessThan(opencodeIndex);
      expect(opencodeIndex).toBeLessThan(configIndex);
      expect(configIndex).toBeLessThan(finalizeIndex);
    });

    it("completes within reasonable time", async () => {
      const processRunner = createMockProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      const startTime = Date.now();
      await service.setup();
      const elapsedMs = Date.now() - startTime;

      // Setup should complete within 5 seconds (generous for slow CI)
      expect(elapsedMs).toBeLessThan(5000);
    });
  });

  describe("Partial failure cleanup", () => {
    it("does not write marker when extension install fails", async () => {
      const processRunner = createMockProcessRunner(1, "Failed to install extension");
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      const result = await service.setup();

      expect(result.success).toBe(false);

      // Marker should not exist
      await expect(access(mockPaths.markerPath)).rejects.toThrow();
    });

    it("custom extension is created before marketplace extension", async () => {
      const processRunner = createMockProcessRunner(1, "Failed");
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      await service.setup();

      // Custom extension should exist (created before marketplace failure)
      const extensionDir = join(mockPaths.extensionsDir, "codehydra.vscode-0.0.1-universal");
      const packageJson = await readFile(join(extensionDir, "package.json"), "utf-8");
      expect(JSON.parse(packageJson).name).toBe("codehydra");
    });
  });

  describe("Version mismatch triggers re-setup", () => {
    it("returns false for old version marker", async () => {
      // Create marker with old version
      await mkdir(mockPaths.vscodeDir, { recursive: true });
      const marker: SetupMarker = {
        version: CURRENT_SETUP_VERSION - 1,
        completedAt: new Date().toISOString(),
      };
      await writeFile(mockPaths.markerPath, JSON.stringify(marker), "utf-8");

      const processRunner = createMockProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      const isComplete = await service.isSetupComplete();
      expect(isComplete).toBe(false);
    });

    it("returns true for current version marker", async () => {
      // Create marker with current version
      await mkdir(mockPaths.vscodeDir, { recursive: true });
      const marker: SetupMarker = {
        version: CURRENT_SETUP_VERSION,
        completedAt: new Date().toISOString(),
      };
      await writeFile(mockPaths.markerPath, JSON.stringify(marker), "utf-8");

      const processRunner = createMockProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      const isComplete = await service.isSetupComplete();
      expect(isComplete).toBe(true);
    });

    it("cleanVscodeDir removes entire directory", async () => {
      // Create full setup state
      await mkdir(join(mockPaths.extensionsDir, "codehydra.vscode-0.0.1-universal"), {
        recursive: true,
      });
      await writeFile(
        join(mockPaths.extensionsDir, "codehydra.vscode-0.0.1-universal", "package.json"),
        "{}",
        "utf-8"
      );
      await mkdir(join(mockPaths.userDataDir, "User"), { recursive: true });
      await writeFile(join(mockPaths.userDataDir, "User", "settings.json"), "{}", "utf-8");
      await writeFile(mockPaths.markerPath, "{}", "utf-8");

      const processRunner = createMockProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        "mock-code-server",
        fsLayer
      );

      await service.cleanVscodeDir();

      // Entire vscode directory should be gone
      await expect(access(mockPaths.vscodeDir)).rejects.toThrow();
    });
  });

  describe("Test utilities", () => {
    it("createMockSetupState creates complete state", async () => {
      vi.restoreAllMocks(); // Use real paths for this test

      const vscodeDir = await createMockSetupState({
        complete: true,
        includeExtensions: true,
        includeConfig: true,
      });

      try {
        const isComplete = await verifySetupCompleted(vscodeDir);
        expect(isComplete).toBe(true);
      } finally {
        await cleanupTestDir(vscodeDir);
      }
    });

    it("createMockSetupState creates incomplete state", async () => {
      vi.restoreAllMocks(); // Use real paths for this test

      const vscodeDir = await createMockSetupState({
        complete: false,
        includeExtensions: true,
      });

      try {
        const isComplete = await verifySetupCompleted(vscodeDir);
        expect(isComplete).toBe(false);
      } finally {
        await cleanupTestDir(vscodeDir);
      }
    });

    it("createPartialSetupState creates partial state", async () => {
      vi.restoreAllMocks(); // Use real paths for this test

      const vscodeDir = await createPartialSetupState();

      try {
        const isComplete = await verifySetupCompleted(vscodeDir);
        expect(isComplete).toBe(false);
      } finally {
        await cleanupTestDir(vscodeDir);
      }
    });

    it("getCodeServerTestPath returns valid path", () => {
      const path = getCodeServerTestPath();
      expect(path).toBe("code-server"); // In dev, available via PATH
    });
  });

  /**
   * Network-dependent tests - skipped by default.
   * Run manually with: npm test -- --run vscode-setup-service.integration --no-skip
   */
  describe.skip("Network-dependent tests (manual only)", () => {
    it("extension install with real code-server", async () => {
      const { ExecaProcessRunner } = await import("../platform/process");
      const realProcessRunner = new ExecaProcessRunner();

      const service = new VscodeSetupService(
        realProcessRunner,
        testPathProvider,
        getCodeServerTestPath()
      );

      // Clean up any existing state first
      await service.cleanVscodeDir();

      const result = await service.setup();

      // This test may fail without network access
      if (result.success) {
        // Verify OpenCode extension was installed
        const extensionsDir = mockPaths.extensionsDir;
        const entries = await import("node:fs/promises").then((fs) => fs.readdir(extensionsDir));
        const hasOpenCode = entries.some((e) => e.includes("opencode"));
        expect(hasOpenCode).toBe(true);
      } else {
        // Skip assertion if network failure
        console.warn("Skipping network-dependent assertion:", result);
      }
    }, 180000); // 3 minute timeout for extension download
  });
});
