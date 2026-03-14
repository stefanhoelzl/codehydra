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
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly loggingService: LoggingService;
  readonly providerLogger: Logger;
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
    // ClaudeCodeProvider: initial status is "none" (status comes via onStatusChange from ServerManager)
    handleStatusUpdate(path, "none");
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
      // ClaudeCodeProvider: status comes via onStatusChange, initial reconnect status is "none"
      handleStatusUpdate(path, "none");
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

  async function handleServerStarted(workspacePath: WorkspacePath, port: number): Promise<void> {
    try {
      // Check if this is a restart (provider already exists from disconnect)
      if (providers.has(workspacePath)) {
        try {
          await reconnectProvider(workspacePath);
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
        logger: deps.providerLogger,
      });

      try {
        await provider.connect(port);
        addProvider(workspacePath, provider);
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
    serverManager.setMarkActiveHandler((wp) => markProviderActive(wp as WorkspacePath));

    serverStartedCleanupFn = serverManager.onServerStarted((workspacePath, port) => {
      const promise = handleServerStarted(workspacePath as WorkspacePath, port);
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

            const envVars: Record<string, string> = {
              ...(providers.get(workspacePath as WorkspacePath)?.getEnvironmentVariables() ?? {}),
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

              tuiAttachedWorkspaces.delete(workspacePath as WorkspacePath);

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
            active = agentType === "claude";
          }
        },
      },
    },
  };
}
