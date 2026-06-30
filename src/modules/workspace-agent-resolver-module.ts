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
import type { HookContext, HookHandler, HookOutput } from "../intents/lib/operation";
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

      const defaultAgent = deps.agentConfig.get();
      // Only the typed arms ("claude"/"opencode") pin a backend; "default" and
      // absent defer to metadata/config.
      const requestedType = intent.payload.agent?.type;
      const requested =
        requestedType === "claude" || requestedType === "opencode" ? requestedType : undefined;

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

      const openResolved = await resolveAgent(workspacePath, deps);
      return openResolved !== null ? { provides: { agent: openResolved } } : {};
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
