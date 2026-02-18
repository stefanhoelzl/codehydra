/**
 * Bootstrap - Application bootstrap using ApiRegistry pattern.
 *
 * This module provides the main bootstrap path that uses the ApiRegistry
 * pattern from planning/API_REGISTRY_REFACTOR.md.
 *
 * The bootstrap flow:
 * 1. initializeBootstrap() - Creates registry + lifecycle handlers + early operations
 * 2. startServices() - Called when setup completes, creates remaining modules
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
  WorkspaceRefPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
  EmptyPayload,
} from "./api/registry-types";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { Logger } from "../services/logging";
import type { IpcLayer } from "../services/platform/ipc";
import { ApiIpcChannels, type WorkspacePath, type SetupErrorPayload } from "../shared/ipc";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import { SetMetadataOperation, INTENT_SET_METADATA } from "./operations/set-metadata";
import type { SetMetadataIntent } from "./operations/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "./operations/get-metadata";
import type { GetMetadataIntent } from "./operations/get-metadata";
import {
  GetWorkspaceStatusOperation,
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
} from "./operations/get-workspace-status";
import type {
  GetWorkspaceStatusIntent,
  GetStatusHookResult,
  GetStatusHookInput,
} from "./operations/get-workspace-status";
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
import {
  OpenWorkspaceOperation,
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
} from "./operations/open-workspace";
import type { OpenWorkspaceIntent, WorkspaceCreatedEvent } from "./operations/open-workspace";
import {
  DeleteWorkspaceOperation,
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_DELETED,
} from "./operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  WorkspaceDeletedEvent,
  ShutdownHookResult,
  ReleaseHookResult,
  DetectHookResult,
  FlushHookResult,
  FlushHookInput,
} from "./operations/delete-workspace";
import {
  OpenProjectOperation,
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
} from "./operations/open-project";
import type { OpenProjectIntent, ProjectOpenedEvent } from "./operations/open-project";
import {
  CloseProjectOperation,
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  EVENT_PROJECT_CLOSED,
} from "./operations/close-project";
import type {
  CloseProjectIntent,
  CloseHookInput,
  CloseHookResult,
  ProjectClosedEvent,
} from "./operations/close-project";
import { SwitchWorkspaceOperation, INTENT_SWITCH_WORKSPACE } from "./operations/switch-workspace";
import type { SwitchWorkspaceIntent } from "./operations/switch-workspace";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { createBadgeModule } from "./modules/badge-module";
import { createWindowTitleModule } from "./modules/window-title-module";
import { createTelemetryModule } from "./modules/telemetry-module";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./operations/update-agent-status";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "./operations/update-available";
import type { UpdateAvailableIntent } from "./operations/update-available";
import {
  AppStartOperation,
  INTENT_APP_START,
  APP_START_OPERATION_ID,
} from "./operations/app-start";
import type { ShowUIHookResult, StartHookResult, ActivateHookResult } from "./operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "./operations/app-shutdown";
import type { AppShutdownIntent } from "./operations/app-shutdown";
import {
  SetupOperation,
  INTENT_SETUP,
  SETUP_OPERATION_ID,
  EVENT_SETUP_ERROR,
} from "./operations/setup";
import type { SetupErrorEvent } from "./operations/setup";
import type { BadgeManager } from "./managers/badge-manager";
import type { IpcEventHandler } from "../services/platform/ipc";
import { ApiIpcChannels as SetupIpcChannels } from "../shared/ipc";
import { wireApiEvents } from "./ipc/api-handlers";
import { wirePluginApi, type PluginApiRegistry } from "./api/wire-plugin-api";
import type { Unsubscribe } from "../shared/api/interfaces";
import { wireModules } from "./intents/infrastructure/wire";
import { generateProjectId, extractWorkspaceName } from "../shared/api/id-utils";
import type { IntentModule } from "./intents/infrastructure/module";
import type { HookContext } from "./intents/infrastructure/operation";
import type { Intent, DomainEvent } from "./intents/infrastructure/types";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import type { IKeepFilesService } from "../services/keepfiles";
import type { IWorkspaceFileService } from "../services";
import type { WorkspaceLockHandler } from "../services/platform/workspace-lock-handler";
import type { DeletionProgressCallback } from "./operations/delete-workspace";
import { getErrorMessage } from "../shared/error-utils";
import {
  type ProjectId,
  type SetupRowId,
  type SetupRowProgress,
  type SetupRowStatus,
  type Workspace,
} from "../shared/api/types";
import { Path } from "../services/platform/path";
import { expandGitUrl } from "../services/project/url-utils";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";
import { createMetadataModule } from "./modules/metadata-module";
import { createKeepFilesModule } from "./modules/keepfiles-module";
import { createCodeServerModule } from "./modules/code-server-module";
import { createViewModule, type MountSignal } from "./modules/view-module";
import { createAgentModule } from "./modules/agent-module";

// =============================================================================
// Types
// =============================================================================

/**
 * Lifecycle service references for app:start and app:shutdown modules.
 *
 * These are constructed in index.ts before wireDispatcher() runs.
 * Modules capture them via closure and use them when hooks execute.
 */
export interface LifecycleServiceRefs {
  /** PluginServer instance (may be null if not needed) */
  readonly pluginServer: import("../services/plugin-server").PluginServer | null;
  /** CodeServerManager instance (constructed but not started) */
  readonly codeServerManager: import("../services").CodeServerManager;
  /** FileSystemLayer for directory creation */
  readonly fileSystemLayer: import("../services").FileSystemLayer;
  /** AgentStatusManager instance */
  readonly agentStatusManager: import("../agents").AgentStatusManager;
  /** AgentServerManager instance */
  readonly serverManager: import("../agents").AgentServerManager;
  /** Selected agent type */
  readonly selectedAgentType: import("../agents").AgentType;
  /** TelemetryService instance */
  readonly telemetryService: import("../services/telemetry").TelemetryService | null;
  /** AutoUpdater instance (constructed but not started) */
  readonly autoUpdater: import("../services/auto-updater").AutoUpdater;
  /** Logging service for creating loggers */
  readonly loggingService: import("../services/logging").LoggingService;
  /** Platform info for telemetry */
  readonly platformInfo: import("../services").PlatformInfo;
  /** Build info for telemetry */
  readonly buildInfo: import("../services").BuildInfo;
  /** Path provider */
  readonly pathProvider: import("../services").PathProvider;
  /** ConfigService for plugin onConfigData */
  readonly configService: import("../services/config/config-service").ConfigService;
  /** Dispatcher instance for agent status wiring */
  readonly dispatcher: Dispatcher;
  /** ViewLayer for dispose */
  readonly viewLayer: import("../services/shell/view").ViewLayer | null;
  /** WindowLayer for dispose */
  readonly windowLayer: import("../services/shell/window").WindowLayerInternal | null;
  /** SessionLayer for dispose */
  readonly sessionLayer: import("../services/shell/session").SessionLayer | null;
  /** Lazy getter for ICodeHydraApi (available after wireDispatcher completes) */
  readonly getApi: () => ICodeHydraApi;
  /** Window manager for title updates */
  readonly windowManager: import("./managers/window-manager").WindowManager;
  /** Config data provider for PluginServer (agent env vars + type) */
  readonly configDataProvider: import("../services/plugin-server/plugin-server").ConfigDataProvider;
}

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
  /** Core module dependencies (provided after setup completes) */
  readonly coreDepsFn: () => CoreModuleDeps;
  /** View manager for workspace view lifecycle (provided after setup completes) */
  readonly viewManagerFn: () => import("./managers/view-manager.interface").IViewManager;
  /** Git client for clone operations (provided after setup completes) */
  readonly gitClientFn: () => import("../services").IGitClient;
  /** Path provider for directory paths (provided after setup completes) */
  readonly pathProviderFn: () => import("../services").PathProvider;
  /** Project store for project persistence (provided after setup completes) */
  readonly projectStoreFn: () => import("../services").ProjectStore;
  /** Global worktree provider for metadata operations (provided after setup completes) */
  readonly globalWorktreeProviderFn: () => GitWorktreeProvider;
  /** Factory for KeepFilesService (provided after setup completes) */
  readonly keepFilesServiceFn: () => IKeepFilesService;
  /** Factory for IWorkspaceFileService (provided after setup completes) */
  readonly workspaceFileServiceFn: () => IWorkspaceFileService;
  /** Deletion progress callback for emitting DeletionProgress to the renderer */
  readonly emitDeletionProgressFn: () => DeletionProgressCallback;
  /** Kill terminals callback (optional, only when PluginServer is available) */
  readonly killTerminalsCallbackFn: () =>
    | import("./modules/agent-module").KillTerminalsCallback
    | undefined;
  /** Workspace lock handler for Windows file handle detection (optional) */
  readonly workspaceLockHandlerFn: () => WorkspaceLockHandler | undefined;
  /** Factory that returns the early-created dispatcher and hook registry */
  readonly dispatcherFn: () => { hookRegistry: HookRegistry; dispatcher: Dispatcher };
  /** Window title setter callback (provided after setup completes) */
  readonly setTitleFn: () => (title: string) => void;
  /** Version suffix for window title (branch in dev, version in packaged) */
  readonly titleVersionFn: () => string | undefined;
  /** BadgeManager factory (created in index.ts, passed down) */
  readonly badgeManagerFn: () => import("./managers/badge-manager").BadgeManager;
  /** Lifecycle service references for app:start/shutdown modules */
  readonly lifecycleRefsFn: () => LifecycleServiceRefs;
  /** ViewLayer for shell layer disposal (nullable for testing) */
  readonly viewLayer: import("../services/shell/view").ViewLayer | null;
  /** WindowLayer for shell layer disposal (nullable for testing) */
  readonly windowLayer: import("../services/shell/window").WindowLayerInternal | null;
  /** SessionLayer for shell layer disposal (nullable for testing) */
  readonly sessionLayer: import("../services/shell/session").SessionLayer | null;
  /** Function to get UI webContents for setup error IPC events */
  readonly getUIWebContentsFn: () => import("electron").WebContents | null;
  /** Setup dependencies for app:setup hook modules (available immediately) */
  readonly setupDeps: {
    /** ConfigService for config check/save modules */
    readonly configService: import("../services/config/config-service").ConfigService;
    /** CodeServerManager for binary preflight/download */
    readonly codeServerManager: import("../services").CodeServerManager;
    /** Factory to create AgentBinaryManager for a specific agent type */
    readonly getAgentBinaryManager: (
      agentType: import("../shared/api/types").ConfigAgentType
    ) => import("../services/binary-download").AgentBinaryManager;
    /** ExtensionManager for extension preflight/install */
    readonly extensionManager: import("../services/vscode-setup/extension-manager").ExtensionManager;
  };
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
 * Initialize the bootstrap with lifecycle handlers and early operations.
 *
 * This is the first phase of the two-phase startup:
 * 1. initializeBootstrap() - Creates registry, registers lifecycle.quit, wires app:shutdown
 * 2. startServices() - Called when setup completes, creates remaining modules
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

  // 3. Get dispatcher early for operation registration
  // The dispatcher is created in index.ts bootstrap() before initializeBootstrap() is called
  const { hookRegistry, dispatcher } = deps.dispatcherFn();

  // 4. Register app:shutdown early so it's available during setup
  // (e.g., quit from setup screen dispatches app:shutdown)
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  // 5. Shutdown idempotency interceptor: ensures only one app:shutdown execution proceeds.
  // Uses a simple boolean flag (no completion event since the process exits).
  let shutdownStarted = false;
  const shutdownIdempotencyModule: IntentModule = {
    interceptors: [
      {
        id: "shutdown-idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_APP_SHUTDOWN) {
            return intent;
          }
          if (shutdownStarted) {
            return null; // Block duplicate
          }
          shutdownStarted = true;
          return intent;
        },
      },
    ],
  };

  // 6. Quit hook module: calls app.quit() after all stop hooks complete
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

  wireModules([shutdownIdempotencyModule, quitModule], hookRegistry, dispatcher);

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

  // 8. Setup idempotency interceptor to prevent concurrent setup attempts
  // Note: Flag is only reset on error (via setup:error event handler) to allow retry.
  // On success, setup completes and no reset is needed (app won't restart setup).
  let setupInProgress = false;
  const resetSetupInProgress = () => {
    setupInProgress = false;
  };
  const setupIdempotencyModule: IntentModule = {
    interceptors: [
      {
        id: "setup-idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_SETUP) {
            return intent;
          }
          if (setupInProgress) {
            return null; // Block concurrent setup
          }
          setupInProgress = true;
          return intent;
        },
      },
    ],
  };
  wireModules([setupIdempotencyModule], hookRegistry, dispatcher);

  // 9. Wire module for app-start operation - handles the "wire" hook point
  // Uses late-binding via closure because the actual function is passed from index.ts.
  let startServicesFn: (() => Promise<void>) | null = null;
  const appStartWireModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        wire: {
          handler: async () => {
            if (startServicesFn) {
              await startServicesFn();
            }
          },
        },
      },
    },
  };

  // 10. Domain event handler for setup:error
  // Resets idempotency flag and sends IPC to renderer
  const setupErrorModule: IntentModule = {
    events: {
      [EVENT_SETUP_ERROR]: (event) => {
        resetSetupInProgress();
        const webContents = deps.getUIWebContentsFn();
        if (webContents && !webContents.isDestroyed()) {
          const { message, code } = (event as SetupErrorEvent).payload;
          const payload: SetupErrorPayload = {
            message,
            ...(code !== undefined && { code }),
          };
          webContents.send(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, payload);
        }
      },
    },
  };

  // 11. RetryModule: "show-ui" hook on app-start -- returns waitForRetry
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

  wireModules([appStartWireModule, setupErrorModule, retryModule], hookRegistry, dispatcher);

  // 12. Register AppStartOperation and SetupOperation immediately (before UI loads)
  // app:start is dispatched first in index.ts, so both must be registered early
  // Hook modules will be wired when setup dependencies are available
  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
  dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());

  // Wire ViewModule early (set-mode, app-start UI, setup UI, view lifecycle, mount)
  // Alt+X can fire before wireDispatcher completes, so set-mode must be wired here.
  const { module: viewModule, mountSignal } = createViewModule({
    viewManager: deps.viewManagerFn(),
    logger: deps.logger,
    viewLayer: deps.viewLayer,
    windowLayer: deps.windowLayer,
    sessionLayer: deps.sessionLayer,
  });
  wireModules([viewModule], hookRegistry, dispatcher);

  // 13. Wire setup hook modules (these run during app:setup, before startServices)
  const { configService, codeServerManager, getAgentBinaryManager, extensionManager } =
    deps.setupDeps;
  const setupLogger = deps.logger;

  // Progress tracking for setup screen
  const progressState: Record<SetupRowId, SetupRowProgress> = {
    vscode: { id: "vscode", status: "pending" },
    agent: { id: "agent", status: "pending" },
    setup: { id: "setup", status: "pending" },
  };

  let lastEmitTime = 0;
  const THROTTLE_MS = 100;

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitTime < THROTTLE_MS) return;
    lastEmitTime = now;
    registry.emit("lifecycle:setup-progress", {
      rows: [progressState.vscode, progressState.agent, progressState.setup],
    });
  };

  const updateProgress = (
    id: SetupRowId,
    status: SetupRowStatus,
    message?: string,
    error?: string,
    progress?: number
  ) => {
    progressState[id] = {
      id,
      status,
      ...(message !== undefined && { message }),
      ...(error !== undefined && { error }),
      ...(progress !== undefined && { progress }),
    };
    emitProgress(status !== "running");
  };

  // CodeServerModule: manages code-server lifecycle, extensions, and per-workspace files
  const codeServerModule = createCodeServerModule({
    codeServerManager,
    extensionManager,
    reportProgress: updateProgress,
    logger: setupLogger,
    getLifecycleDeps: () => {
      const refs = deps.lifecycleRefsFn();
      return {
        pluginServer: refs.pluginServer,
        codeServerManager: refs.codeServerManager,
        fileSystemLayer: refs.fileSystemLayer,
        configDataProvider: refs.configDataProvider,
        onPortChanged: (port: number) => {
          deps.viewManagerFn().updateCodeServerPort(port);
        },
      };
    },
    getWorkspaceDeps: () => ({
      workspaceFileService: deps.workspaceFileServiceFn(),
      wrapperPath: deps.coreDepsFn().wrapperPath,
    }),
  });

  // AgentModule: manages agent lifecycle, setup, per-workspace hooks, status tracking.
  // Consolidates configCheckModule, agentBinaryPreflightModule, rendererSetupModule,
  // configSaveModule, agentBinaryDownloadModule, agentLifecycleModule, agentModule,
  // deleteAgentModule, and agentStatusModule into a single extracted module.
  const agentModule = createAgentModule({
    configService,
    getAgentBinaryManager,
    ipcLayer: deps.ipcLayer,
    getUIWebContentsFn: deps.getUIWebContentsFn,
    reportProgress: updateProgress,
    logger: setupLogger,
    getLifecycleDeps: () => {
      const refs = deps.lifecycleRefsFn();
      return {
        agentStatusManager: refs.agentStatusManager,
        serverManager: refs.serverManager,
        selectedAgentType: refs.selectedAgentType,
        loggingService: refs.loggingService,
        dispatcher: refs.dispatcher,
        killTerminalsCallback: deps.killTerminalsCallbackFn(),
      };
    },
  });

  // Wire all startup modules (check hooks on app-start, work hooks on setup)
  wireModules([codeServerModule, agentModule], hookRegistry, dispatcher);

  // 14. Services started flag
  let servicesStarted = false;

  /**
   * Start remaining services after setup completes.
   * This creates CoreModule and wires the remaining intent operations.
   * Note: SetupOperation was already registered in initializeBootstrap().
   */
  function startServices(): void {
    if (servicesStarted) return;
    servicesStarted = true;

    const baseDeps = deps.coreDepsFn();

    // Wire remaining operations first to get the workspace index resolver
    const { workspaceResolver } = wireDispatcher(
      registry,
      hookRegistry,
      dispatcher,
      deps.globalWorktreeProviderFn(),
      deps.viewManagerFn(),
      deps.gitClientFn(),
      deps.pathProviderFn(),
      deps.projectStoreFn(),
      deps.logger,
      deps.keepFilesServiceFn(),
      deps.emitDeletionProgressFn(),
      deps.workspaceLockHandlerFn(),
      deps.setTitleFn(),
      deps.titleVersionFn(),
      deps.badgeManagerFn(),
      deps.lifecycleRefsFn(),
      mountSignal
    );

    // Create CoreModule with workspace index resolver wired in
    const coreDeps: CoreModuleDeps = {
      ...baseDeps,
      resolveWorkspace: workspaceResolver,
    };
    const coreModule = new CoreModule(registry, coreDeps);
    modules.push(coreModule);
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

  /**
   * Set the wire hook handler function.
   * This is called by index.ts to wire the async service creation.
   * The handler is invoked during the "wire" hook point in SetupOperation.
   */
  function setBeforeAppStart(fn: () => Promise<void>): void {
    startServicesFn = fn;
  }

  // Return bootstrap result with start function attached
  const result: BootstrapResult & {
    startServices: () => void;
    setBeforeAppStart: (fn: () => Promise<void>) => void;
  } = {
    registry,
    getInterface,
    dispose,
    startServices,
    setBeforeAppStart,
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
  hookRegistry: HookRegistry,
  dispatcher: Dispatcher,
  globalProvider: GitWorktreeProvider,
  viewManager: import("./managers/view-manager.interface").IViewManager,
  gitClient: import("../services").IGitClient,
  pathProvider: import("../services").PathProvider,
  projectStore: import("../services").ProjectStore,
  logger: Logger,
  keepFilesService: IKeepFilesService,
  emitDeletionProgress: DeletionProgressCallback,
  workspaceLockHandler: WorkspaceLockHandler | undefined,
  setTitle: (title: string) => void,
  titleVersion: string | undefined,
  badgeManager: BadgeManager,
  lifecycleRefs: LifecycleServiceRefs,
  mountSignal: MountSignal
): {
  workspaceResolver: (
    projectId: ProjectId,
    workspaceName: import("../shared/api/types").WorkspaceName
  ) => string;
} {
  // --- Workspace Index (replaces AppState project/workspace Maps for API boundary) ---
  const projectsById = new Map<string, { path: string; name: string }>();
  const workspaceToProject = new Map<
    string,
    { projectId: ProjectId; projectName: string; projectPath: string }
  >();
  const workspacesByKey = new Map<string, string>();

  function wsKey(projectId: string, workspaceName: string): string {
    return `${projectId}/${workspaceName}`;
  }

  const indexModule: IntentModule = {
    events: {
      [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
        const { project } = (event as ProjectOpenedEvent).payload;
        projectsById.set(project.id, { path: project.path, name: project.name });
      },
      [EVENT_PROJECT_CLOSED]: (event: DomainEvent) => {
        const { projectId } = (event as ProjectClosedEvent).payload;
        projectsById.delete(projectId);
        for (const [wsPath, info] of workspaceToProject) {
          if (info.projectId === projectId) {
            workspaceToProject.delete(wsPath);
          }
        }
        for (const key of workspacesByKey.keys()) {
          if (key.startsWith(projectId + "/")) {
            workspacesByKey.delete(key);
          }
        }
      },
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const p = (event as WorkspaceCreatedEvent).payload;
        const proj = projectsById.get(p.projectId);
        const normalized = new Path(p.workspacePath).toString();
        workspaceToProject.set(normalized, {
          projectId: p.projectId,
          projectName: proj?.name ?? "",
          projectPath: p.projectPath,
        });
        workspacesByKey.set(wsKey(p.projectId, p.workspaceName), normalized);
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const p = (event as WorkspaceDeletedEvent).payload;
        workspaceToProject.delete(new Path(p.workspacePath).toString());
        workspacesByKey.delete(wsKey(p.projectId, p.workspaceName));
      },
    },
  };

  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
  // Note: SetModeOperation is registered early in initializeBootstrap()
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
  const deleteOp = new DeleteWorkspaceOperation(emitDeletionProgress);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteOp);
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());
  // SwitchWorkspaceOperation: needs extractWorkspaceName, generateProjectId, and agent status scorer
  // for the auto-select algorithm (used when the active workspace is deleted).
  const agentStatusScorer = (workspacePath: WorkspacePath): number => {
    const status = lifecycleRefs.agentStatusManager.getStatus(workspacePath);
    if (status === undefined || status.status === "none") return 2;
    if (status.status === "busy") return 1;
    return 0; // idle or mixed
  };
  dispatcher.registerOperation(
    INTENT_SWITCH_WORKSPACE,
    new SwitchWorkspaceOperation(extractWorkspaceName, generateProjectId, agentStatusScorer)
  );
  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());
  // Note: AppStartOperation and AppShutdownOperation are registered early in initializeBootstrap()

  // Idempotency module (interceptor + event handler, wired via wireModules below)
  const inProgressDeletions = new Set<string>();
  const idempotencyModule: IntentModule = {
    interceptors: [
      {
        id: "idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_DELETE_WORKSPACE) {
            return intent;
          }
          const deleteIntent = intent as DeleteWorkspaceIntent;
          const workspacePath = deleteIntent.payload.workspacePath;

          // Force always passes through
          if (deleteIntent.payload.force) {
            inProgressDeletions.add(workspacePath);
            return intent;
          }

          // Block if already in progress
          if (inProgressDeletions.has(workspacePath)) {
            return null;
          }

          inProgressDeletions.add(workspacePath);
          return intent;
        },
      },
    ],
    events: {
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        inProgressDeletions.delete(payload.workspacePath);
      },
    },
  };

  const metadataModule = createMetadataModule({ globalProvider });

  // Workspace status hook handler module (get hook only — resolve handled by extracted modules)
  const workspaceStatusModule: IntentModule = {
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            const isDirty = await globalProvider.isDirty(new Path(workspacePath));
            return { isDirty };
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Open-workspace hook modules
  // ---------------------------------------------------------------------------

  // KeepFilesModule: "setup" hook -- copies .keepfiles to workspace (best-effort)
  const keepFilesModule = createKeepFilesModule({ keepFilesService, logger });

  // ---------------------------------------------------------------------------
  // Delete-workspace hook modules
  // ---------------------------------------------------------------------------

  const deleteWindowsLockModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force || !workspaceLockHandler) {
              return {};
            }

            // CWD-only scan: find and kill processes whose CWD is under workspace
            try {
              const cwdProcesses = await workspaceLockHandler.detectCwd(
                new Path(payload.workspacePath)
              );
              if (cwdProcesses.length > 0) {
                logger.info("Killing CWD-blocking processes before deletion", {
                  workspacePath: payload.workspacePath,
                  pids: cwdProcesses.map((p) => p.pid).join(","),
                });
                await workspaceLockHandler.killProcesses(cwdProcesses.map((p) => p.pid));
              }
            } catch {
              // Non-fatal: CWD detection/kill failure shouldn't block deletion
            }
            return {};
          },
        },
        detect: {
          handler: async (ctx: HookContext): Promise<DetectHookResult> => {
            if (!workspaceLockHandler) return {};

            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const detected = await workspaceLockHandler.detect(new Path(payload.workspacePath));
              return { blockingProcesses: detected };
            } catch (error) {
              logger.warn("Detection failed", {
                workspacePath: payload.workspacePath,
                error: getErrorMessage(error),
              });
              return { blockingProcesses: [] };
            }
          },
        },
        flush: {
          handler: async (ctx: HookContext): Promise<FlushHookResult> => {
            if (!workspaceLockHandler) return {};

            const { blockingPids } = ctx as FlushHookInput;
            if (blockingPids.length > 0) {
              try {
                await workspaceLockHandler.killProcesses([...blockingPids]);
              } catch (error) {
                return { error: getErrorMessage(error) };
              }
            }
            return {};
          },
        },
      },
    },
  };

  const deleteIpcBridge: IntentModule = {
    events: {
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        registry.emit("workspace:removed", {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.workspacePath,
        });
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Project:open modules
  // ---------------------------------------------------------------------------

  const inProgressOpens = new Set<string>();

  // ---------------------------------------------------------------------------
  // Project:close hook modules
  // ---------------------------------------------------------------------------

  // ProjectCloseIndexModule: "close" hook -- checks if other projects exist via workspace index
  const projectCloseIndexModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const currentProjectId = (ctx.intent as CloseProjectIntent).payload.projectId;
            let otherExists = false;
            for (const id of projectsById.keys()) {
              if (id !== currentProjectId) {
                otherExists = true;
                break;
              }
            }
            return { otherProjectsExist: otherExists };
          },
        },
      },
    },
  };

  // ProjectWorktreeCloseModule: "close" hook -- unregister project from global git provider
  const projectWorktreeCloseModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath } = ctx as CloseHookInput;
            globalProvider.unregisterProject(new Path(projectPath));
            return {};
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Workspace:switch hook modules
  // ---------------------------------------------------------------------------

  // WindowTitleModule: event subscriber on workspace:switched and update:available
  const windowTitleModule = createWindowTitleModule(setTitle, titleVersion);

  // ---------------------------------------------------------------------------
  // App lifecycle modules (app:start and app:shutdown hooks)
  // ---------------------------------------------------------------------------

  const lifecycleLogger = lifecycleRefs.loggingService.createLogger("lifecycle");

  // WrapperReadyViewModule: activate → wire onWorkspaceReady to setWorkspaceLoaded.
  // stop → cleanup callback.
  // NOTE: This module stays inline for Phase 8 (ViewModule) to absorb.
  let wrapperReadyViewCleanupFn: Unsubscribe | null = null;
  const wrapperReadyViewModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            if (lifecycleRefs.selectedAgentType === "claude") {
              const claudeServerManager =
                lifecycleRefs.serverManager as import("../agents/claude/server-manager").ClaudeCodeServerManager;
              if (claudeServerManager.onWorkspaceReady) {
                wrapperReadyViewCleanupFn = claudeServerManager.onWorkspaceReady(
                  (workspacePath) => {
                    viewManager.setWorkspaceLoaded(workspacePath);
                  }
                );
              }
            } else if (lifecycleRefs.selectedAgentType === "opencode") {
              const opencodeManager =
                lifecycleRefs.serverManager as import("../agents/opencode/server-manager").OpenCodeServerManager;
              wrapperReadyViewCleanupFn = opencodeManager.onWorkspaceReady((workspacePath) => {
                viewManager.setWorkspaceLoaded(workspacePath);
              });
            }
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (wrapperReadyViewCleanupFn) {
                wrapperReadyViewCleanupFn();
                wrapperReadyViewCleanupFn = null;
              }
            } catch (error) {
              lifecycleLogger.error(
                "WrapperReadyView shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // BadgeLifecycleModule: start → (badgeManager already created, just needs to exist).
  // stop → dispose BadgeManager.
  const badgeLifecycleModule: IntentModule = {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              badgeManager.dispose();
            } catch (error) {
              lifecycleLogger.error(
                "Badge lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  const telemetryLifecycleModule = createTelemetryModule({
    telemetryService: lifecycleRefs.telemetryService,
    platformInfo: lifecycleRefs.platformInfo,
    buildInfo: lifecycleRefs.buildInfo,
    selectedAgentType: lifecycleRefs.selectedAgentType,
    logger: lifecycleLogger,
  });

  // AutoUpdaterLifecycleModule: start → start, wire update-available→title.
  // stop → dispose.
  const autoUpdaterLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const refs = lifecycleRefs;
            refs.autoUpdater.start();

            // Wire auto-updater to dispatch update:available intent
            refs.autoUpdater.onUpdateAvailable((version: string) => {
              void lifecycleRefs.dispatcher.dispatch({
                type: INTENT_UPDATE_AVAILABLE,
                payload: { version },
              } as UpdateAvailableIntent);
            });
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              lifecycleRefs.autoUpdater.dispose();
            } catch (error) {
              lifecycleLogger.error(
                "AutoUpdater lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // IpcBridgeLifecycleModule: start → wire API events to IPC, wire Plugin→API.
  // stop → cleanup API event wiring.
  let apiEventCleanupFn: Unsubscribe | null = null;
  let pluginApiRegistry: PluginApiRegistry | null = null;
  const ipcBridgeLifecycleModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        pluginApiRegistry?.registerWorkspace(
          payload.workspacePath,
          payload.projectId,
          payload.workspaceName
        );
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        pluginApiRegistry?.unregisterWorkspace(payload.workspacePath);
      },
    },
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const api = lifecycleRefs.getApi();

            // Wire API events to IPC emission
            apiEventCleanupFn = wireApiEvents(api, () => viewManager.getUIWebContents());

            // Wire PluginServer to CodeHydraApi (if PluginServer is running)
            if (lifecycleRefs.pluginServer) {
              pluginApiRegistry = wirePluginApi(
                lifecycleRefs.pluginServer,
                api,
                lifecycleRefs.loggingService.createLogger("plugin")
              );
            }
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (apiEventCleanupFn) {
                apiEventCleanupFn();
                apiEventCleanupFn = null;
              }
              pluginApiRegistry = null;
            } catch (error) {
              lifecycleLogger.error(
                "IpcBridge lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // Project modules: activate → load saved project configs, populate state, return paths.
  // LocalProjectModule is sole project state owner for ALL projects.
  // RemoteProjectModule handles filesystem concerns (clone on open, delete on close).
  const localProjectModule = createLocalProjectModule({
    projectStore,
    globalProvider,
  });
  const remoteProjectModule = createRemoteProjectModule({
    projectStore,
    gitClient,
    pathProvider,
    logger: lifecycleLogger,
  });
  const gitWorktreeWorkspaceModule = createGitWorktreeWorkspaceModule(
    globalProvider,
    pathProvider,
    logger
  );
  // Deferred for the "loaded" hook point: resolved after all initial project:open dispatches
  // complete. lifecycle.ready awaits this so the renderer receives project:opened events
  // (via Electron IPC FIFO ordering) before setLoaded() fires.
  let projectsLoadedResolve: (() => void) | null = null;
  const projectsLoadedPromise = new Promise<void>((resolve) => {
    projectsLoadedResolve = resolve;
  });
  // LoadedSignalModule: "loaded" hook on app-start resolves the deferred so lifecycle.ready
  // can return to the renderer after all initial project:open dispatches complete.
  const loadedSignalModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        loaded: {
          handler: async (): Promise<void> => {
            if (projectsLoadedResolve) {
              projectsLoadedResolve();
              projectsLoadedResolve = null;
            }
          },
        },
      },
    },
  };

  // Wire IpcEventBridge, BadgeModule, and hook handler modules
  // Note: shutdownIdempotencyModule and quitModule are wired early in initializeBootstrap()
  const ipcEventBridge = createIpcEventBridge(registry);
  const badgeModule = createBadgeModule(badgeManager);
  wireModules(
    [
      // Workspace index (must be first to receive events before other modules)
      indexModule,
      ipcEventBridge,
      badgeModule,
      metadataModule,
      workspaceStatusModule,
      // Open-workspace hook modules (kept inline)
      keepFilesModule,
      // Delete-workspace modules
      idempotencyModule,
      deleteWindowsLockModule,
      deleteIpcBridge,
      // Project modules: remote before local so RemoteProjectModule.close reads
      // the project config before LocalProjectModule.close removes the store entry.
      remoteProjectModule,
      localProjectModule,
      gitWorktreeWorkspaceModule,
      // Project:close modules
      projectCloseIndexModule,
      projectWorktreeCloseModule,
      // Workspace:switch modules
      windowTitleModule,
      // App lifecycle modules
      wrapperReadyViewModule,
      badgeLifecycleModule,
      telemetryLifecycleModule,
      autoUpdaterLifecycleModule,
      ipcBridgeLifecycleModule,
      loadedSignalModule,
    ],
    hookRegistry,
    dispatcher
  );

  // Register dispatcher bridge handlers in the API registry
  registry.register(
    "workspaces.create",
    async (payload: WorkspaceCreatePayload) => {
      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.name,
          base: payload.base,
          ...(payload.initialPrompt !== undefined && { initialPrompt: payload.initialPrompt }),
          ...(payload.keepInBackground !== undefined && {
            keepInBackground: payload.keepInBackground,
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
      // Resolve workspace to get paths needed for intent payload via workspace index
      const projectPath = projectsById.get(payload.projectId)?.path;
      if (!projectPath) {
        throw new Error(`Project not found: ${payload.projectId}`);
      }
      const workspacePath = workspacesByKey.get(wsKey(payload.projectId, payload.workspaceName));
      if (!workspacePath) {
        throw new Error(`Workspace not found: ${payload.workspaceName}`);
      }

      // If pipeline is waiting for user choice, signal it instead of dispatching new intent
      if (deleteOp.hasPendingRetry(workspacePath)) {
        if (payload.force) {
          deleteOp.signalDismiss(workspacePath);
          // Fall through to dispatch force intent after pipeline exits
        } else {
          deleteOp.signalRetry(workspacePath);
          return { started: true };
        }
      }

      const intent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          workspacePath,
          projectPath,
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

  registry.register(
    "ui.switchWorkspace",
    async (payload: UiSwitchWorkspacePayload) => {
      const intent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
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
      };

      // Fire-and-forget background update (same as old CoreModule pattern)
      void (async () => {
        try {
          const projectPath = projectsById.get(payload.projectId)?.path;
          if (!projectPath) return;
          const projectRoot = new Path(projectPath);
          await globalProvider.updateBases(projectRoot);
          const updatedBases = await globalProvider.listBases(projectRoot);
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
      if (mountSignal.resolve) {
        // Resolve the mount promise so app:start activate completes
        // and project:open dispatches can fire (renderer is already subscribed).
        mountSignal.resolve();
        mountSignal.resolve = null;
        // Wait for initial project:open dispatches to complete.
        // This ensures renderer stores are populated before setLoaded() fires.
        await projectsLoadedPromise;
      }
    },
    { ipc: ApiIpcChannels.LIFECYCLE_READY }
  );

  // Return workspace resolver function for CoreModule
  return {
    workspaceResolver: (
      projectId: ProjectId,
      workspaceName: import("../shared/api/types").WorkspaceName
    ): string => {
      const path = workspacesByKey.get(wsKey(projectId, workspaceName));
      if (!path) {
        throw new Error(`Workspace not found: ${workspaceName} in project ${projectId}`);
      }
      return path;
    },
  };
}
