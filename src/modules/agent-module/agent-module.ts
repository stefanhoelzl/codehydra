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
import { ANY_VALUE, type HookContext, type HookOutput } from "../../intents/lib/operation";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { BinaryType } from "../../utils/binary-resolution/types";
import type { AgentType } from "../../shared/plugin-protocol";
import type { WorkspacePath } from "../../shared/ipc";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../../boundaries/platform/config";

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type {
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
} from "../../intents/app-start";
import type {
  RegisterAgentResult,
  SaveAgentHookInput,
  BinaryHookInput,
  SetupProgressPayload,
} from "../../intents/setup";
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
import type { AgentLifecycleHookInput } from "../../intents/agent-lifecycle";
import type { UpdateAgentStatusIntent } from "../../intents/update-agent-status";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { APP_READY_OPERATION_ID, type AvailableAgentsResult } from "../../intents/app-ready";
import {
  GET_LAUNCH_OPTIONS_OPERATION_ID,
  type LaunchOptionsHookInput,
  type LaunchOptionsHookResult,
} from "../../intents/agent-launch-options";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import { streamProgress } from "../../intents/lib/hook-helpers";
import { OPEN_WORKSPACE_OPERATION_ID } from "../../intents/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../../intents/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../../intents/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../../intents/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../../intents/restart-agent";
import { AGENT_LIFECYCLE_OPERATION_ID } from "../../intents/agent-lifecycle";
import { INTENT_UPDATE_AGENT_STATUS } from "../../intents/update-agent-status";
import { SetupError, getErrorMessage } from "../../shared/errors/service-errors";
import type { AgentSpec } from "../../shared/api/types";
import type { AgentPromptConfig } from "./types";
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
  /** Accessor for the user's agent selection (registered in the composition root). */
  readonly agentConfig: PersistedAccessor<ConfigAgentType>;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Project the payload's AgentSpec onto the launch config for the resolved
 * provider. The "default" arm yields prompt-only; a matching typed arm yields
 * its full config. Returns undefined when there's nothing to apply (no spec,
 * or an empty arm) so providers skip prompt/marker work.
 */
function agentPromptConfigFor(
  spec: AgentSpec | undefined,
  providerType: AgentType
): AgentPromptConfig | undefined {
  if (spec === undefined) return undefined;
  if (spec.type === "default") {
    return spec.prompt !== undefined ? { prompt: spec.prompt } : undefined;
  }
  // Capability gating routes this hook only to the matching provider; guard anyway.
  if (spec.type !== providerType) return undefined;
  const config: AgentPromptConfig = {
    ...(spec.prompt !== undefined && { prompt: spec.prompt }),
    ...(spec.model !== undefined && { model: spec.model }),
    ...("permissionMode" in spec &&
      spec.permissionMode !== undefined && { permissionMode: spec.permissionMode }),
    ...(spec.agentName !== undefined && { agentName: spec.agentName }),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Create a generic agent module that manages agent lifecycle by delegating
 * to the provided AgentModuleProvider.
 */
export function createAgentModule(
  provider: AgentModuleProvider,
  deps: AgentModuleDeps
): IntentModule {
  const { logger } = deps;

  // =========================================================================
  // Internal closure state
  // =========================================================================

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
          handler: async (): Promise<HookOutput<ConfigureResult>> => {
            return {
              result: {
                scripts: provider.scripts,
              },
            };
          },
        },

        "check-deps": {
          handler: async (ctx: HookContext): Promise<HookOutput<CheckDepsResult>> => {
            const { configuredAgent } = ctx as CheckDepsHookContext;
            if (configuredAgent !== provider.type) return { result: {} };

            const missingBinaries: BinaryType[] = [];
            const result = await provider.preflight();
            if (result.success && result.needsDownload) {
              missingBinaries.push(provider.binaryType);
            }
            return { result: { missingBinaries } };
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
          handler: async (): Promise<HookOutput<AvailableAgentsResult>> => {
            try {
              const result = await provider.preflight();
              if (!result.success || result.needsDownload) return { result: {} };
              return {
                result: {
                  agent: {
                    agent: provider.type,
                    label: provider.displayName,
                    icon: provider.icon,
                  },
                },
              };
            } catch {
              return { result: {} };
            }
          },
        },
      },

      [GET_LAUNCH_OPTIONS_OPERATION_ID]: {
        "launch-options": {
          handler: async (ctx: HookContext): Promise<HookOutput<LaunchOptionsHookResult>> => {
            const { backend } = ctx as LaunchOptionsHookInput;
            // Only the module matching the requested backend contributes.
            if (backend !== provider.type || provider.getLaunchOptions === undefined) {
              return { result: {} };
            }
            try {
              const { permissionModes } = await provider.getLaunchOptions();
              return { result: { permissionModes } };
            } catch {
              // Best-effort: detection failure → form offers only the default.
              return { result: {} };
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
          handler: async (): Promise<HookOutput<RegisterAgentResult>> => {
            return {
              result: {
                agent: provider.type,
                label: provider.displayName,
                icon: provider.icon,
              },
            };
          },
        },

        "save-agent": {
          handler: async (ctx: HookContext) => {
            const { selectedAgent } = ctx as SaveAgentHookInput;
            if (selectedAgent !== provider.type) return;

            try {
              await deps.agentConfig.set(selectedAgent);
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
          // Streaming handler: yield progress frames; the setup operation emits them.
          handler: async function* (
            ctx: HookContext
          ): AsyncGenerator<SetupProgressPayload, void, void> {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];

            const agentType = hookCtx.selectedAgent ?? hookCtx.configuredAgent;
            if (agentType !== provider.type) return;

            if (!missingBinaries.includes(provider.binaryType)) {
              yield { id: "agent", status: "done" };
              return;
            }

            yield { id: "agent", status: "running", message: "Downloading..." };
            try {
              yield* streamProgress<SetupProgressPayload>(async (emit) => {
                let lastKey = "";
                await provider.downloadBinary((p) => {
                  const pct = p.totalBytes
                    ? Math.floor((p.bytesDownloaded / p.totalBytes) * 100)
                    : undefined;
                  // Throttle: only forward when the phase or integer % changes.
                  const key = `${p.phase}:${pct ?? "x"}`;
                  if (key === lastKey) return;
                  lastKey = key;
                  const message = p.phase === "downloading" ? "Downloading..." : "Extracting...";
                  emit({
                    id: "agent",
                    status: "running",
                    message,
                    ...(pct !== undefined && { progress: pct }),
                  });
                });
              });
              yield { id: "agent", status: "done" };
            } catch (error) {
              yield { id: "agent", status: "failed", error: getErrorMessage(error) };
              throw new SetupError(
                `Failed to download ${provider.binaryType}: ${getErrorMessage(error)}`,
                "BINARY_DOWNLOAD_FAILED"
              );
            }
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HookOutput<SetupHookResult>> => {
            ensureInitialized();

            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;

            const initialPrompt = agentPromptConfigFor(intent.payload.agent, provider.type);
            const isNewWorkspace = intent.payload.existingWorkspace === undefined;

            const result = await provider.startWorkspace(workspacePath, {
              ...(initialPrompt !== undefined && { initialPrompt }),
              isNewWorkspace,
            });

            return {
              result: { envVars: result.envVars, agentType: provider.type },
            };
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            const result = await stopAgentForWorkspace(workspacePath, "delete shutdown");
            if (result.error && !payload.force) {
              throw new Error(result.error);
            }
            return {
              result: result.error
                ? { serverName: provider.serverName, error: result.error }
                : { serverName: provider.serverName },
            };
          },
        },
      },

      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HookOutput<HibernateShutdownHookResult>> => {
            const { workspacePath } = ctx as HibernatePipelineHookInput;
            await stopAgentForWorkspace(workspacePath, "hibernate shutdown");
            return { result: {} };
          },
        },
      },

      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HookOutput<GetStatusHookResult>> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            return {
              result: {
                agentStatus: provider.getStatus(workspacePath as WorkspacePath),
              },
            };
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HookOutput<GetAgentSessionHookResult>> => {
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            return {
              result: {
                session: provider.getSession(workspacePath as WorkspacePath),
              },
            };
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<HookOutput<RestartAgentHookResult>> => {
            const { workspacePath } = ctx as RestartAgentHookInput;
            const result = await provider.restartWorkspace(workspacePath);
            if (result.success) {
              return { result: { port: result.port } };
            } else {
              throw new Error(result.error);
            }
          },
        },
      },

      [AGENT_LIFECYCLE_OPERATION_ID]: {
        lifecycle: {
          requires: { agent: provider.type },
          handler: async (ctx: HookContext): Promise<void> => {
            const { workspacePath, event } = ctx as AgentLifecycleHookInput;
            provider.applyTerminalLifecycle(workspacePath, event);
          },
        },
      },
    },
  };
}
