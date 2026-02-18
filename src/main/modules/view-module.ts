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
 * Internal state: cachedActiveRef, loadingChangeCleanupFn, mountSignal.
 */

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
import type { ShowUIHookResult, ActivateHookResult } from "../operations/app-start";
import type { GetActiveWorkspaceHookResult } from "../operations/get-active-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "../operations/switch-workspace";
import type { DeleteWorkspaceIntent, ShutdownHookResult } from "../operations/delete-workspace";
import type { WorkspaceCreatedEvent } from "../operations/open-workspace";
import type { ProjectOpenedEvent } from "../operations/open-project";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { SET_MODE_OPERATION_ID } from "../operations/set-mode";
import { APP_START_OPERATION_ID } from "../operations/app-start";
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
 * Mount coordination signal shared between ViewModule and wireDispatcher's
 * lifecycle.ready handler.
 */
export interface MountSignal {
  /** Set by mountModule's activate handler; called by lifecycle.ready handler. */
  resolve: (() => void) | null;
}

/**
 * Dependencies for ViewModule.
 *
 * Shell layers are nullable because they may not exist in test environments
 * or when the app quits before full initialization.
 */
export interface ViewModuleDeps {
  readonly viewManager: IViewManager;
  readonly logger: Logger;
  readonly viewLayer: ViewLayer | null;
  readonly windowLayer: WindowLayerInternal | null;
  readonly sessionLayer: SessionLayer | null;
}

/**
 * Result of createViewModule.
 */
export interface ViewModuleResult {
  readonly module: IntentModule;
  readonly mountSignal: MountSignal;
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
      // app-start → show-ui: send LIFECYCLE_SHOW_STARTING to renderer
      // app-start → activate: wire loading change callback + mount signal
      // -------------------------------------------------------------------
      [APP_START_OPERATION_ID]: {
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
          handler: async (): Promise<ActivateHookResult> => {
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
    },
  };

  return { module, mountSignal };
}
