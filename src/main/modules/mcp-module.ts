/**
 * McpModule - MCP server lifecycle, workspace registration, and event wiring.
 *
 * Subscribes to:
 * - workspace:created: registers workspace with MCP server manager
 * - workspace:deleted: unregisters workspace from MCP server manager (safety net)
 *
 * Hook handlers:
 * - app:start / start: start MCP server, wire callbacks, configure agent ServerManager
 * - workspace:open / setup: contribute bridge port env vars (OpenCode only)
 * - workspace:delete / shutdown: unregister workspace before agent server stops
 * - app:shutdown / stop: dispose MCP server, cleanup callbacks
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { HookContext } from "../intents/infrastructure/operation";
import type { StartHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type { DeleteWorkspaceIntent, ShutdownHookResult } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_CREATED, OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type { WorkspaceCreatedEvent, SetupHookResult } from "../operations/open-workspace";
import { EVENT_WORKSPACE_DELETED } from "../operations/delete-workspace";
import type { WorkspaceDeletedEvent } from "../operations/delete-workspace";
import type { McpServerManager } from "../../services/mcp-server/mcp-server-manager";
import type { IViewManager } from "../managers/view-manager.interface";
import type { AgentStatusManager } from "../../agents/opencode/status-manager";
import type { AgentServerManager, AgentType } from "../../agents/types";
import type { ClaudeCodeServerManager } from "../../agents/claude/server-manager";
import type { OpenCodeServerManager } from "../../agents/opencode/server-manager";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { WorkspacePath } from "../../shared/ipc";
import type { Logger } from "../../services/logging";

// =============================================================================
// Dependencies
// =============================================================================

export interface McpModuleDeps {
  readonly mcpServerManager: McpServerManager;
  readonly viewManager: IViewManager;
  readonly agentStatusManager: AgentStatusManager;
  readonly serverManager: AgentServerManager;
  readonly selectedAgentType: AgentType;
  readonly logger: Logger;
  readonly setMcpServerManager: (manager: McpServerManager) => void;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createMcpModule(deps: McpModuleDeps): IntentModule {
  let wrapperReadyCleanupFn: Unsubscribe | null = null;

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

            // Register callback for wrapper start (bridge server notification)
            if (deps.selectedAgentType === "claude") {
              const claudeServerManager = deps.serverManager as ClaudeCodeServerManager;
              if (claudeServerManager.onWorkspaceReady) {
                wrapperReadyCleanupFn = claudeServerManager.onWorkspaceReady((workspacePath) => {
                  deps.viewManager.setWorkspaceLoaded(workspacePath);
                });
              }
            } else if (deps.selectedAgentType === "opencode") {
              const opencodeManager = deps.serverManager as OpenCodeServerManager;
              wrapperReadyCleanupFn = opencodeManager.onWorkspaceReady((workspacePath) => {
                deps.viewManager.setWorkspaceLoaded(workspacePath);
                deps.agentStatusManager.markActive(workspacePath as WorkspacePath);
              });
            }

            // Configure server manager to connect to MCP
            if (deps.serverManager && deps.selectedAgentType === "claude") {
              const claudeManager = deps.serverManager as ClaudeCodeServerManager;
              claudeManager.setMcpConfig({
                port: deps.mcpServerManager.getPort()!,
              });
            } else if (deps.serverManager) {
              const opencodeManager = deps.serverManager as OpenCodeServerManager;
              opencodeManager.setMcpConfig({
                port: deps.mcpServerManager.getPort()!,
              });
            }

            // Inject MCP server manager into AppState for onServerStopped cleanup
            deps.setMcpServerManager(deps.mcpServerManager);

            return { mcpPort };
          },
        },
      },
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (): Promise<SetupHookResult> => {
            if (deps.selectedAgentType !== "opencode") {
              return {};
            }
            const opencodeManager = deps.serverManager as OpenCodeServerManager;
            const bridgePort = opencodeManager.getBridgePort();
            if (bridgePort === null) {
              return {};
            }
            return { envVars: { CODEHYDRA_BRIDGE_PORT: String(bridgePort) } };
          },
        },
      },
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            deps.mcpServerManager.unregisterWorkspace(payload.workspacePath);
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Cleanup callbacks
              if (wrapperReadyCleanupFn) {
                wrapperReadyCleanupFn();
                wrapperReadyCleanupFn = null;
              }

              // Dispose MCP server
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
