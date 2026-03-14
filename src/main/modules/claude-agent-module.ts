/**
 * ClaudeAgentModule - Manages Claude Code agent lifecycle, per-workspace server
 * management, and status tracking.
 *
 * One of two per-agent modules (alongside OpenCodeAgentModule). Each module:
 * - Knows its agent type at creation time
 * - Has an internal `active` boolean set during `start` based on config
 * - Returns early from per-agent hooks when inactive (collect() skips undefined)
 * - Creates its own provider type directly (no factory dispatch)
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { ANY_VALUE, type HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { Logger } from "../../services/logging/types";
import type { AgentBinaryManager } from "../../services/binary-download";
import type { AgentBinaryType } from "../../services/binary-download";
import type { BinaryType } from "../../services/vscode-setup/types";
import type { AgentType } from "../../shared/plugin-protocol";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";

import type { LoggingService } from "../../services/logging";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { AgentStatusManager } from "../../agents";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  RegisterConfigResult,
} from "../operations/app-start";
import type { RegisterAgentResult, SaveAgentHookInput, BinaryHookInput } from "../operations/setup";
import type {
  SetupHookInput,
  SetupHookResult,
  OpenWorkspaceIntent,
} from "../operations/open-workspace";
import type {
  DeleteWorkspaceIntent,
  ShutdownHookResult,
  DeletePipelineHookInput,
} from "../operations/delete-workspace";
import type { GetStatusHookInput, GetStatusHookResult } from "../operations/get-workspace-status";
import type {
  GetAgentSessionHookInput,
  GetAgentSessionHookResult,
} from "../operations/get-agent-session";
import type { RestartAgentHookInput, RestartAgentHookResult } from "../operations/restart-agent";
import type { UpdateAgentStatusIntent } from "../operations/update-agent-status";
import type { ClaudeCodeServerManager } from "../../agents/claude/server-manager";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../operations/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../operations/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../operations/restart-agent";
import { INTENT_UPDATE_AGENT_STATUS } from "../operations/update-agent-status";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type { ConfigSetValuesIntent } from "../operations/config-set-values";
import { INTENT_CONFIG_SET_VALUES, EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { configString } from "../../services/config/config-definition";
import { SetupError, getErrorMessage } from "../../services/errors";
import { normalizeInitialPrompt } from "../../shared/api/types";
import { ClaudeCodeProvider } from "../../agents/claude/provider";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies for ClaudeAgentModule.
 */
export interface ClaudeAgentModuleDeps {
  readonly agentBinaryManager: AgentBinaryManager;
  readonly serverManager: ClaudeCodeServerManager;
  readonly agentStatusManager: AgentStatusManager;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly loggingService: LoggingService;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ClaudeAgentModule that manages the Claude Code agent lifecycle.
 */
export function createClaudeAgentModule(deps: ClaudeAgentModuleDeps): IntentModule {
  const { agentBinaryManager, serverManager, logger } = deps;

  // =========================================================================
  // Internal closure state
  // =========================================================================

  /** Whether this module is the active agent (set by config:updated event). */
  let active = false;

  /** Capability: agentType provided by setup handler. */
  let capAgentType: AgentType | undefined;

  /** Tracks pending handleServerStarted() promises for waitForProvider(). */
  const serverStartedPromises = new Map<string, Promise<void>>();

  /** Cleanup function for agentStatusManager.onStatusChanged subscription. */
  let statusUnsubscribeFn: Unsubscribe | null = null;

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: Unsubscribe | null = null;
  let serverStoppedCleanupFn: Unsubscribe | null = null;

  // =========================================================================
  // Internal functions
  // =========================================================================

  async function waitForProvider(workspacePath: string): Promise<void> {
    const promise = serverStartedPromises.get(workspacePath);
    if (promise) {
      await promise;
    }
  }

  async function handleServerStarted(workspacePath: WorkspacePath, port: number): Promise<void> {
    try {
      const agentStatusManager = deps.agentStatusManager;

      // Check if this is a restart (provider already exists from disconnect)
      if (agentStatusManager.hasProvider(workspacePath)) {
        try {
          await agentStatusManager.reconnectWorkspace(workspacePath);
          logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: "claude",
          });
        } catch (error) {
          logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: "claude" },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create Claude-specific provider directly
      const provider = new ClaudeCodeProvider({
        serverManager,
        workspacePath,
        logger: agentStatusManager.getLogger(),
      });

      try {
        await provider.connect(port);
        agentStatusManager.addProvider(workspacePath, provider);
      } catch (error) {
        logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: "claude" },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      serverStartedPromises.delete(workspacePath);
    }
  }

  function wireServerCallbacks(): void {
    const agentStatusManager = deps.agentStatusManager;

    serverManager.setMarkActiveHandler((wp) => agentStatusManager.markActive(wp as WorkspacePath));

    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port) => {
      const promise = handleServerStarted(workspacePath as WorkspacePath, port);
      serverStartedPromises.set(workspacePath, promise);
    });

    serverStoppedCleanupFn = serverManager.onServerStopped((workspacePath, isRestart) => {
      if (isRestart) {
        agentStatusManager.disconnectWorkspace(workspacePath as WorkspacePath);
      } else {
        agentStatusManager.removeWorkspace(workspacePath as WorkspacePath);
      }
    });
  }

  // =========================================================================
  // Build the IntentModule
  // =========================================================================

  return {
    name: "claude-agent",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "version.claude",
                default: null,
                description: "Claude agent version override",
                ...configString({ nullable: true }),
              },
            ],
          }),
        },

        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            return {
              scripts: [
                "ch-claude",
                "ch-claude.cjs",
                "ch-claude.cmd",
                "claude-code-hook-handler.cjs",
              ],
            };
          },
        },

        "check-deps": {
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { configuredAgent } = ctx as CheckDepsHookContext;
            if (configuredAgent !== "claude") return {};

            const missingBinaries: BinaryType[] = [];
            const agentResult = await agentBinaryManager.preflight();
            if (agentResult.success && agentResult.needsDownload) {
              const binaryType = agentBinaryManager.getBinaryType() as AgentBinaryType;
              missingBinaries.push(binaryType);
            }
            return { missingBinaries };
          },
        },

        start: {
          requires: { mcpPort: ANY_VALUE },
          handler: async (ctx: HookContext): Promise<void> => {
            if (!active) return;

            wireServerCallbacks();

            statusUnsubscribeFn = deps.agentStatusManager.onStatusChanged(
              (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => {
                void deps.dispatcher.dispatch({
                  type: INTENT_UPDATE_AGENT_STATUS,
                  payload: { workspacePath, status },
                } as UpdateAgentStatusIntent);
              }
            );

            const mcpPort = ctx.capabilities?.mcpPort as number | null;
            if (mcpPort !== null) {
              serverManager.setMcpConfig({ port: mcpPort });
            }
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (serverStartedCleanupFn) {
              serverStartedCleanupFn();
              serverStartedCleanupFn = null;
            }
            if (serverStoppedCleanupFn) {
              serverStoppedCleanupFn();
              serverStoppedCleanupFn = null;
            }

            await serverManager.dispose();

            if (statusUnsubscribeFn) {
              statusUnsubscribeFn();
              statusUnsubscribeFn = null;
            }

            if (active) {
              deps.agentStatusManager.dispose();
            }
          },
        },
      },

      [SETUP_OPERATION_ID]: {
        "register-agents": {
          handler: async (): Promise<RegisterAgentResult> => {
            return { agent: "claude", label: "Claude Code", icon: "sparkle" };
          },
        },

        "save-agent": {
          handler: async (ctx: HookContext) => {
            const { selectedAgent } = ctx as SaveAgentHookInput;
            if (selectedAgent !== "claude") return;

            try {
              await deps.dispatcher.dispatch({
                type: INTENT_CONFIG_SET_VALUES,
                payload: { values: { agent: selectedAgent } },
              } as ConfigSetValuesIntent);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new SetupError(
                `Failed to save agent selection: ${message}`,
                "CONFIG_SAVE_FAILED"
              );
            }
          },
        },

        binary: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];
            const { report } = hookCtx;

            const agentType = hookCtx.selectedAgent ?? hookCtx.configuredAgent;
            if (agentType !== "claude") return;

            const binaryType = agentBinaryManager.getBinaryType();
            if (missingBinaries.includes(binaryType)) {
              report("agent", "running", "Downloading...");
              try {
                await agentBinaryManager.downloadBinary((p) => {
                  if (p.phase === "downloading" && p.totalBytes) {
                    const pct = Math.floor((p.bytesDownloaded / p.totalBytes) * 100);
                    report("agent", "running", "Downloading...", undefined, pct);
                  } else if (p.phase === "extracting") {
                    report("agent", "running", "Extracting...");
                  }
                });
                report("agent", "done");
              } catch (error) {
                report("agent", "failed", undefined, getErrorMessage(error));
                throw new SetupError(
                  `Failed to download ${binaryType}: ${getErrorMessage(error)}`,
                  "BINARY_DOWNLOAD_FAILED"
                );
              }
            } else {
              report("agent", "done");
            }
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          provides: () => ({
            ...(capAgentType !== undefined && { agentType: capAgentType }),
          }),
          handler: async (ctx: HookContext): Promise<SetupHookResult | undefined> => {
            capAgentType = undefined;
            if (!active) return undefined;

            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;

            await serverManager.startServer(workspacePath);
            await waitForProvider(workspacePath);

            if (intent.payload.initialPrompt && serverManager.setInitialPrompt) {
              const normalizedPrompt = normalizeInitialPrompt(intent.payload.initialPrompt);
              await serverManager.setInitialPrompt(workspacePath, normalizedPrompt);
            }

            // Create no-session marker for new workspaces (skips --continue on first launch)
            if (
              intent.payload.existingWorkspace === undefined &&
              serverManager.setNoSessionMarker
            ) {
              await serverManager.setNoSessionMarker(workspacePath);
            }

            const agentProvider = deps.agentStatusManager.getProvider(
              workspacePath as WorkspacePath
            );
            const envVars: Record<string, string> = {
              ...(agentProvider?.getEnvironmentVariables() ?? {}),
            };

            capAgentType = "claude";
            return { envVars };
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult | undefined> => {
            if (!active) return undefined;

            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              let serverError: string | undefined;
              const stopResult = await serverManager.stopServer(workspacePath);
              if (!stopResult.success) {
                serverError = stopResult.error ?? "Failed to stop server";
                if (!payload.force) {
                  throw new Error(serverError);
                }
              }

              deps.agentStatusManager.clearTuiTracking(workspacePath as WorkspacePath);

              return serverError
                ? { serverName: "Claude Code hook", error: serverError }
                : { serverName: "Claude Code hook" };
            } catch (error) {
              if (payload.force) {
                logger.warn("ClaudeAgentModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { serverName: "Claude Code hook", error: getErrorMessage(error) };
              }
              throw error;
            }
          },
        },
      },

      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult | undefined> => {
            if (!active) return undefined;
            const { workspacePath } = ctx as GetStatusHookInput;
            return {
              agentStatus: deps.agentStatusManager.getStatus(workspacePath as WorkspacePath),
            };
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult | undefined> => {
            if (!active) return undefined;
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            const session =
              deps.agentStatusManager.getSession(workspacePath as WorkspacePath) ?? null;
            return { session };
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult | undefined> => {
            if (!active) return undefined;
            const { workspacePath } = ctx as RestartAgentHookInput;
            const result = await serverManager.restartServer(workspacePath);
            if (result.success) {
              return { port: result.port };
            } else {
              throw new Error(result.error);
            }
          },
        },
      },
    },
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;
        if (values.agent !== undefined) {
          // Agent value received — check if this module should be active
          const agentType = (values.agent as string | null) ?? "opencode";
          active = agentType === "claude";
        }
      },
    },
  };
}
