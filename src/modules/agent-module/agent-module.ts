/**
 * Generic agent module factory - Creates an IntentModule from an AgentModuleProvider.
 *
 * This is a thin adapter: every hook handler delegates to the provider.
 * Replaces both claude-agent-module.ts and opencode-agent-module.ts with a single
 * implementation parameterized by the AgentModuleProvider interface.
 *
 * Closure state:
 * - capAgentType: AgentType | undefined - capability for open-workspace
 * - statusChangeCleanup: (() => void) | null - cleanup for onStatusChange subscription
 */

import type { IntentModule } from "../../intents/lib/module";
import { ANY_VALUE, type HookContext } from "../../intents/lib/operation";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { BinaryType } from "../../utils/binary-resolution/types";
import type { AgentType } from "../../shared/plugin-protocol";
import type { WorkspacePath } from "../../shared/ipc";
import type { Config } from "../../boundaries/platform/config";

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
} from "../../intents/app-start";
import type { RegisterAgentResult, SaveAgentHookInput, BinaryHookInput } from "../../intents/setup";
import type {
  SetupHookInput,
  SetupHookResult,
  OpenWorkspaceIntent,
} from "../../intents/open-workspace";
import type {
  DeleteWorkspaceIntent,
  ShutdownHookResult,
  DeletePipelineHookInput,
} from "../../intents/delete-workspace";
import type {
  HibernatePipelineHookInput,
  HibernateShutdownHookResult,
} from "../../intents/hibernate-workspace";
import { HIBERNATE_WORKSPACE_OPERATION_ID } from "../../intents/hibernate-workspace";
import type { GetStatusHookInput, GetStatusHookResult } from "../../intents/get-workspace-status";
import type {
  GetAgentSessionHookInput,
  GetAgentSessionHookResult,
} from "../../intents/get-agent-session";
import type { RestartAgentHookInput, RestartAgentHookResult } from "../../intents/restart-agent";
import type { UpdateAgentStatusIntent } from "../../intents/update-agent-status";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { APP_READY_OPERATION_ID, type AvailableAgentsResult } from "../../intents/app-ready";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../../intents/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../../intents/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../../intents/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../../intents/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../../intents/restart-agent";
import { INTENT_UPDATE_AGENT_STATUS } from "../../intents/update-agent-status";
import { SetupError, getErrorMessage } from "../../shared/errors/service-errors";
import { normalizeInitialPrompt } from "../../shared/api/types";
import type { AgentModuleProvider } from "./agent-module-provider";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies for the generic agent module factory.
 */
export interface AgentModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly configService: Config;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a generic agent module that manages agent lifecycle by delegating
 * to the provided AgentModuleProvider.
 */
export function createAgentModule(
  provider: AgentModuleProvider,
  deps: AgentModuleDeps
): IntentModule {
  const { logger } = deps;

  // Register provider's config key (e.g. version.claude, version.opencode)
  const configDef = provider.getConfigDefinition();
  deps.configService.register(configDef.name, configDef);

  // =========================================================================
  // Internal closure state
  // =========================================================================

  /** Capability: agentType provided by setup handler. */
  let capAgentType: AgentType | undefined;

  /** MCP port captured during app:start; consumed on lazy initialize. */
  let capturedMcpPort: number | null = null;

  /** Whether the provider has been initialized (lazy on first workspace:open). */
  let initialized = false;

  /** Cleanup function for onStatusChange subscription. */
  let statusChangeCleanup: (() => void) | null = null;

  /** Initialize the provider on demand. Idempotent. */
  function ensureInitialized(): void {
    if (initialized) return;
    provider.initialize(capturedMcpPort !== null ? { port: capturedMcpPort } : null);
    statusChangeCleanup = provider.onStatusChange((workspacePath, status) => {
      void deps.dispatcher.dispatch({
        type: INTENT_UPDATE_AGENT_STATUS,
        payload: { workspacePath, status },
      } as UpdateAgentStatusIntent);
    });
    initialized = true;
  }

  /**
   * Shared agent-server teardown used by delete + hibernate.
   * Returns a structured outcome and never throws. Callers decide whether
   * to propagate the error (delete in non-force mode does; hibernate doesn't).
   */
  async function stopAgentForWorkspace(
    workspacePath: string,
    logTag: string
  ): Promise<{ error?: string }> {
    try {
      const stopResult = await provider.stopWorkspace(workspacePath);
      provider.clearWorkspaceTracking(workspacePath as WorkspacePath);
      if (!stopResult.success) {
        return { error: stopResult.error ?? "Failed to stop server" };
      }
      return {};
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn(`${provider.type}AgentModule: ${logTag} error`, { error: message });
      return { error: message };
    }
  }

  // =========================================================================
  // Build the IntentModule
  // =========================================================================

  return {
    name: `${provider.type}-agent`,
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            return {
              scripts: provider.scripts,
            };
          },
        },

        "check-deps": {
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { configuredAgent } = ctx as CheckDepsHookContext;
            if (configuredAgent !== provider.type) return {};

            const missingBinaries: BinaryType[] = [];
            const result = await provider.preflight();
            if (result.success && result.needsDownload) {
              missingBinaries.push(provider.binaryType);
            }
            return { missingBinaries };
          },
        },

        start: {
          requires: { mcpPort: ANY_VALUE },
          handler: async (ctx: HookContext): Promise<void> => {
            const mcpPort = ctx.capabilities?.mcpPort as number | null | undefined;
            capturedMcpPort = mcpPort !== null && mcpPort !== undefined ? mcpPort : null;
            // Initialization is deferred until the first workspace using this
            // agent is opened (see open-workspace setup hook).
          },
        },
      },

      [APP_READY_OPERATION_ID]: {
        "available-agents": {
          handler: async (): Promise<AvailableAgentsResult> => {
            try {
              const result = await provider.preflight();
              if (!result.success || result.needsDownload) return {};
              return {
                agent: {
                  agent: provider.type,
                  label: provider.displayName,
                  icon: provider.icon,
                },
              };
            } catch {
              return {};
            }
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (statusChangeCleanup) {
              statusChangeCleanup();
              statusChangeCleanup = null;
            }
            if (initialized) {
              await provider.dispose();
              initialized = false;
            }
          },
        },
      },

      [SETUP_OPERATION_ID]: {
        "register-agents": {
          handler: async (): Promise<RegisterAgentResult> => {
            return {
              agent: provider.type,
              label: provider.displayName,
              icon: provider.icon,
            };
          },
        },

        "save-agent": {
          handler: async (ctx: HookContext) => {
            const { selectedAgent } = ctx as SaveAgentHookInput;
            if (selectedAgent !== provider.type) return;

            try {
              await deps.configService.set("agent", selectedAgent);
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
            if (agentType !== provider.type) return;

            if (missingBinaries.includes(provider.binaryType)) {
              report("agent", "running", "Downloading...");
              try {
                await provider.downloadBinary((p) => {
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
                  `Failed to download ${provider.binaryType}: ${getErrorMessage(error)}`,
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
          requires: { agent: provider.type },
          provides: () => ({
            ...(capAgentType !== undefined && { agentType: capAgentType }),
          }),
          handler: async (ctx: HookContext): Promise<SetupHookResult | undefined> => {
            capAgentType = undefined;
            ensureInitialized();

            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;

            const initialPrompt = intent.payload.initialPrompt
              ? normalizeInitialPrompt(intent.payload.initialPrompt)
              : undefined;
            const isNewWorkspace = intent.payload.existingWorkspace === undefined;

            const result = await provider.startWorkspace(workspacePath, {
              ...(initialPrompt !== undefined && { initialPrompt }),
              ...(isNewWorkspace !== undefined && { isNewWorkspace }),
            });

            capAgentType = provider.type;
            return { envVars: result.envVars };
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<ShutdownHookResult | undefined> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            const result = await stopAgentForWorkspace(workspacePath, "delete shutdown");
            if (result.error && !payload.force) {
              throw new Error(result.error);
            }
            return result.error
              ? { serverName: provider.serverName, error: result.error }
              : { serverName: provider.serverName };
          },
        },
      },

      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HibernateShutdownHookResult | undefined> => {
            const { workspacePath } = ctx as HibernatePipelineHookInput;
            await stopAgentForWorkspace(workspacePath, "hibernate shutdown");
            return {};
          },
        },
      },

      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<GetStatusHookResult | undefined> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            return {
              agentStatus: provider.getStatus(workspacePath as WorkspacePath),
            };
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult | undefined> => {
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            return {
              session: provider.getSession(workspacePath as WorkspacePath),
            };
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult | undefined> => {
            const { workspacePath } = ctx as RestartAgentHookInput;
            const result = await provider.restartWorkspace(workspacePath);
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
