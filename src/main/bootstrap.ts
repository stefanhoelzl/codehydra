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
import {
  ApiIpcChannels,
  type WorkspacePath,
  type WorkspaceLoadingChangedPayload,
  type SetupErrorPayload,
} from "../shared/ipc";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./operations/set-metadata";
import type { SetMetadataIntent, SetHookInput } from "./operations/set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./operations/get-metadata";
import type {
  GetMetadataIntent,
  GetMetadataHookResult,
  GetHookInput as GetMetadataGetHookInput,
} from "./operations/get-metadata";
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
import {
  GetAgentSessionOperation,
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "./operations/get-agent-session";
import type {
  GetAgentSessionIntent,
  GetAgentSessionHookInput,
  GetAgentSessionHookResult,
} from "./operations/get-agent-session";
import {
  RestartAgentOperation,
  RESTART_AGENT_OPERATION_ID,
  INTENT_RESTART_AGENT,
} from "./operations/restart-agent";
import type {
  RestartAgentIntent,
  RestartAgentHookInput,
  RestartAgentHookResult,
} from "./operations/restart-agent";
import { SetModeOperation, SET_MODE_OPERATION_ID, INTENT_SET_MODE } from "./operations/set-mode";
import type { SetModeIntent, SetModeHookResult } from "./operations/set-mode";
import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./operations/get-active-workspace";
import type {
  GetActiveWorkspaceIntent,
  GetActiveWorkspaceHookResult,
} from "./operations/get-active-workspace";
import {
  OpenWorkspaceOperation,
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
} from "./operations/open-workspace";
import type {
  OpenWorkspaceIntent,
  SetupHookInput,
  SetupHookResult,
  FinalizeHookInput,
  FinalizeHookResult,
  WorkspaceCreatedEvent,
} from "./operations/open-workspace";
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
  DeleteHookResult,
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
import {
  SwitchWorkspaceOperation,
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
} from "./operations/switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "./operations/switch-workspace";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { createBadgeModule } from "./modules/badge-module";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./operations/update-agent-status";
import {
  AppStartOperation,
  INTENT_APP_START,
  APP_START_OPERATION_ID,
} from "./operations/app-start";
import type {
  ShowUIHookResult,
  StartHookResult,
  ActivateHookResult,
  CheckConfigResult,
  CheckDepsHookContext,
  CheckDepsResult,
} from "./operations/app-start";
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
import type {
  AgentSelectionHookResult,
  SaveAgentHookInput,
  BinaryHookInput,
  ExtensionsHookInput,
  SetupErrorEvent,
} from "./operations/setup";
import type { BadgeManager } from "./managers/badge-manager";
import type { IpcEventHandler } from "../services/platform/ipc";
import { SetupError } from "../services/errors";
import type { AgentBinaryType } from "../services/binary-download";
import {
  ApiIpcChannels as SetupIpcChannels,
  type LifecycleAgentType,
  type ShowAgentSelectionPayload,
  type AgentSelectedPayload,
} from "../shared/ipc";
import nodePath from "node:path";
import { wireApiEvents, formatWindowTitle } from "./ipc/api-handlers";
import { wirePluginApi, type PluginApiRegistry } from "./api/wire-plugin-api";
import type { UpdateAgentStatusIntent } from "./operations/update-agent-status";
import type { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { OpenCodeServerManager } from "../agents/opencode/server-manager";
import type { Unsubscribe } from "../shared/api/interfaces";
import { wireModules } from "./intents/infrastructure/wire";
import { generateProjectId, extractWorkspaceName } from "../shared/api/id-utils";
import type { IntentModule } from "./intents/infrastructure/module";
import type { HookContext } from "./intents/infrastructure/operation";
import type { Intent, DomainEvent } from "./intents/infrastructure/types";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import type { IKeepFilesService } from "../services/keepfiles";
import { urlForWorkspace, urlForFolder, type IWorkspaceFileService } from "../services";
import type { WorkspaceLockHandler } from "../services/platform/workspace-lock-handler";
import type { DeletionProgressCallback } from "./operations/delete-workspace";
import { getErrorMessage } from "../shared/error-utils";
import {
  normalizeInitialPrompt,
  type ProjectId,
  type SetupRowId,
  type SetupRowProgress,
  type SetupRowStatus,
  type Workspace,
  type WorkspaceRef,
} from "../shared/api/types";
import { Path } from "../services/platform/path";
import { expandGitUrl } from "../services/project/url-utils";
import { createLocalProjectModule } from "./modules/local-project-module";
import { createRemoteProjectModule } from "./modules/remote-project-module";
import { createGitWorktreeWorkspaceModule } from "./modules/git-worktree-workspace-module";

// =============================================================================
// Constants
// =============================================================================

/**
 * Available agents for selection.
 */
const AVAILABLE_AGENTS: readonly LifecycleAgentType[] = ["opencode", "claude"];

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal interface for kill terminals callback.
 */
export type KillTerminalsCallback = (workspacePath: string) => Promise<void>;

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
  /** McpServerManager instance (constructed but not started) */
  readonly mcpServerManager: import("../services/mcp-server").McpServerManager;
  /** TelemetryService instance */
  readonly telemetryService: import("../services/telemetry").TelemetryService | null;
  /** AutoUpdater instance (constructed but not started) */
  readonly autoUpdater: import("../services/auto-updater").AutoUpdater;
  /** Logging service for creating loggers */
  readonly loggingService: import("../services/logging").LoggingService;
  /** Selected agent type */
  readonly selectedAgentType: import("../agents").AgentType;
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
  /** Wait for agent provider registration after server start */
  readonly waitForProvider: (workspacePath: string) => Promise<void>;
  /** Update code-server port in AppState */
  readonly updateCodeServerPort: (port: number) => void;
  /** Inject MCP server manager into AppState for onServerStopped cleanup */
  readonly setMcpServerManager: (
    manager: import("../services/mcp-server").McpServerManager
  ) => void;
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
  readonly killTerminalsCallbackFn: () => KillTerminalsCallback | undefined;
  /** Workspace lock handler for Windows file handle detection (optional) */
  readonly workspaceLockHandlerFn: () => WorkspaceLockHandler | undefined;
  /** Factory that returns the early-created dispatcher and hook registry */
  readonly dispatcherFn: () => { hookRegistry: HookRegistry; dispatcher: Dispatcher };
  /** Window title setter callback (provided after setup completes) */
  readonly setTitleFn: () => (title: string) => void;
  /** Version suffix for window title (branch in dev, version in packaged) */
  readonly titleVersionFn: () => string | undefined;
  /** Callback to check if an update is available */
  readonly hasUpdateAvailableFn: () => () => boolean;
  /** BadgeManager factory (created in index.ts, passed down) */
  readonly badgeManagerFn: () => import("./managers/badge-manager").BadgeManager;
  /** Lifecycle service references for app:start/shutdown modules */
  readonly lifecycleRefsFn: () => LifecycleServiceRefs;
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

  // 11. UI hooks for app-start and setup operations
  const appStartUIModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "show-ui": {
          handler: async (): Promise<ShowUIHookResult> => {
            const webContents = deps.getUIWebContentsFn();
            if (webContents && !webContents.isDestroyed()) {
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_STARTING);
            }
            return {};
          },
        },
      },
    },
  };

  const setupUIModule: IntentModule = {
    hooks: {
      [SETUP_OPERATION_ID]: {
        "show-ui": {
          handler: async () => {
            const webContents = deps.getUIWebContentsFn();
            if (webContents && !webContents.isDestroyed()) {
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_SETUP);
            }
          },
        },
        "hide-ui": {
          handler: async () => {
            const webContents = deps.getUIWebContentsFn();
            if (webContents && !webContents.isDestroyed()) {
              // Return to starting screen
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_STARTING);
            }
          },
        },
      },
    },
  };

  // RetryModule: "show-ui" hook on app-start -- returns waitForRetry
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

  wireModules(
    [appStartWireModule, setupErrorModule, appStartUIModule, setupUIModule, retryModule],
    hookRegistry,
    dispatcher
  );

  // 12. Register AppStartOperation and SetupOperation immediately (before UI loads)
  // app:start is dispatched first in index.ts, so both must be registered early
  // Hook modules will be wired when setup dependencies are available
  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
  dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());

  // 13. Wire setup hook modules (these run during app:setup, before startServices)
  const { configService, codeServerManager, getAgentBinaryManager, extensionManager } =
    deps.setupDeps;
  const setupLogger = deps.logger;

  // ConfigCheckModule: "check-config" hook -- loads config, returns configuredAgent
  const configCheckModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "check-config": {
          handler: async (): Promise<CheckConfigResult> => {
            const config = await configService.load();
            return { configuredAgent: config.agent };
          },
        },
      },
    },
  };

  // BinaryPreflightModule: "check-deps" hook -- checks if binaries need download
  const binaryPreflightModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
            const { configuredAgent } = ctx as CheckDepsHookContext;
            const missingBinaries: import("../services/vscode-setup/types").BinaryType[] = [];

            // Check code-server binary
            const codeServerResult = await codeServerManager.preflight();
            if (codeServerResult.success && codeServerResult.needsDownload) {
              missingBinaries.push("code-server");
            }

            // Check agent binary (only if agent is already configured)
            if (configuredAgent) {
              const agentBinaryManager = getAgentBinaryManager(configuredAgent);
              const agentResult = await agentBinaryManager.preflight();
              if (agentResult.success && agentResult.needsDownload) {
                const binaryType = agentBinaryManager.getBinaryType() as AgentBinaryType;
                missingBinaries.push(binaryType);
              }
            }

            return { missingBinaries };
          },
        },
      },
    },
  };

  // ExtensionPreflightModule: "check-deps" hook -- checks if extensions need install
  const extensionPreflightModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (): Promise<CheckDepsResult> => {
            const result = await extensionManager.preflight();
            if (result.success) {
              return {
                missingExtensions: result.missingExtensions,
                outdatedExtensions: result.outdatedExtensions,
              };
            }
            // Preflight failed -- return empty arrays; operation derives needsExtensions=false
            return {};
          },
        },
      },
    },
  };

  // RendererSetupModule: "agent-selection" hook -- shows agent selection UI, waits for response
  // Also handles "activate" hook for app:start -- shows main view
  const rendererSetupModule: IntentModule = {
    hooks: {
      [SETUP_OPERATION_ID]: {
        "agent-selection": {
          handler: async (): Promise<AgentSelectionHookResult> => {
            const webContents = deps.getUIWebContentsFn();

            if (!webContents || webContents.isDestroyed()) {
              throw new SetupError("UI not available for agent selection", "TIMEOUT");
            }

            setupLogger.debug("Showing agent selection dialog");

            // Create a promise that resolves when the renderer responds
            const agentPromise = new Promise<LifecycleAgentType>((resolve) => {
              const handleAgentSelected: IpcEventHandler = (_event, ...args) => {
                deps.ipcLayer.removeListener(
                  SetupIpcChannels.LIFECYCLE_AGENT_SELECTED,
                  handleAgentSelected
                );
                const payload = args[0] as AgentSelectedPayload;
                resolve(payload.agent);
              };

              deps.ipcLayer.on(SetupIpcChannels.LIFECYCLE_AGENT_SELECTED, handleAgentSelected);
            });

            // Send IPC event to show agent selection
            const payload: ShowAgentSelectionPayload = {
              agents: AVAILABLE_AGENTS,
            };
            webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_AGENT_SELECTION, payload);

            // Wait for response
            const selectedAgent = await agentPromise;
            setupLogger.info("Agent selected", { agent: selectedAgent });

            return { selectedAgent };
          },
        },
      },
    },
  };

  // ConfigSaveModule: "save-agent" hook -- saves agent selection to config
  const configSaveModule: IntentModule = {
    hooks: {
      [SETUP_OPERATION_ID]: {
        "save-agent": {
          handler: async (ctx: HookContext) => {
            const { selectedAgent } = ctx as SaveAgentHookInput;

            if (!selectedAgent) {
              throw new SetupError(
                "No agent selected in save-agent hook",
                "AGENT_SELECTION_REQUIRED"
              );
            }

            try {
              await configService.setAgent(selectedAgent);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new SetupError(
                `Failed to save agent selection: ${message}`,
                "CONFIG_SAVE_FAILED"
              );
            }
          },
        },
      },
    },
  };

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

  // BinaryDownloadModule: "binary" hook -- downloads missing binaries
  const binaryDownloadModule: IntentModule = {
    hooks: {
      [SETUP_OPERATION_ID]: {
        binary: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as BinaryHookInput;
            const missingBinaries = hookCtx.missingBinaries ?? [];

            // Download code-server if missing
            if (missingBinaries.includes("code-server")) {
              updateProgress("vscode", "running", "Downloading...");
              try {
                await codeServerManager.downloadBinary((p) => {
                  if (p.phase === "downloading" && p.totalBytes) {
                    const pct = Math.floor((p.bytesDownloaded / p.totalBytes) * 100);
                    updateProgress("vscode", "running", "Downloading...", undefined, pct);
                  } else if (p.phase === "extracting") {
                    updateProgress("vscode", "running", "Extracting...");
                  }
                });
                updateProgress("vscode", "done");
              } catch (error) {
                updateProgress("vscode", "failed", undefined, getErrorMessage(error));
                throw new SetupError(
                  `Failed to download code-server: ${getErrorMessage(error)}`,
                  "BINARY_DOWNLOAD_FAILED"
                );
              }
            } else {
              updateProgress("vscode", "done");
            }

            // Get the agent type from context (set by ConfigCheckModule or ConfigSaveModule)
            const agentType = hookCtx.selectedAgent ?? hookCtx.configuredAgent;
            if (agentType) {
              const agentBinaryManager = getAgentBinaryManager(agentType);
              const binaryType = agentBinaryManager.getBinaryType();

              // Download agent binary if missing
              if (missingBinaries.includes(binaryType)) {
                updateProgress("agent", "running", "Downloading...");
                try {
                  await agentBinaryManager.downloadBinary((p) => {
                    if (p.phase === "downloading" && p.totalBytes) {
                      const pct = Math.floor((p.bytesDownloaded / p.totalBytes) * 100);
                      updateProgress("agent", "running", "Downloading...", undefined, pct);
                    } else if (p.phase === "extracting") {
                      updateProgress("agent", "running", "Extracting...");
                    }
                  });
                  updateProgress("agent", "done");
                } catch (error) {
                  updateProgress("agent", "failed", undefined, getErrorMessage(error));
                  throw new SetupError(
                    `Failed to download ${binaryType}: ${getErrorMessage(error)}`,
                    "BINARY_DOWNLOAD_FAILED"
                  );
                }
              } else {
                updateProgress("agent", "done");
              }
            } else {
              updateProgress("agent", "done");
            }
          },
        },
      },
    },
  };

  // ExtensionInstallModule: "extensions" hook -- installs missing/outdated extensions
  const extensionInstallModule: IntentModule = {
    hooks: {
      [SETUP_OPERATION_ID]: {
        extensions: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as ExtensionsHookInput;
            const missingExtensions = hookCtx.missingExtensions ?? [];
            const outdatedExtensions = hookCtx.outdatedExtensions ?? [];

            const extensionsToInstall = [...missingExtensions, ...outdatedExtensions];
            if (extensionsToInstall.length === 0) {
              updateProgress("setup", "done");
              return;
            }

            updateProgress("setup", "running", "Installing extensions...");

            // Clean outdated extensions before reinstalling
            if (outdatedExtensions.length > 0) {
              try {
                await extensionManager.cleanOutdated(outdatedExtensions);
              } catch (error) {
                updateProgress("setup", "failed", undefined, getErrorMessage(error));
                throw new SetupError(
                  `Failed to clean outdated extensions: ${getErrorMessage(error)}`,
                  "EXTENSION_INSTALL_FAILED"
                );
              }
            }

            // Install extensions
            try {
              await extensionManager.install(extensionsToInstall, (message) => {
                updateProgress("setup", "running", message);
              });
              updateProgress("setup", "done");
            } catch (error) {
              updateProgress("setup", "failed", undefined, getErrorMessage(error));
              throw new SetupError(
                `Failed to install extensions: ${getErrorMessage(error)}`,
                "EXTENSION_INSTALL_FAILED"
              );
            }
          },
        },
      },
    },
  };

  // Wire all startup modules (check hooks on app-start, work hooks on setup)
  wireModules(
    [
      configCheckModule,
      binaryPreflightModule,
      extensionPreflightModule,
      rendererSetupModule,
      configSaveModule,
      binaryDownloadModule,
      extensionInstallModule,
    ],
    hookRegistry,
    dispatcher
  );

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
    const workspaceResolver = wireDispatcher(
      registry,
      hookRegistry,
      dispatcher,
      deps.globalWorktreeProviderFn(),
      baseDeps,
      deps.viewManagerFn(),
      deps.gitClientFn(),
      deps.pathProviderFn(),
      deps.projectStoreFn(),
      deps.logger,
      deps.keepFilesServiceFn(),
      deps.workspaceFileServiceFn(),
      deps.emitDeletionProgressFn(),
      deps.killTerminalsCallbackFn(),
      deps.workspaceLockHandlerFn(),
      deps.setTitleFn(),
      deps.titleVersionFn(),
      deps.hasUpdateAvailableFn(),
      deps.badgeManagerFn(),
      deps.lifecycleRefsFn()
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
  coreDeps: CoreModuleDeps,
  viewManager: import("./managers/view-manager.interface").IViewManager,
  gitClient: import("../services").IGitClient,
  pathProvider: import("../services").PathProvider,
  projectStore: import("../services").ProjectStore,
  logger: Logger,
  keepFilesService: IKeepFilesService,
  workspaceFileService: IWorkspaceFileService,
  emitDeletionProgress: DeletionProgressCallback,
  killTerminalsCallback: KillTerminalsCallback | undefined,
  workspaceLockHandler: WorkspaceLockHandler | undefined,
  setTitle: (title: string) => void,
  titleVersion: string | undefined,
  hasUpdateAvailable: () => boolean,
  badgeManager: BadgeManager,
  lifecycleRefs: LifecycleServiceRefs
): (projectId: ProjectId, workspaceName: import("../shared/api/types").WorkspaceName) => string {
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

  // Mutable code-server port (initially 0, updated by codeServerLifecycleModule after start)
  let codeServerPort = coreDeps.codeServerPort;

  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());
  dispatcher.registerOperation(
    INTENT_DELETE_WORKSPACE,
    new DeleteWorkspaceOperation(emitDeletionProgress)
  );
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

  // Metadata hook handler module
  const metadataModule: IntentModule = {
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const { workspacePath } = ctx as SetHookInput;
            const intent = ctx.intent as SetMetadataIntent;
            await globalProvider.setMetadata(
              new Path(workspacePath),
              intent.payload.key,
              intent.payload.value
            );
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetMetadataHookResult> => {
            const { workspacePath } = ctx as GetMetadataGetHookInput;
            const metadata = await globalProvider.getMetadata(new Path(workspacePath));
            return { metadata };
          },
        },
      },
    },
  };

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

  const agentStatusModule: IntentModule = {
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            return {
              agentStatus: lifecycleRefs.agentStatusManager.getStatus(
                workspacePath as WorkspacePath
              ),
            };
          },
        },
      },
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult> => {
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            const session =
              lifecycleRefs.agentStatusManager.getSession(workspacePath as WorkspacePath) ?? null;
            return { session };
          },
        },
      },
      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult> => {
            const { workspacePath } = ctx as RestartAgentHookInput;
            const result = await lifecycleRefs.serverManager.restartServer(workspacePath);
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

  // UI hook handler module (mode changes + active workspace queries)
  let cachedActiveRef: WorkspaceRef | null = null;

  const uiHookModule: IntentModule = {
    hooks: {
      [SET_MODE_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<SetModeHookResult> => {
            const intent = ctx.intent as SetModeIntent;
            const previousMode = viewManager.getMode();
            viewManager.setMode(intent.payload.mode);
            return { previousMode };
          },
        },
      },
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<GetActiveWorkspaceHookResult> => {
            return { workspaceRef: cachedActiveRef };
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        if (payload === null) {
          cachedActiveRef = null;
        } else {
          cachedActiveRef = {
            projectId: payload.projectId,
            workspaceName: payload.workspaceName,
            path: payload.path,
          };
        }
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Open-workspace hook modules
  // ---------------------------------------------------------------------------

  // KeepFilesModule: "setup" hook -- copies .keepfiles to workspace (best-effort)
  const keepFilesModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;

            try {
              await keepFilesService.copyToWorkspace(
                new Path(setupCtx.projectPath),
                new Path(setupCtx.workspacePath)
              );
            } catch (error) {
              logger.error(
                "Keepfiles copy failed for workspace (non-fatal)",
                { workspacePath: setupCtx.workspacePath },
                error instanceof Error ? error : undefined
              );
              // Do not re-throw -- keepfiles is best-effort
            }

            return {};
          },
        },
      },
    },
  };

  // AgentModule: "setup" hook -- starts agent server, sets initial prompt, gets env vars (fatal)
  const agentModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;

            // 1. Start agent server
            await lifecycleRefs.serverManager.startServer(workspacePath);

            // 2. Wait for provider registration (handleServerStarted runs async)
            await lifecycleRefs.waitForProvider(workspacePath);

            // 3. Set initial prompt if provided (must happen after startServer)
            if (intent.payload.initialPrompt && lifecycleRefs.serverManager.setInitialPrompt) {
              const normalizedPrompt = normalizeInitialPrompt(intent.payload.initialPrompt);
              await lifecycleRefs.serverManager.setInitialPrompt(workspacePath, normalizedPrompt);
            }

            // 4. Get environment variables from agent provider
            const agentProvider = lifecycleRefs.agentStatusManager.getProvider(
              workspacePath as WorkspacePath
            );
            return { envVars: agentProvider?.getEnvironmentVariables() ?? {} };
          },
        },
      },
    },
  };

  // CodeServerModule: "finalize" hook -- creates .code-workspace file, returns workspaceUrl
  const codeServerModule: IntentModule = {
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<FinalizeHookResult> => {
            const finalizeCtx = ctx as FinalizeHookInput;
            try {
              const workspacePathObj = new Path(finalizeCtx.workspacePath);
              const projectWorkspacesDir = workspacePathObj.dirname;
              const envVarsArray = Object.entries(finalizeCtx.envVars).map(([name, value]) => ({
                name,
                value,
              }));
              const agentSettings: Record<string, unknown> = {
                "claudeCode.useTerminal": true,
                "claudeCode.claudeProcessWrapper": coreDeps.wrapperPath,
                "claudeCode.environmentVariables": envVarsArray,
              };
              const workspaceFilePath = await workspaceFileService.ensureWorkspaceFile(
                workspacePathObj,
                projectWorkspacesDir,
                agentSettings
              );
              return {
                workspaceUrl: urlForWorkspace(codeServerPort, workspaceFilePath.toString()),
              };
            } catch (error) {
              logger.warn("Failed to ensure workspace file, using folder URL", {
                workspacePath: finalizeCtx.workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                workspaceUrl: urlForFolder(codeServerPort, finalizeCtx.workspacePath),
              };
            }
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Create-workspace event subscriber modules
  // ---------------------------------------------------------------------------

  // ViewModule: subscribes to workspace:created, creates workspace view
  // Note: workspace activation is now handled by OpenWorkspaceOperation dispatching workspace:switch
  const viewModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        viewManager.createWorkspaceView(
          payload.workspacePath,
          payload.workspaceUrl,
          payload.projectPath,
          true
        );
        viewManager.preloadWorkspaceUrl(payload.workspacePath);
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Delete-workspace hook modules
  // ---------------------------------------------------------------------------

  const deleteViewModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            const isActive = viewManager.getActiveWorkspacePath() === payload.workspacePath;

            try {
              await viewManager.destroyWorkspaceView(payload.workspacePath);
              return { ...(isActive && { wasActive: true }) };
            } catch (error) {
              if (payload.force) {
                logger.warn("ViewModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {
                  ...(isActive && { wasActive: true }),
                  error: getErrorMessage(error),
                };
              }
              throw error;
            }
          },
        },
      },
    },
  };

  const deleteAgentModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              // Kill terminals (best-effort even in normal mode)
              if (killTerminalsCallback) {
                try {
                  await killTerminalsCallback(payload.workspacePath);
                } catch (error) {
                  logger.warn("Kill terminals failed", {
                    workspacePath: payload.workspacePath,
                    error: getErrorMessage(error),
                  });
                }
              }

              // Stop server
              let serverError: string | undefined;
              const stopResult = await lifecycleRefs.serverManager.stopServer(
                payload.workspacePath
              );
              if (!stopResult.success) {
                serverError = stopResult.error ?? "Failed to stop server";
                if (!payload.force) {
                  throw new Error(serverError);
                }
              }

              // Clear TUI tracking
              lifecycleRefs.agentStatusManager.clearTuiTracking(
                payload.workspacePath as WorkspacePath
              );

              return serverError ? { error: serverError } : {};
            } catch (error) {
              if (payload.force) {
                logger.warn("AgentModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { error: getErrorMessage(error) };
              }
              throw error;
            }
          },
        },
      },
    },
  };

  const deleteWindowsLockModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            // Skip entirely in force mode
            if (payload.force || !workspaceLockHandler) {
              return {};
            }

            // Handle unblock actions (kill/close)
            if (payload.unblock === "kill" || payload.unblock === "close") {
              try {
                if (payload.unblock === "kill") {
                  const detected = await workspaceLockHandler.detect(
                    new Path(payload.workspacePath)
                  );
                  if (detected.length > 0) {
                    logger.info("Killing blocking processes before deletion", {
                      workspacePath: payload.workspacePath,
                      pids: detected.map((p) => p.pid).join(","),
                    });
                    await workspaceLockHandler.killProcesses(detected.map((p) => p.pid));
                  }
                  return { unblockPerformed: true };
                } else {
                  logger.info("Closing handles before deletion", {
                    workspacePath: payload.workspacePath,
                  });
                  await workspaceLockHandler.closeHandles(new Path(payload.workspacePath));
                  return { unblockPerformed: true };
                }
              } catch (error) {
                return { unblockPerformed: false, error: getErrorMessage(error) };
              }
            }

            // Proactive detection (first attempt only, not retry, not ignore)
            if (!payload.isRetry && payload.unblock !== "ignore") {
              try {
                const detected = await workspaceLockHandler.detect(new Path(payload.workspacePath));

                if (detected.length > 0) {
                  return {
                    blockingProcesses: detected,
                    error: `Blocked by ${detected.length} process(es)`,
                  };
                }
                return { blockingProcesses: [] };
              } catch (error) {
                logger.warn("Detection failed, continuing with deletion", {
                  error: getErrorMessage(error),
                });
                return {};
              }
            }

            return {};
          },
        },
      },
    },
  };

  const deleteCodeServerModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const workspacePath = new Path(payload.workspacePath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await workspaceFileService.deleteWorkspaceFile(workspaceName, projectWorkspacesDir);
              return {};
            } catch (error) {
              if (payload.force) {
                logger.warn("CodeServerModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {};
              }
              throw error;
            }
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

  // ProjectViewModule: subscribes to project:opened, preloads non-first workspaces
  // Note: first workspace activation is now handled by OpenProjectOperation dispatching workspace:switch
  const projectViewModule: IntentModule = {
    events: {
      [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
        const payload = (event as ProjectOpenedEvent).payload;
        const workspaces = payload.project.workspaces;
        for (let i = 1; i < workspaces.length; i++) {
          viewManager.preloadWorkspaceUrl(workspaces[i]!.path);
        }
      },
    },
  };

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

  // SwitchViewModule: "activate" hook -- calls setActiveWorkspace
  // Resolution is handled by resolve-project and resolve-workspace hooks.
  // When the workspace is already active, resolvedPath is left undefined (no-op).
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath } = ctx as ActivateHookInput;
            const intent = ctx.intent as SwitchWorkspaceIntent;

            if (viewManager.getActiveWorkspacePath() === workspacePath) {
              return {};
            }

            const focus = intent.payload.focus ?? true;
            viewManager.setActiveWorkspace(workspacePath, focus);
            return { resolvedPath: workspacePath };
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        if (payload === null) {
          viewManager.setActiveWorkspace(null, false);
        }
      },
    },
  };

  // SwitchTitleModule: event subscriber on workspace:switched -- updates window title
  const switchTitleModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        const hasUpdate = hasUpdateAvailable();

        if (payload === null) {
          const title = formatWindowTitle(undefined, undefined, titleVersion, hasUpdate);
          setTitle(title);
          return;
        }

        const title = formatWindowTitle(
          payload.projectName,
          payload.workspaceName,
          titleVersion,
          hasUpdate
        );
        setTitle(title);
      },
    },
  };

  // ---------------------------------------------------------------------------
  // App lifecycle modules (app:start and app:shutdown hooks)
  // ---------------------------------------------------------------------------

  const lifecycleLogger = lifecycleRefs.loggingService.createLogger("lifecycle");

  // CodeServerLifecycleModule: start → start PluginServer (graceful), ensure dirs,
  // start CodeServerManager, update ViewManager port. stop → stop CodeServerManager, close PluginServer.
  const codeServerLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const refs = lifecycleRefs;

            // Start PluginServer BEFORE code-server (graceful degradation)
            let pluginPort: number | undefined;
            if (refs.pluginServer) {
              try {
                pluginPort = await refs.pluginServer.start();
                lifecycleLogger.info("PluginServer started", { port: pluginPort });

                // Wire config data provider
                refs.pluginServer.onConfigData((workspacePath) => {
                  const env =
                    lifecycleRefs.agentStatusManager.getEnvironmentVariables(
                      workspacePath as import("../shared/ipc").WorkspacePath
                    ) ?? null;
                  const agentType = lifecycleRefs.selectedAgentType;
                  return { env, agentType };
                });

                // Pass pluginPort to CodeServerManager so extensions can connect
                refs.codeServerManager.setPluginPort(pluginPort);
              } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                lifecycleLogger.warn("PluginServer start failed", { error: message });
                pluginPort = undefined;
              }
            }

            // Ensure required directories exist
            const config = refs.codeServerManager.getConfig();
            await Promise.all([
              refs.fileSystemLayer.mkdir(config.runtimeDir),
              refs.fileSystemLayer.mkdir(config.extensionsDir),
              refs.fileSystemLayer.mkdir(config.userDataDir),
            ]);

            // Start code-server
            await refs.codeServerManager.ensureRunning();
            const port = refs.codeServerManager.port()!;

            // Update code-server port everywhere
            viewManager.updateCodeServerPort(port);
            codeServerPort = port;
            lifecycleRefs.updateCodeServerPort(port);

            return { codeServerPort: port };
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Stop code-server
              await lifecycleRefs.codeServerManager.stop();

              // Close PluginServer AFTER code-server (extensions disconnect first)
              if (lifecycleRefs.pluginServer) {
                await lifecycleRefs.pluginServer.close();
              }
            } catch (error) {
              lifecycleLogger.error(
                "CodeServer lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // AgentLifecycleModule: start → wire status→dispatcher. stop → dispose ServerManager,
  // unsubscribe, dispose AgentStatusManager.
  let agentStatusUnsubscribeFn: Unsubscribe | null = null;
  const agentLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            // Wire agent status changes through the intent dispatcher
            agentStatusUnsubscribeFn = lifecycleRefs.agentStatusManager.onStatusChanged(
              (workspacePath, status) => {
                // Resolve project for this workspace path via workspace index
                const info = workspaceToProject.get(new Path(workspacePath).toString());
                if (!info) return; // Unknown workspace — skip dispatch

                const projectId = info.projectId;
                const workspaceName = extractWorkspaceName(workspacePath);

                void lifecycleRefs.dispatcher.dispatch({
                  type: INTENT_UPDATE_AGENT_STATUS,
                  payload: { workspacePath, projectId, workspaceName, status },
                } as UpdateAgentStatusIntent);
              }
            );
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Dispose ServerManager (stops all servers)
              await lifecycleRefs.serverManager.dispose();

              // Cleanup agent status subscription
              if (agentStatusUnsubscribeFn) {
                agentStatusUnsubscribeFn();
                agentStatusUnsubscribeFn = null;
              }

              // Dispose AgentStatusManager
              lifecycleRefs.agentStatusManager.dispose();
            } catch (error) {
              lifecycleLogger.error(
                "Agent lifecycle shutdown failed (non-fatal)",
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

  // McpLifecycleModule: start → start server, wire callbacks, configure ServerManager with
  // MCP port, inject into AppState. stop → dispose server, cleanup callbacks.
  let mcpFirstRequestCleanupFn: Unsubscribe | null = null;
  let wrapperReadyCleanupFn: Unsubscribe | null = null;
  const mcpLifecycleModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        lifecycleRefs.mcpServerManager.registerWorkspace({
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          workspacePath: payload.workspacePath,
        });
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        lifecycleRefs.mcpServerManager.unregisterWorkspace(payload.workspacePath);
      },
    },
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const refs = lifecycleRefs;

            const mcpPort = await refs.mcpServerManager.start();
            lifecycleLogger.info("MCP server started", {
              port: mcpPort,
              configPath: refs.pathProvider.opencodeConfig.toString(),
            });

            // Register callback for first MCP request per workspace
            mcpFirstRequestCleanupFn = refs.mcpServerManager.onFirstRequest((workspacePath) => {
              viewManager.setWorkspaceLoaded(workspacePath);
              refs.agentStatusManager.markActive(
                workspacePath as import("../shared/ipc").WorkspacePath
              );
            });

            // Register callback for wrapper start (Claude Code only)
            if (refs.selectedAgentType === "claude" && refs.serverManager) {
              const claudeServerManager = refs.serverManager as ClaudeCodeServerManager;
              if (claudeServerManager.onWorkspaceReady) {
                wrapperReadyCleanupFn = claudeServerManager.onWorkspaceReady((workspacePath) => {
                  viewManager.setWorkspaceLoaded(workspacePath);
                });
              }
            }

            // Configure server manager to connect to MCP
            if (refs.serverManager && refs.selectedAgentType === "claude") {
              const claudeManager = refs.serverManager as ClaudeCodeServerManager;
              claudeManager.setMcpConfig({
                port: refs.mcpServerManager.getPort()!,
              });
            } else if (refs.serverManager) {
              const opencodeManager = refs.serverManager as OpenCodeServerManager;
              opencodeManager.setMcpConfig({
                configPath: refs.pathProvider.opencodeConfig.toString(),
                port: refs.mcpServerManager.getPort()!,
              });
            }

            // Inject MCP server manager into AppState for onServerStopped cleanup
            lifecycleRefs.setMcpServerManager(refs.mcpServerManager);

            return { mcpPort };
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Cleanup callbacks
              if (mcpFirstRequestCleanupFn) {
                mcpFirstRequestCleanupFn();
                mcpFirstRequestCleanupFn = null;
              }
              if (wrapperReadyCleanupFn) {
                wrapperReadyCleanupFn();
                wrapperReadyCleanupFn = null;
              }

              // Dispose MCP server
              await lifecycleRefs.mcpServerManager.dispose();
            } catch (error) {
              lifecycleLogger.error(
                "MCP lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // TelemetryLifecycleModule: start → capture app_launched. stop → flush & shutdown.
  const telemetryLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            lifecycleRefs.telemetryService?.capture("app_launched", {
              platform: lifecycleRefs.platformInfo.platform,
              arch: lifecycleRefs.platformInfo.arch,
              isDevelopment: lifecycleRefs.buildInfo.isDevelopment,
              agent: lifecycleRefs.selectedAgentType,
            });
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (lifecycleRefs.telemetryService) {
                await lifecycleRefs.telemetryService.shutdown();
              }
            } catch (error) {
              lifecycleLogger.error(
                "Telemetry lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // AutoUpdaterLifecycleModule: start → start, wire update-available→title.
  // stop → dispose.
  const autoUpdaterLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const refs = lifecycleRefs;
            refs.autoUpdater.start();

            // Wire auto-updater to update window title when update is available
            refs.autoUpdater.onUpdateAvailable(() => {
              refs.windowManager.setUpdateAvailable();
              // Update the current title immediately
              const activeWorkspace = viewManager.getActiveWorkspacePath();
              const titleVersion = refs.buildInfo.gitBranch ?? refs.buildInfo.version;
              if (activeWorkspace) {
                const info = workspaceToProject.get(new Path(activeWorkspace).toString());
                const workspaceName = nodePath.basename(activeWorkspace);
                const title = formatWindowTitle(
                  info?.projectName,
                  workspaceName,
                  titleVersion,
                  true
                );
                refs.windowManager.setTitle(title);
              } else {
                const title = formatWindowTitle(undefined, undefined, titleVersion, true);
                refs.windowManager.setTitle(title);
              }
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
  // LocalProjectModule handles local paths; RemoteProjectModule handles URL-cloned projects.
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
  // ViewLifecycleModule: activate → wire loading-state→IPC callback.
  // stop → destroy views, cleanup loading-state callback, dispose layers.
  // Note: first workspace activation + window title are now handled by
  // project:open → workspace:switch dispatches during startup.
  let loadingChangeCleanupFn: Unsubscribe | null = null;
  const viewLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            // Wire loading state changes to IPC
            loadingChangeCleanupFn = viewManager.onLoadingChange(
              (path: string, loading: boolean) => {
                try {
                  const webContents = viewManager.getUIWebContents();
                  if (webContents && !webContents.isDestroyed()) {
                    const payload: WorkspaceLoadingChangedPayload = {
                      path: path as import("../shared/ipc").WorkspacePath,
                      loading,
                    };
                    webContents.send(ApiIpcChannels.WORKSPACE_LOADING_CHANGED, payload);
                  }
                } catch {
                  // Ignore errors - UI might be disconnected during shutdown
                }
              }
            );
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Cleanup loading state callback
              if (loadingChangeCleanupFn) {
                loadingChangeCleanupFn();
                loadingChangeCleanupFn = null;
              }

              // Dispose layers in reverse initialization order
              // Note: ViewManager.destroy() is called by cleanup() in index.ts
              // (ViewManager has concrete type there, IViewManager interface here)
              if (lifecycleRefs.viewLayer) {
                await lifecycleRefs.viewLayer.dispose();
              }
              if (lifecycleRefs.windowLayer) {
                await lifecycleRefs.windowLayer.dispose();
              }
              if (lifecycleRefs.sessionLayer) {
                await lifecycleRefs.sessionLayer.dispose();
              }
            } catch (error) {
              lifecycleLogger.error(
                "View lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };

  // MountModule: activate → send show-main-view to renderer, block until lifecycle.ready().
  // Wired last among activate handlers so config loading and callback wiring complete first.
  // collect() runs handlers sequentially, so mount blocks until the renderer signals ready.
  // After mount completes, project:open dispatches fire — the renderer is already subscribed.
  let mountResolve: (() => void) | null = null;
  const mountModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            const webContents = viewManager.getUIWebContents();
            if (!webContents || webContents.isDestroyed()) {
              lifecycleLogger.warn("UI not available for mount");
              return {};
            }
            lifecycleLogger.debug("Mounting renderer — waiting for lifecycle.ready");
            await new Promise<void>((resolve) => {
              mountResolve = resolve;
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW);
            });
            return {};
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
      agentStatusModule,
      uiHookModule,
      // Open-workspace hook modules (kept inline)
      keepFilesModule,
      agentModule,
      codeServerModule,
      viewModule,
      // Delete-workspace modules
      idempotencyModule,
      deleteViewModule,
      deleteAgentModule,
      deleteWindowsLockModule,
      deleteCodeServerModule,
      deleteIpcBridge,
      // Project:open modules
      localProjectModule,
      remoteProjectModule,
      gitWorktreeWorkspaceModule,
      projectViewModule,
      // Project:close modules
      projectCloseIndexModule,
      projectWorktreeCloseModule,
      // Workspace:switch modules
      switchViewModule,
      switchTitleModule,
      // App lifecycle modules
      codeServerLifecycleModule,
      agentLifecycleModule,
      badgeLifecycleModule,
      mcpLifecycleModule,
      telemetryLifecycleModule,
      autoUpdaterLifecycleModule,
      ipcBridgeLifecycleModule,
      viewLifecycleModule,
      mountModule,
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
          ...(payload.unblock !== undefined && { unblock: payload.unblock }),
          ...(payload.isRetry !== undefined && { isRetry: payload.isRetry }),
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
      // Resolve the mount promise so app:start activate completes
      // and project:open dispatches can fire (renderer is already subscribed).
      if (mountResolve) {
        mountResolve();
        mountResolve = null;
      }
    },
    { ipc: ApiIpcChannels.LIFECYCLE_READY }
  );

  // Return workspace resolver function for CoreModule
  return (
    projectId: ProjectId,
    workspaceName: import("../shared/api/types").WorkspaceName
  ): string => {
    const path = workspacesByKey.get(wsKey(projectId, workspaceName));
    if (!path) {
      throw new Error(`Workspace not found: ${workspaceName} in project ${projectId}`);
    }
    return path;
  };
}
