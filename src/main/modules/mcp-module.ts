/**
 * McpModule - MCP server lifecycle, workspace registration, and event wiring.
 *
 * Subscribes to:
 * - workspace:created: registers workspace with MCP server manager
 * - workspace:deleted: unregisters workspace from MCP server manager (safety net)
 *
 * Hook handlers:
 * - app:start / start: start MCP server, return mcpPort
 * - workspace:delete / shutdown: unregister workspace before agent server stops
 * - app:shutdown / stop: dispose MCP server
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { HookContext } from "../intents/infrastructure/operation";
import type { StartHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type { ShutdownHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import type { WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_WORKSPACE_DELETED } from "../operations/delete-workspace";
import type { WorkspaceDeletedEvent } from "../operations/delete-workspace";
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
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        deps.mcpServerManager.registerWorkspace({
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          workspacePath: payload.workspacePath,
        });
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        deps.mcpServerManager.unregisterWorkspace(payload.workspacePath);
      },
    },
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
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            deps.mcpServerManager.unregisterWorkspace(workspacePath);
            return {};
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
