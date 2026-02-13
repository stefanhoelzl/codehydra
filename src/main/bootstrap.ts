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
import type { SetMetadataIntent } from "./operations/set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./operations/get-metadata";
import type { GetMetadataIntent, GetMetadataHookResult } from "./operations/get-metadata";
import {
  GetWorkspaceStatusOperation,
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
} from "./operations/get-workspace-status";
import type {
  GetWorkspaceStatusIntent,
  GetStatusHookResult,
} from "./operations/get-workspace-status";
import {
  GetAgentSessionOperation,
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "./operations/get-agent-session";
import type {
  GetAgentSessionIntent,
  GetAgentSessionHookResult,
} from "./operations/get-agent-session";
import {
  RestartAgentOperation,
  RESTART_AGENT_OPERATION_ID,
  INTENT_RESTART_AGENT,
} from "./operations/restart-agent";
import type { RestartAgentIntent, RestartAgentHookResult } from "./operations/restart-agent";
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
  CreateWorkspaceOperation,
  CREATE_WORKSPACE_OPERATION_ID,
  INTENT_CREATE_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
} from "./operations/create-workspace";
import type {
  CreateWorkspaceIntent,
  CreateHookResult,
  SetupHookInput,
  SetupHookResult,
  FinalizeHookInput,
  FinalizeHookResult,
  WorkspaceCreatedEvent,
} from "./operations/create-workspace";
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
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
} from "./operations/open-project";
import type {
  OpenProjectIntent,
  ResolveHookResult,
  DiscoverHookInput,
  DiscoverHookResult,
  RegisterHookInput,
  RegisterHookResult,
  ProjectOpenedEvent,
} from "./operations/open-project";
import {
  CloseProjectOperation,
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
} from "./operations/close-project";
import type {
  CloseProjectIntent,
  CloseResolveHookResult,
  CloseHookInput,
  CloseHookResult,
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
  WorkspaceSwitchedEvent,
} from "./operations/switch-workspace";
import { createIpcEventBridge, type WorkspaceResolver } from "./modules/ipc-event-bridge";
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
import { wirePluginApi } from "./api/wire-plugin-api";
import type { UpdateAgentStatusIntent } from "./operations/update-agent-status";
import type { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { OpenCodeServerManager } from "../agents/opencode/server-manager";
import type { Unsubscribe } from "../shared/api/interfaces";
import { wireModules } from "./intents/infrastructure/wire";
import {
  resolveWorkspace,
  resolveProjectPath,
  generateProjectId,
  extractWorkspaceName,
} from "./api/id-utils";
import type { IntentModule } from "./intents/infrastructure/module";
import type { HookContext } from "./intents/infrastructure/operation";
import type { Intent, DomainEvent } from "./intents/infrastructure/types";
import type { AppState } from "./app-state";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import type { IKeepFilesService } from "../services/keepfiles";
import type { IWorkspaceFileService, IWorkspaceProvider } from "../services";
import type { WorkspaceLockHandler } from "../services/platform/workspace-lock-handler";
import type { DeletionProgressCallback } from "./operations/delete-workspace";
import { getErrorMessage } from "../shared/error-utils";
import {
  normalizeInitialPrompt,
  type BlockingProcess,
  type SetupRowId,
  type SetupRowProgress,
  type SetupRowStatus,
} from "../shared/api/types";
import type { Workspace as InternalWorkspace } from "../services/git/types";
import { Path } from "../services/platform/path";
import {
  expandGitUrl,
  generateProjectIdFromUrl,
  extractRepoName,
} from "../services/project/url-utils";
import { ProjectScopedWorkspaceProvider } from "../services/git/project-scoped-provider";

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
  /** Workspace resolver for IPC event bridge (resolves workspace path to project/name) */
  readonly workspaceResolverFn: () => import("./modules/ipc-event-bridge").WorkspaceResolver;
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

    const coreDeps = deps.coreDepsFn();

    // Create remaining modules
    const coreModule = new CoreModule(registry, coreDeps);
    modules.push(coreModule);

    // Wire remaining operations (hookRegistry and dispatcher already available)
    wireDispatcher(
      registry,
      hookRegistry,
      dispatcher,
      deps.globalWorktreeProviderFn(),
      coreDeps,
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
      deps.workspaceResolverFn(),
      deps.lifecycleRefsFn()
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
// Workspace Switching Helper
// =============================================================================

/**
 * Prioritized workspace selection algorithm.
 * Returns the best workspace to switch to when the active workspace is being deleted,
 * or null if no other workspace is available.
 */
export async function findNextWorkspace(
  currentWorkspacePath: string,
  appState: AppState
): Promise<{
  projectId: import("../shared/api/types").ProjectId;
  workspaceName: import("../shared/api/types").WorkspaceName;
} | null> {
  const allProjects = await appState.getAllProjects();

  // Build sorted list (projects alphabetically, workspaces alphabetically)
  const sortedProjects = [...allProjects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { caseFirst: "upper" })
  );

  const workspaces: Array<{ path: string; projectPath: string }> = [];
  for (const project of sortedProjects) {
    const sortedWs = [...project.workspaces].sort((a, b) => {
      const nameA = extractWorkspaceName(a.path);
      const nameB = extractWorkspaceName(b.path);
      return nameA.localeCompare(nameB, undefined, { caseFirst: "upper" });
    });
    for (const ws of sortedWs) {
      workspaces.push({ path: ws.path, projectPath: project.path });
    }
  }

  if (workspaces.length === 0) {
    return null;
  }

  // Find current workspace index
  const currentIndex = workspaces.findIndex((w) => w.path === currentWorkspacePath);
  if (currentIndex === -1) {
    return null;
  }

  // Score by agent status: idle=0, busy=1, none=2
  const agentStatusManager = appState.getAgentStatusManager();
  const getKey = (ws: { path: string }, index: number): number => {
    let statusKey: number;
    const status = agentStatusManager?.getStatus(ws.path as WorkspacePath);
    if (!status || status.status === "none") {
      statusKey = 2;
    } else if (status.status === "busy") {
      statusKey = 1;
    } else {
      statusKey = 0; // idle or mixed
    }

    const positionKey = (index - currentIndex + workspaces.length) % workspaces.length;
    return statusKey * workspaces.length + positionKey;
  };

  // Find best candidate (excluding current)
  let bestWorkspace: { path: string; projectPath: string } | undefined;
  let bestKey = Infinity;

  for (let i = 0; i < workspaces.length; i++) {
    if (i === currentIndex) continue;
    const key = getKey(workspaces[i]!, i);
    if (key < bestKey) {
      bestKey = key;
      bestWorkspace = workspaces[i];
    }
  }

  if (!bestWorkspace) {
    return null;
  }

  return {
    projectId: generateProjectId(bestWorkspace.projectPath),
    workspaceName: extractWorkspaceName(
      bestWorkspace.path
    ) as import("../shared/api/types").WorkspaceName,
  };
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
  workspaceResolver: WorkspaceResolver,
  lifecycleRefs: LifecycleServiceRefs
): void {
  const { appState, viewManager, gitClient, pathProvider, projectStore } = coreDeps;
  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_CREATE_WORKSPACE, new CreateWorkspaceOperation());
  dispatcher.registerOperation(
    INTENT_DELETE_WORKSPACE,
    new DeleteWorkspaceOperation(emitDeletionProgress)
  );
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
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
          handler: async (ctx: HookContext): Promise<GetMetadataHookResult> => {
            const intent = ctx.intent as GetMetadataIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const metadata = await globalProvider.getMetadata(new Path(workspace.path));
            return { metadata };
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
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const intent = ctx.intent as GetWorkspaceStatusIntent;
            const { projectPath, workspace } = await resolveWorkspace(intent.payload, appState);
            const provider = appState.getWorkspaceProvider(projectPath);
            const isDirty = provider ? await provider.isDirty(new Path(workspace.path)) : false;
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
            const intent = ctx.intent as GetWorkspaceStatusIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const agentStatusManager = appState.getAgentStatusManager();
            if (agentStatusManager) {
              return { agentStatus: agentStatusManager.getStatus(workspace.path as WorkspacePath) };
            }
            return {};
          },
        },
      },
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult> => {
            const intent = ctx.intent as GetAgentSessionIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const agentStatusManager = appState.getAgentStatusManager();
            const session = agentStatusManager?.getSession(workspace.path as WorkspacePath) ?? null;
            return { session };
          },
        },
      },
      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult> => {
            const intent = ctx.intent as RestartAgentIntent;
            const { workspace } = await resolveWorkspace(intent.payload, appState);
            const serverManager = appState.getServerManager();
            if (!serverManager) {
              throw new Error("Agent server manager not available");
            }
            const result = await serverManager.restartServer(workspace.path);
            if (result.success) {
              return { port: result.port, workspacePath: workspace.path };
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
            const activeWorkspacePath = viewManager.getActiveWorkspacePath();
            if (!activeWorkspacePath) {
              return { workspaceRef: null };
            }

            const project = appState.findProjectForWorkspace(activeWorkspacePath);
            if (!project) {
              return { workspaceRef: null };
            }

            const projectId = generateProjectId(project.path);
            const workspaceName = extractWorkspaceName(activeWorkspacePath);

            return {
              workspaceRef: {
                projectId,
                workspaceName,
                path: activeWorkspacePath,
              },
            };
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Create-workspace hook modules
  // ---------------------------------------------------------------------------

  // WorktreeModule: "create" hook -- creates git worktree, returns CreateHookResult
  // When existingWorkspace is set, returns context from existing data (skips worktree creation)
  const worktreeModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext): Promise<CreateHookResult> => {
            const intent = ctx.intent as CreateWorkspaceIntent;

            // Existing workspace path: return context from existing data
            if (intent.payload.existingWorkspace) {
              const existing = intent.payload.existingWorkspace;
              return {
                workspacePath: existing.path,
                branch: existing.branch ?? existing.name,
                metadata: existing.metadata,
                projectPath: intent.payload.projectPath!,
              };
            }

            const projectPath = await resolveProjectPath(intent.payload.projectId, appState);
            if (!projectPath) {
              throw new Error(`Project not found: ${intent.payload.projectId}`);
            }

            const provider = appState.getWorkspaceProvider(projectPath);
            if (!provider) {
              throw new Error(`No workspace provider for project: ${intent.payload.projectId}`);
            }

            const internalWorkspace: InternalWorkspace = await provider.createWorkspace(
              intent.payload.name,
              intent.payload.base
            );

            return {
              workspacePath: internalWorkspace.path.toString(),
              branch: internalWorkspace.branch ?? internalWorkspace.name,
              metadata: internalWorkspace.metadata,
              projectPath,
            };
          },
        },
      },
    },
  };

  // KeepFilesModule: "setup" hook -- copies .keepfiles to workspace (best-effort)
  const keepFilesModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
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
      [CREATE_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as CreateWorkspaceIntent;
            const workspacePath = setupCtx.workspacePath;

            // 1. Start agent server
            const serverManager = appState.getServerManager();
            if (serverManager) {
              await serverManager.startServer(workspacePath);

              // 2. Wait for provider registration (handleServerStarted runs async)
              await appState.waitForProvider(workspacePath);

              // 3. Set initial prompt if provided (must happen after startServer)
              if (intent.payload.initialPrompt && serverManager.setInitialPrompt) {
                const normalizedPrompt = normalizeInitialPrompt(intent.payload.initialPrompt);
                await serverManager.setInitialPrompt(workspacePath, normalizedPrompt);
              }
            }

            // 4. Get environment variables from agent provider
            const agentStatusManager = appState.getAgentStatusManager();
            const agentProvider = agentStatusManager?.getProvider(workspacePath as WorkspacePath);
            return { envVars: agentProvider?.getEnvironmentVariables() ?? {} };
          },
        },
      },
    },
  };

  // CodeServerModule: "finalize" hook -- creates .code-workspace file, returns workspaceUrl
  const codeServerModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<FinalizeHookResult> => {
            const finalizeCtx = ctx as FinalizeHookInput;
            const workspaceUrl = await appState.getWorkspaceUrl(
              finalizeCtx.workspacePath,
              finalizeCtx.envVars
            );
            return { workspaceUrl };
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Create-workspace event subscriber modules
  // ---------------------------------------------------------------------------

  // StateModule: subscribes to workspace:created, registers workspace in app state
  const stateModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        const internalWorkspace: InternalWorkspace = {
          name: payload.workspaceName,
          path: new Path(payload.workspacePath),
          branch: payload.branch,
          metadata: payload.metadata,
        };
        appState.registerWorkspace(payload.projectPath, internalWorkspace);
        appState.setLastBaseBranch(payload.projectPath, payload.base);
      },
    },
  };

  // ViewModule: subscribes to workspace:created, creates workspace view
  // Note: workspace activation is now handled by CreateWorkspaceOperation dispatching workspace:switch
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
            let nextSwitch: ShutdownHookResult["nextSwitch"];

            try {
              // Populate nextSwitch for the operation to dispatch
              if (isActive && !payload.skipSwitch) {
                const next = await findNextWorkspace(payload.workspacePath, appState);
                nextSwitch = next;
                // Deactivate immediately if no next (operation will emit null event)
                if (!next) {
                  viewManager.setActiveWorkspace(null, false);
                }
              }

              await viewManager.destroyWorkspaceView(payload.workspacePath);

              return {
                ...(isActive && { wasActive: true }),
                ...(nextSwitch !== undefined && { nextSwitch }),
              };
            } catch (error) {
              if (payload.force) {
                logger.warn("ViewModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {
                  ...(isActive && { wasActive: true }),
                  ...(nextSwitch !== undefined && { nextSwitch }),
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
              const serverManager = appState.getServerManager();
              if (serverManager) {
                const stopResult = await serverManager.stopServer(payload.workspacePath);
                if (!stopResult.success) {
                  serverError = stopResult.error ?? "Failed to stop server";
                  if (!payload.force) {
                    throw new Error(serverError);
                  }
                }
              }

              // Clear MCP tracking
              const mcpServerManager = appState.getMcpServerManager();
              if (mcpServerManager) {
                mcpServerManager.clearWorkspace(payload.workspacePath);
              }

              // Clear TUI tracking
              const agentStatusManager = appState.getAgentStatusManager();
              if (agentStatusManager) {
                agentStatusManager.clearTuiTracking(payload.workspacePath as WorkspacePath);
              }

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

  const deleteWorktreeModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const provider = appState.getWorkspaceProvider(payload.projectPath);
              if (provider) {
                await provider.removeWorkspace(
                  new Path(payload.workspacePath),
                  !payload.keepBranch
                );
              }
              return {};
            } catch (error) {
              if (payload.force) {
                logger.warn("WorktreeModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { error: getErrorMessage(error) };
              }

              // Reactive blocker detection on Windows for ANY cleanup error
              let reactiveBlockingProcesses: readonly BlockingProcess[] | undefined;
              if (workspaceLockHandler) {
                try {
                  const detected = await workspaceLockHandler.detect(
                    new Path(payload.workspacePath)
                  );
                  if (detected.length > 0) {
                    reactiveBlockingProcesses = detected;
                    logger.info("Detected blocking processes", {
                      workspacePath: payload.workspacePath,
                      count: detected.length,
                    });
                  }
                } catch (detectError) {
                  logger.warn("Failed to detect blocking processes", {
                    workspacePath: payload.workspacePath,
                    error: getErrorMessage(detectError),
                  });
                }
              }

              return {
                ...(reactiveBlockingProcesses && { reactiveBlockingProcesses }),
                error: getErrorMessage(error),
              };
            }
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

  const deleteStateModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        appState.unregisterWorkspace(payload.projectPath, payload.workspacePath);
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
  // Project:open idempotency interceptor
  // ---------------------------------------------------------------------------

  const inProgressOpens = new Set<string>();

  const openIdempotencyModule: IntentModule = {
    interceptors: [
      {
        id: "project-open-idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_OPEN_PROJECT) {
            return intent;
          }
          const { path, git } = (intent as OpenProjectIntent).payload;

          // Use expanded URL as key for git (so it matches remoteUrl in cleanup)
          const key = path ? path.toString() : expandGitUrl(git!);

          if (path && appState.isProjectOpen(path.toString())) {
            return null;
          }

          if (inProgressOpens.has(key)) {
            return null;
          }

          inProgressOpens.add(key);
          return intent;
        },
      },
    ],
    events: {
      [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
        const { project } = (event as ProjectOpenedEvent).payload;
        inProgressOpens.delete(project.path);
        if (project.remoteUrl) {
          inProgressOpens.delete(project.remoteUrl);
        }
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Project:open hook modules
  // ---------------------------------------------------------------------------

  // ProjectResolverModule: "resolve" hook -- clone if URL, validate git
  const projectResolverModule: IntentModule = {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git } = intent.payload;

            let projectPath: Path;
            let remoteUrl: string | undefined;

            if (git) {
              const expanded = expandGitUrl(git);

              // Check if we already have a project from this URL
              const existingPath = await projectStore.findByRemoteUrl(expanded);
              if (existingPath) {
                logger.debug("Found existing project for URL", {
                  url: expanded,
                  existingPath,
                });
                projectPath = new Path(existingPath);
              } else {
                // Clone the repository into remotes/ directory
                const urlProjectId = generateProjectIdFromUrl(expanded);
                const repoName = extractRepoName(expanded);
                const remotesDirPath = pathProvider.remotesDir;
                const projectDir = new Path(remotesDirPath, urlProjectId);
                const gitPath = new Path(projectDir.toString(), repoName);

                logger.debug("Cloning repository", {
                  url: expanded,
                  gitPath: gitPath.toString(),
                });

                await gitClient.clone(expanded, gitPath);

                // Save to project store with remoteUrl
                await projectStore.saveProject(gitPath.toString(), {
                  remoteUrl: expanded,
                });

                projectPath = gitPath;
              }

              remoteUrl = expanded;
            } else {
              projectPath = path!;
            }

            // Validate git repo
            await globalProvider.validateRepository(projectPath);

            return {
              projectPath: projectPath.toString(),
              ...(remoteUrl !== undefined && { remoteUrl }),
            };
          },
        },
      },
    },
  };

  // ProjectDiscoveryModule: "discover" hook -- discover workspaces, orphan cleanup
  const projectDiscoveryModule: IntentModule = {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        discover: {
          handler: async (ctx: HookContext): Promise<DiscoverHookResult> => {
            const { projectPath } = ctx as DiscoverHookInput;
            const projectPathObj = new Path(projectPath);
            const workspacesDir = pathProvider.getProjectWorkspacesDir(projectPathObj);
            const provider: IWorkspaceProvider = new ProjectScopedWorkspaceProvider(
              globalProvider,
              projectPathObj,
              workspacesDir
            );

            const workspaces = await provider.discover();

            // Fire-and-forget cleanup
            if (provider.cleanupOrphanedWorkspaces) {
              void provider.cleanupOrphanedWorkspaces().catch((err: unknown) => {
                logger.error(
                  "Workspace cleanup failed",
                  { projectPath },
                  err instanceof Error ? err : undefined
                );
              });
            }

            return { workspaces };
          },
        },
      },
    },
  };

  // ProjectRegistryModule: "register" hook -- generate ID, load config, store state, persist
  const projectRegistryModule: IntentModule = {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        register: {
          handler: async (ctx: HookContext): Promise<RegisterHookResult> => {
            const { projectPath: projectPathStr, remoteUrl: resolvedRemoteUrl } =
              ctx as RegisterHookInput;
            const projectPath = new Path(projectPathStr);

            // Generate project ID
            const projectId = generateProjectId(projectPathStr);

            // Load project config for remoteUrl
            const projectConfig = await projectStore.getProjectConfig(projectPathStr);
            let remoteUrl = resolvedRemoteUrl;
            if (projectConfig?.remoteUrl) {
              remoteUrl = projectConfig.remoteUrl;
            }

            // Create provider for AppState registration
            const workspacesDir = pathProvider.getProjectWorkspacesDir(projectPath);
            const provider: IWorkspaceProvider = new ProjectScopedWorkspaceProvider(
              globalProvider,
              projectPath,
              workspacesDir
            );

            // Register in AppState
            appState.registerProject({
              id: projectId,
              name: projectPath.basename,
              path: projectPath,
              workspaces: [],
              provider,
              ...(remoteUrl !== undefined && { remoteUrl }),
            });

            // Get and cache default base branch
            let defaultBaseBranch: string | undefined;
            const baseBranch = await appState.getDefaultBaseBranch(projectPathStr);
            if (baseBranch) {
              appState.setLastBaseBranch(projectPathStr, baseBranch);
              defaultBaseBranch = baseBranch;
            }

            // Persist to store if new
            if (!projectConfig) {
              await projectStore.saveProject(projectPathStr);
            }

            return {
              projectId,
              ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
              ...(remoteUrl !== undefined && { remoteUrl }),
            };
          },
        },
      },
    },
  };

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

  // ProjectResolveModule: "resolve" hook -- resolves projectId to path, loads config, gets workspaces
  const projectResolveModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<CloseResolveHookResult> => {
            const intent = ctx.intent as CloseProjectIntent;

            const projectPath = await resolveProjectPath(intent.payload.projectId, appState);
            if (!projectPath) {
              throw new Error(`Project not found: ${intent.payload.projectId}`);
            }

            const projectConfig = await projectStore.getProjectConfig(projectPath);
            const project = appState.getProject(projectPath);

            return {
              projectPath,
              removeLocalRepo: intent.payload.removeLocalRepo ?? false,
              workspaces: project?.workspaces ?? [],
              ...(projectConfig?.remoteUrl !== undefined && { remoteUrl: projectConfig.remoteUrl }),
            };
          },
        },
      },
    },
  };

  // ProjectCloseViewModule: "close" hook -- clears active workspace if no other projects
  // Note: workspace:switched(null) is emitted by CloseProjectOperation, not here
  const projectCloseViewModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath } = ctx as CloseHookInput;
            const allProjects = await appState.getAllProjects();
            const otherProjectsExist = allProjects.some((p) => p.path !== projectPath);
            if (!otherProjectsExist) {
              viewManager.setActiveWorkspace(null, false);
            }
            return { otherProjectsExist };
          },
        },
      },
    },
  };

  // ProjectCloseManagerModule: "close" hook -- dispose provider, delete dir
  const projectCloseManagerModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, removeLocalRepo, remoteUrl } = ctx as CloseHookInput;

            // Dispose workspace provider
            const provider = appState.getWorkspaceProvider(projectPath);
            if (provider instanceof ProjectScopedWorkspaceProvider) {
              provider.dispose();
            }

            // If removeLocalRepo + remoteUrl: delete project directory
            if (removeLocalRepo && remoteUrl) {
              logger.debug("Deleting cloned project directory", {
                projectPath,
              });
              await projectStore.deleteProjectDirectory(projectPath, {
                isClonedProject: true,
              });
            }

            return {};
          },
        },
      },
    },
  };

  // ProjectCloseRegistryModule: "close" hook -- remove from state + store
  const projectCloseRegistryModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath } = ctx as CloseHookInput;

            // Remove from AppState
            appState.deregisterProject(projectPath);

            // Remove from persistent storage
            try {
              await projectStore.removeProject(projectPath);
            } catch {
              // Fail silently as per requirements
            }

            return {};
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Workspace:switch hook modules
  // ---------------------------------------------------------------------------

  // SwitchViewModule: "activate" hook -- resolves workspace, calls setActiveWorkspace
  // When the workspace is already active, resolvedPath is left undefined (no-op).
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const intent = ctx.intent as SwitchWorkspaceIntent;
            const { workspace, projectPath } = await resolveWorkspace(intent.payload, appState);

            // No-op: already the active workspace -- return empty result
            if (viewManager.getActiveWorkspacePath() === workspace.path) {
              return {};
            }

            const focus = intent.payload.focus ?? true;
            viewManager.setActiveWorkspace(workspace.path, focus);
            return { resolvedPath: workspace.path, projectPath };
          },
        },
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

        const project = appState.findProjectForWorkspace(payload.path);
        const title = formatWindowTitle(
          project?.name,
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
                    appState
                      .getAgentStatusManager()
                      ?.getEnvironmentVariables(
                        workspacePath as import("../shared/ipc").WorkspacePath
                      ) ?? null;
                  const agentType = appState.getAgentType() ?? null;
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

            // Update ViewManager and AppState with code-server port
            viewManager.updateCodeServerPort(port);
            appState.updateCodeServerPort(port);

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
                void lifecycleRefs.dispatcher.dispatch({
                  type: INTENT_UPDATE_AGENT_STATUS,
                  payload: { workspacePath, status },
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

            // Inject MCP server manager into AppState
            appState.setMcpServerManager(refs.mcpServerManager);

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
                const project = appState.findProjectForWorkspace(activeWorkspace);
                const workspaceName = nodePath.basename(activeWorkspace);
                const title = formatWindowTitle(project?.name, workspaceName, titleVersion, true);
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
  const ipcBridgeLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const api = lifecycleRefs.getApi();

            // Wire API events to IPC emission
            apiEventCleanupFn = wireApiEvents(api, () => viewManager.getUIWebContents());

            // Wire PluginServer to CodeHydraApi (if PluginServer is running)
            if (lifecycleRefs.pluginServer) {
              wirePluginApi(
                lifecycleRefs.pluginServer,
                api,
                appState,
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

  // DataLifecycleModule: activate → gather saved project paths and return them.
  // The AppStartOperation dispatches project:open for each path after the activate hook.
  const dataLifecycleModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            const projectPaths = await projectStore.loadAllProjects();
            return { projectPaths };
          },
        },
      },
    },
  };

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
            loadingChangeCleanupFn = viewManager.onLoadingChange((path, loading) => {
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
            });
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

  // ShowMainViewModule: finalize → tell renderer to show main view.
  // Must run AFTER project:open dispatches (loads projects, sets active workspace)
  // so the renderer's initial projects.list query returns the full project list.
  const showMainViewModule: IntentModule = {
    hooks: {
      [APP_START_OPERATION_ID]: {
        finalize: {
          handler: async () => {
            const webContents = viewManager.getUIWebContents();
            if (!webContents || webContents.isDestroyed()) {
              lifecycleLogger.warn("UI not available to show main view");
              return;
            }
            lifecycleLogger.debug("Showing main view");
            webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW);
          },
        },
      },
    },
  };

  // Wire IpcEventBridge, BadgeModule, and hook handler modules
  // Note: shutdownIdempotencyModule and quitModule are wired early in initializeBootstrap()
  const ipcEventBridge = createIpcEventBridge(registry, workspaceResolver);
  const badgeModule = createBadgeModule(badgeManager);
  wireModules(
    [
      ipcEventBridge,
      badgeModule,
      metadataModule,
      gitStatusModule,
      agentStatusModule,
      uiHookModule,
      worktreeModule,
      keepFilesModule,
      agentModule,
      codeServerModule,
      stateModule,
      viewModule,
      // Delete-workspace modules
      idempotencyModule,
      deleteViewModule,
      deleteAgentModule,
      deleteWindowsLockModule,
      deleteWorktreeModule,
      deleteCodeServerModule,
      deleteStateModule,
      deleteIpcBridge,
      // Project:open modules
      openIdempotencyModule,
      projectResolverModule,
      projectDiscoveryModule,
      projectRegistryModule,
      projectViewModule,
      // Project:close modules
      projectResolveModule,
      projectCloseViewModule,
      projectCloseManagerModule,
      projectCloseRegistryModule,
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
      dataLifecycleModule,
      viewLifecycleModule,
      showMainViewModule,
    ],
    hookRegistry,
    dispatcher
  );

  // Register dispatcher bridge handlers in the API registry
  registry.register(
    "workspaces.create",
    async (payload: WorkspaceCreatePayload) => {
      const intent: CreateWorkspaceIntent = {
        type: INTENT_CREATE_WORKSPACE,
        payload: {
          projectId: payload.projectId,
          name: payload.name,
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
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_CREATE }
  );

  registry.register(
    "workspaces.remove",
    async (payload: WorkspaceRemovePayload) => {
      // Resolve workspace to get paths needed for intent payload
      const { projectPath, workspace } = await resolveWorkspace(payload, appState);

      const intent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          workspacePath: workspace.path,
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
      const intent: OpenProjectIntent = {
        type: INTENT_OPEN_PROJECT,
        payload: { path: new Path(payload.path) },
      };
      const handle = dispatcher.dispatch(intent);
      if (!(await handle.accepted)) {
        // Idempotency: project already open, return current state
        const project = appState.getProject(payload.path);
        if (project) {
          return project as import("../shared/api/types").Project;
        }
        throw new Error("Project open was cancelled");
      }
      const result = await handle;
      if (!result) {
        throw new Error("Open project dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.PROJECT_OPEN }
  );

  registry.register(
    "projects.clone",
    async (payload: ProjectClonePayload) => {
      const intent: OpenProjectIntent = {
        type: INTENT_OPEN_PROJECT,
        payload: { git: payload.url },
      };
      const handle = dispatcher.dispatch(intent);
      if (!(await handle.accepted)) {
        throw new Error("Clone was cancelled (project may already be open)");
      }
      const result = await handle;
      if (!result) {
        throw new Error("Clone project dispatch returned no result");
      }
      return result;
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
}
