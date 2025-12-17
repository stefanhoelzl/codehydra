/**
 * Binary version constants and download URL configuration.
 */

import type { BinaryConfig, BinaryType, SupportedArch, SupportedPlatform } from "./types.js";

/**
 * Current version of code-server to download.
 */
export const CODE_SERVER_VERSION = "4.106.3";

/**
 * Current version of opencode to download.
 */
export const OPENCODE_VERSION = "1.0.163";

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
 * Get the download URL for code-server.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the code-server release
 * @throws Error if platform/arch combination is not supported
 */
function getCodeServerUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows code-server builds only support x64, got: ${arch}`);
    }
    return `https://github.com/${CODEHYDRA_REPO}/releases/download/code-server-windows-v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-win32-x64.zip`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-${os}-${archName}.tar.gz`;
}

/**
 * Architecture name mappings for opencode releases (new naming convention).
 */
const OPENCODE_ARCH_NEW = {
  x64: "x64",
  arm64: "arm64",
} as const;

/**
 * Get the download URL for opencode.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the opencode release
 * @throws Error if platform/arch combination is not supported
 */
function getOpencodeUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows opencode builds only support x64, got: ${arch}`);
    }
    return `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-windows-x64.zip`;
  }
  const archName = OPENCODE_ARCH_NEW[arch];
  const os = platform === "darwin" ? "darwin" : "linux";
  const ext = platform === "darwin" ? "zip" : "tar.gz";
  return `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${os}-${archName}.${ext}`;
}

/**
 * Configuration for all supported binaries.
 * Uses satisfies to ensure type safety while preserving literal types.
 */
export const BINARY_CONFIGS = {
  "code-server": {
    type: "code-server",
    version: CODE_SERVER_VERSION,
    getUrl: getCodeServerUrl,
    extractedBinaryPath: (platform: SupportedPlatform) =>
      platform === "win32" ? "bin/code-server.cmd" : "bin/code-server",
  },
  opencode: {
    type: "opencode",
    version: OPENCODE_VERSION,
    getUrl: getOpencodeUrl,
    extractedBinaryPath: (platform: SupportedPlatform) =>
      platform === "win32" ? "opencode.exe" : "opencode",
  },
} as const satisfies Record<BinaryType, BinaryConfig>;
