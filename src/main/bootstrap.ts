/**
 * Bootstrap - Application bootstrap using ApiRegistry pattern.
 *
 * This module provides the main bootstrap path that uses the ApiRegistry
 * pattern from planning/API_REGISTRY_REFACTOR.md.
 *
 * The bootstrap flow:
 * 1. initializeBootstrap() - Creates registry + lifecycle module
 * 2. startServices() - Called when setup completes, creates remaining modules
 */

import { ApiRegistry } from "./api/registry";
import { LifecycleModule, type LifecycleModuleDeps } from "./modules/lifecycle";
import { CoreModule, type CoreModuleDeps } from "./modules/core";
import type {
  IApiRegistry,
  IApiModule,
  WorkspaceSetMetadataPayload,
  WorkspaceRefPayload,
  UiSetModePayload,
  EmptyPayload,
} from "./api/registry-types";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { Logger } from "../services/logging";
import type { IpcLayer } from "../services/platform/ipc";
import { ApiIpcChannels, type WorkspacePath } from "../shared/ipc";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./operations/set-metadata";
import type { SetMetadataIntent } from "./operations/set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./operations/get-metadata";
import type { GetMetadataIntent, GetMetadataHookContext } from "./operations/get-metadata";
import {
  GetWorkspaceStatusOperation,
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
} from "./operations/get-workspace-status";
import type {
  GetWorkspaceStatusIntent,
  GetWorkspaceStatusHookContext,
} from "./operations/get-workspace-status";
import {
  GetAgentSessionOperation,
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "./operations/get-agent-session";
import type {
  GetAgentSessionIntent,
  GetAgentSessionHookContext,
} from "./operations/get-agent-session";
import {
  RestartAgentOperation,
  RESTART_AGENT_OPERATION_ID,
  INTENT_RESTART_AGENT,
} from "./operations/restart-agent";
import type { RestartAgentIntent, RestartAgentHookContext } from "./operations/restart-agent";
import { SetModeOperation, SET_MODE_OPERATION_ID, INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent, SetModeHookContext } from "./operations/set-mode";
import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./operations/get-active-workspace";
import type {
  GetActiveWorkspaceIntent,
  GetActiveWorkspaceHookContext,
} from "./operations/get-active-workspace";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { wireModules } from "./intents/infrastructure/wire";
import { resolveWorkspace, generateProjectId, extractWorkspaceName } from "./api/id-utils";
import type { IntentModule } from "./intents/infrastructure/module";
import type { HookContext } from "./intents/infrastructure/operation";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import { Path } from "../services/platform/path";

// =============================================================================
// Types
// =============================================================================

/**
 * Dependencies required to create and start the registry-based API.
 */
export interface BootstrapDeps {
  /** Logger for the registry */
  readonly logger: Logger;
  /** IPC layer for handler registration */
  readonly ipcLayer: IpcLayer;
  /** Lifecycle module dependencies */
  readonly lifecycleDeps: LifecycleModuleDeps;
  /** Core module dependencies (provided after setup completes) */
  readonly coreDepsFn: () => CoreModuleDeps;
  /** Global worktree provider for metadata operations (provided after setup completes) */
  readonly globalWorktreeProviderFn: () => GitWorktreeProvider;
}

/**
 * Result of bootstrap initialization.
 */
export interface BootstrapResult {
  /** The API registry */
  readonly registry: IApiRegistry;
  /** The typed API interface (throws if not all methods registered) */
  readonly getInterface: () => ICodeHydraApi;
  /** Dispose all modules and the registry */
  readonly dispose: () => Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Initialize the bootstrap with lifecycle module only.
 *
 * This is the first phase of the two-phase startup:
 * 1. initializeBootstrap() - Creates registry + lifecycle module
 * 2. startServices() - Called when setup completes, creates remaining modules
 *
 * @param deps Bootstrap dependencies
 * @returns Bootstrap result with registry and interface getter
 */
export function initializeBootstrap(deps: BootstrapDeps): BootstrapResult {
  // 1. Create registry FIRST (before any modules)
  const registry = new ApiRegistry({
    logger: deps.logger,
    ipcLayer: deps.ipcLayer,
  });

  // 2. Track modules for disposal (reverse order)
  const modules: IApiModule[] = [];

  // 3. Create LifecycleModule - must be ready before UI loads
  const lifecycleModule = new LifecycleModule(registry, deps.lifecycleDeps);
  modules.push(lifecycleModule);

  // 4. Services started flag
  let servicesStarted = false;

  // 5. The onSetupComplete callback triggers startServices
  // This is wired through deps.lifecycleDeps.onSetupComplete

  /**
   * Start remaining services after setup completes.
   * This creates CoreModule and wires the intent dispatcher.
   */
  function startServices(): void {
    if (servicesStarted) return;
    servicesStarted = true;

    const coreDeps = deps.coreDepsFn();

    // Create remaining modules
    const coreModule = new CoreModule(registry, coreDeps);
    modules.push(coreModule);

    // Wire shared intent dispatcher for all operations
    wireDispatcher(
      registry,
      deps.globalWorktreeProviderFn(),
      coreDeps.appState,
      coreDeps.viewManager
    );
  }

  /**
   * Get the typed API interface.
   * Throws if not all methods are registered.
   */
  function getInterface(): ICodeHydraApi {
    // If services haven't started, only lifecycle methods are available
    // This will throw with missing methods
    return registry.getInterface();
  }

  /**
   * Dispose all modules and the registry.
   * Modules are disposed in reverse order of creation.
   */
  async function dispose(): Promise<void> {
    // Dispose modules in reverse order
    for (let i = modules.length - 1; i >= 0; i--) {
      const module = modules[i];
      if (module) {
        module.dispose();
      }
    }
    modules.length = 0;

    // Dispose registry
    await registry.dispose();
  }

  // Return bootstrap result with start function attached
  const result: BootstrapResult & { startServices: () => void } = {
    registry,
    getInterface,
    dispose,
    startServices,
  };

  return result;
}

// =============================================================================
// Intent Dispatcher Wiring
// =============================================================================

/**
 * Wire all operations into the shared intent dispatcher and register
 * bridge handlers in the API registry.
 *
 * This is the single dispatcher for all intent-based operations
 * (metadata from Phase 1, plus Phase 2 operations).
 */
function wireDispatcher(
  registry: IApiRegistry,
  globalProvider: GitWorktreeProvider,
  appState: CoreModuleDeps["appState"],
  viewManager: CoreModuleDeps["viewManager"]
): void {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());

  // Metadata hook handler module
  const metadataModule: IntentModule = {
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const intent = ctx.intent as SetMetadataIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            await globalProvider.setMetadata(
              new Path(workspace.path),
              intent.payload.key,
              intent.payload.value
            );
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        get: {
          handler: async (ctx: GetMetadataHookContext) => {
            const intent = ctx.intent as GetMetadataIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const metadata = await globalProvider.getMetadata(new Path(workspace.path));
            ctx.metadata = metadata;
          },
        },
      },
    },
  };

  // Workspace status hook handler modules (each service contributes its piece)
  const gitStatusModule: IntentModule = {
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: GetWorkspaceStatusHookContext) => {
            const intent = ctx.intent as GetWorkspaceStatusIntent;
            const { projectPath, workspace } = await resolveWorkspace(intent.payload, appState);
            const provider = appState.getWorkspaceProvider(projectPath);
            ctx.isDirty = provider ? await provider.isDirty(new Path(workspace.path)) : false;
          },
        },
      },
    },
  };

  const agentStatusModule: IntentModule = {
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: GetWorkspaceStatusHookContext) => {
            const intent = ctx.intent as GetWorkspaceStatusIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const agentStatusManager = appState.getAgentStatusManager();
            if (agentStatusManager) {
              ctx.agentStatus = agentStatusManager.getStatus(workspace.path as WorkspacePath);
            }
          },
        },
      },
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: GetAgentSessionHookContext) => {
            const intent = ctx.intent as GetAgentSessionIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const agentStatusManager = appState.getAgentStatusManager();
            ctx.session = agentStatusManager?.getSession(workspace.path as WorkspacePath) ?? null;
          },
        },
      },
      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: RestartAgentHookContext) => {
            const intent = ctx.intent as RestartAgentIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const serverManager = appState.getServerManager();
            if (!serverManager) {
              throw new Error("Agent server manager not available");
            }
            const result = await serverManager.restartServer(workspace.path);
            if (result.success) {
              ctx.port = result.port;
              ctx.workspacePath = workspace.path;
            } else {
              throw new Error(result.error);
            }
          },
        },
      },
    },
  };

  // UI hook handler module (mode changes + active workspace queries)
  const uiHookModule: IntentModule = {
    hooks: {
      [SET_MODE_OPERATION_ID]: {
        set: {
          handler: async (ctx: SetModeHookContext) => {
            const intent = ctx.intent as SetModeIntent;
            const previousMode = viewManager.getMode();
            viewManager.setMode(intent.payload.mode);
            ctx.previousMode = previousMode;
          },
        },
      },
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (ctx: GetActiveWorkspaceHookContext) => {
            const activeWorkspacePath = viewManager.getActiveWorkspacePath();
            if (!activeWorkspacePath) {
              ctx.workspaceRef = null;
              return;
            }

            const project = appState.findProjectForWorkspace(activeWorkspacePath);
            if (!project) {
              ctx.workspaceRef = null;
              return;
            }

            const projectId = generateProjectId(project.path);
            const workspaceName = extractWorkspaceName(activeWorkspacePath);

            ctx.workspaceRef = {
              projectId,
              workspaceName,
              path: activeWorkspacePath,
            };
          },
        },
      },
    },
  };

  // Wire IpcEventBridge and hook handler modules
  const ipcEventBridge = createIpcEventBridge(registry);
  wireModules(
    [ipcEventBridge, metadataModule, gitStatusModule, agentStatusModule, uiHookModule],
    hookRegistry,
    dispatcher
  );

  // Register dispatcher bridge handlers in the API registry
  registry.register(
    "workspaces.setMetadata",
    async (payload: WorkspaceSetMetadataPayload) => {
      const intent: SetMetadataIntent = {
        type: INTENT_SET_METADATA,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          key: payload.key,
          value: payload.value,
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.WORKSPACE_SET_METADATA }
  );

  registry.register(
    "workspaces.getMetadata",
    async (payload: WorkspaceRefPayload) => {
      const intent: GetMetadataIntent = {
        type: INTENT_GET_METADATA,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get metadata dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_METADATA }
  );

  registry.register(
    "workspaces.getStatus",
    async (payload: WorkspaceRefPayload) => {
      const intent: GetWorkspaceStatusIntent = {
        type: INTENT_GET_WORKSPACE_STATUS,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get workspace status dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_STATUS }
  );

  registry.register(
    "workspaces.getAgentSession",
    async (payload: WorkspaceRefPayload) => {
      const intent: GetAgentSessionIntent = {
        type: INTENT_GET_AGENT_SESSION,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
        },
      };
      return dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION }
  );

  registry.register(
    "workspaces.restartAgentServer",
    async (payload: WorkspaceRefPayload) => {
      const intent: RestartAgentIntent = {
        type: INTENT_RESTART_AGENT,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (result === undefined) {
        throw new Error("Restart agent dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_RESTART_AGENT_SERVER }
  );

  registry.register(
    "ui.setMode",
    async (payload: UiSetModePayload) => {
      const intent: SetModeIntent = {
        type: INTENT_SET_MODE,
        payload: {
          mode: payload.mode,
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.UI_SET_MODE }
  );

  registry.register(
    "ui.getActiveWorkspace",
    async (payload: EmptyPayload) => {
      void payload;
      const intent: GetActiveWorkspaceIntent = {
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {} as Record<string, never>,
      };
      return dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE }
  );
}
