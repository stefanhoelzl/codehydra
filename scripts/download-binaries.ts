/**
 * Postinstall script to download code-server and opencode binaries.
 *
 * This script is run after `npm install` to ensure binaries are available
 * for development. In production, binaries are downloaded during app setup.
 *
 * Usage: npm run postinstall (automatically run after npm install)
 *        npx tsx scripts/download-binaries.ts (manual run)
 */

import * as path from "node:path";
import * as os from "node:os";
import { DefaultBinaryDownloadService } from "../src/services/binary-download/binary-download-service";
import { DefaultArchiveExtractor } from "../src/services/binary-download/archive-extractor";
import { DefaultNetworkLayer } from "../src/services/platform/network";
import { DefaultFileSystemLayer } from "../src/services/platform/filesystem";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "../src/services/binary-download/versions";
import type { PathProvider } from "../src/services/platform/path-provider";
import type { PlatformInfo, SupportedArch } from "../src/services/platform/platform-info";
import type { BinaryType, DownloadProgress } from "../src/services/binary-download/types";
import type { Logger, LogContext } from "../src/services/logging";

// Console logger for the script
const logger: Logger = {
  debug(): void {
    // Don't log debug messages in postinstall
  },
  info(message: string, context?: LogContext): void {
    if (context) {
      console.log(`[info] ${message}`, context);
    } else {
      console.log(`[info] ${message}`);
    }
  },
  warn(message: string, context?: LogContext): void {
    if (context) {
      console.warn(`[warn] ${message}`, context);
    } else {
      console.warn(`[warn] ${message}`);
    }
  },
  error(message: string, context?: LogContext): void {
    if (context) {
      console.error(`[error] ${message}`, context);
    } else {
      console.error(`[error] ${message}`);
    }
  },
};

// Map Node.js arch to SupportedArch
function getSupportedArch(): SupportedArch {
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  throw new Error(`Unsupported architecture: ${process.arch}. CodeHydra requires x64 or arm64.`);
}

// Create a path provider for development mode (uses ./app-data/)
function createDevPathProvider(platformInfo: PlatformInfo): PathProvider {
  const dataRootDir = path.join(process.cwd(), "app-data");
  const isWindows = platformInfo.platform === "win32";

  // Binary directories with versions
  const codeServerDir = path.join(dataRootDir, "code-server", CODE_SERVER_VERSION);
  const opencodeDir = path.join(dataRootDir, "opencode", OPENCODE_VERSION);

  return {
    dataRootDir,
    projectsDir: path.join(dataRootDir, "projects"),
    vscodeDir: path.join(dataRootDir, "vscode"),
    vscodeExtensionsDir: path.join(dataRootDir, "vscode", "extensions"),
    vscodeUserDataDir: path.join(dataRootDir, "vscode", "user-data"),
    vscodeSetupMarkerPath: path.join(dataRootDir, "vscode", ".setup-completed"),
    electronDataDir: path.join(dataRootDir, "electron"),
    vscodeAssetsDir: path.join(process.cwd(), "out", "main", "assets"),
    appIconPath: path.join(process.cwd(), "resources", "icon.png"),
    binDir: path.join(dataRootDir, "bin"),
    codeServerDir,
    opencodeDir,
    codeServerBinaryPath: path.join(
      codeServerDir,
      isWindows ? "bin/code-server.cmd" : "bin/code-server"
    ),
    opencodeBinaryPath: path.join(opencodeDir, isWindows ? "opencode.exe" : "opencode"),
    getProjectWorkspacesDir: (projectPath: string): string => {
      const basename = path.basename(projectPath);
      return path.join(dataRootDir, "projects", basename, "workspaces");
    },
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
  const pathProvider = createDevPathProvider(platformInfo);

  console.log(`Platform: ${platformInfo.platform}-${platformInfo.arch}`);
  console.log(`Data directory: ${pathProvider.dataRootDir}\n`);

  // Create service with real implementations
  const service = new DefaultBinaryDownloadService(
    new DefaultNetworkLayer(logger),
    new DefaultFileSystemLayer(logger),
    new DefaultArchiveExtractor(),
    pathProvider,
    platformInfo,
    logger
  );

  // Download binaries
  console.log("Checking code-server...");
  await downloadBinary(service, "code-server", CODE_SERVER_VERSION);

  console.log("Checking opencode...");
  await downloadBinary(service, "opencode", OPENCODE_VERSION);

  // Create wrapper scripts
  console.log("\nCreating wrapper scripts...");
  await service.createWrapperScripts();
  console.log(`  Wrapper scripts created in ${pathProvider.binDir}`);

  console.log("\nBinary setup complete!");
}

main().catch((error) => {
  console.error("\nError during binary download:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
