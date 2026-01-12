/**
 * Test utility for ensuring binaries are available before tests.
 *
 * This module provides utilities for boundary tests that need actual binaries.
 * Instead of silently skipping tests when binaries are missing, tests should
 * use these utilities to ensure binaries are downloaded before running.
 */

import { existsSync } from "node:fs";
import { DefaultPathProvider } from "../platform/path-provider";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { DefaultNetworkLayer } from "../platform/network";
import { DefaultBinaryDownloadService } from "../binary-download/binary-download-service";
import { DefaultArchiveExtractor } from "../binary-download/archive-extractor";
import { BINARY_CONFIGS, CODE_SERVER_VERSION, OPENCODE_VERSION } from "../binary-download/versions";
import { SILENT_LOGGER } from "../logging";
import { createMockBuildInfo } from "../platform/build-info.test-utils";
import { NodePlatformInfo } from "../../main/platform-info";
import type { BinaryType } from "../binary-download/types";
import type { PlatformInfo } from "../platform/platform-info";

/**
 * Options for ensureBinaryForTests.
 */
export interface EnsureBinaryOptions {
  /** Custom PathProvider to use (defaults to development PathProvider) */
  pathProvider?: DefaultPathProvider;
  /** Custom PlatformInfo to use (defaults to NodePlatformInfo) */
  platformInfo?: PlatformInfo;
  /** Timeout for download in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
}

/**
 * Get the default PathProvider for tests.
 * Uses development mode with current working directory as appPath.
 */
export function getTestPathProvider(): DefaultPathProvider {
  const buildInfo = createMockBuildInfo({
    isDevelopment: true,
    appPath: process.cwd(),
  });
  const platformInfo = new NodePlatformInfo();
  return new DefaultPathProvider(buildInfo, platformInfo);
}

/**
 * Get the version for a binary type.
 */
function getBinaryVersion(binary: BinaryType): string {
  const config = BINARY_CONFIGS[binary];
  if (config.version === null) {
    // For binaries with null version (like Claude), we can't download a pinned version
    // Return a placeholder - caller should handle this case
    throw new Error(`Binary ${binary} has no pinned version. Use BinaryResolutionService instead.`);
  }
  return config.version;
}

/**
 * Check if a binary is installed at the expected path.
 *
 * @param binary - Binary type to check
 * @param options - Options for path provider
 * @returns true if the binary exists at the expected path
 */
export function isBinaryInstalled(binary: BinaryType, options?: EnsureBinaryOptions): boolean {
  try {
    const pathProvider = options?.pathProvider ?? getTestPathProvider();
    const version = getBinaryVersion(binary);
    const binaryPath = pathProvider.getBinaryPath(binary, version).toNative();
    return existsSync(binaryPath);
  } catch {
    return false;
  }
}

/**
 * Ensure a binary is available for tests.
 *
 * This function checks if the binary exists and downloads it if missing.
 * It's designed for use in beforeAll hooks in boundary tests.
 *
 * @param binary - Binary type to ensure
 * @param options - Options for download behavior
 * @throws Error if the binary cannot be downloaded
 *
 * @example
 * ```typescript
 * describe("MyBoundaryTest", () => {
 *   beforeAll(async () => {
 *     await ensureBinaryForTests("opencode");
 *   });
 *
 *   it("uses the binary", async () => {
 *     // binary is guaranteed to be available
 *   });
 * });
 * ```
 */
export async function ensureBinaryForTests(
  binary: BinaryType,
  options?: EnsureBinaryOptions
): Promise<void> {
  const pathProvider = options?.pathProvider ?? getTestPathProvider();
  const platformInfo = options?.platformInfo ?? new NodePlatformInfo();

  // Get version
  const version = getBinaryVersion(binary);
  const binaryPath = pathProvider.getBinaryPath(binary, version).toNative();

  // Check if already installed
  if (existsSync(binaryPath)) {
    return;
  }

  // Download the binary
  console.log(`Downloading ${binary} v${version} for tests...`);

  const httpClient = new DefaultNetworkLayer(SILENT_LOGGER);
  const fileSystem = new DefaultFileSystemLayer(SILENT_LOGGER);
  const archiveExtractor = new DefaultArchiveExtractor();

  const downloadService = new DefaultBinaryDownloadService(
    httpClient,
    fileSystem,
    archiveExtractor,
    pathProvider,
    platformInfo,
    SILENT_LOGGER
  );

  await downloadService.download(binary, (progress) => {
    if (progress.totalBytes) {
      const percent = Math.round((progress.bytesDownloaded / progress.totalBytes) * 100);
      process.stdout.write(`\r  Downloading ${binary}: ${percent}%`);
    }
  });

  process.stdout.write("\n");
  console.log(`Downloaded ${binary} to ${binaryPath}`);
}

/**
 * Ensure multiple binaries are available for tests.
 *
 * @param binaries - Array of binary types to ensure
 * @param options - Options for download behavior
 */
export async function ensureBinariesForTests(
  binaries: readonly BinaryType[],
  options?: EnsureBinaryOptions
): Promise<void> {
  for (const binary of binaries) {
    await ensureBinaryForTests(binary, options);
  }
}

/**
 * Get the path to a binary for tests.
 * Throws if the binary is not installed.
 *
 * @param binary - Binary type
 * @param options - Options for path provider
 * @returns Absolute path to the binary
 * @throws Error if the binary is not installed
 */
export function getBinaryPathForTests(binary: BinaryType, options?: EnsureBinaryOptions): string {
  const pathProvider = options?.pathProvider ?? getTestPathProvider();
  const version = getBinaryVersion(binary);
  const binaryPath = pathProvider.getBinaryPath(binary, version).toNative();

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Binary ${binary} not found at ${binaryPath}. ` +
        `Run 'pnpm install' to download binaries or call ensureBinaryForTests() first.`
    );
  }

  return binaryPath;
}

// Re-export version constants for convenience
export { CODE_SERVER_VERSION, OPENCODE_VERSION };
