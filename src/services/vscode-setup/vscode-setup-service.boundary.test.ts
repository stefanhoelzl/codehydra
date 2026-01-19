// @vitest-environment node
/**
 * Boundary tests for VscodeSetupService bin setup functionality.
 * Tests real filesystem operations for CLI wrapper script generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { readFile as nodeReadFile, stat, mkdir, copyFile } from "node:fs/promises";
import { VscodeSetupService } from "./vscode-setup-service";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { SILENT_LOGGER } from "../logging";
import { createTempDir } from "../test-utils";
import type { ProcessRunner, ProcessResult } from "./types";
import type { SpawnedProcess } from "../platform/process";

/**
 * Path to source bin scripts in resources/bin/.
 */
const RESOURCES_BIN_DIR = resolve(__dirname, "../../../resources/bin");

/**
 * Path to compiled wrappers (built by pnpm build:wrappers).
 */
const DIST_BIN_DIR = resolve(__dirname, "../../../dist/bin");

/**
 * Create a mock ProcessRunner for boundary tests.
 * Process spawning isn't needed for testing setupBinDirectory.
 */
function createBoundaryProcessRunner(): ProcessRunner {
  const result: ProcessResult = { exitCode: 0, stdout: "", stderr: "" };
  const proc: SpawnedProcess = {
    pid: 12345,
    kill: () => Promise.resolve({ success: true, reason: "SIGTERM" as const }),
    wait: () => Promise.resolve(result),
  };
  return {
    run: () => proc,
  };
}

/**
 * Set up bin assets directory with source scripts for testing.
 * Copies scripts from resources/bin/ and dist/bin/ to the temp assets dir.
 */
async function setupBinAssets(binAssetsDir: string): Promise<void> {
  await mkdir(binAssetsDir, { recursive: true });

  // Copy shell scripts from resources/bin/
  const shellScripts = ["code", "code.cmd", "ch-opencode", "ch-opencode.cmd"];
  for (const script of shellScripts) {
    await copyFile(join(RESOURCES_BIN_DIR, script), join(binAssetsDir, script));
  }

  // Copy compiled ch-opencode.cjs from dist/bin/
  await copyFile(join(DIST_BIN_DIR, "ch-opencode.cjs"), join(binAssetsDir, "ch-opencode.cjs"));
}

describe("VscodeSetupService.setupBinDirectory (boundary)", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let fs: DefaultFileSystemLayer;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new DefaultFileSystemLayer(SILENT_LOGGER);
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it("creates bin directory on filesystem", async () => {
    const binDir = join(tempDir.path, "bin");
    const binAssetsDir = join(tempDir.path, "assets", "bin");
    await setupBinAssets(binAssetsDir);

    const pathProvider = createMockPathProvider({
      dataRootDir: tempDir.path,
      binDir,
      binAssetsDir,
      vscodeDir: join(tempDir.path, "vscode"),
      vscodeAssetsDir: join(tempDir.path, "assets"),
      setupMarkerPath: join(tempDir.path, "vscode", ".setup-completed"),
    });

    const service = new VscodeSetupService(
      createBoundaryProcessRunner(),
      pathProvider,
      fs,
      createMockPlatformInfo({ platform: "linux" })
    );

    await service.setupBinDirectory();

    // Verify directory exists
    const dirStat = await stat(binDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("writes executable scripts on Unix", async () => {
    // Skip on Windows
    if (process.platform === "win32") {
      return;
    }

    const binDir = join(tempDir.path, "bin");
    const binAssetsDir = join(tempDir.path, "assets", "bin");
    await setupBinAssets(binAssetsDir);

    const pathProvider = createMockPathProvider({
      dataRootDir: tempDir.path,
      binDir,
      binAssetsDir,
      vscodeDir: join(tempDir.path, "vscode"),
      vscodeAssetsDir: join(tempDir.path, "assets"),
      setupMarkerPath: join(tempDir.path, "vscode", ".setup-completed"),
    });

    const service = new VscodeSetupService(
      createBoundaryProcessRunner(),
      pathProvider,
      fs,
      createMockPlatformInfo({ platform: "linux" })
    );

    await service.setupBinDirectory();

    // Verify code script exists and is executable
    // Note: code-server wrapper is not generated - we launch code-server directly
    const codeScriptPath = join(binDir, "code");
    const codeStat = await stat(codeScriptPath);
    expect(codeStat.isFile()).toBe(true);
    // Check execute permission (at least for owner)
    expect(codeStat.mode & 0o100).toBe(0o100);
  });

  it("generates scripts with correct content", async () => {
    const binDir = join(tempDir.path, "bin");
    const binAssetsDir = join(tempDir.path, "assets", "bin");
    await setupBinAssets(binAssetsDir);

    const pathProvider = createMockPathProvider({
      dataRootDir: tempDir.path,
      binDir,
      binAssetsDir,
      vscodeDir: join(tempDir.path, "vscode"),
      vscodeAssetsDir: join(tempDir.path, "assets"),
      setupMarkerPath: join(tempDir.path, "vscode", ".setup-completed"),
    });

    const service = new VscodeSetupService(
      createBoundaryProcessRunner(),
      pathProvider,
      fs,
      createMockPlatformInfo({ platform: "linux" })
    );

    await service.setupBinDirectory();

    // Read and verify script content
    // Note: code-server wrapper is not generated - we launch code-server directly
    const codeScript = await nodeReadFile(join(binDir, "code"), "utf-8");
    expect(codeScript).toMatch(/^#!/); // Shebang
    expect(codeScript).toContain("exec");
  });

  it("generates Windows scripts with correct content", async () => {
    const binDir = join(tempDir.path, "bin");
    const binAssetsDir = join(tempDir.path, "assets", "bin");
    await setupBinAssets(binAssetsDir);

    const pathProvider = createMockPathProvider({
      dataRootDir: tempDir.path,
      binDir,
      binAssetsDir,
      vscodeDir: join(tempDir.path, "vscode"),
      vscodeAssetsDir: join(tempDir.path, "assets"),
      setupMarkerPath: join(tempDir.path, "vscode", ".setup-completed"),
    });

    const service = new VscodeSetupService(
      createBoundaryProcessRunner(),
      pathProvider,
      fs,
      createMockPlatformInfo({ platform: "win32" })
    );

    await service.setupBinDirectory();

    // Read and verify Windows script content
    // Note: code-server wrapper is not generated - we launch code-server directly
    const codeScript = await nodeReadFile(join(binDir, "code.cmd"), "utf-8");
    expect(codeScript).toMatch(/^@echo off/);
    expect(codeScript).toContain("%*"); // Arguments
  });

  // Note: The code-server wrapper test was removed because we no longer generate
  // a code-server wrapper script - we launch code-server directly with an absolute path.
  // The `code` script cannot be tested here as it requires a running code-server instance.
});
