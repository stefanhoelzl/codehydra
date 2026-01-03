/**
 * Utility module for generating MCP config.
 *
 * Note: CLI wrapper script generation has been moved to static files in resources/bin/
 * that are compiled by Vite and copied during setup. This module only contains the
 * MCP config generation which uses environment variable substitution.
 */

/**
 * OpenCode configuration structure.
 * Includes MCP server configuration for the CodeHydra MCP server.
 */
interface OpencodeConfig {
  $schema: string;
  mcp: {
    codehydra: {
      type: "remote";
      url: string;
      headers: {
        "X-Workspace-Path": string;
      };
      enabled: boolean;
    };
  };
}

/**
 * Generate OpenCode configuration content.
 *
 * The config includes MCP server configuration with environment variable substitution:
 * - `{env:CODEHYDRA_MCP_PORT}` - Resolved to the actual port at runtime
 * - `{env:CODEHYDRA_WORKSPACE_PATH}` - Resolved to the workspace path at runtime
 *
 * This is a static config file written during setup. OpenCode reads these
 * env var references and substitutes them when connecting to the MCP server.
 *
 * Note: default_agent is intentionally NOT set here. This config is passed via
 * OPENCODE_CONFIG which takes precedence over project configs. By omitting
 * default_agent, users can set their preferred agent in their project's
 * opencode.jsonc or global config.
 *
 * @returns JSON string for the config file
 */
export function generateOpencodeConfigContent(): string {
  const config: OpencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      codehydra: {
        type: "remote",
        url: "http://127.0.0.1:{env:CODEHYDRA_MCP_PORT}/mcp",
        headers: {
          "X-Workspace-Path": "{env:CODEHYDRA_WORKSPACE_PATH}",
        },
        enabled: true,
      },
    },
  };

  return JSON.stringify(config, null, 2);
}
