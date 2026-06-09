/**
 * WorkspaceAgentResolver - Resolves the per-workspace agent for workspace operations.
 *
 * On each workspace-scoped hook point, this module:
 *  1. Reads the per-workspace `agent` from worktree metadata (fallback: global default).
 *  2. For workspace:open: if the intent payload sets a non-default agent, writes it
 *     to metadata first so subsequent operations see the same resolution.
 *  3. Emits an `agent` capability so per-agent modules can gate via
 *     `requires: { agent: provider.type }`.
 */
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookHandler } from "../intents/lib/operation";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../boundaries/platform/config";
import type { Logger } from "../boundaries/platform/logging-types";
import type { AgentType } from "../shared/plugin-protocol";
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
import {
  AGENT_LIFECYCLE_OPERATION_ID,
  type AgentLifecycleHookInput,
} from "../intents/agent-lifecycle";

export const AGENT_METADATA_KEY = "agent";

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
  try {
    const metadata = await deps.gitWorktreeProvider.getMetadata(new Path(workspacePath));
    const fromMetadata = metadata[AGENT_METADATA_KEY];
    if (fromMetadata === "claude" || fromMetadata === "opencode") {
      return fromMetadata;
    }
  } catch (error) {
    deps.logger.debug("metadata read failed; using global default", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  let resolved: AgentType | null = null;
  return {
    provides: () => (resolved !== null ? { agent: resolved } : {}),
    handler: async (ctx: HookContext): Promise<void> => {
      resolved = null;
      const workspacePath = getWorkspacePath(ctx);
      if (workspacePath === undefined) return;
      resolved = await resolveAgent(workspacePath, deps);
    },
  };
}

export function createWorkspaceAgentResolverModule(deps: WorkspaceAgentResolverDeps): IntentModule {
  // workspace:open is special — the intent payload may carry a per-workspace
  // override that must be persisted before downstream hooks read it.
  let openResolved: AgentType | null = null;
  const openSetupHandler: HookHandler = {
    provides: () => (openResolved !== null ? { agent: openResolved } : {}),
    handler: async (ctx: HookContext): Promise<void> => {
      openResolved = null;
      const setupCtx = ctx as SetupHookInput;
      const intent = ctx.intent as OpenWorkspaceIntent;
      const { workspacePath } = setupCtx;
      if (!workspacePath) return;

      const defaultAgent = deps.agentConfig.get();
      const requested = intent.payload.agent;

      if (requested !== undefined && requested !== defaultAgent) {
        // Persist a non-default agent choice so future operations resolve to it.
        try {
          await deps.gitWorktreeProvider.setMetadata(
            new Path(workspacePath),
            AGENT_METADATA_KEY,
            requested
          );
        } catch (error) {
          deps.logger.warn("failed to persist workspace agent metadata", {
            workspacePath,
            requested,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      openResolved = await resolveAgent(workspacePath, deps);
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
      [AGENT_LIFECYCLE_OPERATION_ID]: {
        lifecycle: makeResolverHandler(
          deps,
          (ctx) => (ctx as AgentLifecycleHookInput).workspacePath
        ),
      },
    },
  };
}
