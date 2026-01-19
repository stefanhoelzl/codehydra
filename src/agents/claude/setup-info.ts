/**
 * Claude agent setup information.
 * Provides version, binary paths, download URLs, and config generation for Claude.
 */

import { Path } from "../../services/platform/path";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { HttpClient } from "../../services/platform/network";
import type { AgentSetupInfo, SupportedArch, SupportedPlatform } from "../types";

// Import config templates as JSON objects
import hooksConfigTemplate from "./hooks.template.json";
import mcpConfigTemplate from "./mcp.template.json";

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
 * @param version - Version string (e.g., "1.0.58") - currently unused as binaries are unversioned
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
 * This is the versioned URL function for the AgentSetupInfo interface.
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
 * Get the URL to fetch the latest Claude version.
 */
export function getClaudeLatestVersionUrl(): string {
  return `${CLAUDE_DOWNLOAD_BASE}/latest`;
}

/**
 * Get the binary filename for the current platform.
 */
function getBinaryFilename(platform: SupportedPlatform): string {
  // Claude CLI is named 'claude' on all platforms
  return platform === "win32" ? "claude.exe" : "claude";
}

/**
 * Dependencies for creating ClaudeSetupInfo.
 */
export interface ClaudeSetupInfoDeps {
  readonly fileSystem: FileSystemLayer;
  readonly httpClient: HttpClient;
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
}

/**
 * Claude implementation of AgentSetupInfo.
 * Provides version, URLs, and config generation for Claude agent.
 *
 * Key features:
 * - Prefers system-installed Claude (CLAUDE_VERSION = null)
 * - Falls back to downloading if not found on system
 * - Two config files: hooks.json and mcp.json
 * - Uses HttpClient to fetch latest version from GCS bucket
 */
export class ClaudeSetupInfo implements AgentSetupInfo {
  /**
   * Version from CLAUDE_VERSION constant.
   * Returns "latest" if CLAUDE_VERSION is null (system-first preference).
   */
  readonly version = CLAUDE_VERSION ?? "latest";

  /**
   * Entry point for the wrapper script that adds CodeHydra flags.
   */
  readonly wrapperEntryPoint = "agents/claude-wrapper.cjs";

  private readonly fileSystem: FileSystemLayer;
  private readonly httpClient: HttpClient;
  private readonly platform: SupportedPlatform;
  private readonly arch: SupportedArch;

  constructor(deps: ClaudeSetupInfoDeps) {
    this.fileSystem = deps.fileSystem;
    this.httpClient = deps.httpClient;
    this.platform = deps.platform;
    this.arch = deps.arch;
  }

  /**
   * Binary filename (claude or claude.exe).
   * The full path is determined by searching PATH at runtime.
   */
  get binaryPath(): string {
    return getBinaryFilename(this.platform);
  }

  /**
   * Get download URL for Claude binary using instance's platform/arch.
   */
  getBinaryUrl(): string {
    return getClaudeUrl(this.platform, this.arch);
  }

  /**
   * Get download URL for a specific version and platform/arch.
   * Used by BinaryDownloadService for downloading specific versions.
   *
   * @param version - Version string (e.g., "1.0.58")
   * @param platform - Operating system platform
   * @param arch - CPU architecture
   * @returns Download URL for the binary
   */
  getBinaryUrlForVersion(
    version: string,
    platform: SupportedPlatform,
    arch: SupportedArch
  ): string {
    return getClaudeUrlForVersion(version, platform, arch);
  }

  /**
   * Fetch the latest available version from the GCS bucket.
   * The /latest endpoint returns a plain text version string.
   *
   * @returns Latest version string (e.g., "1.0.58")
   * @throws Error if the request fails or returns invalid data
   */
  async getLatestVersion(): Promise<string> {
    const url = getClaudeLatestVersionUrl();
    const response = await this.httpClient.fetch(url, { timeout: 10000 });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch latest Claude version: ${response.status} ${response.statusText}`
      );
    }

    const version = (await response.text()).trim();

    // Validate version format (basic semver pattern)
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`Invalid version format from Claude latest endpoint: ${version}`);
    }

    return version;
  }

  /**
   * Generate config file with environment variable substitution.
   *
   * Claude requires two separate config files:
   * - hooks.json (settings file with hook definitions)
   * - mcp.json (MCP server configuration)
   *
   * The template uses ${VAR_NAME} syntax for substitution.
   * Variables provided will be substituted at generation time.
   *
   * @param targetPath - Path where config file should be written
   * @param variables - Variables to substitute (e.g., { BRIDGE_PORT: "3000" })
   */
  async generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void> {
    // Determine which template to use based on filename
    const filename = targetPath.basename;
    const template = filename.includes("hooks") ? hooksConfigTemplate : mcpConfigTemplate;

    // Stringify with pretty printing
    let content = JSON.stringify(template, null, 2);

    // Substitute provided variables (pattern: ${VAR_NAME})
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, "g");
      content = content.replace(pattern, value);
    }

    // Ensure target directory exists
    await this.fileSystem.mkdir(targetPath.dirname);

    // Write config file
    await this.fileSystem.writeFile(targetPath, content);
  }
}

// Re-export old names for backward compatibility during transition
export { ClaudeSetupInfo as ClaudeCodeSetupInfo };
export type { ClaudeSetupInfoDeps as ClaudeCodeSetupInfoDeps };

/**
 * Creates a ClaudeSetupInfo instance with the given dependencies.
 */
export function createClaudeSetupInfo(deps: ClaudeSetupInfoDeps): AgentSetupInfo {
  return new ClaudeSetupInfo(deps);
}

// Re-export old function name for backward compatibility
export { createClaudeSetupInfo as createClaudeCodeSetupInfo };
