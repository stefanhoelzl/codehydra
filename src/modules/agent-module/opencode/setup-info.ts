/**
 * OpenCode agent setup information: executable names and download coordinates.
 *
 * OpenCode 1.x and 2.x publish their binaries in different places, so a
 * download is routed by the version's major: 1.x are GitHub release assets of
 * {@link OPENCODE_REPO_URL}; 2.x ships no platform binaries on GitHub and is
 * distributed as npm platform packages under {@link OPENCODE_NPM_PACKAGE}.
 * Either way the executable ends up at the root of
 * `<bundles>/opencode/<version>/` (an npm tarball's `package/bin/` is promoted).
 *
 * The latest version is read from where `releases/latest` redirects
 * (`…/releases/tag/v<version>`), which needs no API token and has no rate
 * limit — whatever upstream marks latest is what the channel delivers (a 1.x
 * tag today; a future 2.x flip is picked up by the major routing above).
 */

import type { SupportedArch, SupportedPlatform } from "../types";
import type { ArchiveDownloadRequest } from "../../../utils/binary-download";
import { assertWindowsX64 } from "../../../utils/binary-download";
import type { ArchiveExtension } from "../../../utils/binary-download/types";
import { BinaryDownloadError } from "../../../shared/errors/service-errors";
import type { AgentBinaryDescriptor } from "../binary-resolver";

/** The OpenCode repository (moved from sst/opencode, whose URLs only redirect). */
export const OPENCODE_REPO_URL = "https://github.com/anomalyco/opencode";

/** npm's registry, where OpenCode 2 publishes its CLI platform packages. */
export const OPENCODE_NPM_REGISTRY = "https://registry.npmjs.org";

/** The npm package OpenCode 2 publishes its CLI through. */
export const OPENCODE_NPM_PACKAGE = "@opencode/cli";

/** Channels `version.opencode` may name instead of a version. */
export const OPENCODE_CHANNELS = ["latest"] as const;

/** Channel downloaded when nothing is configured or installed. */
export const OPENCODE_DEFAULT_CHANNEL = "latest";

/** Major versions with a server API CodeHydra can talk to. */
export const OPENCODE_SUPPORTED_MAJORS = [1, 2] as const;

/**
 * The server API a version of OpenCode speaks. 1.x and 2.x are different
 * contracts (docs/AGENT_PROVIDERS.md); anything unreadable defaults to 1.x, the wire
 * CodeHydra has always spoken.
 */
export function opencodeWireVersion(version: string | null | undefined): 1 | 2 {
  const major = Number.parseInt(version ?? "1", 10);
  return major === 2 ? 2 : 1;
}

/**
 * Architecture name mappings for OpenCode releases and npm packages.
 */
const OPENCODE_ARCH: Record<SupportedArch, string> = {
  x64: "x64",
  arm64: "arm64",
};

/** How to download one OpenCode version on one platform. */
export interface OpencodeDownload {
  /** Download URL. */
  readonly url: string;
  /** Archive extension for temp file naming and extraction. */
  readonly archiveExtension: ArchiveExtension;
  /**
   * Directory inside the extracted archive that holds the executable, promoted
   * to the destination's root. npm tarballs nest it under `package/bin/`.
   */
  readonly subPath?: string;
}

/**
 * Get the download coordinates for OpenCode for a specific version, routed by
 * the version's major: 1.x from GitHub releases, 2.x from npm.
 *
 * @param version - Version string (e.g., "1.19.2", "2.1.4")
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download coordinates for the OpenCode release
 * @throws Error if platform/arch combination is not supported
 */
export function getOpencodeDownload(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): OpencodeDownload {
  assertWindowsX64(platform, arch, "OpenCode");
  const archName = OPENCODE_ARCH[arch];

  if (opencodeWireVersion(version) === 2) {
    // GitHub 2.x releases carry source archives only, so the binary comes from
    // the npm platform package (`@opencode/cli-linux-x64` and siblings), whose
    // tarball nests the executable under `package/bin/`.
    const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
    const pkgName = `cli-${os}-${archName}`;
    return {
      url: `${OPENCODE_NPM_REGISTRY}/${OPENCODE_NPM_PACKAGE}-${os}-${archName}/-/${pkgName}-${version}.tgz`,
      archiveExtension: ".tgz",
      subPath: "package/bin",
    };
  }

  const base = `${OPENCODE_REPO_URL}/releases/download/v${version}`;
  if (platform === "win32") {
    return { url: `${base}/opencode-windows-x64.zip`, archiveExtension: ".zip" };
  }
  const os = platform === "darwin" ? "darwin" : "linux";
  const ext: ArchiveExtension = platform === "darwin" ? ".zip" : ".tar.gz";
  return { url: `${base}/opencode-${os}-${archName}${ext}`, archiveExtension: ext };
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
    // 1.x and 2.x speak different server APIs; a PATH install of any other
    // major is a binary CodeHydra cannot talk to.
    supportedMajors: OPENCODE_SUPPORTED_MAJORS,

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
      const download = getOpencodeDownload(version, platform, arch);
      return {
        name: "opencode",
        url: download.url,
        destDir,
        archiveExtension: download.archiveExtension,
        executablePath,
        ...(download.subPath !== undefined && { subPath: download.subPath }),
      };
    },
  };
}
