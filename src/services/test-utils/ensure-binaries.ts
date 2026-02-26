/**
 * Test utility for ensuring binaries are available before tests.
 *
 * This module provides utilities for boundary tests that need actual binaries.
 * Instead of silently skipping tests when binaries are missing, tests should
 * use these utilities to ensure binaries are downloaded before running.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DefaultPathProvider } from "../platform/path-provider";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { DefaultNetworkLayer } from "../platform/network";
import { DefaultBinaryDownloadService } from "../binary-download/binary-download-service";
import { DefaultArchiveExtractor } from "../binary-download/archive-extractor";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrl,
  getCodeServerExecutablePath,
} from "../code-server/setup-info";
import {
  OPENCODE_VERSION,
  getOpencodeUrl,
  getOpencodeExecutablePath,
} from "../../agents/opencode/setup-info";
import { SILENT_LOGGER } from "../logging";
import { createMockBuildInfo } from "../platform/build-info.test-utils";
import { NodePlatformInfo } from "../../main/platform-info";
import type { DownloadRequest } from "../binary-download/types";
import type { PlatformInfo } from "../platform/platform-info";
import type { SupportedPlatform, SupportedArch } from "../../agents/types";

/**
 * Binary types supported for test downloads.
 */
export type TestBinaryType = "code-server" | "opencode";

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
 * Build a DownloadRequest for a binary type.
 */
function buildDownloadRequest(
  binary: TestBinaryType,
  pathProvider: DefaultPathProvider,
  platformInfo: PlatformInfo
): { request: DownloadRequest; binaryPath: string } {
  const platform = platformInfo.platform as SupportedPlatform;
  const arch = platformInfo.arch as SupportedArch;

  if (binary === "code-server") {
    const destDir = pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toNative();
    const executablePath = getCodeServerExecutablePath(platform);
    return {
      request: {
        name: "code-server",
        url: getCodeServerUrl(platform, arch),
        destDir,
        executablePath,
      },
      binaryPath: join(destDir, executablePath),
    };
  }

  const destDir = pathProvider.getBinaryDir("opencode", OPENCODE_VERSION).toNative();
  const executablePath = getOpencodeExecutablePath(platform);
  return {
    request: {
      name: "opencode",
      url: getOpencodeUrl(platform, arch),
      destDir,
      executablePath,
    },
    binaryPath: join(destDir, executablePath),
  };
}

/**
 * Check if a binary is installed at the expected path.
 *
 * @param binary - Binary type to check
 * @param options - Options for path provider
 * @returns true if the binary exists at the expected path
 */
export function isBinaryInstalled(binary: TestBinaryType, options?: EnsureBinaryOptions): boolean {
  try {
    const pathProvider = options?.pathProvider ?? getTestPathProvider();
    const platformInfo = options?.platformInfo ?? new NodePlatformInfo();
    const { binaryPath } = buildDownloadRequest(binary, pathProvider, platformInfo);
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
  binary: TestBinaryType,
  options?: EnsureBinaryOptions
): Promise<void> {
  const pathProvider = options?.pathProvider ?? getTestPathProvider();
  const platformInfo = options?.platformInfo ?? new NodePlatformInfo();
  const { request, binaryPath } = buildDownloadRequest(binary, pathProvider, platformInfo);

  // Check if already installed
  if (existsSync(binaryPath)) {
    return;
  }

  // Download the binary
  const version = binary === "code-server" ? CODE_SERVER_VERSION : OPENCODE_VERSION;
  console.log(`Downloading ${binary} v${version} for tests...`);

  const httpClient = new DefaultNetworkLayer(SILENT_LOGGER);
  const fileSystem = new DefaultFileSystemLayer(SILENT_LOGGER);
  const archiveExtractor = new DefaultArchiveExtractor();

  const downloadService = new DefaultBinaryDownloadService(
    httpClient,
    fileSystem,
    archiveExtractor,
    SILENT_LOGGER
  );

  await downloadService.download(request, (progress) => {
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
  binaries: readonly TestBinaryType[],
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
export function getBinaryPathForTests(
  binary: TestBinaryType,
  options?: EnsureBinaryOptions
): string {
  const pathProvider = options?.pathProvider ?? getTestPathProvider();
  const platformInfo = options?.platformInfo ?? new NodePlatformInfo();
  const { binaryPath } = buildDownloadRequest(binary, pathProvider, platformInfo);

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
