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
import { ANY_VALUE, type HookOutput } from "../../intents/lib/operation";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { BinaryType } from "../../utils/binary-resolution/types";
import type { AgentType, WorkspaceRef } from "../../intents/contract";
import { Path } from "../../utils/path/path";
import { streamDownloadProgress } from "../../utils/binary-download/setup-progress";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../../boundaries/platform/config";

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type {
  CheckDepsResult,
  ConfigureResult,
  RegisterAgentResult,
} from "../../intents/app-start";
import type { SetupProgressPayload } from "../../intents/setup";
import type { SetupHookResult } from "../../intents/open-workspace";
import type { ShutdownHookResult } from "../../intents/delete-workspace";
import type { HibernateShutdownHookResult } from "../../intents/hibernate-workspace";
import { HIBERNATE_WORKSPACE_OPERATION_ID } from "../../intents/hibernate-workspace";
import type { GetStatusHookResult } from "../../intents/get-workspace-status";
import type { GetAgentSessionHookResult } from "../../intents/get-agent-session";
import type { RestartAgentHookResult } from "../../intents/restart-agent";
import {
  SEND_AGENT_MESSAGE_OPERATION_ID,
  type SendHookResult,
} from "../../intents/send-agent-message";
import type { UpdateAgentStatusIntent } from "../../intents/update-agent-status";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { APP_READY_OPERATION_ID, type AvailableAgentsResult } from "../../intents/app-ready";
import {
  GET_LAUNCH_OPTIONS_OPERATION_ID,
  type LaunchOptionsHookResult,
} from "../../intents/agent-launch-options";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import { OPEN_WORKSPACE_OPERATION_ID } from "../../intents/open-workspace";
import {
  CAPABILITY_AGENT_STOPPED,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../../intents/delete-workspace";
import { GET_WORKSPACE_STATUS_OPERATION_ID } from "../../intents/get-workspace-status";
import { GET_AGENT_SESSION_OPERATION_ID } from "../../intents/get-agent-session";
import { RESTART_AGENT_OPERATION_ID } from "../../intents/restart-agent";
import { AGENT_LIFECYCLE_OPERATION_ID } from "../../intents/agent-lifecycle";
import { VSCODE_MODAL_CHANGED_OPERATION_ID } from "../../intents/vscode-modal-changed";
import { INTENT_UPDATE_AGENT_STATUS } from "../../intents/update-agent-status";
import { SetupError, getErrorMessage } from "../../shared/errors/service-errors";
import type { AgentSpec } from "../../shared/api/types";
import { agentSpecSchema } from "../../intents/contract";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import { AgentUnreachableError, type AgentPromptConfig, type McpConfig } from "./types";
import { CLI_CONNECTION_CAPABILITY } from "../cli-module";
import { MODAL_RECORDED_CAPABILITY } from "../terminal-focus-module";
import type { AgentModuleProvider } from "./agent-module-provider";
import { defineHooks } from "../../intents/declarations";

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
  /**
   * How agents should launch CodeHydra's MCP server, or null when they cannot.
   *
   * Resolved by the composition root, which is the only place that knows all
   * four pieces — the interpreter, the CLI bundle, the API server port and the
   * token. Read at app:start rather than injected as a value because the port
   * and token only exist once the API server has bound.
   */
  readonly resolveMcpConfig: () => McpConfig | null;
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
 * Metadata key holding a new workspace's AgentSpec (JSON) until its agent has
 * taken the prompt over. The prompt is otherwise handed to the agent in memory,
 * so a restart before the agent starts would lose it; the reopen that follows
 * reads it back from here. Internal: not rendered, not documented.
 */
const PENDING_PROMPT_METADATA_KEY = "agent.pending-prompt";

/** The AgentSpec a reopened workspace still owes its agent, if any. */
function pendingAgentSpec(metadata: Readonly<Record<string, string>>): AgentSpec | undefined {
  const value = metadata[PENDING_PROMPT_METADATA_KEY];
  if (value === undefined) return undefined;
  try {
    const parsed = agentSpecSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
  let capturedMcpConfig: McpConfig | null = null;

  /** Whether the provider has been initialized (lazy on first workspace:open). */
  let initialized = false;

  /** Cleanup function for onStatusChange subscription. */
  let statusChangeCleanup: (() => void) | null = null;

  /** Initialize the provider on demand. Idempotent. */
  function ensureInitialized(): void {
    if (initialized) return;
    provider.initialize(capturedMcpConfig);
    statusChangeCleanup = provider.onStatusChange((workspaceRef, status) => {
      void deps.dispatcher.dispatch<UpdateAgentStatusIntent>(
        {
          type: INTENT_UPDATE_AGENT_STATUS,
          payload: { workspaceRef, status },
        },
        { origin: "agent-hook" }
      );
    });
    initialized = true;
  }

  /**
   * Shared agent-server teardown used by delete + hibernate.
   * Returns a structured outcome and never throws. Callers decide whether
   * to propagate the error (delete in non-force mode does; hibernate doesn't).
   */
  async function stopAgentForWorkspace(
    workspaceRef: WorkspaceRef,
    logTag: string
  ): Promise<{ error?: string }> {
    try {
      const stopResult = await provider.stopWorkspace(workspaceRef);
      provider.clearWorkspaceTracking(workspaceRef);
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

  /**
   * Write (or, with null, clear) the pending prompt. Best-effort: a failure
   * only loses the restart safety net, never the workspace.
   */
  async function setPendingPrompt(workspaceRef: WorkspaceRef, value: string | null) {
    try {
      await deps.dispatcher.dispatch<SetMetadataIntent>({
        type: INTENT_SET_METADATA,
        payload: { workspaceRef, key: PENDING_PROMPT_METADATA_KEY, value },
      });
    } catch (error) {
      logger.scoped({ workspace: workspaceRef }).warn("Failed to update pending initial prompt", {
        error: getErrorMessage(error),
      });
    }
  }

  // =========================================================================
  // Build the IntentModule
  // =========================================================================

  return {
    name: `${provider.type}-agent`,
    hooks: defineHooks({
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
          handler: async (ctx) => {
            const { selectedAgent } = ctx;
            if (selectedAgent !== provider.type) return;

            try {
              await deps.agentConfig.set(selectedAgent);
            } catch (error) {
              throw new SetupError(
                `Failed to save agent selection: ${getErrorMessage(error)}`,
                "CONFIG_SAVE_FAILED"
              );
            }
          },
        },

        // Runs after agent selection, so `configuredAgent` is the agent the user just
        // picked (or the one already in config.json) — never null.
        "check-deps": {
          handler: async (ctx): Promise<HookOutput<CheckDepsResult>> => {
            const { configuredAgent } = ctx;
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
          // The MCP config carries the API server port AND the CLI's token, so it
          // cannot be resolved until the API server has bound and cli-module
          // has minted and published one. Requiring only `apiPort` would let
          // this run alongside cli-module and read a token that does not exist
          // yet, writing an MCP config with an empty command and no credentials
          // — an agent with no CodeHydra tools at all.
          requires: { apiPort: ANY_VALUE, [CLI_CONNECTION_CAPABILITY]: ANY_VALUE },
          handler: async (): Promise<void> => {
            capturedMcpConfig = deps.resolveMcpConfig();
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
          handler: async (ctx): Promise<HookOutput<LaunchOptionsHookResult>> => {
            const { backend } = ctx;
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
        binary: {
          // Streaming handler: yield progress frames; the setup operation emits them.
          handler: async function* (ctx): AsyncGenerator<SetupProgressPayload, void, void> {
            const missingBinaries = ctx.missingBinaries ?? [];

            if (ctx.configuredAgent !== provider.type) return;

            if (!missingBinaries.includes(provider.binaryType)) {
              yield { id: "agent", status: "done" };
              return;
            }

            try {
              yield* streamDownloadProgress("agent", (onProgress) =>
                provider.downloadBinary(onProgress)
              );
            } catch (error) {
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
          handler: async (ctx): Promise<HookOutput<SetupHookResult>> => {
            ensureInitialized();

            const { intent } = ctx;
            const { workspaceRef, workspacePath, fresh } = ctx;

            // A reopened workspace whose agent never took its prompt over (the app
            // quit first) gets it again, and starts as fresh as a new one.
            const existingMetadata = intent.payload.existingWorkspace?.metadata ?? {};
            const hasPending =
              !fresh && existingMetadata[PENDING_PROMPT_METADATA_KEY] !== undefined;
            const spec = fresh ? intent.payload.agent : pendingAgentSpec(existingMetadata);
            const initialPrompt = agentPromptConfigFor(spec, provider.type);

            if (fresh && initialPrompt !== undefined) {
              await setPendingPrompt(workspaceRef, JSON.stringify(spec));
            } else if (hasPending && initialPrompt === undefined) {
              // Unreadable, or nothing this agent can use: drop it rather than keep it forever.
              await setPendingPrompt(workspaceRef, null);
            }

            const result = await provider.startWorkspace(workspaceRef, new Path(workspacePath), {
              ...(initialPrompt !== undefined && {
                initialPrompt,
                onInitialPromptDelivered: () => void setPendingPrompt(workspaceRef, null),
              }),
              isNewWorkspace: fresh || initialPrompt !== undefined,
              env: ctx.workspaceEnv,
            });

            return {
              result: { envVars: result.envVars, agentType: provider.type },
            };
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        // Stopping the agent cuts the connection the api-server's terminal close
        // travels over, so it waits for that close to finish.
        shutdown: {
          requires: { agent: provider.type, [CAPABILITY_AGENT_STOPPED]: ANY_VALUE },
          handler: async (ctx): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspaceRef } = ctx;
            const { payload } = ctx.intent;
            const result = await stopAgentForWorkspace(workspaceRef, "delete shutdown");
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
          handler: async (ctx): Promise<HookOutput<HibernateShutdownHookResult>> => {
            const { workspaceRef } = ctx;
            await stopAgentForWorkspace(workspaceRef, "hibernate shutdown");
            return { result: {} };
          },
        },
      },

      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          requires: { agent: provider.type },
          handler: async (ctx): Promise<HookOutput<GetStatusHookResult>> => {
            const { workspaceRef } = ctx;
            return {
              result: {
                agentStatus: provider.getStatus(workspaceRef),
              },
            };
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          requires: { agent: provider.type },
          handler: async (ctx): Promise<HookOutput<GetAgentSessionHookResult>> => {
            const { workspaceRef } = ctx;
            return {
              result: {
                session: provider.getSession(workspaceRef),
              },
            };
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          requires: { agent: provider.type },
          handler: async (ctx): Promise<HookOutput<RestartAgentHookResult>> => {
            const { workspaceRef } = ctx;
            const result = await provider.restartWorkspace(workspaceRef);
            if (result.success) {
              return { result: { port: result.port } };
            } else {
              throw new Error(result.error);
            }
          },
        },
      },

      [SEND_AGENT_MESSAGE_OPERATION_ID]: {
        send: {
          requires: { agent: provider.type },
          handler: async (ctx): Promise<HookOutput<SendHookResult>> => {
            const { workspaceRef, waitMs } = ctx;
            const { text, from } = ctx.intent.payload;
            try {
              await provider.sendMessage(workspaceRef, { text, from }, { waitMs });
            } catch (error) {
              // No agent to take it is the target's state, not a fault.
              if (error instanceof AgentUnreachableError) {
                return { result: { sent: false, reason: error.message } };
              }
              throw error;
            }
            return { result: { sent: true } };
          },
        },
      },

      [AGENT_LIFECYCLE_OPERATION_ID]: {
        lifecycle: {
          requires: { agent: provider.type },
          handler: async (ctx): Promise<void> => {
            const { workspaceRef, event } = ctx;
            provider.applyTerminalLifecycle(workspaceRef, event);
          },
        },
      },

      [VSCODE_MODAL_CHANGED_OPERATION_ID]: {
        // After terminal-focus has recorded the modal, so the status this
        // re-reports is never acted on against a stale modal state.
        modal: {
          requires: { agent: provider.type, [MODAL_RECORDED_CAPABILITY]: ANY_VALUE },
          handler: async (ctx): Promise<void> => {
            const { workspaceRef, open } = ctx;
            provider.setModalOpen(workspaceRef, open);
          },
        },
      },
    }),
  };
}
