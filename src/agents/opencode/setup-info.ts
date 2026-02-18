/**
 * OpenCode agent setup information.
 * Provides version, binary paths, and config generation for OpenCode.
 */

import type { Path } from "../../services/platform/path";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { AgentSetupInfo, SupportedArch, SupportedPlatform } from "../types";

/**
 * Current version of OpenCode to download.
 */
export const OPENCODE_VERSION = "1.0.223";

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
 * Get the binary filename for the current platform.
 */
function getBinaryFilename(platform: SupportedPlatform): string {
  return platform === "win32" ? "opencode.exe" : "opencode";
}

/**
 * Dependencies for creating OpenCodeSetupInfo.
 */
export interface OpenCodeSetupInfoDeps {
  readonly fileSystem: FileSystemLayer;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
}

/**
 * OpenCode implementation of AgentSetupInfo.
 * Provides version, URLs, and config generation for OpenCode agent.
 *
 * Note: OpenCode uses a pinned version, so getLatestVersion() returns
 * the pinned version rather than fetching from a remote endpoint.
 */
export class OpenCodeSetupInfo implements AgentSetupInfo {
  readonly version = OPENCODE_VERSION;
  readonly wrapperEntryPoint = "agents/opencode-wrapper.cjs";

  private readonly platform: SupportedPlatform;
  private readonly arch: SupportedArch;

  constructor(deps: OpenCodeSetupInfoDeps) {
    this.platform = deps.platform;
    this.arch = deps.arch;
  }

  get binaryPath(): string {
    return getBinaryFilename(this.platform);
  }

  getBinaryUrl(): string {
    return getOpencodeUrl(this.platform, this.arch);
  }

  /**
   * Get download URL for a specific version and platform/arch.
   * Used by BinaryDownloadService for downloading specific versions.
   *
   * @param version - Version string (e.g., "1.0.223")
   * @param platform - Operating system platform
   * @param arch - CPU architecture
   * @returns Download URL for the binary
   */
  getBinaryUrlForVersion(
    version: string,
    platform: SupportedPlatform,
    arch: SupportedArch
  ): string {
    return getOpencodeUrlForVersion(version, platform, arch);
  }

  /**
   * Get the latest available version.
   * OpenCode uses a pinned version, so this returns the constant.
   *
   * @returns The pinned version string
   */
  async getLatestVersion(): Promise<string> {
    // OpenCode uses pinned versions, return the constant
    return OPENCODE_VERSION;
  }

  /**
   * No-op for OpenCode. MCP config is passed inline via OPENCODE_CONFIG_CONTENT
   * environment variable at spawn time (see OpenCodeServerManager.spawnServerOnPort).
   */
  async generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void> {
    void targetPath;
    void variables;
    // OpenCode uses inline config via OPENCODE_CONFIG_CONTENT env var.
    // No file generation needed.
  }
}

/**
 * Creates an OpenCodeSetupInfo instance with the given dependencies.
 */
export function createOpenCodeSetupInfo(deps: OpenCodeSetupInfoDeps): AgentSetupInfo {
  return new OpenCodeSetupInfo(deps);
}
