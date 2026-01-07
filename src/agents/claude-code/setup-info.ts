/**
 * Claude Code agent setup information.
 * Provides binary detection and config generation for Claude Code.
 *
 * Unlike OpenCode, Claude Code is system-installed (no version management).
 * The binary is expected to be in the user's PATH or a known location.
 */

import { Path } from "../../services/platform/path";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { AgentSetupInfo } from "../types";

// Import config templates as JSON objects
import hooksConfigTemplate from "./hooks.template.json";
import mcpConfigTemplate from "./mcp.template.json";

/**
 * Supported operating system platforms for Claude Code.
 */
type SupportedPlatform = "darwin" | "linux" | "win32";

/**
 * Get the binary filename for the current platform.
 */
function getBinaryFilename(platform: SupportedPlatform): string {
  // Claude Code CLI is named 'claude' on all platforms
  return platform === "win32" ? "claude.exe" : "claude";
}

/**
 * Dependencies for creating ClaudeCodeSetupInfo.
 */
export interface ClaudeCodeSetupInfoDeps {
  readonly fileSystem: FileSystemLayer;
  readonly platform: SupportedPlatform;
}

/**
 * Claude Code implementation of AgentSetupInfo.
 * Provides binary detection and config generation for Claude Code agent.
 *
 * Key differences from OpenCode:
 * - No version management (system-installed)
 * - Binary detection via PATH
 * - Two config files: hooks.json and mcp.json
 */
export class ClaudeCodeSetupInfo implements AgentSetupInfo {
  /**
   * Version is "system" since we use the system-installed Claude Code.
   * The actual version can be detected via `claude --version` at runtime.
   */
  readonly version = "system";

  /**
   * Entry point for the wrapper script that adds CodeHydra flags.
   */
  readonly wrapperEntryPoint = "agents/claude-code-wrapper.cjs";

  /**
   * VS Code marketplace extension ID for Claude Code.
   */
  readonly extensionId = "anthropic.claude-code";

  private readonly fileSystem: FileSystemLayer;
  private readonly platform: SupportedPlatform;

  constructor(deps: ClaudeCodeSetupInfoDeps) {
    this.fileSystem = deps.fileSystem;
    this.platform = deps.platform;
  }

  /**
   * Binary filename (claude or claude.exe).
   * The full path is determined by searching PATH at runtime.
   */
  get binaryPath(): string {
    return getBinaryFilename(this.platform);
  }

  /**
   * Claude Code is system-installed, not downloaded.
   * This method is required by the interface but throws for Claude Code.
   */
  getBinaryUrl(): string {
    throw new Error(
      "Claude Code is system-installed. " +
        "Please install Claude Code CLI manually: https://docs.anthropic.com/en/docs/claude-code"
    );
  }

  /**
   * Generate config file with environment variable substitution.
   *
   * Claude Code requires two separate config files:
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

/**
 * Creates a ClaudeCodeSetupInfo instance with the given dependencies.
 */
export function createClaudeCodeSetupInfo(deps: ClaudeCodeSetupInfoDeps): AgentSetupInfo {
  return new ClaudeCodeSetupInfo(deps);
}
