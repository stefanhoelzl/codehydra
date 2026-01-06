/**
 * Binary version constants and download URL configuration.
 */

import type { BinaryConfig, BinaryType, SupportedArch, SupportedPlatform } from "./types.js";
import { OPENCODE_VERSION, getOpencodeUrl } from "../../agents/opencode/setup-info";

// Re-export OPENCODE_VERSION for backward compatibility
export { OPENCODE_VERSION };

/**
 * Current version of code-server to download.
 */
export const CODE_SERVER_VERSION = "4.107.0";

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
    return `https://github.com/${CODEHYDRA_REPO}/releases/download/code-server-windows-v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-win32-x64.tar.gz`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-${os}-${archName}.tar.gz`;
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
