/**
 * OpenCodeAgentModule - Manages OpenCode agent lifecycle, per-workspace server
 * management, and status tracking.
 *
 * One of two per-agent modules (alongside ClaudeAgentModule). Each module:
 * - Knows its agent type at creation time
 * - Has an internal `active` boolean set during `start` based on config
 * - Returns early from per-agent hooks when inactive (collect() skips undefined)
 * - Creates its own provider type directly (no factory dispatch)
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { ConfigService } from "../../services/config/config-service";
import type { AgentBinaryManager } from "../../services/binary-download";
import type { AgentBinaryType } from "../../services/binary-download";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { AgentType } from "../../agents/types";
import type { LoggingService } from "../../services/logging";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { AgentStatusManager } from "../../agents";
import type {
  CheckConfigResult,
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  StartHookResult,
  ActivateHookContext,
  ActivateHookResult,
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
import type { OpenCodeServerManager, PendingPrompt } from "../../agents/opencode/server-manager";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../operations/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../operations/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../operations/restart-agent";
import { INTENT_UPDATE_AGENT_STATUS } from "../operations/update-agent-status";
import { SetupError, getErrorMessage } from "../../services/errors";
import { normalizeInitialPrompt } from "../../shared/api/types";
import { OpenCodeProvider } from "../../agents/opencode/provider";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies for OpenCodeAgentModule.
 */
export interface OpenCodeAgentModuleDeps {
  readonly configService: Pick<ConfigService, "load" | "setAgent">;
  readonly agentBinaryManager: AgentBinaryManager;
  readonly serverManager: OpenCodeServerManager;
  readonly agentStatusManager: AgentStatusManager;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly loggingService: LoggingService;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an OpenCodeAgentModule that manages the OpenCode agent lifecycle.
 */
export function createOpenCodeAgentModule(deps: OpenCodeAgentModuleDeps): IntentModule {
  const { configService, agentBinaryManager, serverManager, logger } = deps;

  // =========================================================================
  // Internal closure state
  // =========================================================================

  /** Whether this module is the active agent (set during start hook). */
  let active = false;

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

  async function handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    pendingPrompt: PendingPrompt | undefined
  ): Promise<void> {
    try {
      const agentStatusManager = deps.agentStatusManager;

      // Check if this is a restart (provider already exists from disconnect)
      if (agentStatusManager.hasProvider(workspacePath)) {
        try {
          await agentStatusManager.reconnectWorkspace(workspacePath);
          logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: "opencode",
          });
        } catch (error) {
          logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: "opencode" },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create OpenCode-specific provider directly
      const provider = new OpenCodeProvider(
        workspacePath,
        agentStatusManager.getLogger(),
        agentStatusManager.getSdkFactory()
      );

      try {
        await provider.connect(port);
        await provider.fetchStatus();

        // Set bridge port so getEnvironmentVariables() includes it
        const bridgePort = serverManager.getBridgePort();
        if (bridgePort !== null) {
          provider.setBridgePort(bridgePort);
        }

        agentStatusManager.addProvider(workspacePath, provider);

        // Send initial prompt if provided
        if (pendingPrompt) {
          const sessionResult = await provider.createSession();
          if (sessionResult.ok) {
            const promptResult = await provider.sendPrompt(
              sessionResult.value.id,
              pendingPrompt.prompt,
              {
                ...(pendingPrompt.agent !== undefined && { agent: pendingPrompt.agent }),
                ...(pendingPrompt.model !== undefined && { model: pendingPrompt.model }),
              }
            );
            if (!promptResult.ok) {
              logger.error("Failed to send initial prompt", {
                workspacePath,
                error: promptResult.error.message,
              });
            }
          } else {
            logger.error("Failed to create session for initial prompt", {
              workspacePath,
              error: sessionResult.error.message,
            });
          }
        }
      } catch (error) {
        logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: "opencode" },
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

    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port, pendingPrompt) => {
      const promise = handleServerStarted(workspacePath as WorkspacePath, port, pendingPrompt);
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
    hooks: {
      [APP_START_OPERATION_ID]: {
        "check-config": {
          handler: async (): Promise<CheckConfigResult> => {
            const config = await configService.load();
            return { configuredAgent: config.agent };
          },
        },

        configure: {
          handler: async (): Promise<ConfigureResult> => {
            return {
              scripts: ["ch-opencode", "ch-opencode.cjs", "ch-opencode.cmd"],
            };
          },
        },

        "check-deps": {
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { configuredAgent } = ctx as CheckDepsHookContext;
            if (configuredAgent !== "opencode") return {};

            const missingBinaries: import("../../services/vscode-setup/types").BinaryType[] = [];
            const agentResult = await agentBinaryManager.preflight();
            if (agentResult.success && agentResult.needsDownload) {
              const binaryType = agentBinaryManager.getBinaryType() as AgentBinaryType;
              missingBinaries.push(binaryType);
            }
            return { missingBinaries };
          },
        },

        start: {
          handler: async (): Promise<StartHookResult> => {
            const config = await configService.load();
            const agentType: AgentType = config.agent ?? "opencode";

            if (agentType === "opencode") {
              active = true;
              wireServerCallbacks();

              statusUnsubscribeFn = deps.agentStatusManager.onStatusChanged(
                (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => {
                  void deps.dispatcher.dispatch({
                    type: INTENT_UPDATE_AGENT_STATUS,
                    payload: { workspacePath, status },
                  } as UpdateAgentStatusIntent);
                }
              );
            }
            return {};
          },
        },

        activate: {
          handler: async (ctx: HookContext): Promise<ActivateHookResult> => {
            if (!active) return {};
            const { mcpPort } = ctx as ActivateHookContext;
            if (mcpPort !== null) {
              serverManager.setMcpConfig({ port: mcpPort });
            }
            return {};
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
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
            } catch (error) {
              logger.error(
                "OpenCode agent lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },

      [SETUP_OPERATION_ID]: {
        "register-agents": {
          handler: async (): Promise<RegisterAgentResult> => {
            return { agent: "opencode", label: "OpenCode", icon: "terminal" };
          },
        },

        "save-agent": {
          handler: async (ctx: HookContext) => {
            const { selectedAgent } = ctx as SaveAgentHookInput;
            if (selectedAgent !== "opencode") return;

            try {
              await configService.setAgent(selectedAgent);
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
            if (agentType !== "opencode") return;

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
          handler: async (ctx: HookContext): Promise<SetupHookResult | undefined> => {
            if (!active) return undefined;

            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;

            // Start with initial prompt options for OpenCode
            if (intent.payload.initialPrompt) {
              const normalizedPrompt = normalizeInitialPrompt(intent.payload.initialPrompt);
              await serverManager.startServer(workspacePath, {
                initialPrompt: normalizedPrompt,
              });
            } else {
              await serverManager.startServer(workspacePath);
            }

            await waitForProvider(workspacePath);

            const agentProvider = deps.agentStatusManager.getProvider(
              workspacePath as WorkspacePath
            );
            const envVars: Record<string, string> = {
              ...(agentProvider?.getEnvironmentVariables() ?? {}),
            };

            return { envVars, agentType: "opencode" };
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
                ? { serverName: "OpenCode", error: serverError }
                : { serverName: "OpenCode" };
            } catch (error) {
              if (payload.force) {
                logger.warn("OpenCodeAgentModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { serverName: "OpenCode", error: getErrorMessage(error) };
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
  };
}
