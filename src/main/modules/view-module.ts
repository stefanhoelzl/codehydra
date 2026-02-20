/**
 * ViewModule - Manages workspace views, UI modes, loading states, mount coordination,
 * and shell layer disposal.
 *
 * Consolidates 11 inline bootstrap modules into a single extracted module:
 * - earlySetModeModule (set-mode/set hook)
 * - appStartUIModule (app-start/show-ui hook)
 * - setupUIModule (setup/show-ui + setup/hide-ui hooks)
 * - uiHookModule (get-active-workspace/get hook + workspace:switched event)
 * - viewModule (workspace:created event)
 * - deleteViewModule (delete-workspace/shutdown hook)
 * - switchViewModule (switch-workspace/activate hook + workspace:switched event)
 * - projectViewModule (project:opened event)
 * - viewLifecycleModule (app-start/activate + app-shutdown/stop hooks)
 * - mountModule (app-start/activate hook)
 * - wrapperReadyViewModule (agent:status-updated event → setWorkspaceLoaded)
 *
 * Also owns the lifecycle.ready handler (merged from LifecycleReadyModule):
 * - app:started event resolves projectsLoadedPromise
 * - readyHandler resolves mountSignal and awaits projectsLoadedPromise
 *
 * Internal state: cachedActiveRef, loadingChangeCleanupFn, mountSignal,
 * projectsLoadedPromise.
 */

import { Path } from "../../services/platform/path";
import type { DialogLayer } from "../../services/platform/dialog";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IViewManager } from "../managers/view-manager.interface";
import type { Logger } from "../../services/logging";
import type { ViewLayer } from "../../services/shell/view";
import type { WindowLayerInternal } from "../../services/shell/window";
import type { SessionLayer } from "../../services/shell/session";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { WorkspaceRef } from "../../shared/api/types";
import type { WorkspacePath, WorkspaceLoadingChangedPayload } from "../../shared/ipc";
import type { SetModeIntent, SetModeHookResult } from "../operations/set-mode";
import {
  APP_START_OPERATION_ID,
  EVENT_APP_STARTED,
  type ConfigureResult,
  type ShowUIHookResult,
  type ActivateHookContext,
  type ActivateHookResult,
} from "../operations/app-start";
import type { GetActiveWorkspaceHookResult } from "../operations/get-active-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "../operations/switch-workspace";
import type {
  DeleteWorkspaceIntent,
  ShutdownHookResult,
  DeletePipelineHookInput,
} from "../operations/delete-workspace";
import type { WorkspaceCreatedEvent } from "../operations/open-workspace";
import type { ProjectOpenedEvent, SelectFolderHookResult } from "../operations/open-project";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { SET_MODE_OPERATION_ID } from "../operations/set-mode";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { GET_ACTIVE_WORKSPACE_OPERATION_ID } from "../operations/get-active-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import { EVENT_PROJECT_OPENED } from "../operations/open-project";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import { ApiIpcChannels } from "../../shared/ipc";
import { ApiIpcChannels as SetupIpcChannels } from "../../shared/ipc";
import { getErrorMessage } from "../../shared/error-utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Mount coordination signal used internally by ViewModule.
 */
interface MountSignal {
  /** Set by mountModule's activate handler; called by readyHandler. */
  resolve: (() => void) | null;
}

/**
 * Dependencies for ViewModule.
 *
 * Shell layers are nullable because they may not exist in test environments
 * or when the app quits before full initialization.
 *
 * Lifecycle deps (menuLayer, windowManager, buildInfo, pathProvider, uiHtmlPath,
 * electronApp, devToolsHandler) are nullable so existing call sites that
 * don't need them pass unchanged.
 */
export interface ViewModuleDeps {
  readonly viewManager: IViewManager & { create(): void };
  readonly logger: Logger;
  readonly viewLayer: ViewLayer | null;
  readonly windowLayer: WindowLayerInternal | null;
  readonly sessionLayer: SessionLayer | null;
  readonly dialogLayer?: Pick<DialogLayer, "showOpenDialog"> | null;
  readonly menuLayer?: { setApplicationMenu(menu: null): void } | null;
  readonly windowManager?: {
    create(): void;
    maximizeAsync(): Promise<void>;
  } | null;
  readonly buildInfo?: {
    isPackaged: boolean;
    isDevelopment: boolean;
    gitBranch?: string;
  } | null;
  readonly pathProvider?: { electronDataDir: { toNative(): string } } | null;
  readonly uiHtmlPath?: string | null;
  readonly electronApp?: {
    commandLine: { appendSwitch(key: string, value?: string): void };
    setPath(name: string, path: string): void;
  } | null;
  readonly devToolsHandler?: (() => void) | null;
}

/**
 * Result of createViewModule.
 */
export interface ViewModuleResult {
  readonly module: IntentModule;
  /** Handler for the lifecycle.ready API method. Call from registry.register(). */
  readonly readyHandler: () => Promise<void>;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parses Electron command-line flags from a string.
 * @param flags - Space-separated flags string (e.g., "--disable-gpu --use-gl=swiftshader")
 * @returns Array of parsed flags
 * @throws Error if quotes are detected (not supported)
 */
export function parseElectronFlags(flags: string | undefined): { name: string; value?: string }[] {
  if (!flags || !flags.trim()) {
    return [];
  }

  if (flags.includes('"') || flags.includes("'")) {
    throw new Error(
      "Quoted values are not supported in CODEHYDRA_ELECTRON_FLAGS. " +
        'Use --flag=value instead of --flag="value".'
    );
  }

  const result: { name: string; value?: string }[] = [];
  const parts = flags.trim().split(/\s+/);

  for (const part of parts) {
    const withoutDashes = part.replace(/^--?/, "");
    const eqIndex = withoutDashes.indexOf("=");
    if (eqIndex !== -1) {
      result.push({
        name: withoutDashes.substring(0, eqIndex),
        value: withoutDashes.substring(eqIndex + 1),
      });
    } else {
      result.push({ name: withoutDashes });
    }
  }

  return result;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ViewModule that manages workspace views, UI modes, loading states,
 * mount coordination, and shell layer disposal.
 */
export function createViewModule(deps: ViewModuleDeps): ViewModuleResult {
  const { viewManager, logger } = deps;

  // Internal state
  let cachedActiveRef: WorkspaceRef | null = null;
  let loadingChangeCleanupFn: Unsubscribe | null = null;
  const mountSignal: MountSignal = { resolve: null };
  let projectsLoadedResolve: (() => void) | null = null;
  const projectsLoadedPromise = new Promise<void>((resolve) => {
    projectsLoadedResolve = resolve;
  });

  const module: IntentModule = {
    hooks: {
      // -------------------------------------------------------------------
      // ui:set-mode → set: capture previous mode, apply new mode
      // -------------------------------------------------------------------
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

      // -------------------------------------------------------------------
      // app-start → configure: Electron configuration (pre-ready)
      // app-start → init: Shell creation + UI loading (post-ready)
      // app-start → show-ui: send LIFECYCLE_SHOW_STARTING to renderer
      // app-start → activate: wire loading change callback + mount signal
      // -------------------------------------------------------------------
      [APP_START_OPERATION_ID]: {
        configure: {
          handler: async (): Promise<ConfigureResult> => {
            // Disable ASAR when not packaged
            if (deps.buildInfo && !deps.buildInfo.isPackaged) {
              process.noAsar = true;
            }
            if (deps.electronApp) {
              // Apply Electron flags from environment
              const flags = parseElectronFlags(process.env.CODEHYDRA_ELECTRON_FLAGS);
              for (const flag of flags) {
                deps.electronApp.commandLine.appendSwitch(
                  flag.name,
                  ...(flag.value !== undefined ? [flag.value] : [])
                );
                logger.info("Applied Electron flag", {
                  flag: flag.name,
                  ...(flag.value !== undefined && { value: flag.value }),
                });
              }
              // Redirect data paths to isolate from system defaults
              if (deps.pathProvider) {
                const electronDir = new Path(deps.pathProvider.electronDataDir.toNative());
                for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
                  deps.electronApp.setPath(name, new Path(electronDir, name).toNative());
                }
              }
            }
            return {};
          },
        },
        init: {
          handler: async (): Promise<void> => {
            // Disable application menu
            if (deps.menuLayer) {
              deps.menuLayer.setApplicationMenu(null);
            }

            // Create window and views
            if (deps.windowManager) {
              deps.windowManager.create();
            }
            viewManager.create();

            // Maximize window
            if (deps.windowManager) {
              await deps.windowManager.maximizeAsync();
            }

            // Load UI HTML
            if (deps.viewLayer && deps.uiHtmlPath) {
              await deps.viewLayer.loadURL(viewManager.getUIViewHandle(), deps.uiHtmlPath);
            }

            // Focus UI
            viewManager.focusUI();

            // Set up devtools handler
            if (deps.devToolsHandler) {
              deps.devToolsHandler();
            }
          },
        },
        "show-ui": {
          handler: async (): Promise<ShowUIHookResult> => {
            const webContents = viewManager.getUIWebContents();
            if (webContents && !webContents.isDestroyed()) {
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_STARTING);
            }
            return {};
          },
        },
        activate: {
          handler: async (ctx: HookContext): Promise<ActivateHookResult> => {
            // Update code-server port from start results
            const { codeServerPort } = ctx as ActivateHookContext;
            if (codeServerPort !== null) {
              viewManager.updateCodeServerPort(codeServerPort);
            }

            // Wire loading state changes to IPC
            loadingChangeCleanupFn = viewManager.onLoadingChange(
              (path: string, loading: boolean) => {
                try {
                  const webContents = viewManager.getUIWebContents();
                  if (webContents && !webContents.isDestroyed()) {
                    const payload: WorkspaceLoadingChangedPayload = {
                      path: path as WorkspacePath,
                      loading,
                    };
                    webContents.send(ApiIpcChannels.WORKSPACE_LOADING_CHANGED, payload);
                  }
                } catch {
                  // Ignore errors - UI might be disconnected during shutdown
                }
              }
            );

            // Mount: send show-main-view and block until lifecycle.ready resolves
            const webContents = viewManager.getUIWebContents();
            if (!webContents || webContents.isDestroyed()) {
              logger.warn("UI not available for mount");
              return {};
            }
            logger.debug("Mounting renderer — waiting for lifecycle.ready");
            await new Promise<void>((resolve) => {
              mountSignal.resolve = resolve;
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW);
            });
            return {};
          },
        },
      },

      // -------------------------------------------------------------------
      // setup → show-ui: send LIFECYCLE_SHOW_SETUP
      // setup → hide-ui: send LIFECYCLE_SHOW_STARTING (return to starting)
      // -------------------------------------------------------------------
      [SETUP_OPERATION_ID]: {
        "show-ui": {
          handler: async () => {
            const webContents = viewManager.getUIWebContents();
            if (webContents && !webContents.isDestroyed()) {
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_SETUP);
            }
          },
        },
        "hide-ui": {
          handler: async () => {
            const webContents = viewManager.getUIWebContents();
            if (webContents && !webContents.isDestroyed()) {
              // Return to starting screen
              webContents.send(SetupIpcChannels.LIFECYCLE_SHOW_STARTING);
            }
          },
        },
      },

      // -------------------------------------------------------------------
      // get-active-workspace → get: return cached active ref
      // -------------------------------------------------------------------
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<GetActiveWorkspaceHookResult> => {
            return { workspaceRef: cachedActiveRef };
          },
        },
      },

      // -------------------------------------------------------------------
      // switch-workspace → activate: setActiveWorkspace (no-op if same)
      // -------------------------------------------------------------------
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

      // -------------------------------------------------------------------
      // delete-workspace → shutdown: destroy workspace view
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            const isActive = viewManager.getActiveWorkspacePath() === workspacePath;

            try {
              await viewManager.destroyWorkspaceView(workspacePath);
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

      // -------------------------------------------------------------------
      // open-project → select-folder: show folder dialog
      // -------------------------------------------------------------------
      [OPEN_PROJECT_OPERATION_ID]: {
        "select-folder": {
          handler: async (): Promise<SelectFolderHookResult> => {
            if (!deps.dialogLayer) {
              return { folderPath: null };
            }
            const result = await deps.dialogLayer.showOpenDialog({
              properties: ["openDirectory"] as const,
            });
            if (result.canceled || result.filePaths.length === 0) {
              return { folderPath: null };
            }
            return { folderPath: result.filePaths[0]!.toString() };
          },
        },
      },

      // -------------------------------------------------------------------
      // app-shutdown → stop: cleanup + layer disposal
      // -------------------------------------------------------------------
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              // Cleanup loading state callback
              if (loadingChangeCleanupFn) {
                loadingChangeCleanupFn();
                loadingChangeCleanupFn = null;
              }

              // Destroy all views before disposing layers (uses viewLayer internally)
              viewManager.destroy();

              // Dispose layers in reverse initialization order
              if (deps.viewLayer) {
                await deps.viewLayer.dispose();
              }
              if (deps.windowLayer) {
                await deps.windowLayer.dispose();
              }
              if (deps.sessionLayer) {
                await deps.sessionLayer.dispose();
              }
            } catch (error) {
              logger.error(
                "View lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },

    events: {
      // -------------------------------------------------------------------
      // workspace:created → create view + preload URL
      // -------------------------------------------------------------------
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

      // -------------------------------------------------------------------
      // workspace:switched → update cachedActiveRef + handle null (clear)
      // Merged from uiHookModule + switchViewModule event handlers.
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        if (payload === null) {
          cachedActiveRef = null;
          viewManager.setActiveWorkspace(null, false);
        } else {
          cachedActiveRef = {
            projectId: payload.projectId,
            workspaceName: payload.workspaceName,
            path: payload.path,
          };
        }
      },

      // -------------------------------------------------------------------
      // project:opened → preload non-first workspaces
      // -------------------------------------------------------------------
      [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
        const payload = (event as ProjectOpenedEvent).payload;
        const workspaces = payload.project.workspaces;
        for (let i = 1; i < workspaces.length; i++) {
          viewManager.preloadWorkspaceUrl(workspaces[i]!.path);
        }
      },

      // -------------------------------------------------------------------
      // agent:status-updated → clear loading screen (idempotent)
      // -------------------------------------------------------------------
      [EVENT_AGENT_STATUS_UPDATED]: (event: DomainEvent) => {
        const payload = (event as AgentStatusUpdatedEvent).payload;
        viewManager.setWorkspaceLoaded(payload.workspacePath);
      },

      // -------------------------------------------------------------------
      // app:started → resolve projectsLoadedPromise
      // -------------------------------------------------------------------
      [EVENT_APP_STARTED]: () => {
        if (projectsLoadedResolve) {
          projectsLoadedResolve();
          projectsLoadedResolve = null;
        }
      },
    },
  };

  const readyHandler = async (): Promise<void> => {
    if (mountSignal.resolve) {
      mountSignal.resolve();
      mountSignal.resolve = null;
      await projectsLoadedPromise;
    }
  };

  return { module, readyHandler };
}
