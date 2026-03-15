/**
 * ViewModule - Manages workspace views, UI modes, loading states,
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
 * - viewLifecycleModule (app-start/start + app-shutdown/stop hooks)
 * - mountModule (app-start/start hook)
 * - wrapperReadyViewModule (agent:status-updated event → setWorkspaceLoaded)
 *
 * Internal state: cachedActiveRef, loadingChangeCleanupFn.
 */

import type { DialogLayer } from "../../services/platform/dialog";
import type { IntentModule } from "../intents/infrastructure/module";
import { ANY_VALUE, type HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IViewManager } from "../managers/view-manager.interface";
import type { Logger } from "../../services/logging";
import type { ViewLayer } from "../../services/shell/view";
import type { WindowLayerInternal } from "../../services/shell/window";
import type { SessionLayer } from "../../services/shell/session";
import type { IpcEventHandler, IpcLayer } from "../../services/platform/ipc";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { WorkspaceRef } from "../../shared/api/types";
import type { WorkspacePath, WorkspaceLoadingChangedPayload } from "../../shared/ipc";
import type { SetModeIntent, SetModeHookResult } from "../operations/set-mode";
import { APP_START_OPERATION_ID, type ShowUIHookResult } from "../operations/app-start";
import type { AgentSelectionHookContext } from "../operations/setup";
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
import { EVENT_APP_RESUMED } from "../operations/app-resume";
import { SETUP_OPERATION_ID } from "../operations/setup";
import { UPDATE_APPLY_OPERATION_ID, type UpdateChoiceResult } from "../operations/update-apply";
import { GET_ACTIVE_WORKSPACE_OPERATION_ID } from "../operations/get-active-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import { EVENT_PROJECT_OPENED } from "../operations/open-project";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { ConfigService } from "../../services/config/config-service";
import { configBoolean } from "../../services/config/config-definition";
import {
  ApiIpcChannels,
  type LifecycleAgentType,
  type ShowAgentSelectionPayload,
  type AgentSelectedPayload,
  type UpdateChoice,
  type UpdateChoicePayload,
} from "../../shared/ipc";
import { ApiIpcChannels as SetupIpcChannels } from "../../shared/ipc";
import { SetupError } from "../../services/errors";
import { getErrorMessage } from "../../shared/error-utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Dependencies for ViewModule.
 *
 * Shell layers are nullable because they may not exist in test environments
 * or when the app quits before full initialization.
 *
 * Lifecycle deps (menuLayer, windowManager, buildInfo, uiHtmlPath) are nullable
 * so existing call sites that don't need them pass unchanged.
 */
export interface ViewModuleDeps {
  readonly viewManager: IViewManager & { create(): void };
  readonly logger: Logger;
  readonly viewLayer: ViewLayer | null;
  readonly windowLayer: WindowLayerInternal | null;
  readonly sessionLayer: SessionLayer | null;
  readonly dialogLayer?: Pick<DialogLayer, "showOpenDialog"> | null;
  readonly ipcLayer?: Pick<IpcLayer, "on" | "removeListener"> | null;
  readonly menuLayer?: { setApplicationMenu(menu: null): void } | null;
  readonly windowManager?: {
    create(): void;
    maximizeAsync(): Promise<void>;
    focus(): void;
  } | null;
  readonly buildInfo?: {
    isDevelopment: boolean;
    gitBranch?: string;
  } | null;
  readonly uiHtmlPath?: string | null;
  readonly configService: ConfigService;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ViewModule that manages workspace views, UI modes, loading states,
 * and shell layer disposal.
 */
export function createViewModule(deps: ViewModuleDeps): IntentModule {
  const { viewManager, logger } = deps;

  // Register config key
  deps.configService.register("experimental.load-on-resume", {
    name: "experimental.load-on-resume",
    default: false,
    description: "Reload workspace views when system resumes from sleep",
    ...configBoolean(),
  });

  // Internal state
  let cachedActiveRef: WorkspaceRef | null = null;
  /** Capability: agentType provided by agent-selection handler. */
  let capAgentType: LifecycleAgentType | undefined;
  let loadingChangeCleanupFn: Unsubscribe | null = null;
  // loadOnResume is read from configService on demand

  const module: IntentModule = {
    name: "view",
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
      // app-start → init: Shell creation + UI loading (post-ready)
      // app-start → show-ui: send LIFECYCLE_SHOW_STARTING to renderer
      // app-start → start: wire loading change callback + mount signal
      // -------------------------------------------------------------------
      [APP_START_OPERATION_ID]: {
        init: {
          requires: { "app-ready": true },
          provides: () => ({ "ui-ready": true }),
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

            // Maximize and focus window
            if (deps.windowManager) {
              await deps.windowManager.maximizeAsync();
              deps.windowManager.focus();
            }

            // Load UI HTML
            if (deps.viewLayer && deps.uiHtmlPath) {
              await deps.viewLayer.loadURL(viewManager.getUIViewHandle(), deps.uiHtmlPath);
            }

            // Focus UI
            viewManager.focus();
          },
        },
        "show-ui": {
          handler: async (): Promise<ShowUIHookResult> => {
            viewManager.sendToUI(SetupIpcChannels.LIFECYCLE_SHOW_STARTING);
            if (!deps.ipcLayer) return {};
            const ipcLayer = deps.ipcLayer;
            return {
              waitForRetry: () =>
                new Promise<void>((resolve) => {
                  const handleRetry: IpcEventHandler = () => {
                    ipcLayer.removeListener(ApiIpcChannels.LIFECYCLE_RETRY, handleRetry);
                    resolve();
                  };
                  ipcLayer.on(ApiIpcChannels.LIFECYCLE_RETRY, handleRetry);
                }),
            };
          },
        },
        start: {
          requires: { codeServerPort: ANY_VALUE },
          handler: async (ctx: HookContext): Promise<void> => {
            // Update code-server port from capabilities
            const codeServerPort = ctx.capabilities?.codeServerPort as number | null;
            if (codeServerPort !== null) {
              viewManager.updateCodeServerPort(codeServerPort);
            }

            // Wire loading state changes to IPC
            loadingChangeCleanupFn = viewManager.onLoadingChange(
              (path: string, loading: boolean) => {
                const payload: WorkspaceLoadingChangedPayload = {
                  path: path as WorkspacePath,
                  loading,
                };
                viewManager.sendToUI(ApiIpcChannels.WORKSPACE_LOADING_CHANGED, payload);
              }
            );

            // Send show-main-view to trigger renderer mount.
            // The renderer will call lifecycle.ready() IPC when mounted,
            // which dispatches app:ready to load initial projects.
            if (!viewManager.isUIAvailable()) {
              logger.warn("UI not available for mount");
              return;
            }
            logger.debug("Mounting renderer");
            viewManager.sendToUI(SetupIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW);
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
            viewManager.sendToUI(SetupIpcChannels.LIFECYCLE_SHOW_SETUP);
          },
        },
        "agent-selection": {
          provides: () => ({
            ...(capAgentType !== undefined && { agentType: capAgentType }),
          }),
          handler: async (ctx: HookContext): Promise<void> => {
            capAgentType = undefined;
            const { availableAgents } = ctx as AgentSelectionHookContext;

            if (!viewManager.isUIAvailable()) {
              throw new SetupError("UI not available for agent selection", "TIMEOUT");
            }

            if (!deps.ipcLayer) {
              throw new SetupError("IPC layer not available for agent selection", "TIMEOUT");
            }

            const ipcLayer = deps.ipcLayer;
            logger.debug("Showing agent selection dialog");

            const agentPromise = new Promise<LifecycleAgentType>((resolve) => {
              const handleAgentSelected: IpcEventHandler = (_event, ...args) => {
                ipcLayer.removeListener(
                  SetupIpcChannels.LIFECYCLE_AGENT_SELECTED,
                  handleAgentSelected
                );
                const payload = args[0] as AgentSelectedPayload;
                resolve(payload.agent);
              };

              ipcLayer.on(SetupIpcChannels.LIFECYCLE_AGENT_SELECTED, handleAgentSelected);
            });

            const selectionPayload: ShowAgentSelectionPayload = {
              agents: availableAgents.map((a) => ({
                agent: a.agent,
                label: a.label,
                icon: a.icon,
              })),
            };
            viewManager.sendToUI(SetupIpcChannels.LIFECYCLE_SHOW_AGENT_SELECTION, selectionPayload);

            capAgentType = await agentPromise;
            logger.info("Agent selected", { agent: capAgentType });
          },
        },
        "hide-ui": {
          handler: async () => {
            viewManager.sendToUI(SetupIpcChannels.LIFECYCLE_SHOW_STARTING);
          },
        },
      },

      // -------------------------------------------------------------------
      // update-apply → await-choice: listen for user's update choice via IPC
      // -------------------------------------------------------------------
      [UPDATE_APPLY_OPERATION_ID]: {
        "await-choice": {
          handler: async (): Promise<UpdateChoiceResult> => {
            if (!deps.ipcLayer) {
              return {};
            }

            const ipcLayer = deps.ipcLayer;
            const choice = await new Promise<UpdateChoice>((resolve) => {
              const handler: IpcEventHandler = (_event, ...args) => {
                ipcLayer.removeListener(ApiIpcChannels.UPDATE_CHOICE, handler);
                resolve((args[0] as UpdateChoicePayload).choice);
              };
              ipcLayer.on(ApiIpcChannels.UPDATE_CHOICE, handler);
            });

            return { choice };
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
          },
        },
      },
    },

    events: {
      // -------------------------------------------------------------------
      // workspace:created → create view + preload URL
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
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

      // -------------------------------------------------------------------
      // workspace:switched → update cachedActiveRef + handle null (clear)
      // Merged from uiHookModule + switchViewModule event handlers.
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceSwitchedEvent).payload;
          if (payload === null) {
            cachedActiveRef = null;
            viewManager.setActiveWorkspace(null);
          } else {
            cachedActiveRef = {
              projectId: payload.projectId,
              workspaceName: payload.workspaceName,
              path: payload.path,
            };
          }
        },
      },

      // -------------------------------------------------------------------
      // project:opened → preload non-first workspaces
      // -------------------------------------------------------------------
      [EVENT_PROJECT_OPENED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as ProjectOpenedEvent).payload;
          const workspaces = payload.project.workspaces;
          for (let i = 1; i < workspaces.length; i++) {
            viewManager.preloadWorkspaceUrl(workspaces[i]!.path);
          }
        },
      },

      // -------------------------------------------------------------------
      // agent:status-updated → clear loading screen (idempotent)
      // -------------------------------------------------------------------
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as AgentStatusUpdatedEvent).payload;
          viewManager.setWorkspaceLoaded(payload.workspacePath);
        },
      },

      // -------------------------------------------------------------------
      // app:resumed → reload workspace views (gated by config)
      // -------------------------------------------------------------------
      [EVENT_APP_RESUMED]: {
        handler: async (): Promise<void> => {
          const loadOnResume = deps.configService.get("experimental.load-on-resume") as boolean;
          if (!loadOnResume) return;
          logger.info("Reloading workspace views after system resume");
          viewManager.reloadAllViews();
        },
      },
    },
  };

  return module;
}
