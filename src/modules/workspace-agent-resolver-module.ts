/**
 * WorkspaceAgentResolver - Resolves the per-workspace agent for workspace operations.
 *
 * On each workspace-scoped hook point, this module:
 *  1. Reads the per-workspace `agent` from worktree metadata (fallback: global default).
 *  2. For workspace:open: records the workspace's agent in metadata unless it is
 *     already there — the one the intent payload asks for, else the global default.
 *     Recording the default too pins the workspace: changing the default later
 *     never switches the agent of a workspace that already exists.
 *  3. Emits an `agent` capability so per-agent modules can gate via
 *     `requires: { agent: provider.type }`.
 */
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookHandler, HookOutput } from "../intents/lib/operation";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../boundaries/platform/config";
import type { Logger } from "../boundaries/platform/logging-types";
import type { AgentType } from "../shared/api-protocol";
import { Path } from "../utils/path/path";

import {
  OPEN_WORKSPACE_OPERATION_ID,
  type OpenWorkspaceIntent,
  type SetupHookInput,
} from "../intents/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeletePipelineHookInput,
} from "../intents/delete-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type HibernatePipelineHookInput,
} from "../intents/hibernate-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  type GetStatusHookInput,
} from "../intents/get-workspace-status";
import {
  GET_AGENT_SESSION_OPERATION_ID,
  type GetAgentSessionHookInput,
} from "../intents/get-agent-session";
import { RESTART_AGENT_OPERATION_ID, type RestartAgentHookInput } from "../intents/restart-agent";
import { SEND_AGENT_MESSAGE_OPERATION_ID, type SendHookInput } from "../intents/send-agent-message";
import {
  AGENT_LIFECYCLE_OPERATION_ID,
  type AgentLifecycleHookInput,
} from "../intents/agent-lifecycle";
import {
  VSCODE_MODAL_CHANGED_OPERATION_ID,
  type ModalHookInput,
} from "../intents/vscode-modal-changed";

const AGENT_METADATA_KEY = "agent";

interface WorkspaceAgentResolverDeps {
  readonly gitWorktreeProvider: GitWorktreeProvider;
  /** Accessor for the user's global agent selection (registered in the composition root). */
  readonly agentConfig: PersistedAccessor<ConfigAgentType>;
  readonly logger: Logger;
}

/**
 * Lookup agent for a workspace: metadata first, then global default.
 * Returns null only when both metadata and config are unset.
 */
async function resolveAgent(
  workspacePath: string,
  deps: WorkspaceAgentResolverDeps
): Promise<AgentType | null> {
  return (await recordedAgent(workspacePath, deps)) ?? defaultAgent(deps);
}

/** The agent recorded in the workspace's metadata, if any. */
async function recordedAgent(
  workspacePath: string,
  deps: WorkspaceAgentResolverDeps
): Promise<AgentType | null> {
  try {
    const metadata = await deps.gitWorktreeProvider.getMetadata(new Path(workspacePath));
    const fromMetadata = metadata[AGENT_METADATA_KEY];
    if (fromMetadata === "claude" || fromMetadata === "opencode") {
      return fromMetadata;
    }
  } catch (error) {
    deps.logger
      .scoped({ path: workspacePath })
      .debug("metadata read failed; using global default", {
        error: error instanceof Error ? error.message : String(error),
      });
  }
  return null;
}

/** The user's global agent selection, if one is made. */
function defaultAgent(deps: WorkspaceAgentResolverDeps): AgentType | null {
  const fromConfig = deps.agentConfig.get();
  if (fromConfig === "claude" || fromConfig === "opencode") {
    return fromConfig;
  }
  return null;
}

/**
 * Build a handler that resolves the workspace agent and exposes it as the
 * `agent` capability. `getWorkspacePath` adapts the hook context per operation.
 */
function makeResolverHandler(
  deps: WorkspaceAgentResolverDeps,
  getWorkspacePath: (ctx: HookContext) => string | undefined
): HookHandler {
  return {
    handler: async (ctx: HookContext): Promise<HookOutput> => {
      const workspacePath = getWorkspacePath(ctx);
      if (workspacePath === undefined) return {};
      const resolved = await resolveAgent(workspacePath, deps);
      // Omit the capability entirely when unresolved (null) — a present-but-null
      // `agent` would differ from "absent" for key-presence checks.
      return resolved !== null ? { provides: { agent: resolved } } : {};
    },
  };
}

export function createWorkspaceAgentResolverModule(deps: WorkspaceAgentResolverDeps): IntentModule {
  // workspace:open is special — the intent payload may carry a per-workspace
  // override that must be persisted before downstream hooks read it.
  const openSetupHandler: HookHandler = {
    handler: async (ctx: HookContext): Promise<HookOutput> => {
      const setupCtx = ctx as SetupHookInput;
      const intent = ctx.intent as OpenWorkspaceIntent;
      const { workspacePath } = setupCtx;
      if (!workspacePath) return {};

      // Only the typed arms ("claude"/"opencode") pin a backend; "default" and
      // absent defer to metadata/config.
      const requestedType = intent.payload.agent?.type;
      const requested =
        requestedType === "claude" || requestedType === "opencode" ? requestedType : null;
      const recorded = await recordedAgent(workspacePath, deps);
      const agent = requested ?? recorded ?? defaultAgent(deps);

      if (agent !== null && agent !== recorded) {
        // Persist the choice so future operations resolve to it, whatever the
        // default becomes. The workspace's finalize re-reads its metadata, so the
        // workspace snapshot picks this up without a metadata-changed event.
        try {
          await deps.gitWorktreeProvider.setMetadata(
            new Path(workspacePath),
            AGENT_METADATA_KEY,
            agent
          );
        } catch (error) {
          deps.logger
            .scoped({ path: workspacePath })
            .warn("failed to persist workspace agent metadata", {
              agent,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }

      return agent !== null ? { provides: { agent } } : {};
    },
  };

  return {
    name: "workspace-agent-resolver",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: openSetupHandler,
      },
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: makeResolverHandler(
          deps,
          (ctx) => (ctx as DeletePipelineHookInput).workspacePath
        ),
      },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: makeResolverHandler(
          deps,
          (ctx) => (ctx as HibernatePipelineHookInput).workspacePath
        ),
      },
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: makeResolverHandler(deps, (ctx) => (ctx as GetStatusHookInput).workspacePath),
      },
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: makeResolverHandler(deps, (ctx) => (ctx as GetAgentSessionHookInput).workspacePath),
      },
      [RESTART_AGENT_OPERATION_ID]: {
        restart: makeResolverHandler(deps, (ctx) => (ctx as RestartAgentHookInput).workspacePath),
      },
      [SEND_AGENT_MESSAGE_OPERATION_ID]: {
        send: makeResolverHandler(deps, (ctx) => (ctx as SendHookInput).workspacePath),
      },
      [AGENT_LIFECYCLE_OPERATION_ID]: {
        lifecycle: makeResolverHandler(
          deps,
          (ctx) => (ctx as AgentLifecycleHookInput).workspacePath
        ),
      },
      [VSCODE_MODAL_CHANGED_OPERATION_ID]: {
        modal: makeResolverHandler(deps, (ctx) => (ctx as ModalHookInput).workspacePath),
      },
    },
  };
}
