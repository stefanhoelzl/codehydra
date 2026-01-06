/**
 * OpenCode agent setup information.
 * Provides version, binary paths, and config generation for OpenCode.
 */

import { Path } from "../../services/platform/path";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { AgentSetupInfo } from "../types";
import type { SupportedArch } from "../../services/platform/platform-info";

// Import the config template as a JSON object
import mcpConfigTemplate from "./opencode.codehydra.json";

/**
 * Current version of OpenCode to download.
 */
export const OPENCODE_VERSION = "1.0.223";

/**
 * Supported operating system platforms for OpenCode.
 */
type SupportedPlatform = "darwin" | "linux" | "win32";

/**
 * Architecture name mappings for OpenCode releases.
 */
const OPENCODE_ARCH: Record<SupportedArch, string> = {
  x64: "x64",
  arm64: "arm64",
};

/**
 * Get the download URL for OpenCode.
 *
 * @param platform - Operating system platform
 * @param arch - CPU architecture
 * @returns Download URL for the OpenCode release
 * @throws Error if platform/arch combination is not supported
 */
export function getOpencodeUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows OpenCode builds only support x64, got: ${arch}`);
    }
    return `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-windows-x64.zip`;
  }
  const archName = OPENCODE_ARCH[arch];
  const os = platform === "darwin" ? "darwin" : "linux";
  const ext = platform === "darwin" ? "zip" : "tar.gz";
  return `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${os}-${archName}.${ext}`;
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
 */
export class OpenCodeSetupInfo implements AgentSetupInfo {
  readonly version = OPENCODE_VERSION;
  readonly wrapperEntryPoint = "agents/opencode-wrapper.cjs";

  private readonly fileSystem: FileSystemLayer;
  private readonly platform: SupportedPlatform;
  private readonly arch: SupportedArch;

  constructor(deps: OpenCodeSetupInfoDeps) {
    this.fileSystem = deps.fileSystem;
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
   * Generate config file with optional environment variable substitution.
   *
   * The template uses `{env:VAR_NAME}` syntax which can either be:
   * 1. Substituted at generation time with values from the `variables` parameter
   * 2. Left as-is for runtime substitution by OpenCode
   *
   * Currently, we copy the template as-is since OpenCode handles env var substitution.
   *
   * @param targetPath - Path where config file should be written
   * @param variables - Variables to substitute (currently unused, for future flexibility)
   */
  async generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void> {
    // Use imported template directly
    let content = JSON.stringify(mcpConfigTemplate, null, 2);

    // Substitute any provided variables (pattern: {env:VAR_NAME})
    for (const [key, value] of Object.entries(variables)) {
      const pattern = `{env:${key}}`;
      content = content.replace(new RegExp(pattern.replace(/[{}]/g, "\\$&"), "g"), value);
    }

    // Ensure target directory exists
    await this.fileSystem.mkdir(targetPath.dirname);

    // Write config file
    await this.fileSystem.writeFile(targetPath, content);
  }
}

/**
 * Creates an OpenCodeSetupInfo instance with the given dependencies.
 */
export function createOpenCodeSetupInfo(deps: OpenCodeSetupInfoDeps): AgentSetupInfo {
  return new OpenCodeSetupInfo(deps);
}
