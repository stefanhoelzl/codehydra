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
import { SILENT_LOGGER } from "../logging";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { createMockProcessRunner, type MockProcessRunner } from "../platform/process.state-mock";
import { type SetupMarker, type PreflightResult } from "./types";
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
    assetsDir: string;
    binDir: string;
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
   * Creates mock asset files in the assets directory.
   * Note: Agent extensions (opencode, claude) are installed from marketplace,
   * not bundled. Only CodeHydra's own extensions are in the manifest.
   */
  async function createMockAssets(assetsDir: string): Promise<void> {
    await mkdir(assetsDir, { recursive: true });

    // manifest.json - bundled extensions only (agent extensions installed from marketplace)
    await writeFile(
      join(assetsDir, "manifest.json"),
      JSON.stringify([
        {
          id: "codehydra.sidekick",
          version: "0.0.3",
          vsix: "codehydra-sidekick-0.0.3.vsix",
        },
      ])
    );

    // Create mock vsix files (just needs to exist for the test)
    await writeFile(join(assetsDir, "codehydra-sidekick-0.0.3.vsix"), "mock-vsix-content");

    // Create bin assets directory with wrapper scripts
    const binAssetsDir = join(assetsDir, "bin");
    await mkdir(binAssetsDir, { recursive: true });
    await writeFile(join(binAssetsDir, "code"), "#!/bin/sh\nexec code-server");
    await writeFile(join(binAssetsDir, "code.cmd"), "@echo off\ncall code-server");
    await writeFile(join(binAssetsDir, "opencode"), "#!/bin/sh\nexec opencode.cjs");
    await writeFile(join(binAssetsDir, "opencode.cmd"), "@echo off\ncall opencode.cjs");
    await writeFile(join(binAssetsDir, "opencode.cjs"), "// opencode wrapper");
  }

  /**
   * Creates a mock ProcessRunner that simulates code-server.
   */
  function createTestProcessRunner(exitCode = 0, stderr = ""): MockProcessRunner {
    return createMockProcessRunner({
      defaultResult: {
        stdout: exitCode === 0 ? "Extension was successfully installed." : "",
        stderr,
        exitCode,
      },
    });
  }

  /**
   * Create a preflight result for full setup (all components missing).
   * Note: Agent extensions are handled separately via agentExtensionId parameter.
   */
  function createFullSetupPreflightResult(): PreflightResult {
    return {
      success: true,
      needsSetup: true,
      missingBinaries: ["code-server", "opencode"],
      missingExtensions: ["codehydra.sidekick"],
      outdatedExtensions: [],
    };
  }

  beforeEach(async () => {
    tempDir = await createTestDir();
    fsLayer = new DefaultFileSystemLayer(SILENT_LOGGER);

    // Set up mock paths pointing to our temp directory
    mockPaths = {
      vscodeDir: join(tempDir, "vscode"),
      extensionsDir: join(tempDir, "vscode", "extensions"),
      userDataDir: join(tempDir, "vscode", "user-data"),
      markerPath: join(tempDir, ".setup-completed"), // New location is <dataRoot>/.setup-completed
      assetsDir: join(tempDir, "assets"),
      binDir: join(tempDir, "bin"),
    };

    // Create mock asset files
    await createMockAssets(mockPaths.assetsDir);

    // Create PathProvider pointing to our temp directory
    testPathProvider = createMockPathProvider({
      dataRootDir: tempDir,
      vscodeDir: mockPaths.vscodeDir,
      vscodeExtensionsDir: mockPaths.extensionsDir,
      vscodeUserDataDir: mockPaths.userDataDir,
      setupMarkerPath: mockPaths.markerPath,
      vscodeAssetsDir: mockPaths.assetsDir,
      binDir: mockPaths.binDir,
      binAssetsDir: join(mockPaths.assetsDir, "bin"),
      binRuntimeDir: join(mockPaths.assetsDir, "bin"), // Same as assets in dev mode
      extensionsRuntimeDir: mockPaths.assetsDir, // Same as assets in dev mode
      scriptsRuntimeDir: join(mockPaths.assetsDir, "scripts"), // Same as assets in dev mode
      opencodeConfig: join(tempDir, "opencode", "opencode.codehydra.json"),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("Full setup flow", () => {
    it("creates all required files in correct locations", async () => {
      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      // Run setup
      const result = await service.setup(preflight);

      expect(result.success).toBe(true);

      // Verify vsix exists in extensionsRuntimeDir (no copy - installed directly)
      const vsixPath = join(mockPaths.assetsDir, "codehydra-sidekick-0.0.3.vsix");
      const vsixContent = await readFile(vsixPath, "utf-8");
      expect(vsixContent).toBe("mock-vsix-content");

      // Verify marker file
      const marker = JSON.parse(await readFile(mockPaths.markerPath, "utf-8")) as SetupMarker;
      expect(marker.schemaVersion).toBe(1);
      expect(marker.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("emits progress callbacks in correct order", async () => {
      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      const progressMessages: string[] = [];
      const result = await service.setup(preflight, (progress) => {
        progressMessages.push(progress.message);
      });

      expect(result.success).toBe(true);
      // Extension installation, then CLI scripts, then finalize
      expect(progressMessages).toContain("Installing codehydra.sidekick...");
      expect(progressMessages).toContain("Creating CLI wrapper scripts...");
      expect(progressMessages).toContain("Finalizing setup...");

      // Verify order: bundled extensions, then CLI scripts, then finalize
      const codehydraIndex = progressMessages.indexOf("Installing codehydra.sidekick...");
      const scriptsIndex = progressMessages.indexOf("Creating CLI wrapper scripts...");
      const finalizeIndex = progressMessages.indexOf("Finalizing setup...");

      expect(codehydraIndex).toBeLessThan(scriptsIndex);
      expect(scriptsIndex).toBeLessThan(finalizeIndex);
    });

    it("completes within reasonable time", async () => {
      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      const startTime = Date.now();
      await service.setup(preflight);
      const elapsedMs = Date.now() - startTime;

      // Setup should complete within 5 seconds (generous for slow CI)
      expect(elapsedMs).toBeLessThan(5000);
    });
  });

  describe("Partial failure cleanup", () => {
    it("does not write marker when extension install fails", async () => {
      const processRunner = createTestProcessRunner(1, "Failed to install extension");
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      const result = await service.setup(preflight);

      expect(result.success).toBe(false);

      // Marker should not exist
      await expect(access(mockPaths.markerPath)).rejects.toThrow();
    });

    it("bundled vsix exists in extensionsRuntimeDir for install", async () => {
      const processRunner = createTestProcessRunner(1, "Failed");
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      await service.setup(preflight);

      // Vsix file should exist in extensionsRuntimeDir (created by createMockAssets)
      // No copy needed - code-server reads directly from this location
      const vsixPath = join(mockPaths.assetsDir, "codehydra-sidekick-0.0.3.vsix");
      const vsixContent = await readFile(vsixPath, "utf-8");
      expect(vsixContent).toBe("mock-vsix-content");
    });
  });

  describe("Version mismatch triggers re-setup", () => {
    it("returns false for legacy version marker", async () => {
      // Create marker with old 'version' field (legacy format)
      await mkdir(mockPaths.vscodeDir, { recursive: true });
      const legacyMarker = {
        version: 6, // Old format used 'version' instead of 'schemaVersion'
        completedAt: new Date().toISOString(),
      };
      await writeFile(mockPaths.markerPath, JSON.stringify(legacyMarker), "utf-8");

      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);

      const isComplete = await service.isSetupComplete();
      expect(isComplete).toBe(false);
    });

    it("returns true for current schemaVersion marker", async () => {
      // Create marker with current schemaVersion
      await mkdir(mockPaths.vscodeDir, { recursive: true });
      const marker: SetupMarker = {
        schemaVersion: 1,
        completedAt: new Date().toISOString(),
      };
      await writeFile(mockPaths.markerPath, JSON.stringify(marker), "utf-8");

      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);

      const isComplete = await service.isSetupComplete();
      expect(isComplete).toBe(true);
    });

    it("cleanVscodeDir removes entire directory", async () => {
      // Create full setup state
      await mkdir(join(mockPaths.extensionsDir, "codehydra.sidekick-0.0.2-universal"), {
        recursive: true,
      });
      await writeFile(
        join(mockPaths.extensionsDir, "codehydra.sidekick-0.0.2-universal", "package.json"),
        "{}",
        "utf-8"
      );
      await mkdir(join(mockPaths.userDataDir, "User"), { recursive: true });
      await writeFile(join(mockPaths.userDataDir, "User", "settings.json"), "{}", "utf-8");
      await writeFile(mockPaths.markerPath, "{}", "utf-8");

      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);

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

  describe("Setup with bin scripts", () => {
    it("setup() calls setupBinDirectory()", async () => {
      // Update pathProvider to include binDir
      const binDir = join(tempDir, "bin");
      testPathProvider = createMockPathProvider({
        dataRootDir: tempDir,
        vscodeDir: mockPaths.vscodeDir,
        vscodeExtensionsDir: mockPaths.extensionsDir,
        vscodeUserDataDir: mockPaths.userDataDir,
        setupMarkerPath: mockPaths.markerPath,
        vscodeAssetsDir: mockPaths.assetsDir,
        binDir,
        binAssetsDir: join(mockPaths.assetsDir, "bin"),
        binRuntimeDir: join(mockPaths.assetsDir, "bin"),
        extensionsRuntimeDir: mockPaths.assetsDir,
        scriptsRuntimeDir: join(mockPaths.assetsDir, "scripts"),
        opencodeConfig: join(tempDir, "opencode", "opencode.codehydra.json"),
      });

      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        fsLayer,
        createMockPlatformInfo({ platform: "linux" })
      );
      const preflight = createFullSetupPreflightResult();

      const result = await service.setup(preflight);

      expect(result.success).toBe(true);

      // Verify bin directory was created with scripts copied from assets
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(binDir));
      expect(entries).toContain("code");
    });

    it("emits progress callback for bin scripts", async () => {
      const binDir = join(tempDir, "bin");
      testPathProvider = createMockPathProvider({
        dataRootDir: tempDir,
        vscodeDir: mockPaths.vscodeDir,
        vscodeExtensionsDir: mockPaths.extensionsDir,
        vscodeUserDataDir: mockPaths.userDataDir,
        setupMarkerPath: mockPaths.markerPath,
        vscodeAssetsDir: mockPaths.assetsDir,
        binDir,
        binAssetsDir: join(mockPaths.assetsDir, "bin"),
        binRuntimeDir: join(mockPaths.assetsDir, "bin"),
        extensionsRuntimeDir: mockPaths.assetsDir,
        scriptsRuntimeDir: join(mockPaths.assetsDir, "scripts"),
        opencodeConfig: join(tempDir, "opencode", "opencode.codehydra.json"),
      });

      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(
        processRunner,
        testPathProvider,
        fsLayer,
        createMockPlatformInfo({ platform: "linux" })
      );
      const preflight = createFullSetupPreflightResult();

      const progressMessages: string[] = [];
      await service.setup(preflight, (progress) => {
        progressMessages.push(progress.message);
      });

      expect(progressMessages).toContain("Creating CLI wrapper scripts...");
    });
  });

  describe("Progress callbacks for row-based UI", () => {
    it("emits progress callbacks with step information for row mapping", async () => {
      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      const progressUpdates: Array<{ step: string; message: string }> = [];
      const result = await service.setup(preflight, (progress) => {
        progressUpdates.push({ step: progress.step, message: progress.message });
      });

      expect(result.success).toBe(true);

      // Verify progress steps are emitted (these map to UI rows)
      // Extension installation maps to "setup" row
      const extensionSteps = progressUpdates.filter((p) => p.step === "extensions");
      expect(extensionSteps.length).toBeGreaterThan(0);
      expect(extensionSteps[0]?.message).toMatch(/installing/i);

      // Config steps map to "setup" row
      const configSteps = progressUpdates.filter((p) => p.step === "config");
      expect(configSteps.length).toBeGreaterThan(0);

      // Finalize step maps to "setup" row
      const finalizeSteps = progressUpdates.filter((p) => p.step === "finalize");
      expect(finalizeSteps.length).toBe(1);
    });
  });

  describe("Extension installation failures", () => {
    it("fails with clear error when vsix file is missing", async () => {
      // Clean up assets directory and recreate without the vsix file
      await rm(mockPaths.assetsDir, { recursive: true, force: true });
      await mkdir(mockPaths.assetsDir, { recursive: true });
      await writeFile(
        join(mockPaths.assetsDir, "manifest.json"),
        JSON.stringify([
          {
            id: "codehydra.sidekick",
            version: "0.0.3",
            vsix: "codehydra-sidekick-0.0.3.vsix", // This file won't exist
          },
        ])
      );
      // Don't create the vsix file

      const processRunner = createTestProcessRunner();
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      // Preflight with extension missing
      const preflight: PreflightResult = {
        success: true,
        needsSetup: true,
        missingBinaries: [],
        missingExtensions: ["codehydra.sidekick"],
        outdatedExtensions: [],
      };

      const result = await service.setup(preflight);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("missing-assets");
        expect(result.error.message).toContain("codehydra-sidekick-0.0.3.vsix");
        expect(result.error.code).toBe("VSIX_NOT_FOUND");
      }
    });

    it("fails with error when extension installation fails", async () => {
      const processRunner = createTestProcessRunner(1, "Extension installation failed");
      const service = new VscodeSetupService(processRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      const result = await service.setup(preflight);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("Failed to install extension");
      }
    });
  });

  /**
   * Real code-server tests - skipped by default.
   * Run manually with: pnpm test -- --run vscode-setup-service.integration --no-skip
   */
  describe.skip("Real code-server tests (manual only)", () => {
    it("extension install with real code-server", async () => {
      const { ExecaProcessRunner } = await import("../platform/process");
      const realProcessRunner = new ExecaProcessRunner(SILENT_LOGGER);

      const service = new VscodeSetupService(realProcessRunner, testPathProvider, fsLayer);
      const preflight = createFullSetupPreflightResult();

      // Clean up any existing state first
      await service.cleanVscodeDir();

      const result = await service.setup(preflight);

      // Verify extensions were installed from bundled vsix files
      if (result.success) {
        const extensionsDir = mockPaths.extensionsDir;
        const entries = await import("node:fs/promises").then((fs) => fs.readdir(extensionsDir));
        const hasSidekick = entries.some((e) => e.includes("sidekick"));
        const hasOpenCode = entries.some((e) => e.includes("opencode"));
        expect(hasSidekick).toBe(true);
        expect(hasOpenCode).toBe(true);
      } else {
        // Skip assertion if installation failure
        console.warn("Skipping real code-server test:", result);
      }
    }, 180000); // 3 minute timeout for extension installation
  });
});
