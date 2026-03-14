/**
 * McpModule - MCP server lifecycle management.
 *
 * Hook handlers:
 * - app:start / start: start MCP server, return mcpPort
 * - app:shutdown / stop: dispose MCP server
 *
 * Workspace registration is no longer needed — the MCP server passes
 * workspacePath directly to API methods, and the intent system resolves
 * workspace identity via hook modules.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import type { McpServerManager } from "../../services/mcp-server/mcp-server-manager";

// =============================================================================
// Dependencies
// =============================================================================

export interface McpModuleDeps {
  readonly mcpServerManager: McpServerManager;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createMcpModule(deps: McpModuleDeps): IntentModule {
  /** Capability: mcpPort provided by start handler. */
  let capMcpPort: number | undefined;

  return {
    name: "mcp",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({
            ...(capMcpPort !== undefined && { mcpPort: capMcpPort }),
          }),
          handler: async (): Promise<void> => {
            capMcpPort = undefined;
            capMcpPort = await deps.mcpServerManager.start();
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await deps.mcpServerManager.dispose();
          },
        },
      },
    },
  };
}
