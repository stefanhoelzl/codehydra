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
import type { AgentProvider, AgentStatus } from "../../agents/types";
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
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type { ConfigSetValuesIntent } from "../operations/config-set-values";
import { INTENT_CONFIG_SET_VALUES, EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { configString } from "../../services/config/config-definition";
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
  readonly agentBinaryManager: AgentBinaryManager;
  readonly serverManager: OpenCodeServerManager;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly loggingService: LoggingService;
  readonly providerLogger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an OpenCodeAgentModule that manages the OpenCode agent lifecycle.
 */
export function createOpenCodeAgentModule(deps: OpenCodeAgentModuleDeps): IntentModule {
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

  /** Cleanup functions for onServerStarted/onServerStopped callbacks. */
  let serverStartedCleanupFn: Unsubscribe | null = null;
  let serverStoppedCleanupFn: Unsubscribe | null = null;

  /** Per-workspace provider instances. */
  const providers = new Map<WorkspacePath, AgentProvider>();

  /** Cached aggregated status per workspace (for deduplication and queries). */
  const statusCache = new Map<WorkspacePath, AggregatedAgentStatus>();

  /**
   * Track workspaces that have had TUI attached.
   * Persists across provider recreations (e.g., server restart) so we can
   * restore the attached state without waiting for a new MCP request.
   */
  const tuiAttachedWorkspaces = new Set<WorkspacePath>();

  // =========================================================================
  // Provider management helpers
  // =========================================================================

  function createNoneStatus(): AggregatedAgentStatus {
    return { status: "none", counts: { idle: 0, busy: 0 } };
  }

  function convertToAggregatedStatus(status: AgentStatus): AggregatedAgentStatus {
    switch (status) {
      case "none":
        return { status: "none", counts: { idle: 0, busy: 0 } };
      case "idle":
        return { status: "idle", counts: { idle: 1, busy: 0 } };
      case "busy":
        return { status: "busy", counts: { idle: 0, busy: 1 } };
    }
  }

  function getProviderStatus(provider: AgentProvider): AgentStatus {
    if (provider instanceof OpenCodeProvider) {
      const counts = provider.getEffectiveCounts();
      if (counts.idle === 0 && counts.busy === 0) return "none";
      if (counts.busy > 0) return "busy";
      return "idle";
    }
    return "none";
  }

  function handleStatusUpdate(path: WorkspacePath, agentStatus: AgentStatus): void {
    const status = convertToAggregatedStatus(agentStatus);
    const previous = statusCache.get(path);
    const hasChanged =
      !previous ||
      previous.status !== status.status ||
      previous.counts.idle !== status.counts.idle ||
      previous.counts.busy !== status.counts.busy;

    if (hasChanged) {
      statusCache.set(path, status);
      void deps.dispatcher.dispatch({
        type: INTENT_UPDATE_AGENT_STATUS,
        payload: { workspacePath: path, status },
      } as UpdateAgentStatusIntent);
    }
  }

  function addProvider(path: WorkspacePath, provider: AgentProvider): void {
    if (providers.has(path)) return;

    provider.onStatusChange((status) => handleStatusUpdate(path, status));

    if (tuiAttachedWorkspaces.has(path)) {
      provider.markActive();
    }

    providers.set(path, provider);
    handleStatusUpdate(path, getProviderStatus(provider));
  }

  function removeProvider(path: WorkspacePath): void {
    const provider = providers.get(path);
    if (provider) {
      provider.dispose();
      providers.delete(path);
      statusCache.delete(path);
      void deps.dispatcher.dispatch({
        type: INTENT_UPDATE_AGENT_STATUS,
        payload: { workspacePath: path, status: createNoneStatus() },
      } as UpdateAgentStatusIntent);
    }
  }

  function disconnectProvider(path: WorkspacePath): void {
    const provider = providers.get(path);
    if (provider) {
      provider.disconnect();
    }
  }

  async function reconnectProvider(path: WorkspacePath): Promise<void> {
    const provider = providers.get(path);
    if (provider) {
      await provider.reconnect();
      handleStatusUpdate(path, getProviderStatus(provider));
    }
  }

  function markProviderActive(path: WorkspacePath): void {
    tuiAttachedWorkspaces.add(path);
    const provider = providers.get(path);
    if (provider) {
      provider.markActive();
    }
  }

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
      // Check if this is a restart (provider already exists from disconnect)
      if (providers.has(workspacePath)) {
        try {
          await reconnectProvider(workspacePath);
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
      const provider = new OpenCodeProvider(workspacePath, deps.providerLogger, undefined);

      try {
        await provider.connect(port);
        await provider.fetchStatus();

        // Set bridge port so getEnvironmentVariables() includes it
        const bridgePort = serverManager.getBridgePort();
        if (bridgePort !== null) {
          provider.setBridgePort(bridgePort);
        }

        addProvider(workspacePath, provider);

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
    serverManager.setMarkActiveHandler((wp) => markProviderActive(wp as WorkspacePath));

    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port, pendingPrompt) => {
      const promise = handleServerStarted(workspacePath as WorkspacePath, port, pendingPrompt);
      serverStartedPromises.set(workspacePath, promise);
    });

    serverStoppedCleanupFn = serverManager.onServerStopped((workspacePath, isRestart) => {
      if (isRestart) {
        disconnectProvider(workspacePath as WorkspacePath);
      } else {
        removeProvider(workspacePath as WorkspacePath);
      }
    });
  }

  // =========================================================================
  // Build the IntentModule
  // =========================================================================

  return {
    name: "opencode-agent",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "version.opencode",
                default: null,
                description: "OpenCode agent version override",
                ...configString({ nullable: true }),
              },
            ],
          }),
        },

        "before-ready": {
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

            if (active) {
              for (const provider of providers.values()) {
                provider.dispose();
              }
              providers.clear();
              statusCache.clear();
              tuiAttachedWorkspaces.clear();
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
          provides: () => ({
            ...(capAgentType !== undefined && { agentType: capAgentType }),
          }),
          handler: async (ctx: HookContext): Promise<SetupHookResult | undefined> => {
            capAgentType = undefined;
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

            const envVars: Record<string, string> = {
              ...(providers.get(workspacePath as WorkspacePath)?.getEnvironmentVariables() ?? {}),
            };

            capAgentType = "opencode";
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

              tuiAttachedWorkspaces.delete(workspacePath as WorkspacePath);

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
              agentStatus: statusCache.get(workspacePath as WorkspacePath) ?? createNoneStatus(),
            };
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult | undefined> => {
            if (!active) return undefined;
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            const session = providers.get(workspacePath as WorkspacePath)?.getSession() ?? null;
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
      [EVENT_CONFIG_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { values } = (event as ConfigUpdatedEvent).payload;
          if (values.agent !== undefined) {
            // Agent value received — check if this module should be active
            const agentType = (values.agent as string | null) ?? "opencode";
            active = agentType === "opencode";
          }
        },
      },
    },
  };
}
