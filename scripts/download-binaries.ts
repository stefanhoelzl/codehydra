/**
 * Postinstall script to download code-server and opencode binaries.
 *
 * This script is run after `pnpm install` to ensure binaries are available
 * for development and testing. Binaries are downloaded to production paths
 * (e.g., ~/.local/share/codehydra/) so they are globally available across
 * all development environments.
 *
 * In production, binaries are downloaded during app setup to the same paths.
 *
 * Wrapper scripts are copied separately via `pnpm build:wrappers` which
 * copies from resources/bin/ and dist/bin/ to app-data/bin/.
 *
 * Usage: pnpm postinstall (automatically run after pnpm install)
 *        npx tsx scripts/download-binaries.ts (manual run)
 */

import * as os from "node:os";
import { DefaultBinaryDownloadService } from "../src/services/binary-download/binary-download-service";
import { DefaultArchiveExtractor } from "../src/services/binary-download/archive-extractor";
import { DefaultNetworkLayer } from "../src/services/platform/network";
import { DefaultFileSystemLayer } from "../src/services/platform/filesystem";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "../src/services/binary-download/versions";
import { DefaultPathProvider } from "../src/services/platform/path-provider";
import type { PlatformInfo, SupportedArch } from "../src/services/platform/platform-info";
import type { BuildInfo } from "../src/services/platform/build-info";
import type { BinaryType, DownloadProgress } from "../src/services/binary-download/types";
import type { Logger } from "../src/services/logging";

// Console logger for the script - suppresses warnings to avoid alarming output
// (e.g., ENOENT from readdir when checking if binary is installed is expected)
const logger: Logger = {
  silly(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

// Map Node.js arch to SupportedArch
function getSupportedArch(): SupportedArch {
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  throw new Error(`Unsupported architecture: ${process.arch}. CodeHydra requires x64 or arm64.`);
}

// Create build info for development mode
function createDevBuildInfo(): BuildInfo {
  return {
    version: "dev",
    isDevelopment: true,
    appPath: process.cwd(),
  };
}

// Create platform info
function createPlatformInfo(): PlatformInfo {
  return {
    platform: process.platform,
    arch: getSupportedArch(),
    homeDir: os.homedir(),
  };
}

// Format bytes for display
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Progress callback that updates a single line
function createProgressCallback(binary: string): (progress: DownloadProgress) => void {
  return (progress: DownloadProgress) => {
    const downloaded = formatBytes(progress.bytesDownloaded);
    const total = progress.totalBytes ? formatBytes(progress.totalBytes) : "unknown";
    const percent = progress.totalBytes
      ? Math.round((progress.bytesDownloaded / progress.totalBytes) * 100)
      : 0;

    process.stdout.write(`\r  Downloading ${binary}: ${downloaded} / ${total} (${percent}%)`);
  };
}

async function downloadBinary(
  service: DefaultBinaryDownloadService,
  binary: BinaryType,
  version: string
): Promise<void> {
  const isInstalled = await service.isInstalled(binary);

  if (isInstalled) {
    console.log(`  ${binary} v${version} is already installed`);
    return;
  }

  const progressCallback = createProgressCallback(binary);

  try {
    await service.download(binary, progressCallback);
    console.log(`\r  ${binary} v${version} downloaded successfully                    `);
  } catch (error) {
    console.log(""); // Clear progress line
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("Setting up binary dependencies...\n");

  const platformInfo = createPlatformInfo();
  const buildInfo = createDevBuildInfo();
  const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

  console.log(`Platform: ${platformInfo.platform}-${platformInfo.arch}`);
  console.log(`Data directory: ${pathProvider.dataRootDir}`);
  console.log(`Binaries will be downloaded to production paths\n`);

  // Create service with real implementations
  const service = new DefaultBinaryDownloadService(
    new DefaultNetworkLayer(logger),
    new DefaultFileSystemLayer(logger),
    new DefaultArchiveExtractor(),
    pathProvider,
    platformInfo,
    logger
  );

  // Download binaries to production paths
  console.log("Checking code-server...");
  await downloadBinary(service, "code-server", CODE_SERVER_VERSION);

  console.log("Checking opencode...");
  await downloadBinary(service, "opencode", OPENCODE_VERSION);

  console.log("\nBinary setup complete!");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\nBinary download skipped: ${message}`);
  console.log("Run 'pnpm postinstall' to retry, or binaries will download on first app launch.");
  process.exit(1);
});
