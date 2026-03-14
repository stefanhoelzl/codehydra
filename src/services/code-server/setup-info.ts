/**
 * Code-server setup information.
 * Provides version, download URLs, and executable path for code-server.
 */

import type { SupportedArch, SupportedPlatform } from "../agents/types";

/**
 * Current version of code-server to download.
 */
export const CODE_SERVER_VERSION = "4.108.2";

/**
 * GitHub repository for Windows code-server builds.
 * Windows builds are not provided by the official code-server repo.
 */
const CODEHYDRA_REPO = "stefanhoelzl/codehydra";

/**
 * Architecture name mappings for code-server releases.
 */
const CODE_SERVER_ARCH = {
  x64: "amd64",
  arm64: "arm64",
} as const;

/**
 * Get the download URL for a specific code-server version.
 *
 * @param version - Code-server version string
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the code-server release
 * @throws Error if platform/arch combination is not supported
 */
export function getCodeServerUrlForVersion(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows code-server builds only support x64, got: ${arch}`);
    }
    return `https://github.com/${CODEHYDRA_REPO}/releases/download/code-server-windows-v${version}/code-server-${version}-win32-x64.tar.gz`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-${os}-${archName}.tar.gz`;
}

/**
 * Get the download URL for code-server using the built-in version.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the code-server release
 * @throws Error if platform/arch combination is not supported
 */
export function getCodeServerUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  return getCodeServerUrlForVersion(CODE_SERVER_VERSION, platform, arch);
}

/**
 * Get the subpath within the extracted archive for a specific code-server version.
 *
 * @param version - Code-server version string
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Subpath prefix within the archive
 */
export function getCodeServerSubPathForVersion(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch
): string {
  if (platform === "win32") {
    return `code-server-${version}-win32-x64`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `code-server-${version}-${os}-${archName}`;
}

/**
 * Get the subpath within the extracted archive using the built-in version.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Subpath prefix within the archive
 */
export function getCodeServerSubPath(platform: SupportedPlatform, arch: SupportedArch): string {
  return getCodeServerSubPathForVersion(CODE_SERVER_VERSION, platform, arch);
}

/**
 * Get the relative path to the code-server executable within the extracted directory.
 *
 * @param platform - Operating system platform
 * @returns Relative path to the executable
 */
export function getCodeServerExecutablePath(platform: SupportedPlatform): string {
  return platform === "win32" ? "bin/code-server.cmd" : "bin/code-server";
}
