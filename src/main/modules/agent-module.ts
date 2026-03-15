/**
 * Generic agent module factory - Creates an IntentModule from an AgentModuleProvider.
 *
 * This is a thin adapter: every hook handler delegates to the provider.
 * Replaces both claude-agent-module.ts and opencode-agent-module.ts with a single
 * implementation parameterized by the AgentModuleProvider interface.
 *
 * Closure state:
 * - active: boolean - set by config:updated event, guards per-agent hooks
 * - capAgentType: AgentType | undefined - capability for open-workspace
 * - statusChangeCleanup: (() => void) | null - cleanup for onStatusChange subscription
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { ANY_VALUE, type HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { Logger } from "../../services/logging/types";
import type { BinaryType } from "../../services/binary-resolution/types";
import type { AgentType } from "../../shared/plugin-protocol";
import type { WorkspacePath } from "../../shared/ipc";

import type { Dispatcher } from "../intents/infrastructure/dispatcher";
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
import { SetupError, getErrorMessage } from "../../services/errors";
import { normalizeInitialPrompt } from "../../shared/api/types";
import type { AgentModuleProvider } from "../../services/agents/agent-module-provider";

// =============================================================================
// Dependency Interfaces
// =============================================================================

/**
 * Dependencies for the generic agent module factory.
 */
export interface AgentModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a generic agent module that manages agent lifecycle by delegating
 * to the provided AgentModuleProvider.
 *
 * This factory produces an IntentModule with identical hook structure to
 * the former claude-agent-module and opencode-agent-module, but parameterized
 * by the provider interface rather than hardcoding agent-specific logic.
 */
export function createAgentModule(
  provider: AgentModuleProvider,
  deps: AgentModuleDeps
): IntentModule {
  const { logger } = deps;

  // =========================================================================
  // Internal closure state
  // =========================================================================

  /** Whether this module is the active agent (set by config:updated event). */
  let active = false;

  /** Capability: agentType provided by setup handler. */
  let capAgentType: AgentType | undefined;

  /** Cleanup function for onStatusChange subscription. */
  let statusChangeCleanup: (() => void) | null = null;

  // =========================================================================
  // Build the IntentModule
  // =========================================================================

  return {
    name: `${provider.type}-agent`,
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [provider.getConfigDefinition()],
          }),
        },

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
            if (!active) return;

            const mcpPort = ctx.capabilities?.mcpPort as number | null;
            provider.initialize(
              mcpPort !== null && mcpPort !== undefined ? { port: mcpPort } : null
            );

            statusChangeCleanup = provider.onStatusChange((workspacePath, status) => {
              void deps.dispatcher.dispatch({
                type: INTENT_UPDATE_AGENT_STATUS,
                payload: { workspacePath, status },
              } as UpdateAgentStatusIntent);
            });
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

            await provider.dispose();
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
          provides: () => ({
            ...(capAgentType !== undefined && { agentType: capAgentType }),
          }),
          handler: async (ctx: HookContext): Promise<SetupHookResult | undefined> => {
            capAgentType = undefined;
            if (!active) return undefined;

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
          handler: async (ctx: HookContext): Promise<ShutdownHookResult | undefined> => {
            if (!active) return undefined;

            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              let serverError: string | undefined;
              const stopResult = await provider.stopWorkspace(workspacePath);
              if (!stopResult.success) {
                serverError = stopResult.error ?? "Failed to stop server";
                if (!payload.force) {
                  throw new Error(serverError);
                }
              }

              provider.clearWorkspaceTracking(workspacePath as WorkspacePath);

              return serverError
                ? { serverName: provider.serverName, error: serverError }
                : { serverName: provider.serverName };
            } catch (error) {
              if (payload.force) {
                logger.warn(`${provider.type}AgentModule: error in force mode (ignored)`, {
                  error: getErrorMessage(error),
                });
                return { serverName: provider.serverName, error: getErrorMessage(error) };
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
              agentStatus: provider.getStatus(workspacePath as WorkspacePath),
            };
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult | undefined> => {
            if (!active) return undefined;
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            return {
              session: provider.getSession(workspacePath as WorkspacePath),
            };
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult | undefined> => {
            if (!active) return undefined;
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
    events: {
      [EVENT_CONFIG_UPDATED]: {
        handler: async (event: DomainEvent) => {
          const { values } = (event as ConfigUpdatedEvent).payload;
          if (values.agent !== undefined) {
            // Agent value received -- check if this module should be active
            const agentType = (values.agent as string | null) ?? "opencode";
            active = agentType === provider.type;
          }
        },
      },
    },
  };
}
