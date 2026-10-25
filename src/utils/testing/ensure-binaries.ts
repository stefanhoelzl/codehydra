/**
 * Test utility for ensuring binaries are available before tests.
 *
 * This module provides utilities for boundary tests that need actual binaries.
 * Instead of silently skipping tests when binaries are missing, tests should
 * use these utilities to ensure binaries are downloaded before running.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefaultPathProvider } from "../../boundaries/platform/path-provider";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { DefaultNetworkLayer } from "../../boundaries/platform/network";
import { DefaultArchiveExtractor } from "../../boundaries/platform/archive-extractor";
import {
  createVscodiumIdeServer,
  VSCODIUM_VERSION,
} from "../../modules/ide-server-module/vscodium";
import {
  createOpencodeBinaryDescriptor,
  getOpencodeExecutablePath,
  OPENCODE_NPM_PACKAGE,
  OPENCODE_NPM_REGISTRY,
} from "../../modules/agent-module/opencode/setup-info";
import type { HttpClient } from "../../boundaries/platform/network";
import { BinaryDownloadError } from "../../shared/errors/service-errors";
import {
  compareVersions,
  createAgentBinaryResolver,
} from "../../modules/agent-module/binary-resolver";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { ExecaProcessRunner } from "../../boundaries/platform/process";
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
export type TestBinaryType = "vscodium" | "opencode";

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
  /**
   * Which OpenCode wire the tests exercise: 1.x (default) or 2.x. Decides
   * which major is downloaded and which install is picked — both can be on
   * disk at once, one version directory per major.
   */
  opencodeMajor?: 1 | 2;
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
 * Build the DownloadRequest for the pinned VSCodium bundle.
 */
function buildVscodiumRequest(
  pathProvider: DefaultPathProvider,
  platformInfo: PlatformInfo
): { request: DownloadRequest; binaryPath: string } {
  const platform = platformInfo.platform as SupportedPlatform;
  const arch = platformInfo.arch as SupportedArch;
  const ide = createVscodiumIdeServer();
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

/** npm's dist-tags for the OpenCode 2 CLI package; its `latest` is the newest 2.x. */
export const OPENCODE_NPM_DIST_TAGS_URL = `${OPENCODE_NPM_REGISTRY}/-/package/${OPENCODE_NPM_PACKAGE}/dist-tags`;

/**
 * The latest OpenCode 2, from npm's dist-tags: the version the 2.x test lane
 * runs. Test-only — the app has no such channel; its `latest` is whatever the
 * GitHub `releases/latest` redirect names (1.x today).
 */
export async function resolveLatestOpenCode2(
  httpClient: Pick<HttpClient, "fetch">
): Promise<string> {
  const response = await httpClient.fetch(OPENCODE_NPM_DIST_TAGS_URL);
  if (!response.ok) {
    throw new BinaryDownloadError(
      `HTTP ${response.status} looking up the latest OpenCode 2 on npm`,
      "NETWORK_ERROR"
    );
  }
  const tags = (await response.json()) as Partial<Record<string, unknown>>;
  const version = tags.latest;
  if (typeof version !== "string" || version.length === 0) {
    throw new BinaryDownloadError(
      "Could not read the latest OpenCode 2 from npm's dist-tags",
      "INVALID_VERSION"
    );
  }
  return version;
}

/**
 * The newest downloaded OpenCode of a major, or null. The 1.x lane runs the
 * latest release like the app does; the 2.x lane runs the latest 2.x.
 */
function findDownloadedOpencode(
  pathProvider: DefaultPathProvider,
  platformInfo: PlatformInfo,
  major: 1 | 2
): string | null {
  const root = pathProvider.bundlePath("opencode").toNative();
  const executable = getOpencodeExecutablePath(platformInfo.platform as SupportedPlatform);
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return null;
  }
  const ofMajor = versions.filter((v) => v.split(".")[0] === String(major));
  for (const version of ofMajor.sort((a, b) => compareVersions(b, a))) {
    const binaryPath = join(root, version, executable);
    if (existsSync(binaryPath)) return binaryPath;
  }
  return null;
}

function createDownloadDeps(): DownloadDeps {
  return {
    httpClient: new DefaultNetworkLayer(SILENT_LOGGER),
    fileSystemLayer: new DefaultFileSystemBoundary(SILENT_LOGGER),
    archiveExtractor: new DefaultArchiveExtractor(),
    logger: SILENT_LOGGER,
  };
}

function reportProgress(
  binary: TestBinaryType
): (progress: { bytesDownloaded: number; totalBytes: number | null }) => void {
  return (progress) => {
    // `\r` progress only on a terminal; a CI log would get one line per update.
    if (process.stdout.isTTY && progress.totalBytes) {
      const percent = Math.round((progress.bytesDownloaded / progress.totalBytes) * 100);
      process.stdout.write(`\r  Downloading ${binary}: ${percent}%`);
    }
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

  if (binary === "opencode") {
    // The 1.x lane seeds the latest release, whatever is installed on the
    // system — the same download `codehydra --download-binaries` makes. The 2.x
    // lane seeds the latest 2.x npm dist-tag instead, since the GitHub
    // `releases/latest` redirect still points at 1.x. Skipped when present.
    const major = options?.opencodeMajor ?? 1;
    const version =
      major === 2 ? await resolveLatestOpenCode2(createDownloadDeps().httpClient) : null;
    const resolver = createAgentBinaryResolver({
      descriptor: createOpencodeBinaryDescriptor(
        platformInfo.platform as SupportedPlatform,
        platformInfo.arch as SupportedArch
      ),
      version: { get: () => version },
      pathProvider,
      fileSystem: new DefaultFileSystemBoundary(SILENT_LOGGER),
      processRunner: new ExecaProcessRunner(SILENT_LOGGER),
      downloadDeps: createDownloadDeps(),
      env: {},
      platform: platformInfo.platform as SupportedPlatform,
      logger: SILENT_LOGGER,
    });
    const seeded = await resolver.seed(reportProgress(binary));
    console.log(`opencode v${seeded} ready for tests`);
    return;
  }

  const { request, binaryPath } = buildVscodiumRequest(pathProvider, platformInfo);
  if (existsSync(binaryPath)) {
    return;
  }

  console.log(`Downloading ${binary} v${VSCODIUM_VERSION} for tests...`);
  await downloadBinary(request, createDownloadDeps(), reportProgress(binary));
  process.stdout.write("\n");
  console.log(`Downloaded ${binary} to ${binaryPath}`);
}

/**
 * Timeout for warmBinaryForTests, also intended as the beforeAll hook timeout
 * of tests that call it (the default 10s hook timeout is too short for a
 * first-exec Gatekeeper stall).
 */
export const BINARY_WARM_TIMEOUT_MS = 120_000;

/**
 * Warm a binary by executing it once (`--version`) and waiting for exit.
 *
 * On macOS, the first execution of a freshly written unsigned binary triggers
 * a Gatekeeper/syspolicyd code-signature assessment that can stall for many
 * seconds on CI runners. Calling this in a beforeAll hook (with
 * BINARY_WARM_TIMEOUT_MS as the hook timeout) pays that one-time cost outside
 * the per-test timeout budget.
 *
 * Best-effort: a non-zero exit is ignored (the exec itself is what warms the
 * binary); a process still running after the timeout is killed.
 *
 * @param binary - Binary type (must already be installed)
 * @param options - Options for path provider
 */
export async function warmBinaryForTests(
  binary: TestBinaryType,
  options?: EnsureBinaryOptions
): Promise<void> {
  const binaryPath = getBinaryPathForTests(binary, options);
  const runner = new ExecaProcessRunner(SILENT_LOGGER);
  const proc = runner.run(binaryPath, ["--version"]);
  const result = await proc.wait(BINARY_WARM_TIMEOUT_MS);
  if (result.running) {
    await proc.kill(1000, 1000);
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
  const binaryPath =
    binary === "opencode"
      ? findDownloadedOpencode(pathProvider, platformInfo, options?.opencodeMajor ?? 1)
      : buildVscodiumRequest(pathProvider, platformInfo).binaryPath;

  if (binaryPath === null || !existsSync(binaryPath)) {
    throw new Error(
      `Binary ${binary} not found under ${pathProvider.bundlePath(binary).toNative()}. ` +
        `Call ensureBinaryForTests() first.`
    );
  }

  return binaryPath;
}
