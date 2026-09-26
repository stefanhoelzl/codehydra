/**
 * OpenCode agent setup information: executable names and download coordinates.
 *
 * Releases are GitHub releases of {@link OPENCODE_REPO_URL}. The latest version
 * is read from where `releases/latest` redirects (`…/releases/tag/v<version>`),
 * which needs no API token and has no rate limit.
 */

import type { SupportedArch, SupportedPlatform } from "../types";
import type { ArchiveDownloadRequest } from "../../../utils/binary-download";
import { assertWindowsX64 } from "../../../utils/binary-download";
import { BinaryDownloadError } from "../../../shared/errors/service-errors";
import type { AgentBinaryDescriptor } from "../binary-resolver";

/** The OpenCode repository (moved from sst/opencode, whose URLs only redirect). */
export const OPENCODE_REPO_URL = "https://github.com/anomalyco/opencode";

/** Channels `version.opencode` may name instead of a version. */
export const OPENCODE_CHANNELS = ["latest"] as const;

/** Channel downloaded when nothing is configured or installed. */
export const OPENCODE_DEFAULT_CHANNEL = "latest";

/**
 * Architecture name mappings for OpenCode releases.
 */
const OPENCODE_ARCH: Record<SupportedArch, string> = {
  x64: "x64",
  arm64: "arm64",
};

/**
 * Get the download URL for OpenCode for a specific version.
 *
 * @param version - Version string (e.g., "1.18.32")
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the OpenCode release
 * @throws Error if platform/arch combination is not supported
 */
export function getOpencodeUrlForVersion(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): string {
  assertWindowsX64(platform, arch, "OpenCode");
  const base = `${OPENCODE_REPO_URL}/releases/download/v${version}`;
  if (platform === "win32") {
    return `${base}/opencode-windows-x64.zip`;
  }
  const archName = OPENCODE_ARCH[arch];
  const os = platform === "darwin" ? "darwin" : "linux";
  const ext = platform === "darwin" ? "zip" : "tar.gz";
  return `${base}/opencode-${os}-${archName}.${ext}`;
}

/** URL that redirects to the latest release's tag page. */
export const OPENCODE_LATEST_URL = `${OPENCODE_REPO_URL}/releases/latest`;

/**
 * Read the version out of the URL `releases/latest` redirected to.
 *
 * @returns The version without its `v` prefix, or null when the URL is not a tag page
 */
export function parseOpencodeReleaseTagUrl(url: string): string | null {
  const match = /\/releases\/tag\/v?([^/?#]+)\/?(?:[?#].*)?$/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Get the relative path to the OpenCode executable within the extracted directory.
 *
 * @param platform - Operating system platform
 * @returns Relative path to the executable
 */
export function getOpencodeExecutablePath(platform: SupportedPlatform): string {
  return platform === "win32" ? "opencode.exe" : "opencode";
}

/** Download coordinates for OpenCode on one platform. */
export function createOpencodeBinaryDescriptor(
  platform: SupportedPlatform,
  arch: SupportedArch
): AgentBinaryDescriptor {
  const executablePath = getOpencodeExecutablePath(platform);
  return {
    name: "opencode",
    channels: OPENCODE_CHANNELS,
    defaultChannel: OPENCODE_DEFAULT_CHANNEL,
    executablePath,
    systemCandidates: platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"],

    async resolveChannel(channel, httpClient) {
      if (channel !== "latest") {
        throw new BinaryDownloadError(`Unknown OpenCode channel: ${channel}`, "INVALID_VERSION");
      }
      // fetch follows redirects; the response's URL is where it ended up.
      const response = await httpClient.fetch(OPENCODE_LATEST_URL);
      if (!response.ok) {
        throw new BinaryDownloadError(
          `HTTP ${response.status} looking up the latest OpenCode release`,
          "NETWORK_ERROR"
        );
      }
      const version = parseOpencodeReleaseTagUrl(response.url);
      if (version === null) {
        throw new BinaryDownloadError(
          `Could not read the latest OpenCode version from ${response.url || OPENCODE_LATEST_URL}`,
          "INVALID_VERSION"
        );
      }
      return version;
    },

    async downloadRequest(version, destDir): Promise<ArchiveDownloadRequest> {
      return {
        name: "opencode",
        url: getOpencodeUrlForVersion(version, platform, arch),
        destDir,
        archiveExtension: platform === "linux" ? ".tar.gz" : ".zip",
        executablePath,
      };
    },
  };
}
