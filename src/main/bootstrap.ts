/**
 * Bootstrap - Application bootstrap using ApiRegistry pattern.
 *
 * This module provides the main bootstrap path that uses the ApiRegistry
 * pattern from planning/API_REGISTRY_REFACTOR.md.
 *
 * The bootstrap flow:
 * initializeBootstrap() - Creates registry, lifecycle handlers, all operations + modules,
 * wires a single consolidated set of hook modules, and registers API bridge handlers.
 */

import { ApiRegistry } from "./api/registry";
import { CoreModule, type CoreModuleDeps } from "./modules/core";
import type {
  IApiRegistry,
  IApiModule,
  ProjectOpenPayload,
  ProjectClosePayload,
  ProjectClonePayload,
  ProjectIdPayload,
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceSetMetadataPayload,
  WorkspacePathPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
  EmptyPayload,
} from "./api/registry-types";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { Logger } from "../services/logging";
import type { IpcLayer } from "../services/platform/ipc";
import { ApiIpcChannels, type WorkspacePath } from "../shared/ipc";
import type { HookRegistry } from "./intents/infrastructure/hook-registry";
import type { Dispatcher } from "./intents/infrastructure/dispatcher";
import { SetMetadataOperation, INTENT_SET_METADATA } from "./operations/set-metadata";
import type { SetMetadataIntent } from "./operations/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "./operations/get-metadata";
import type { GetMetadataIntent } from "./operations/get-metadata";
import {
  GetWorkspaceStatusOperation,
  INTENT_GET_WORKSPACE_STATUS,
} from "./operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "./operations/get-workspace-status";
import { GetAgentSessionOperation, INTENT_GET_AGENT_SESSION } from "./operations/get-agent-session";
import type { GetAgentSessionIntent } from "./operations/get-agent-session";
import { RestartAgentOperation, INTENT_RESTART_AGENT } from "./operations/restart-agent";
import type { RestartAgentIntent } from "./operations/restart-agent";
import { SetModeOperation, INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent } from "./operations/set-mode";
import {
  GetActiveWorkspaceOperation,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./operations/get-active-workspace";
import type { GetActiveWorkspaceIntent } from "./operations/get-active-workspace";
import { OpenWorkspaceOperation, INTENT_OPEN_WORKSPACE } from "./operations/open-workspace";
import type { OpenWorkspaceIntent } from "./operations/open-workspace";
import { DeleteWorkspaceOperation, INTENT_DELETE_WORKSPACE } from "./operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletionProgressCallback,
} from "./operations/delete-workspace";
import { OpenProjectOperation, INTENT_OPEN_PROJECT } from "./operations/open-project";
import type { OpenProjectIntent } from "./operations/open-project";
import { CloseProjectOperation, INTENT_CLOSE_PROJECT } from "./operations/close-project";
import type { CloseProjectIntent } from "./operations/close-project";
import { SwitchWorkspaceOperation, INTENT_SWITCH_WORKSPACE } from "./operations/switch-workspace";
import type { SwitchWorkspaceIntent } from "./operations/switch-workspace";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./operations/update-agent-status";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "./operations/update-available";
import {
  AppStartOperation,
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  EVENT_APP_STARTED,
} from "./operations/app-start";
import type { ShowUIHookResult } from "./operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "./operations/app-shutdown";
import type { AppShutdownIntent } from "./operations/app-shutdown";
import { SetupOperation, INTENT_SETUP } from "./operations/setup";
import type { IpcEventHandler } from "../services/platform/ipc";
import { ApiIpcChannels as SetupIpcChannels } from "../shared/ipc";
import { wireModules } from "./intents/infrastructure/wire";
import { extractWorkspaceName } from "../shared/api/id-utils";
import type { IntentModule } from "./intents/infrastructure/module";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import type { Workspace } from "../shared/api/types";
import { Path } from "../services/platform/path";
import { expandGitUrl } from "../services/project/url-utils";
import type { MountSignal } from "./modules/view-module";

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
  /** App interface for quit() */
  readonly app: { quit(): void };
  /** HookRegistry for wiring modules */
  readonly hookRegistry: HookRegistry;
  /** Dispatcher for intent dispatch */
  readonly dispatcher: Dispatcher;
  /** Lazy getter for ICodeHydraApi (set after initializeBootstrap returns) */
  readonly getApiFn: () => ICodeHydraApi;
  /** PluginServer instance (may be null if not needed) */
  readonly pluginServer: import("../services/plugin-server").PluginServer | null;
  /** Function to get UI webContents for IPC events */
  readonly getUIWebContentsFn: () => import("electron").WebContents | null;
  /** Deletion progress callback for emitting DeletionProgress to the renderer */
  readonly emitDeletionProgress: DeletionProgressCallback;
  /** AgentStatusManager for workspace switch scoring */
  readonly agentStatusManager: import("../agents").AgentStatusManager;
  /** Global worktree provider for fetchBases API handler */
  readonly globalWorktreeProvider: GitWorktreeProvider;
  /** Wrapper path for Claude Code wrapper script */
  readonly wrapperPath: string;
  /** Electron dialog for folder selection (optional) */
  readonly dialog?: import("./modules/core/index").MinimalDialog;
  /** Pre-created hook modules (from index.ts composition root) */
  readonly modules: IntentModule[];
  /** View mount signal (from createViewModule) */
  readonly mountSignal: MountSignal;
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
 * Initialize the bootstrap with all modules and operations.
 *
 * Creates registry, registers lifecycle handlers, wires all operations and hook
 * modules in a single consolidated wireModules call, then registers API bridge
 * handlers in the registry.
 *
 * @param deps Bootstrap dependencies
 * @returns Bootstrap result with registry and interface getter
 */
export function initializeBootstrap(deps: BootstrapDeps): BootstrapResult {
  const logger = deps.logger;

  // 1. Create registry FIRST (before any modules)
  const registry = new ApiRegistry({
    logger,
    ipcLayer: deps.ipcLayer,
  });

  // 2. Track modules for disposal (reverse order)
  const modules: IApiModule[] = [];

  // 3. Get dispatcher for operation registration
  // The dispatcher is created in index.ts bootstrap() before initializeBootstrap() is called
  const { hookRegistry, dispatcher } = deps;

  // 4. Register app:shutdown early so it's available during setup
  // (e.g., quit from setup screen dispatches app:shutdown)
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  // 5. Quit hook module: calls app.quit() after all stop hooks complete
  const quitModule: IntentModule = {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        quit: {
          handler: async () => {
            deps.app.quit();
          },
        },
      },
    },
  };

  // 7. Register lifecycle.quit IPC handler - dispatches app:shutdown
  registry.register(
    "lifecycle.quit",
    async () => {
      logger.debug("Quit requested");
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);
    },
    { ipc: ApiIpcChannels.LIFECYCLE_QUIT }
  );

  // 8. IPC event bridge: receives domain events during setup
  // (e.g., setup:error fires before the start hook completes).
  // Lifecycle deps (getApi, pluginServer) are late-bound via closures/getters
  // since the bridge's start/stop hooks only run after services are created.
  const ipcEventBridge = createIpcEventBridge({
    apiRegistry: registry,
    getApi: () => deps.getApiFn(),
    getUIWebContents: () => deps.getUIWebContentsFn(),
    pluginServer: deps.pluginServer,
    logger,
  });

  // 10. RetryModule: "show-ui" hook on app-start -- returns waitForRetry
  // waitForRetry returns a promise that resolves when the renderer sends lifecycle:retry IPC
  const retryModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "show-ui": {
          handler: async (): Promise<ShowUIHookResult> => {
            return {
              waitForRetry: () =>
                new Promise<void>((resolve) => {
                  const handleRetry: IpcEventHandler = () => {
                    deps.ipcLayer.removeListener(SetupIpcChannels.LIFECYCLE_RETRY, handleRetry);
                    resolve();
                  };
                  deps.ipcLayer.on(SetupIpcChannels.LIFECYCLE_RETRY, handleRetry);
                }),
            };
          },
        },
      },
    },
  };

  // 11. Register AppStartOperation and SetupOperation immediately (before UI loads)
  // app:start is dispatched first in index.ts, so both must be registered early
  // Hook modules will be wired when setup dependencies are available
  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
  dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());

  // Agent status scorer for SwitchWorkspaceOperation
  const agentStatusScorer = (workspacePath: WorkspacePath): number => {
    const status = deps.agentStatusManager.getStatus(workspacePath);
    if (status === undefined || status.status === "none") return 2;
    if (status.status === "busy") return 1;
    return 0;
  };

  // Register remaining operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
  // Note: SetModeOperation is registered early in initializeBootstrap()
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
  const deleteOp = new DeleteWorkspaceOperation(deps.emitDeletionProgress);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteOp);
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());
  dispatcher.registerOperation(
    INTENT_SWITCH_WORKSPACE,
    new SwitchWorkspaceOperation(extractWorkspaceName, agentStatusScorer)
  );
  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());
  // Note: AppStartOperation and AppShutdownOperation are registered early in initializeBootstrap()

  const inProgressOpens = new Set<string>();

  // Deferred for the app:started event: resolved after all initial project:open dispatches
  // complete. lifecycle.ready awaits this so the renderer receives project:opened events
  // (via Electron IPC FIFO ordering) before setLoaded() fires.
  let projectsLoadedResolve: (() => void) | null = null;
  const projectsLoadedPromise = new Promise<void>((resolve) => {
    projectsLoadedResolve = resolve;
  });
  // LoadedEventModule: subscribes to app:started event to resolve the deferred so
  // lifecycle.ready can return to the renderer after all initial project:open dispatches complete.
  const loadedEventModule: IntentModule = {
    events: {
      [EVENT_APP_STARTED]: () => {
        if (projectsLoadedResolve) {
          projectsLoadedResolve();
          projectsLoadedResolve = null;
        }
      },
    },
  };

  // 14. Wire all hook modules in a single consolidated call
  // Pre-created modules from index.ts (idempotency, view, codeServer, agent, etc.)
  // are combined with inline modules that need bootstrap-internal state.
  wireModules(
    [...deps.modules, quitModule, ipcEventBridge, retryModule, loadedEventModule],
    hookRegistry,
    dispatcher
  );

  // ---------------------------------------------------------------------------
  // Register dispatcher bridge handlers in the API registry
  // ---------------------------------------------------------------------------

  registry.register(
    "workspaces.create",
    async (payload: WorkspaceCreatePayload) => {
      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          ...(payload.projectId !== undefined && { projectId: payload.projectId }),
          workspaceName: payload.name,
          base: payload.base,
          ...(payload.initialPrompt !== undefined && { initialPrompt: payload.initialPrompt }),
          ...(payload.keepInBackground !== undefined && {
            keepInBackground: payload.keepInBackground,
          }),
          ...(payload.callerWorkspacePath !== undefined && {
            callerWorkspacePath: payload.callerWorkspacePath,
          }),
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Create workspace dispatch returned no result");
      }
      return result as Workspace;
    },
    { ipc: ApiIpcChannels.WORKSPACE_CREATE }
  );

  registry.register(
    "workspaces.remove",
    async (payload: WorkspaceRemovePayload) => {
      // If pipeline is waiting for user choice, signal it instead of dispatching new intent.
      if (deleteOp.hasPendingRetry(payload.workspacePath)) {
        if (payload.force) {
          deleteOp.signalDismiss(payload.workspacePath);
          // Fall through to dispatch force intent after pipeline exits
        } else {
          deleteOp.signalRetry(payload.workspacePath);
          return { started: true };
        }
      }

      const intent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: payload.workspacePath,
          keepBranch: payload.keepBranch ?? true,
          force: payload.force ?? false,
          removeWorktree: true,
          ...(payload.skipSwitch !== undefined && { skipSwitch: payload.skipSwitch }),
        },
      };

      // Dispatch and check interceptor result (idempotency check happens inside pipeline)
      const handle = dispatcher.dispatch(intent);
      if (!(await handle.accepted)) {
        return { started: false };
      }
      // Fire-and-forget the operation result (deletion runs asynchronously)
      void handle;
      return { started: true };
    },
    { ipc: ApiIpcChannels.WORKSPACE_REMOVE }
  );

  registry.register(
    "workspaces.setMetadata",
    async (payload: WorkspaceSetMetadataPayload) => {
      const intent: SetMetadataIntent = {
        type: INTENT_SET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
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
    async (payload: WorkspacePathPayload) => {
      const intent: GetMetadataIntent = {
        type: INTENT_GET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
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
    async (payload: WorkspacePathPayload) => {
      const intent: GetWorkspaceStatusIntent = {
        type: INTENT_GET_WORKSPACE_STATUS,
        payload: {
          workspacePath: payload.workspacePath,
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
    async (payload: WorkspacePathPayload) => {
      const intent: GetAgentSessionIntent = {
        type: INTENT_GET_AGENT_SESSION,
        payload: {
          workspacePath: payload.workspacePath,
        },
      };
      return dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION }
  );

  registry.register(
    "workspaces.restartAgentServer",
    async (payload: WorkspacePathPayload) => {
      const intent: RestartAgentIntent = {
        type: INTENT_RESTART_AGENT,
        payload: {
          workspacePath: payload.workspacePath,
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

  registry.register(
    "ui.switchWorkspace",
    async (payload: UiSwitchWorkspacePayload) => {
      const intent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: payload.workspacePath,
          ...(payload.focus !== undefined && { focus: payload.focus }),
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.UI_SWITCH_WORKSPACE }
  );

  // ---------------------------------------------------------------------------
  // Project API bridge handlers
  // ---------------------------------------------------------------------------

  registry.register(
    "projects.open",
    async (payload: ProjectOpenPayload) => {
      const key = new Path(payload.path).toString();
      if (inProgressOpens.has(key)) {
        throw new Error("Project open already in progress");
      }
      inProgressOpens.add(key);
      try {
        const intent: OpenProjectIntent = {
          type: INTENT_OPEN_PROJECT,
          payload: { path: new Path(payload.path) },
        };
        const result = await dispatcher.dispatch(intent);
        if (!result) {
          throw new Error("Open project dispatch returned no result");
        }
        return result;
      } finally {
        inProgressOpens.delete(key);
      }
    },
    { ipc: ApiIpcChannels.PROJECT_OPEN }
  );

  registry.register(
    "projects.clone",
    async (payload: ProjectClonePayload) => {
      const key = expandGitUrl(payload.url);
      if (inProgressOpens.has(key)) {
        throw new Error("Clone already in progress");
      }
      inProgressOpens.add(key);
      try {
        const intent: OpenProjectIntent = {
          type: INTENT_OPEN_PROJECT,
          payload: { git: payload.url },
        };
        const result = await dispatcher.dispatch(intent);
        if (!result) {
          throw new Error("Clone project dispatch returned no result");
        }
        return result;
      } finally {
        inProgressOpens.delete(key);
      }
    },
    { ipc: ApiIpcChannels.PROJECT_CLONE }
  );

  registry.register(
    "projects.close",
    async (payload: ProjectClosePayload) => {
      const intent: CloseProjectIntent = {
        type: INTENT_CLOSE_PROJECT,
        payload: {
          projectId: payload.projectId,
          ...(payload.removeLocalRepo !== undefined && {
            removeLocalRepo: payload.removeLocalRepo,
          }),
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.PROJECT_CLOSE }
  );

  registry.register(
    "projects.fetchBases",
    async (payload: ProjectIdPayload) => {
      // Dispatch workspace:open with incomplete payload (missing workspaceName/base)
      // This triggers the resolve-project + fetch-bases path
      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: payload.projectId,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Fetch bases dispatch returned no result");
      }
      const basesResult = result as {
        bases: readonly { name: string; isRemote: boolean }[];
        defaultBaseBranch?: string;
        projectPath: string;
      };

      // Fire-and-forget background update (same as old CoreModule pattern)
      void (async () => {
        try {
          const projectRoot = new Path(basesResult.projectPath);
          await deps.globalWorktreeProvider.updateBases(projectRoot);
          const updatedBases = await deps.globalWorktreeProvider.listBases(projectRoot);
          registry.emit("project:bases-updated", {
            projectId: payload.projectId,
            bases: updatedBases,
          });
        } catch (error) {
          logger.error(
            "Failed to fetch bases for project",
            { projectId: payload.projectId },
            error instanceof Error ? error : undefined
          );
        }
      })();

      return { bases: basesResult.bases };
    },
    { ipc: ApiIpcChannels.PROJECT_FETCH_BASES }
  );

  // ---------------------------------------------------------------------------
  // Lifecycle: ready signal (renderer calls after subscribing to domain events)
  // ---------------------------------------------------------------------------

  registry.register(
    "lifecycle.ready",
    async () => {
      // Only block when mount is actively waiting (mountSignal.resolve is set).
      // When called outside the mount flow (e.g., tests), skip the await.
      if (deps.mountSignal.resolve) {
        // Resolve the mount promise so app:start activate completes
        // and project:open dispatches can fire (renderer is already subscribed).
        deps.mountSignal.resolve();
        deps.mountSignal.resolve = null;
        // Wait for initial project:open dispatches to complete.
        // This ensures renderer stores are populated before setLoaded() fires.
        await projectsLoadedPromise;
      }
    },
    { ipc: ApiIpcChannels.LIFECYCLE_READY }
  );

  const coreDeps: CoreModuleDeps = {
    codeServerPort: 0, // Updated by CodeServerLifecycleModule
    wrapperPath: deps.wrapperPath,
    ...(deps.dialog ? { dialog: deps.dialog } : {}),
    ...(deps.pluginServer ? { pluginServer: deps.pluginServer } : {}),
  };
  const coreModule = new CoreModule(registry, coreDeps);
  modules.push(coreModule);

  /**
   * Get the typed API interface.
   * Throws if not all methods are registered.
   */
  function getInterface(): ICodeHydraApi {
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

  return {
    registry,
    getInterface,
    dispose,
  };
}
