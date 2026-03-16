/**
 * Postinstall script to download code-server, opencode, and claude binaries.
 *
 * This script is run after `pnpm install` to ensure binaries are available
 * for development and testing. Binaries are downloaded to production paths
 * (e.g., ~/.local/share/codehydra/) so they are globally available across
 * all development environments.
 *
 * In production, binaries are downloaded during app setup to the same paths.
 *
 * For binaries with null version (like Claude), the script first checks if
 * the binary is available on the system (via --version check). If not, it fetches
 * the latest version and downloads to the versioned directory.
 *
 * Wrapper scripts are copied separately via `pnpm build:wrappers` which
 * copies from resources/bin/ and dist/bin/ to app-data/bin/.
 *
 * Usage: pnpm postinstall (automatically run after pnpm install)
 *        npx tsx scripts/download-binaries.ts (manual run)
 */

import { execSync } from "node:child_process";
import { DefaultArchiveExtractor } from "../src/boundaries/platform/archive-extractor";
import { DefaultNetworkLayer } from "../src/boundaries/platform/network";
import { DefaultFileSystemBoundary } from "../src/boundaries/platform/filesystem";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrl,
  getCodeServerSubPath,
  getCodeServerExecutablePath,
} from "../src/modules/code-server-module";
import {
  OPENCODE_VERSION,
  getOpencodeUrl,
  getOpencodeExecutablePath,
} from "../src/modules/agent-module/opencode/setup-info";
import {
  CLAUDE_VERSION,
  getClaudeUrl,
  getClaudeSubPath,
  getClaudeExecutablePath,
  getClaudeLatestVersionUrl,
} from "../src/modules/agent-module/claude/setup-info";
import { DefaultPathProvider } from "../src/boundaries/platform/path-provider";
import { NodePlatformInfo } from "../src/boundaries/platform/node-platform-info";
import type { BuildInfo } from "../src/boundaries/platform/build-info";
import {
  downloadBinary as downloadBinaryUtil,
  isBinaryInstalled,
} from "../src/utils/binary-download";
import type { DownloadRequest, DownloadProgress } from "../src/utils/binary-download";
import type { DownloadDeps } from "../src/utils/binary-download";
import type { SupportedPlatform, SupportedArch } from "../src/boundaries/platform/platform-info";
import type { Logger } from "../src/boundaries/platform/logging";

// Console logger for the script - suppresses warnings to avoid alarming output
// (e.g., ENOENT from readdir when checking if binary is installed is expected)
const logger: Logger = {
  silly(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

// Create build info for development mode
function createDevBuildInfo(): BuildInfo {
  return {
    version: "dev",
    isDevelopment: true,
    isPackaged: false,
    appPath: process.cwd(),
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

/**
 * Check if a binary is available and executable on the system.
 * Uses --version to confirm the binary works, not just exists.
 */
function isSystemBinaryAvailable(binaryName: string): boolean {
  try {
    execSync(`${binaryName} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the latest Claude version from the GCS bucket.
 */
async function fetchLatestClaudeVersion(): Promise<string> {
  const url = getClaudeLatestVersionUrl();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest Claude version: ${response.status}`);
  }

  const version = (await response.text()).trim();

  // Validate version format
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid Claude version format: ${version}`);
  }

  return version;
}

async function downloadBinary(
  deps: DownloadDeps,
  request: DownloadRequest,
  version: string
): Promise<void> {
  const installed = await isBinaryInstalled(request.destDir, deps);

  if (installed) {
    console.log(`  ${request.name} v${version} is already installed`);
    return;
  }

  const progressCallback = createProgressCallback(request.name);

  try {
    await downloadBinaryUtil(request, deps, progressCallback);
    console.log(`\r  ${request.name} v${version} downloaded successfully                    `);
  } catch (error) {
    console.log(""); // Clear progress line
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("Setting up binary dependencies...\n");

  const platformInfo = new NodePlatformInfo();
  const buildInfo = createDevBuildInfo();
  const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);
  const platform = platformInfo.platform as SupportedPlatform;
  const arch = platformInfo.arch as SupportedArch;

  console.log(`Platform: ${platformInfo.platform}-${platformInfo.arch}`);
  console.log(`Binaries will be downloaded to production paths\n`);

  // Create download deps with real implementations
  const deps: DownloadDeps = {
    httpClient: new DefaultNetworkLayer(logger),
    fileSystemLayer: new DefaultFileSystemBoundary(logger),
    archiveExtractor: new DefaultArchiveExtractor(),
    logger,
  };

  // Download binaries to production paths
  console.log("Checking code-server...");
  const codeServerRequest: DownloadRequest = {
    name: "code-server",
    url: getCodeServerUrl(platform, arch),
    destDir: pathProvider.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toNative(),
    archiveExtension: ".tar.gz",
    executablePath: getCodeServerExecutablePath(platform),
    subPath: getCodeServerSubPath(platform, arch),
  };
  await downloadBinary(deps, codeServerRequest, CODE_SERVER_VERSION);

  console.log("Checking opencode...");
  const opencodeRequest: DownloadRequest = {
    name: "opencode",
    url: getOpencodeUrl(platform, arch),
    destDir: pathProvider.bundlePath(`opencode/${OPENCODE_VERSION}`).toNative(),
    archiveExtension: platform === "darwin" || platform === "win32" ? ".zip" : ".tar.gz",
    executablePath: getOpencodeExecutablePath(platform),
  };
  await downloadBinary(deps, opencodeRequest, OPENCODE_VERSION);

  // Claude: prefer system binary, skip download if available
  console.log("Checking claude...");
  if (isSystemBinaryAvailable("claude")) {
    console.log("  claude is available on system PATH");
  } else if (CLAUDE_VERSION !== null) {
    // If CLAUDE_VERSION is pinned, use the standard download flow
    const claudeRequest: DownloadRequest = {
      name: "claude",
      url: getClaudeUrl(platform, arch),
      destDir: pathProvider.bundlePath(`claude/${CLAUDE_VERSION}`).toNative(),
      archiveExtension: ".tar.gz",
      executablePath: getClaudeExecutablePath(platform),
      subPath: getClaudeSubPath(platform, arch),
    };
    await downloadBinary(deps, claudeRequest, CLAUDE_VERSION);
  } else {
    // CLAUDE_VERSION is null: fetch latest version and download
    try {
      const latestVersion = await fetchLatestClaudeVersion();
      console.log(`  claude v${latestVersion} available (will download on first run if needed)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  claude version check skipped: ${message}`);
      console.log("  Install Claude via: npm install -g @anthropic-ai/claude-code");
    }
  }

  console.log("\nBinary setup complete!");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\nBinary download skipped: ${message}`);
  console.log("Run 'pnpm postinstall' to retry, or binaries will download on first app launch.");
  process.exit(1);
});
