/**
 * Test utility for ensuring binaries are available before tests.
 *
 * This module provides utilities for boundary tests that need actual binaries.
 * Instead of silently skipping tests when binaries are missing, tests should
 * use these utilities to ensure binaries are downloaded before running.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DefaultPathProvider } from "../../boundaries/platform/path-provider";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { DefaultNetworkLayer } from "../../boundaries/platform/network";
import { DefaultArchiveExtractor } from "../../boundaries/platform/archive-extractor";
import {
  createCodeServerIdeServer,
  CODE_SERVER_VERSION,
} from "../../modules/ide-server-module/code-server";
import {
  OPENCODE_VERSION,
  getOpencodeUrl,
  getOpencodeExecutablePath,
} from "../../modules/agent-module/opencode/setup-info";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { createMockBuildInfo } from "../../boundaries/platform/build-info.test-utils";
import { NodePlatformInfo } from "../../boundaries/platform/node-platform-info";
import { downloadBinary } from "../binary-download";
import type { DownloadRequest } from "../binary-download";
import type { DownloadDeps } from "../binary-download";
import type { PlatformInfo } from "../../boundaries/platform/platform-info";
import type { SupportedPlatform, SupportedArch } from "../../boundaries/platform/platform-info";

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
    const ide = createCodeServerIdeServer();
    const destDir = pathProvider.bundlePath(ide.bundleSubdir()).toNative();
    const executablePath = ide.executablePath(platform);
    const subPath = ide.archiveSubPath(platform, arch);
    return {
      request: {
        name: ide.id,
        url: ide.downloadUrl(platform, arch),
        destDir,
        archiveExtension: ".tar.gz",
        executablePath,
        ...(subPath !== undefined ? { subPath } : {}),
      },
      binaryPath: join(destDir, executablePath),
    };
  }

  const destDir = pathProvider.bundlePath(`opencode/${OPENCODE_VERSION}`).toNative();
  const executablePath = getOpencodeExecutablePath(platform);
  return {
    request: {
      name: "opencode",
      url: getOpencodeUrl(platform, arch),
      destDir,
      archiveExtension: platform === "darwin" || platform === "win32" ? ".zip" : ".tar.gz",
      executablePath,
    },
    binaryPath: join(destDir, executablePath),
  };
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

  const deps: DownloadDeps = {
    httpClient: new DefaultNetworkLayer(SILENT_LOGGER),
    fileSystemLayer: new DefaultFileSystemBoundary(SILENT_LOGGER),
    archiveExtractor: new DefaultArchiveExtractor(),
    logger: SILENT_LOGGER,
  };

  await downloadBinary(request, deps, (progress) => {
    if (progress.totalBytes) {
      const percent = Math.round((progress.bytesDownloaded / progress.totalBytes) * 100);
      process.stdout.write(`\r  Downloading ${binary}: ${percent}%`);
    }
  });

  process.stdout.write("\n");
  console.log(`Downloaded ${binary} to ${binaryPath}`);
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
