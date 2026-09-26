/**
 * Claude agent setup information: executable names and download coordinates.
 *
 * Releases live under {@link CLAUDE_DOWNLOAD_BASE}:
 * - `<channel>`                       → a version string (`latest`, `stable`)
 * - `<version>/manifest.json`         → per-platform binary name + sha256
 * - `<version>/<platform>/<binary>`   → the raw executable (no archive)
 */

import { z } from "zod/v4";
import type { SupportedArch, SupportedPlatform } from "../types";
import type { HttpClient } from "../../../boundaries/platform/network";
import type { FileDownloadRequest } from "../../../utils/binary-download";
import { assertWindowsX64 } from "../../../utils/binary-download";
import { BinaryDownloadError } from "../../../shared/errors/service-errors";
import type { AgentBinaryDescriptor } from "../binary-resolver";

/** Base URL for Claude Code releases. */
export const CLAUDE_DOWNLOAD_BASE = "https://downloads.claude.ai/claude-code-releases";

/** Channels `version.claude` may name instead of a version. */
export const CLAUDE_CHANNELS = ["latest", "stable"] as const;

/** Channel downloaded when nothing is configured or installed. */
export const CLAUDE_DEFAULT_CHANNEL = "stable";

/**
 * Manifest platform key for this platform/arch. Only the glibc Linux builds:
 * CodeHydra runs on Electron, which itself needs glibc, so a musl host never
 * gets this far.
 *
 * @throws Error on Windows arm64, which CodeHydra does not ship for
 */
export function getClaudePlatformKey(platform: SupportedPlatform, arch: SupportedArch): string {
  assertWindowsX64(platform, arch, "Claude");
  return `${platform}-${arch}`;
}

/** URL returning the version a channel currently points at. */
export function getClaudeChannelUrl(channel: string): string {
  return `${CLAUDE_DOWNLOAD_BASE}/${channel}`;
}

/** URL of a version's manifest. */
export function getClaudeManifestUrl(version: string): string {
  return `${CLAUDE_DOWNLOAD_BASE}/${version}/manifest.json`;
}

/** URL of a version's executable for one platform. */
export function getClaudeBinaryUrl(version: string, platformKey: string, binary: string): string {
  return `${CLAUDE_DOWNLOAD_BASE}/${version}/${platformKey}/${binary}`;
}

/**
 * Get the executable's file name.
 *
 * @param platform - Operating system platform
 * @returns "claude.exe" on Windows, "claude" elsewhere
 */
export function getClaudeExecutablePath(platform: SupportedPlatform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

const manifestSchema = z.object({
  version: z.string(),
  platforms: z.record(
    z.string(),
    z.object({
      binary: z.string(),
      checksum: z.string().regex(/^[0-9a-f]{64}$/i),
    })
  ),
});

/** One platform's entry in a release manifest. */
export interface ClaudeManifestEntry {
  readonly binary: string;
  readonly sha256: string;
}

/**
 * Pick this platform's entry out of a release manifest.
 *
 * @throws BinaryDownloadError when the manifest is malformed or lacks the platform
 */
export function parseClaudeManifest(json: unknown, platformKey: string): ClaudeManifestEntry {
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new BinaryDownloadError(
      `Invalid Claude release manifest: ${parsed.error.message}`,
      "INVALID_VERSION"
    );
  }
  const entry = parsed.data.platforms[platformKey];
  if (entry === undefined) {
    throw new BinaryDownloadError(
      `Claude ${parsed.data.version} has no build for ${platformKey}`,
      "UNSUPPORTED_PLATFORM"
    );
  }
  return { binary: entry.binary, sha256: entry.checksum.toLowerCase() };
}

async function fetchOk(
  httpClient: Pick<HttpClient, "fetch">,
  url: string,
  what: string
): Promise<Response> {
  const response = await httpClient.fetch(url);
  if (!response.ok) {
    throw new BinaryDownloadError(
      `HTTP ${response.status} fetching ${what} from ${url}`,
      "NETWORK_ERROR"
    );
  }
  return response;
}

/** Download coordinates for Claude on one platform. */
export function createClaudeBinaryDescriptor(
  platform: SupportedPlatform,
  arch: SupportedArch
): AgentBinaryDescriptor {
  const executablePath = getClaudeExecutablePath(platform);
  return {
    name: "claude",
    channels: CLAUDE_CHANNELS,
    defaultChannel: CLAUDE_DEFAULT_CHANNEL,
    executablePath,
    // npm installs only drop a `claude.cmd` shim on Windows.
    systemCandidates: platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"],

    async resolveChannel(channel, httpClient) {
      const response = await fetchOk(
        httpClient,
        getClaudeChannelUrl(channel),
        `the ${channel} version`
      );
      const version = (await response.text()).trim();
      if (!/^\d+\.\d+\.\d+/.test(version)) {
        throw new BinaryDownloadError(
          `Unexpected Claude ${channel} version: ${JSON.stringify(version.slice(0, 40))}`,
          "INVALID_VERSION"
        );
      }
      return version;
    },

    async downloadRequest(version, destDir, httpClient): Promise<FileDownloadRequest> {
      const platformKey = getClaudePlatformKey(platform, arch);
      const response = await fetchOk(
        httpClient,
        getClaudeManifestUrl(version),
        `the ${version} manifest`
      );
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new BinaryDownloadError(`Claude ${version} manifest is not JSON`, "INVALID_VERSION");
      }
      const entry = parseClaudeManifest(json, platformKey);
      return {
        name: "claude",
        url: getClaudeBinaryUrl(version, platformKey, entry.binary),
        destDir,
        executablePath,
        sha256: entry.sha256,
      };
    },
  };
}
