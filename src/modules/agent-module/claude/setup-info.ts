/**
 * Claude agent setup information.
 * Provides version, binary paths, and download URLs for Claude.
 */

import type { SupportedArch, SupportedPlatform } from "../types";

/**
 * Current version of Claude to download.
 * Set to null to prefer system binary with fallback to latest.
 */
export const CLAUDE_VERSION: string | null = null;

/**
 * Base URL for Claude binary downloads from GCS bucket.
 */
const CLAUDE_DOWNLOAD_BASE =
  "https://storage.googleapis.com/anthropic-public/claude-code/claude-code-releases";

/**
 * Get the download URL for Claude binary for a specific version.
 *
 * URL pattern: {BASE}/claude-{platform}-{arch}.tar.gz
 * Platforms: darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the Claude release
 * @throws Error if platform/arch combination is not supported
 */
export function getClaudeUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  if (platform === "win32" && arch !== "x64") {
    throw new Error(`Windows Claude builds only support x64, got: ${arch}`);
  }

  // Claude binaries are tarballs: claude-{platform}-{arch}.tar.gz
  return `${CLAUDE_DOWNLOAD_BASE}/claude-${platform}-${arch}.tar.gz`;
}

/**
 * Get the download URL for Claude binary for a specific version.
 *
 * @param version - Version string (e.g., "1.0.58") - currently unused as binaries are unversioned
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the Claude release
 */
export function getClaudeUrlForVersion(
  _version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): string {
  // Currently Claude binaries are not versioned in the URL
  // When versioned URLs become available, pattern will be:
  // {BASE}/{VERSION}/{PLATFORM}/claude[.exe]
  return getClaudeUrl(platform, arch);
}

/**
 * Get the subpath within the extracted archive for Claude.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Subpath prefix within the archive
 */
export function getClaudeSubPath(platform: SupportedPlatform, arch: SupportedArch): string {
  return `claude-${platform}-${arch}`;
}

/**
 * Get the relative path to the Claude executable within the extracted directory.
 *
 * @param platform - Operating system platform
 * @returns Relative path to the executable
 */
export function getClaudeExecutablePath(platform: SupportedPlatform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}
