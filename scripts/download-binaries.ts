/**
 * Postinstall script to download code-server and opencode binaries.
 *
 * This script is run after `pnpm install` to ensure binaries are available
 * for development. In production, binaries are downloaded during app setup.
 *
 * In git worktrees, binaries are symlinked from the main repo's app-data/
 * directory if available, avoiding redundant downloads (~600MB).
 * Falls back to copying if symlinks aren't supported (Windows without
 * Developer Mode, cross-device scenarios).
 *
 * Wrapper scripts are copied separately via `pnpm build:wrappers` which
 * copies from resources/bin/ and dist/bin/ to app-data/bin/.
 *
 * Usage: pnpm postinstall (automatically run after pnpm install)
 *        npx tsx scripts/download-binaries.ts (manual run)
 */

import * as path from "node:path";
import * as fs from "node:fs";
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

/**
 * Detect if we're running in a git worktree and return the main repo's app-data path.
 *
 * Git worktrees have a .git file (not directory) containing:
 *   gitdir: /path/to/main/repo/.git/worktrees/<worktree-name>
 *
 * @returns Path to main repo's app-data directory, or null if not in a worktree
 */
async function findMainRepoAppData(): Promise<string | null> {
  const gitPath = path.join(process.cwd(), ".git");

  try {
    const stat = await fs.promises.stat(gitPath);

    if (stat.isFile()) {
      // This is a worktree - .git is a file with gitdir: pointer
      const content = await fs.promises.readFile(gitPath, "utf-8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match?.[1]) {
        // gitdir points to .git/worktrees/<name>, go up to find main repo
        // e.g., /repo/.git/worktrees/download -> /repo
        const worktreeGitDir = match[1].trim();
        const mainRepoRoot = path.resolve(worktreeGitDir, "..", "..", "..");
        return path.join(mainRepoRoot, "app-data");
      }
    }
  } catch {
    // .git doesn't exist or can't be read - not a git repo
  }

  return null; // Main repo or not a git repo
}

/**
 * Try to symlink a binary directory from the main repo.
 * Falls back to copying if symlinks aren't supported.
 *
 * @returns true if binary was linked/copied, false if source doesn't exist
 */
async function linkOrCopyBinaryFromMainRepo(
  mainAppData: string,
  localAppData: string,
  binaryType: "code-server" | "opencode",
  version: string
): Promise<boolean> {
  const sourcePath = path.join(mainAppData, binaryType, version);
  const destPath = path.join(localAppData, binaryType, version);

  // Check if source exists in main repo
  try {
    const stat = await fs.promises.stat(sourcePath);
    if (!stat.isDirectory()) {
      return false;
    }
  } catch {
    return false; // Source doesn't exist
  }

  // Ensure parent directory exists (e.g., app-data/code-server/)
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  // Try symlink first (saves disk space)
  try {
    await fs.promises.symlink(sourcePath, destPath, "dir");
    console.log(`  ${binaryType} v${version} symlinked from main repo`);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    // Symlink failed - check if it's a recoverable error
    if (code === "EPERM" || code === "EXDEV") {
      // EPERM: Windows without privileges
      // EXDEV: Cross-device link not supported
      console.log(`  Symlink not available, copying ${binaryType} from main repo...`);
      await fs.promises.cp(sourcePath, destPath, { recursive: true });
      console.log(`  ${binaryType} v${version} copied from main repo`);
      return true;
    }

    // Re-throw unexpected errors
    throw err;
  }
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
  version: string,
  mainRepoAppData: string | null,
  localAppData: string
): Promise<void> {
  const isInstalled = await service.isInstalled(binary);

  if (isInstalled) {
    console.log(`  ${binary} v${version} is already installed`);
    return;
  }

  // Try to link/copy from main repo if we're in a worktree
  if (mainRepoAppData) {
    const linked = await linkOrCopyBinaryFromMainRepo(
      mainRepoAppData,
      localAppData,
      binary,
      version
    );
    if (linked) {
      return;
    }
    // Main repo doesn't have this version, fall through to download
    console.log(`  ${binary} v${version} not found in main repo, downloading...`);
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

  // Check if we're in a git worktree
  const mainRepoAppData = await findMainRepoAppData();
  if (mainRepoAppData) {
    console.log(`Detected git worktree`);
    console.log(`Main repo app-data: ${mainRepoAppData}`);
  }

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

  // Download binaries (or link from main repo if in worktree)
  console.log("Checking code-server...");
  await downloadBinary(
    service,
    "code-server",
    CODE_SERVER_VERSION,
    mainRepoAppData,
    pathProvider.dataRootDir.toString()
  );

  console.log("Checking opencode...");
  await downloadBinary(
    service,
    "opencode",
    OPENCODE_VERSION,
    mainRepoAppData,
    pathProvider.dataRootDir.toString()
  );

  console.log("\nBinary setup complete!");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\nBinary download skipped: ${message}`);
  console.log("Run 'pnpm postinstall' to retry, or binaries will download on first app launch.");
  // Exit successfully - missing dev binaries shouldn't fail pnpm install
  process.exit(0);
});
