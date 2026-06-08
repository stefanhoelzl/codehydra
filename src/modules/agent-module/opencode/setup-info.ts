/**
 * OpenCode agent setup information.
 * Provides version, binary paths, and download URLs for OpenCode.
 */

import type { SupportedArch, SupportedPlatform } from "../types";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import { Path } from "../../../utils/path/path";

/**
 * Current version of OpenCode to download.
 */
export const OPENCODE_VERSION = "1.0.223";

/**
 * Resolve the bundle directory holding the extracted OpenCode binary for a
 * given version. Single source of truth for the `opencode/<version>` path
 * shape used by the agent server, binary download/preflight, and the
 * code-server environment (`_CH_OPENCODE_DIR`).
 */
export function getOpencodeBundleDir(
  pathProvider: Pick<PathProvider, "bundlePath">,
  version: string
): Path {
  return pathProvider.bundlePath(`opencode/${version}`);
}

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
 * @param version - Version string (e.g., "1.0.223")
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
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows OpenCode builds only support x64, got: ${arch}`);
    }
    return `https://github.com/sst/opencode/releases/download/v${version}/opencode-windows-x64.zip`;
  }
  const archName = OPENCODE_ARCH[arch];
  const os = platform === "darwin" ? "darwin" : "linux";
  const ext = platform === "darwin" ? "zip" : "tar.gz";
  return `https://github.com/sst/opencode/releases/download/v${version}/opencode-${os}-${archName}.${ext}`;
}

/**
 * Get the download URL for OpenCode using the default version.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the OpenCode release
 * @throws Error if platform/arch combination is not supported
 */
export function getOpencodeUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  return getOpencodeUrlForVersion(OPENCODE_VERSION, platform, arch);
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
