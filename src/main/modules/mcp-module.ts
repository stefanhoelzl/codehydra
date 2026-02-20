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
import type { StartHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import type { McpServerManager } from "../../services/mcp-server/mcp-server-manager";
import type { Logger } from "../../services/logging";

// =============================================================================
// Dependencies
// =============================================================================

export interface McpModuleDeps {
  readonly mcpServerManager: McpServerManager;
  readonly logger: Logger;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createMcpModule(deps: McpModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const mcpPort = await deps.mcpServerManager.start();
            deps.logger.info("MCP server started", {
              port: mcpPort,
            });

            return { mcpPort };
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              await deps.mcpServerManager.dispose();
            } catch (error) {
              deps.logger.error(
                "MCP lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };
}
