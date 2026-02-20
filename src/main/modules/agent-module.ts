/**
 * AgentModule - Manages agent lifecycle, setup, per-workspace server management,
 * and status tracking.
 *
 * Consolidates nine inline bootstrap modules and agent lifecycle logic into a
 * single extracted module (Phase 7 of intent architecture cleanup):
 * - Config check (app:start / check-config)
 * - Agent binary preflight (app:start / check-deps)
 * - Agent selection UI (app:setup / agent-selection)
 * - Config save (app:setup / save-agent)
 * - Agent binary download (app:setup / binary)
 * - Agent lifecycle: start, activate, stop (app:start, app:shutdown)
 * - Per-workspace agent setup (open-workspace / setup)
 * - Per-workspace agent shutdown (delete-workspace / shutdown)
 * - Agent status/session/restart queries
 *
 * Internal closure state: handleServerStarted, waitForProvider, serverStartedPromises,
 * agentStatusUnsubscribe (from agentLifecycleModule).
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { IpcEventHandler } from "../../services/platform/ipc";
import type { ConfigService } from "../../services/config/config-service";
import type { AgentBinaryManager } from "../../services/binary-download";
import type { AgentBinaryType } from "../../services/binary-download";
import type { ConfigAgentType } from "../../shared/api/types";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { AgentServerManager, AgentType } from "../../agents/types";
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
import type {
  AgentSelectionHookResult,
  SaveAgentHookInput,
  BinaryHookInput,
} from "../operations/setup";
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
import { createAgentProvider } from "../../agents";
import { OpenCodeProvider } from "../../agents/opencode/provider";
import {
  ApiIpcChannels as SetupIpcChannels,
  type LifecycleAgentType,
  type ShowAgentSelectionPayload,
  type AgentSelectedPayload,
} from "../../shared/ipc";

// =============================================================================
// Constants
// =============================================================================

/** Available agents for selection. */
const AVAILABLE_AGENTS: readonly LifecycleAgentType[] = ["opencode", "claude"];

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Minimal kill terminals callback interface.
 */
export type KillTerminalsCallback = (workspacePath: string) => Promise<void>;

/**
 * Dependencies available at creation time (composition root scope).
 */
export interface AgentModuleDeps {
  readonly configService: Pick<ConfigService, "load" | "setAgent">;
  readonly getAgentBinaryManager: (type: ConfigAgentType) => AgentBinaryManager;
  readonly ipcLayer: Pick<import("../../services/platform/ipc").IpcLayer, "on" | "removeListener">;
  readonly getUIWebContentsFn: () => import("electron").WebContents | null;
  readonly logger: Logger;
  readonly loggingService: LoggingService;
  readonly dispatcher: Dispatcher;
  readonly killTerminalsCallback: KillTerminalsCallback | undefined;
  /** Pre-created agent server managers keyed by type */
  readonly agentServerManagers: {
    claude: AgentServerManager;
    opencode: AgentServerManager;
  };
  /** AgentStatusManager instance (created upfront in bootstrap) */
  readonly agentStatusManager: AgentStatusManager;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an AgentModule that manages the entire agent lifecycle:
 * setup, server management, status tracking, and per-workspace hooks.
 */
export function createAgentModule(deps: AgentModuleDeps): IntentModule {
  const { configService, getAgentBinaryManager, logger } = deps;

  // =========================================================================
  // Internal closure state
  // =========================================================================

  /**
   * Tracks pending handleServerStarted() promises so callers can await
   * provider registration via waitForProvider().
   */
  const serverStartedPromises = new Map<string, Promise<void>>();

  /** Cleanup function for agentStatusManager.onStatusChanged subscription. */
  let agentStatusUnsubscribeFn: Unsubscribe | null = null;

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: Unsubscribe | null = null;
  let serverStoppedCleanupFn: Unsubscribe | null = null;

  /** Agent services created during the start hook (null before start). */
  let serverManagerInstance: AgentServerManager | null = null;
  let agentStatusManagerInstance: AgentStatusManager | null = null;
  let selectedAgentTypeValue: AgentType | null = null;

  // =========================================================================
  // Internal functions
  // =========================================================================

  /**
   * Wait for the agent provider to be registered for a workspace.
   * Use after startServer() to ensure environment variables are available.
   */
  async function waitForProvider(workspacePath: string): Promise<void> {
    const promise = serverStartedPromises.get(workspacePath);
    if (promise) {
      await promise;
    }
  }

  /**
   * Handle server started event.
   * For restart: reconnects existing provider.
   * For first start: creates provider, registers with AgentStatusManager.
   * For OpenCode: sends initial prompt if provided.
   */
  async function handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    pendingPrompt: PendingPrompt | undefined
  ): Promise<void> {
    try {
      const agentStatusManager = agentStatusManagerInstance!;
      const serverManager = serverManagerInstance!;
      const selectedAgentType = selectedAgentTypeValue!;

      // Check if this is a restart (provider already exists from disconnect)
      if (agentStatusManager.hasProvider(workspacePath)) {
        // Restart: reconnect existing provider
        try {
          await agentStatusManager.reconnectWorkspace(workspacePath);
          logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: selectedAgentType,
          });
        } catch (error) {
          logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: selectedAgentType },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create provider using factory
      const provider = createAgentProvider(selectedAgentType, {
        workspacePath,
        logger: agentStatusManager.getLogger(),
        sdkFactory:
          selectedAgentType === "opencode" ? agentStatusManager.getSdkFactory() : undefined,
        serverManager:
          selectedAgentType === "claude" ? (serverManager as ClaudeCodeServerManager) : undefined,
      });

      try {
        // Connect to server
        await provider.connect(port);

        // OpenCode-specific: fetch initial status and send initial prompt
        if (selectedAgentType === "opencode" && provider instanceof OpenCodeProvider) {
          // Fetch initial status
          await provider.fetchStatus();

          // Register with AgentStatusManager
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
        } else {
          // Claude Code: just register the provider (no initial status fetch or prompt)
          agentStatusManager.addProvider(workspacePath, provider);
        }
      } catch (error) {
        logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: selectedAgentType },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      // Clean up the promise so subsequent waitForProvider calls return immediately
      serverStartedPromises.delete(workspacePath);
    }
  }

  /**
   * Wire server callbacks (onServerStarted / onServerStopped) to
   * handleServerStarted / agentStatusManager methods.
   * Called from the `start` hook after agent services are created.
   */
  function wireServerCallbacks(): void {
    const serverManager = serverManagerInstance!;
    const agentStatusManager = agentStatusManagerInstance!;

    // Wire markActive handler so both OpenCode and Claude Code call it
    serverManager.setMarkActiveHandler((wp) => agentStatusManager.markActive(wp as WorkspacePath));

    // Wire server started callback
    // Note: OpenCode passes (workspacePath, port, pendingPrompt)
    // Claude Code only passes (workspacePath, port)
    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port, ...args) => {
      const pendingPrompt = args[0] as PendingPrompt | undefined;
      // Store promise so callers can await provider registration via waitForProvider()
      const promise = handleServerStarted(workspacePath as WorkspacePath, port, pendingPrompt);
      serverStartedPromises.set(workspacePath, promise);
    });

    // Wire server stopped callback
    // Note: OpenCode passes (workspacePath, isRestart)
    // Claude Code only passes (workspacePath)
    serverStoppedCleanupFn = serverManager.onServerStopped((workspacePath, ...args) => {
      const isRestart = args[0] as boolean | undefined;
      if (isRestart) {
        // For restart: disconnect but keep provider
        agentStatusManager.disconnectWorkspace(workspacePath as WorkspacePath);
      } else {
        // For permanent stop: remove workspace completely
        agentStatusManager.removeWorkspace(workspacePath as WorkspacePath);
      }
    });
  }

  // =========================================================================
  // Build the IntentModule
  // =========================================================================

  const agentServerNameFn = (type: AgentType): string =>
    type === "claude" ? "Claude Code hook" : "OpenCode";

  return {
    hooks: {
      // -------------------------------------------------------------------
      // app-start → check-config: load config, return configuredAgent
      // -------------------------------------------------------------------
      [APP_START_OPERATION_ID]: {
        "check-config": {
          handler: async (): Promise<CheckConfigResult> => {
            const config = await configService.load();
            return { configuredAgent: config.agent };
          },
        },

        // -------------------------------------------------------------------
        // app-start → configure: declare required agent scripts
        // -------------------------------------------------------------------
        configure: {
          handler: async (): Promise<ConfigureResult> => {
            return {
              scripts: [
                "ch-claude",
                "ch-claude.cjs",
                "ch-claude.cmd",
                "ch-opencode",
                "ch-opencode.cjs",
                "ch-opencode.cmd",
                "claude-code-hook-handler.cjs",
              ],
            };
          },
        },

        // -------------------------------------------------------------------
        // app-start → check-deps: check if agent binary needs download
        // -------------------------------------------------------------------
        "check-deps": {
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { configuredAgent } = ctx as CheckDepsHookContext;
            const missingBinaries: import("../../services/vscode-setup/types").BinaryType[] = [];

            if (configuredAgent) {
              const agentBinaryManager = getAgentBinaryManager(configuredAgent);
              const agentResult = await agentBinaryManager.preflight();
              if (agentResult.success && agentResult.needsDownload) {
                const binaryType = agentBinaryManager.getBinaryType() as AgentBinaryType;
                missingBinaries.push(binaryType);
              }
            }

            return { missingBinaries };
          },
        },

        // -------------------------------------------------------------------
        // app-start → start: create agent services, wire callbacks
        // -------------------------------------------------------------------
        start: {
          handler: async (): Promise<StartHookResult> => {
            // Load config to determine agent type, then select the pre-created server manager
            const config = await configService.load();
            const agentType: AgentType = config.agent ?? "opencode";

            // Select the pre-created server manager for the configured agent type
            serverManagerInstance = deps.agentServerManagers[agentType];
            agentStatusManagerInstance = deps.agentStatusManager;
            selectedAgentTypeValue = agentType;

            // Wire server callbacks (onServerStarted / onServerStopped)
            wireServerCallbacks();

            // Wire agent status changes through the intent dispatcher
            agentStatusUnsubscribeFn = deps.agentStatusManager.onStatusChanged(
              (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => {
                void deps.dispatcher.dispatch({
                  type: INTENT_UPDATE_AGENT_STATUS,
                  payload: { workspacePath, status },
                } as UpdateAgentStatusIntent);
              }
            );
            return {};
          },
        },

        // -------------------------------------------------------------------
        // app-start → activate: configure MCP
        // -------------------------------------------------------------------
        activate: {
          handler: async (ctx: HookContext): Promise<ActivateHookResult> => {
            const { mcpPort } = ctx as ActivateHookContext;
            const sm = serverManagerInstance!;
            const agentType = selectedAgentTypeValue!;

            // Configure server manager to connect to MCP
            if (mcpPort !== null) {
              if (agentType === "claude") {
                const claudeManager = sm as ClaudeCodeServerManager;
                claudeManager.setMcpConfig({ port: mcpPort });
              } else {
                const opencodeManager = sm as OpenCodeServerManager;
                opencodeManager.setMcpConfig({ port: mcpPort });
              }
            }

            return {};
          },
        },
      },

      // -------------------------------------------------------------------
      // app-shutdown → stop: dispose services, clean up callbacks
      // -------------------------------------------------------------------
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Cleanup server callbacks
              if (serverStartedCleanupFn) {
                serverStartedCleanupFn();
                serverStartedCleanupFn = null;
              }
              if (serverStoppedCleanupFn) {
                serverStoppedCleanupFn();
                serverStoppedCleanupFn = null;
              }

              // Dispose both server managers (inactive one is a no-op, no resources allocated)
              for (const sm of Object.values(deps.agentServerManagers)) {
                await sm.dispose();
              }

              // Cleanup agent status subscription
              if (agentStatusUnsubscribeFn) {
                agentStatusUnsubscribeFn();
                agentStatusUnsubscribeFn = null;
              }

              // Dispose AgentStatusManager
              deps.agentStatusManager.dispose();
            } catch (error) {
              logger.error(
                "Agent lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // setup → agent-selection: show agent selection UI, wait for response
      // -------------------------------------------------------------------
      [SETUP_OPERATION_ID]: {
        "agent-selection": {
          handler: async (): Promise<AgentSelectionHookResult> => {
            const webContents = deps.getUIWebContentsFn();

            if (!webContents || webContents.isDestroyed()) {
              throw new SetupError("UI not available for agent selection", "TIMEOUT");
            }

            logger.debug("Showing agent selection dialog");

            // Create a promise that resolves when the renderer responds
            const agentPromise = new Promise<LifecycleAgentType>((resolve) => {
              const handleAgentSelected: IpcEventHandler = (_event, ...args) => {
                deps.ipcLayer.removeListener(
                  SetupIpcChannels.LIFECYCLE_AGENT_SELECTED,
                  handleAgentSelected
                );
                const payload = args[0] as AgentSelectedPayload;
                resolve(payload.agent);
              };

              deps.ipcLayer.on(SetupIpcChannels.LIFECYCLE_AGENT_SELECTED, handleAgentSelected);
            });

            // Send IPC event to show agent selection
            const payload: ShowAgentSelectionPayload = {
              agents: AVAILABLE_AGENTS,
            };
            webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_AGENT_SELECTION, payload);

            // Wait for response
            const selectedAgent = await agentPromise;
            logger.info("Agent selected", { agent: selectedAgent });

            return { selectedAgent };
          },
        },

        // -------------------------------------------------------------------
        // setup → save-agent: persist agent selection to config
        // -------------------------------------------------------------------
        "save-agent": {
          handler: async (ctx: HookContext) => {
            const { selectedAgent } = ctx as SaveAgentHookInput;

            if (!selectedAgent) {
              throw new SetupError(
                "No agent selected in save-agent hook",
                "AGENT_SELECTION_REQUIRED"
              );
            }

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

        // -------------------------------------------------------------------
        // setup → binary: download agent binary if missing
        // -------------------------------------------------------------------
        binary: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];
            const { report } = hookCtx;

            // Get the agent type from context (set by ConfigCheckModule or ConfigSaveModule)
            const agentType = hookCtx.selectedAgent ?? hookCtx.configuredAgent;
            if (agentType) {
              const agentBinaryManager = getAgentBinaryManager(agentType);
              const binaryType = agentBinaryManager.getBinaryType();

              // Download agent binary if missing
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
            } else {
              report("agent", "done");
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // open-workspace → setup: start agent server, set initial prompt,
      // get env vars
      // -------------------------------------------------------------------
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;
            const sm = serverManagerInstance!;
            const asm = agentStatusManagerInstance!;
            const agentType = selectedAgentTypeValue!;

            // 1. Start agent server
            await sm.startServer(workspacePath);

            // 2. Wait for provider registration (handleServerStarted runs async)
            await waitForProvider(workspacePath);

            // 3. Set initial prompt if provided (must happen after startServer)
            if (intent.payload.initialPrompt && sm.setInitialPrompt) {
              const normalizedPrompt = normalizeInitialPrompt(intent.payload.initialPrompt);
              await sm.setInitialPrompt(workspacePath, normalizedPrompt);
            }

            // 4. Get environment variables from agent provider
            const agentProvider = asm.getProvider(workspacePath as WorkspacePath);
            const envVars: Record<string, string> = {
              ...(agentProvider?.getEnvironmentVariables() ?? {}),
            };

            // 5. Add bridge port for OpenCode wrapper notifications
            if (agentType === "opencode") {
              const bridgePort = (sm as OpenCodeServerManager).getBridgePort();
              if (bridgePort !== null) {
                envVars.CODEHYDRA_BRIDGE_PORT = String(bridgePort);
              }
            }

            return { envVars, agentType };
          },
        },
      },

      // -------------------------------------------------------------------
      // delete-workspace → shutdown: kill terminals, stop server,
      // clear TUI tracking
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            const sm = serverManagerInstance!;
            const asm = agentStatusManagerInstance!;
            const agentType = selectedAgentTypeValue!;
            const serverName = agentServerNameFn(agentType);

            try {
              // Kill terminals (best-effort even in normal mode)
              if (deps.killTerminalsCallback) {
                try {
                  await deps.killTerminalsCallback(workspacePath);
                } catch (error) {
                  logger.warn("Kill terminals failed", {
                    workspacePath,
                    error: getErrorMessage(error),
                  });
                }
              }

              // Stop server
              let serverError: string | undefined;
              const stopResult = await sm.stopServer(workspacePath);
              if (!stopResult.success) {
                serverError = stopResult.error ?? "Failed to stop server";
                if (!payload.force) {
                  throw new Error(serverError);
                }
              }

              // Clear TUI tracking
              asm.clearTuiTracking(workspacePath as WorkspacePath);

              return serverError ? { serverName, error: serverError } : { serverName };
            } catch (error) {
              if (payload.force) {
                logger.warn("AgentModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { serverName, error: getErrorMessage(error) };
              }
              throw error;
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // get-workspace-status → get: return agent status
      // -------------------------------------------------------------------
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            return {
              agentStatus: agentStatusManagerInstance!.getStatus(workspacePath as WorkspacePath),
            };
          },
        },
      },

      // -------------------------------------------------------------------
      // get-agent-session → get: return session info
      // -------------------------------------------------------------------
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult> => {
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            const session =
              agentStatusManagerInstance!.getSession(workspacePath as WorkspacePath) ?? null;
            return { session };
          },
        },
      },

      // -------------------------------------------------------------------
      // restart-agent → restart: restart agent server
      // -------------------------------------------------------------------
      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult> => {
            const { workspacePath } = ctx as RestartAgentHookInput;
            const result = await serverManagerInstance!.restartServer(workspacePath);
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
