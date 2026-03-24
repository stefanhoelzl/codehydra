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

import type { DialogBoundary } from "../boundaries/shell/dialog";
import type { IntentModule } from "../intents/lib/module";
import { ANY_VALUE, type HookContext } from "../intents/lib/operation";
import type { DomainEvent } from "../intents/lib/types";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { Logger } from "../boundaries/platform/logging";
import type { ViewBoundary } from "../boundaries/shell/view";
import type { WindowBoundaryInternal } from "../boundaries/shell/window";
import type { SessionBoundary } from "../boundaries/shell/session";
import type { IpcBoundary } from "../boundaries/shell/ipc";
import type { Unsubscribe } from "../shared/api/interfaces";
import type { WorkspaceRef } from "../shared/api/types";
import type { SetModeIntent, SetModeHookResult } from "../intents/set-mode";
import { APP_START_OPERATION_ID, type ShowUIHookResult } from "../intents/app-start";
import type { AgentSelectionHookContext } from "../intents/setup";
import type { GetActiveWorkspaceHookResult } from "../intents/get-active-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "../intents/switch-workspace";
import type {
  DeleteWorkspaceIntent,
  ShutdownHookResult,
  DeletePipelineHookInput,
} from "../intents/delete-workspace";
import type { WorkspaceCreatedEvent } from "../intents/open-workspace";
import type { ProjectOpenedEvent, SelectFolderHookResult } from "../intents/open-project";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { SET_MODE_OPERATION_ID } from "../intents/set-mode";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { EVENT_APP_RESUMED } from "../intents/app-resume";
import { SETUP_OPERATION_ID } from "../intents/setup";
import { EVENT_SETUP_PROGRESS, EVENT_SETUP_ERROR } from "../intents/setup";
import type { SetupProgressEvent, SetupErrorEvent } from "../intents/setup";
import { GET_ACTIVE_WORKSPACE_OPERATION_ID } from "../intents/get-active-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../intents/switch-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
} from "../intents/open-workspace";

import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { EVENT_PROJECT_OPENED } from "../intents/open-project";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { Config } from "../boundaries/platform/config";
import { configBoolean } from "../boundaries/platform/config-definition";
import { ApiIpcChannels } from "../shared/ipc";
import type { LifecycleAgentType } from "../shared/ipc";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogConfig, DialogSection, ProgressItem } from "../shared/dialog-types";
import { SetupError } from "../shared/errors/service-errors";
import { getErrorMessage } from "../shared/error-utils";

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
  readonly viewLayer: ViewBoundary | null;
  readonly windowLayer: WindowBoundaryInternal | null;
  readonly sessionLayer: SessionBoundary | null;
  readonly dialogLayer?: Pick<DialogBoundary, "showOpenDialog"> | null;
  readonly ipcLayer?: Pick<IpcBoundary, "on" | "removeListener"> | null;
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
  readonly configService: Config;
  readonly dialogManager?: DialogManager;
  readonly dispatcher?: Dispatcher;
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

  // Register config keys
  deps.configService.register("experimental.load-on-resume", {
    name: "experimental.load-on-resume",
    default: false,
    description: "Reload workspace views when system resumes from sleep",
    ...configBoolean(),
  });
  deps.configService.register("experimental.disable-bg-throttling", {
    name: "experimental.disable-bg-throttling",
    default: false,
    description:
      "Disable background throttling on workspace views (fixes agent startup on Windows)",
    ...configBoolean(),
  });

  // Internal state
  let cachedActiveRef: WorkspaceRef | null = null;
  /** Capability: agentType provided by agent-selection handler. */
  let capAgentType: LifecycleAgentType | undefined;
  let loadingChangeCleanupFn: Unsubscribe | null = null;
  // loadOnResume is read from configService on demand

  /** Track which workspaces are loading (not necessarily showing a dialog). */
  const loadingPaths = new Set<string>();
  /** Currently visible loading dialog (only for active workspace).
   *  path is null when opened by workspace:loading before the workspace path is known. */
  let loadingDialog: { path: string | null; handle: DialogHandle } | null = null;
  /** Track the setup dialog handle (for show-ui/hide-ui). */
  let setupDialogHandle: DialogHandle | null = null;
  /** Accumulated setup row state (persists across progress events). */
  const setupRowState = new Map<
    string,
    { status: ProgressItem["status"]; message?: string; progress?: number }
  >();

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
            // Open a "starting" dialog via DialogManager
            if (deps.dialogManager) {
              const config: DialogConfig = {
                sections: [
                  {
                    type: "progress",
                    items: [
                      { id: "starting", label: "CodeHydra is starting...", status: "running" },
                    ],
                    style: "spinner",
                  },
                ],
              };
              setupDialogHandle = deps.dialogManager.open(config);
            }
            if (!deps.dialogManager) return {};
            return {
              waitForRetry: () =>
                new Promise<void>((resolve) => {
                  // Called after error handler has opened an error dialog with retry/quit
                  // actions and stored the handle in setupDialogHandle.
                  if (!setupDialogHandle) {
                    resolve();
                    return;
                  }
                  setupDialogHandle.onEvent((evt) => {
                    if (evt.actionId === "retry") {
                      setupDialogHandle?.close();
                      setupDialogHandle = null;
                      resolve();
                    } else if (evt.actionId === "quit") {
                      setupDialogHandle?.close();
                      setupDialogHandle = null;
                      if (deps.dispatcher) {
                        void deps.dispatcher.dispatch({
                          type: INTENT_APP_SHUTDOWN,
                          payload: {},
                        } as AppShutdownIntent);
                      }
                    }
                  });
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

            // Wire loading state changes — track silently, show dialog only for active workspace
            loadingChangeCleanupFn = viewManager.onLoadingChange(
              (path: string, loading: boolean) => {
                if (!deps.dialogManager) return;
                if (loading) {
                  loadingPaths.add(path);
                  // Show dialog only if this is the active workspace
                  const activePath = cachedActiveRef?.path ?? null;
                  if (path === activePath) {
                    if (loadingDialog && loadingDialog.path === null) {
                      // Associate path with dialog opened early by workspace:loading event
                      loadingDialog = { path, handle: loadingDialog.handle };
                    } else if (!loadingDialog) {
                      const handle = deps.dialogManager.open({
                        sections: [
                          {
                            type: "progress",
                            items: [
                              {
                                id: "loading",
                                label: "Loading workspace...",
                                status: "running",
                              },
                            ],
                            style: "spinner",
                          },
                        ],
                      });
                      loadingDialog = { path, handle };
                    }
                  }
                } else {
                  loadingPaths.delete(path);
                  // Close dialog if it's for this workspace
                  if (loadingDialog?.path === path) {
                    loadingDialog.handle.close();
                    loadingDialog = null;
                  }
                }
              }
            );

            // Send show-main-view to trigger renderer mount.
            // The renderer will call lifecycle.ready() IPC when mounted,
            // which dispatches app:ready to load initial projects.
            if (!viewManager.isUIAvailable()) {
              logger.warn("UI not available for mount");
              return;
            }
            // Close starting/setup dialog before mounting
            if (setupDialogHandle) {
              setupDialogHandle.close();
              setupDialogHandle = null;
            }

            logger.debug("Mounting renderer");
            viewManager.sendToUI(ApiIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW);
          },
        },
      },

      // -------------------------------------------------------------------
      // setup → show-ui: open setup dialog via DialogManager
      // setup → agent-selection: open selection dialog via DialogManager
      // setup → hide-ui: close setup dialog
      // -------------------------------------------------------------------
      [SETUP_OPERATION_ID]: {
        "show-ui": {
          handler: async () => {
            if (deps.dialogManager) {
              // Close any existing setup dialog and reset accumulated state
              if (setupDialogHandle) {
                setupDialogHandle.close();
              }
              setupRowState.clear();
              const config: DialogConfig = {
                sections: [
                  { type: "text", content: "Setting up CodeHydra", style: "heading" },
                  {
                    type: "text",
                    content: "This is only required on first startup.",
                    style: "subtitle",
                  },
                  {
                    type: "progress",
                    items: [
                      { id: "vscode", label: "VSCode", status: "pending" },
                      { id: "agent", label: "Agent", status: "pending" },
                      { id: "setup", label: "Setup", status: "pending" },
                    ],
                  },
                ],
              };
              setupDialogHandle = deps.dialogManager.open(config);
            }
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

            if (!deps.dialogManager) {
              throw new SetupError("DialogManager not available for agent selection", "TIMEOUT");
            }

            logger.debug("Showing agent selection dialog");

            // Close existing setup dialog to show selection dialog
            if (setupDialogHandle) {
              setupDialogHandle.close();
              setupDialogHandle = null;
            }

            // Build selection dialog config
            const config: DialogConfig = {
              sections: [
                { type: "text", content: "Choose Agent", style: "heading" },
                {
                  type: "selection",
                  options: availableAgents.map((a) => ({
                    id: a.agent,
                    label: a.label,
                    icon: a.icon,
                  })),
                },
              ],
              actions: [{ id: "select", label: "Continue", variant: "primary" }],
            };

            const handle = deps.dialogManager.open(config);
            const event = await handle.nextEvent(5 * 60_000);
            handle.close();

            const selectedAgent =
              (event.data?.["selection"] as string) ?? availableAgents[0]?.agent;
            capAgentType = selectedAgent as LifecycleAgentType;
            logger.info("Agent selected", { agent: capAgentType });

            // Re-open setup progress dialog for binary/extensions hooks
            const labelMap: Record<string, string> = {
              vscode: "VSCode",
              agent: "Agent",
              setup: "Setup",
            };
            const rowIds = ["vscode", "agent", "setup"];
            const items: ProgressItem[] = rowIds.map((id) => {
              const state = setupRowState.get(id);
              return {
                id,
                label: labelMap[id] ?? id,
                status: state?.status ?? "pending",
                ...(state?.message !== undefined && { message: state.message }),
                ...(state?.progress !== undefined && { progress: state.progress }),
              };
            });
            setupDialogHandle = deps.dialogManager.open({
              sections: [
                { type: "text", content: "Setting up CodeHydra", style: "heading" },
                { type: "progress", items },
              ],
            });
          },
        },
        "hide-ui": {
          handler: async () => {
            // Close setup dialog, return to starting state
            if (setupDialogHandle) {
              setupDialogHandle.close();
              setupDialogHandle = null;
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
            // Cleanup loading state callback
            if (loadingChangeCleanupFn) {
              loadingChangeCleanupFn();
              loadingChangeCleanupFn = null;
            }

            // Close loading dialog if open
            if (loadingDialog) {
              loadingDialog.handle.close();
              loadingDialog = null;
            }
            loadingPaths.clear();

            // Close setup dialog if open
            if (setupDialogHandle) {
              setupDialogHandle.close();
              setupDialogHandle = null;
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
      // workspace:loading → open loading dialog before slow work begins
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_LOADING]: {
        handler: async (): Promise<void> => {
          if (deps.dialogManager && !loadingDialog) {
            const handle = deps.dialogManager.open({
              sections: [
                {
                  type: "progress",
                  items: [{ id: "loading", label: "Loading workspace...", status: "running" }],
                  style: "spinner",
                },
              ],
            });
            loadingDialog = { path: null, handle };
          }
        },
      },

      // -------------------------------------------------------------------
      // workspace:create-failed → close loading dialog on error
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_CREATE_FAILED]: {
        handler: async (): Promise<void> => {
          if (loadingDialog?.path === null) {
            loadingDialog.handle.close();
            loadingDialog = null;
          }
        },
      },

      // -------------------------------------------------------------------
      // workspace:created → create view + preload URL
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceCreatedEvent).payload;
          const disableBgThrottling = deps.configService.get(
            "experimental.disable-bg-throttling"
          ) as boolean;
          viewManager.createWorkspaceView(
            payload.workspacePath,
            payload.workspaceUrl,
            payload.projectPath,
            true,
            { disableBgThrottling }
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
          const newPath = payload?.path ?? null;

          // Show/hide loading dialog based on active workspace
          if (deps.dialogManager) {
            if (loadingDialog && loadingDialog.path !== newPath) {
              loadingDialog.handle.close();
              loadingDialog = null;
            }
            if (newPath && loadingPaths.has(newPath) && !loadingDialog) {
              const handle = deps.dialogManager.open({
                sections: [
                  {
                    type: "progress",
                    items: [{ id: "loading", label: "Loading workspace...", status: "running" }],
                    style: "spinner",
                  },
                ],
              });
              loadingDialog = { path: newPath, handle };
            }
          }

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
      // setup:progress → update setup dialog with progress
      // -------------------------------------------------------------------
      [EVENT_SETUP_PROGRESS]: {
        handler: async (event: DomainEvent): Promise<void> => {
          if (!setupDialogHandle) return;
          const row = (event as SetupProgressEvent).payload;

          // Map SetupRowStatus → ProgressItem status ("failed" → "error", rest pass through)
          const status: ProgressItem["status"] = row.status === "failed" ? "error" : row.status;

          // Accumulate per-row state across events
          setupRowState.set(row.id, {
            status,
            ...(row.message !== undefined && { message: row.message }),
            ...(row.progress !== undefined && { progress: row.progress }),
          });

          const labelMap: Record<string, string> = {
            vscode: "VSCode",
            agent: "Agent",
            setup: "Setup",
          };
          const rowIds = ["vscode", "agent", "setup"];
          const items: ProgressItem[] = rowIds.map((id) => {
            const state = setupRowState.get(id);
            return {
              id,
              label: labelMap[id] ?? id,
              status: state?.status ?? "pending",
              ...(state?.message !== undefined && { message: state.message }),
              ...(state?.progress !== undefined && { progress: state.progress }),
            };
          });

          const hasFailed = [...setupRowState.values()].some((s) => s.status === "error");
          const sections: DialogSection[] = [
            { type: "text", content: "Setting up CodeHydra", style: "heading" },
            { type: "progress", items },
          ];
          const config: DialogConfig = {
            sections,
            ...(hasFailed && {
              actions: [
                { id: "retry", label: "Retry" },
                { id: "quit", label: "Quit", variant: "secondary" },
              ],
            }),
          };
          setupDialogHandle.update(config);
        },
      },

      // -------------------------------------------------------------------
      // setup:error → open error dialog with retry/quit actions
      // -------------------------------------------------------------------
      [EVENT_SETUP_ERROR]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { message } = (event as SetupErrorEvent).payload;
          if (!deps.dialogManager) return;

          // Close existing setup dialog
          if (setupDialogHandle) {
            setupDialogHandle.close();
          }

          // Open error dialog with retry/quit actions
          const config: DialogConfig = {
            sections: [
              { type: "text", content: "Setup Failed", style: "heading", icon: "error" },
              { type: "text", content: message },
            ],
            actions: [
              { id: "retry", label: "Retry", variant: "primary" },
              { id: "quit", label: "Quit", variant: "secondary" },
            ],
          };
          setupDialogHandle = deps.dialogManager.open(config);
          // Event handling is done in waitForRetry
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
