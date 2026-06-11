/**
 * ViewModule - Manages UI lifecycle, UI modes, workspace loading dialogs,
 * active-workspace bookkeeping, and shell layer disposal.
 *
 * Workspace surfaces are iframes inside the UI renderer's DOM, derived from
 * the renderer stores — this module no longer creates or destroys views per
 * workspace. What remains main-side:
 * - set-mode/set hook (mode state lives on the UiViewManager)
 * - app-start hooks (window + UI view creation, startup splash, mount signal)
 * - setup dialog hooks
 * - active-workspace bookkeeping (resolve/get-active/switch/delete/hibernate)
 * - per-workspace loading dialogs (created → agent:status-updated / timeout)
 * - app-shutdown/stop (dialog cleanup + UI view + layer disposal)
 *
 * Internal state: cachedActiveRef, activeWorkspacePath, loading bookkeeping.
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
import type { WorkspaceRef } from "../shared/api/types";
import type { SetModeIntent, SetModeHookResult } from "../intents/set-mode";
import { APP_START_OPERATION_ID, type ShowUIHookResult } from "../intents/app-start";
import type { AgentSelectionHookContext } from "../intents/setup";
import type { GetActiveWorkspaceHookResult } from "../intents/get-active-workspace";
import type {
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "../intents/switch-workspace";
import type { ShutdownHookResult, DeletePipelineHookInput } from "../intents/delete-workspace";
import type {
  HibernatePipelineHookInput,
  HibernateShutdownHookResult,
} from "../intents/hibernate-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  HIBERNATED_METADATA_KEY,
} from "../intents/hibernate-workspace";
import type { WorkspaceCreatedEvent } from "../intents/open-workspace";
import type { SelectFolderHookResult } from "../intents/open-project";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { SET_MODE_OPERATION_ID } from "../intents/set-mode";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { WORKSPACE_LOADING_TIMEOUT_MS } from "../boundaries/shell/view-manager.interface";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { SETUP_OPERATION_ID } from "../intents/setup";
import { EVENT_SETUP_PROGRESS, EVENT_SETUP_ERROR } from "../intents/setup";
import type { SetupProgressEvent, SetupErrorEvent } from "../intents/setup";
import { GET_ACTIVE_WORKSPACE_OPERATION_ID } from "../intents/get-active-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../intents/switch-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
} from "../intents/open-workspace";

import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import { ApiIpcChannels } from "../shared/ipc";
import type { LifecycleAgentType } from "../shared/ipc";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogConfig, DialogSection, ProgressItem } from "../shared/dialog-types";
import { SetupError } from "../shared/errors/service-errors";

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

  // Internal state
  let cachedActiveRef: WorkspaceRef | null = null;
  /**
   * The actual active surface, fed by the switch pipeline. Intentionally
   * distinct from `cachedActiveRef`, which is a UI-level cache that sticks
   * to the hibernating workspace during the fallbackToCurrent overlay window
   * (see hibernate-workspace.ts). The resolve hook reports this value;
   * delete/hibernate shutdown clears it so a later wake's switch is not
   * short-circuited as "already active".
   */
  let activeWorkspacePath: string | null = null;
  /** Capability: agentType provided by agent-selection handler. */
  let capAgentType: LifecycleAgentType | undefined;

  /** Track which workspaces are loading (not necessarily showing a dialog). */
  const loadingPaths = new Set<string>();
  /** Loading-timeout fallback per workspace (agent may never report). */
  const loadingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Currently visible loading dialog (only for active workspace).
   *  path is null when opened by workspace:loading before the workspace path is known. */
  let loadingDialog: { path: string | null; handle: DialogHandle } | null = null;
  /** Track the setup dialog handle (for show-ui/hide-ui). */
  let setupDialogHandle: DialogHandle | null = null;
  /**
   * Startup splash state — the "CodeHydra is starting..." dialog is held open
   * across renderer mount, project loading, and the first workspace becoming
   * ready (first agent:status-updated), so the user sees one unified loading
   * screen instead of starting → blank → projects-loading → workspace-loading.
   *
   * Closes on whichever fires first:
   *  - first `agent:status-updated` for any workspace
   *  - `app:started` event with no active workspace (empty-state path)
   *  - 10s fallback timeout
   *
   * While active, per-workspace "Loading workspace..." dialogs are suppressed
   * (the splash already covers the window). Subsequent workspace switches
   * show their own loading dialog as before.
   */
  let startupSplashActive = false;
  let startupSplashTimeout: ReturnType<typeof setTimeout> | null = null;
  function closeStartupSplash(): void {
    if (!startupSplashActive) return;
    startupSplashActive = false;
    if (startupSplashTimeout) {
      clearTimeout(startupSplashTimeout);
      startupSplashTimeout = null;
    }
    if (setupDialogHandle) {
      setupDialogHandle.close();
      setupDialogHandle = null;
    }
  }
  /** Accumulated setup row state (persists across progress events). */
  const setupRowState = new Map<
    string,
    { status: ProgressItem["status"]; message?: string; progress?: number }
  >();

  function openLoadingDialog(): DialogHandle | null {
    if (!deps.dialogManager) return null;
    return deps.dialogManager.open({
      sections: [
        {
          type: "progress",
          items: [{ id: "loading", label: "Loading workspace...", status: "running" }],
          style: "spinner",
        },
      ],
    });
  }

  /**
   * Mark a workspace as loading (from workspace:created until the agent's
   * first status report or the timeout fallback). Shows the loading dialog
   * only when the workspace is the active one and the splash isn't already
   * covering the window.
   */
  function startWorkspaceLoading(workspacePath: string): void {
    if (loadingPaths.has(workspacePath)) return;
    loadingPaths.add(workspacePath);
    loadingTimeouts.set(
      workspacePath,
      setTimeout(() => finishWorkspaceLoading(workspacePath), WORKSPACE_LOADING_TIMEOUT_MS)
    );

    const activePath = cachedActiveRef?.path ?? null;
    if (workspacePath === activePath && !startupSplashActive) {
      if (loadingDialog && loadingDialog.path === null) {
        // Associate path with dialog opened early by workspace:loading event
        loadingDialog = { path: workspacePath, handle: loadingDialog.handle };
      } else if (!loadingDialog) {
        const handle = openLoadingDialog();
        if (handle) loadingDialog = { path: workspacePath, handle };
      }
    }
  }

  /** Clear a workspace's loading state and close its dialog. Idempotent. */
  function finishWorkspaceLoading(workspacePath: string): void {
    const timeout = loadingTimeouts.get(workspacePath);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      loadingTimeouts.delete(workspacePath);
    }
    if (!loadingPaths.delete(workspacePath)) return;
    if (loadingDialog?.path === workspacePath) {
      loadingDialog.handle.close();
      loadingDialog = null;
    }
    logger.debug("Workspace loaded", { workspace: workspacePath });
  }

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
            if (deps.uiHtmlPath) {
              await viewManager.loadUIContent(deps.uiHtmlPath);
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
                modal: true,
              };
              setupDialogHandle = deps.dialogManager.open(config);
              startupSplashActive = true;
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
          // Gate the renderer mount on code-server being up: workspace URLs
          // shipped to the renderer must be servable when iframes mount.
          requires: { codeServerPort: ANY_VALUE },
          handler: async (): Promise<void> => {
            // Send show-main-view to trigger renderer mount.
            // The renderer will call lifecycle.ready() IPC when mounted,
            // which dispatches app:ready to load initial projects.
            if (!viewManager.isUIAvailable()) {
              logger.warn("UI not available for mount");
              return;
            }
            // Keep the startup splash visible through renderer mount + project
            // loading + first workspace ready. If setup ran, the splash was
            // closed during setup/show-ui — reopen it for the workspace-loading
            // phase. Closes via closeStartupSplash() from agent:status-updated,
            // app:started (no active workspace), or the timeout below.
            if (deps.dialogManager && !setupDialogHandle) {
              setupDialogHandle = deps.dialogManager.open({
                sections: [
                  {
                    type: "progress",
                    items: [
                      { id: "starting", label: "CodeHydra is starting...", status: "running" },
                    ],
                    style: "spinner",
                  },
                ],
                modal: true,
              });
              startupSplashActive = true;
            }
            if (startupSplashActive) {
              startupSplashTimeout = setTimeout(closeStartupSplash, WORKSPACE_LOADING_TIMEOUT_MS);
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
              // Close any existing setup dialog and reset accumulated state.
              // If the startup splash was open, this closes it — app-start/start
              // will reopen the splash after setup completes (via hide-ui).
              if (setupDialogHandle) {
                setupDialogHandle.close();
                setupDialogHandle = null;
              }
              startupSplashActive = false;
              if (startupSplashTimeout) {
                clearTimeout(startupSplashTimeout);
                startupSplashTimeout = null;
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
                modal: true,
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
                  type: "radio",
                  id: "agent",
                  options: availableAgents.map((a) => ({
                    id: a.agent,
                    label: a.label,
                    icon: a.icon,
                  })),
                },
                {
                  type: "group",
                  items: [{ type: "button", id: "select", label: "Continue", variant: "primary" }],
                },
              ],
              modal: true,
            };

            const handle = deps.dialogManager.open(config);
            const event = await handle.nextEvent(5 * 60_000);
            handle.close();

            const selectedAgent = event.data?.["agent"] ?? availableAgents[0]?.agent;
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
              modal: true,
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
      // resolve-workspace → resolve: contribute `active` snapshot
      //
      // Sourced from `activeWorkspacePath` (the actual active surface), not
      // from `cachedActiveRef` (a UI-level cache that intentionally sticks
      // to the hibernating workspace during the fallbackToCurrent overlay
      // window — see hibernate-workspace.ts). The switch operation uses this
      // flag to decide whether to short-circuit; hibernate's shutdown hook
      // clears it, otherwise wake would never re-activate the workspace.
      // -------------------------------------------------------------------
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const { workspacePath } = ctx as ResolveHookInput;
            return { active: activeWorkspacePath === workspacePath };
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
      // switch-workspace → activate: record the new active surface
      // (no-op if same). The renderer swaps the visible iframe when the
      // workspace:switched event lands, and routes focus itself (gated on
      // mode), so no view operation happens here.
      // -------------------------------------------------------------------
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath, active } = ctx as ActivateHookInput;

            if (active) {
              return {};
            }

            activeWorkspacePath = workspacePath;
            return { resolvedPath: workspacePath };
          },
        },
      },

      // -------------------------------------------------------------------
      // delete-workspace → shutdown: clear main-side workspace state.
      // The iframe itself unmounts in the renderer when workspace:removed
      // lands; main only reports wasActive (drives the post-delete
      // auto-switch) and clears its bookkeeping.
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { workspacePath, active } = ctx as DeletePipelineHookInput;
            finishWorkspaceLoading(workspacePath);
            if (activeWorkspacePath === workspacePath) {
              activeWorkspacePath = null;
            }
            return { ...(active && { wasActive: true }) };
          },
        },
      },

      // -------------------------------------------------------------------
      // hibernate-workspace → shutdown: clear main-side workspace state.
      // Clearing activeWorkspacePath here covers the fallbackToCurrent case
      // (hibernating the only workspace keeps it "active" for the overlay):
      // a later wake must not be short-circuited as already-active.
      // -------------------------------------------------------------------
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HibernateShutdownHookResult> => {
            const { workspacePath } = ctx as HibernatePipelineHookInput;
            finishWorkspaceLoading(workspacePath);
            if (activeWorkspacePath === workspacePath) {
              activeWorkspacePath = null;
            }
            return {};
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
            // Close loading dialog if open
            if (loadingDialog) {
              loadingDialog.handle.close();
              loadingDialog = null;
            }
            loadingPaths.clear();
            for (const timeout of loadingTimeouts.values()) {
              clearTimeout(timeout);
            }
            loadingTimeouts.clear();

            // Close setup dialog if open
            if (setupDialogHandle) {
              setupDialogHandle.close();
              setupDialogHandle = null;
            }
            if (startupSplashTimeout) {
              clearTimeout(startupSplashTimeout);
              startupSplashTimeout = null;
            }
            startupSplashActive = false;

            // Destroy the UI view before disposing layers (uses viewLayer internally)
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
          if (deps.dialogManager && !loadingDialog && !startupSplashActive) {
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
      // workspace:created → begin loading indication. The renderer mounts
      // the iframe (the event payload carries the code-server URL); main
      // only tracks the created → first-agent-status window for the
      // "Loading workspace..." dialog.
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceCreatedEvent).payload;
          // Hibernated workspaces have no runtime — nothing is loading.
          if (payload.metadata?.[HIBERNATED_METADATA_KEY] === "true") return;
          startWorkspaceLoading(payload.workspacePath);
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
            activeWorkspacePath = null;
          } else {
            cachedActiveRef = {
              projectId: payload.projectId,
              workspaceName: payload.workspaceName,
              path: payload.path,
            };
            activeWorkspacePath = payload.path;
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
          if (hasFailed) {
            sections.push({
              type: "group",
              items: [
                { type: "button", id: "retry", label: "Retry", variant: "primary" },
                { type: "button", id: "quit", label: "Quit", variant: "secondary" },
              ],
            });
          }
          const config: DialogConfig = { sections };
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
              {
                type: "group",
                items: [
                  { type: "button", id: "retry", label: "Retry", variant: "primary" },
                  { type: "button", id: "quit", label: "Quit", variant: "secondary" },
                ],
              },
            ],
            modal: true,
          };
          setupDialogHandle = deps.dialogManager.open(config);
          // Event handling is done in waitForRetry
        },
      },

      // -------------------------------------------------------------------
      // agent:status-updated → clear loading screen (idempotent)
      // Also closes the startup splash on the first such event — by the time
      // any agent reports status, at least one workspace is far enough along
      // to be visually meaningful.
      // -------------------------------------------------------------------
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as AgentStatusUpdatedEvent).payload;
          finishWorkspaceLoading(payload.workspace.path);
          closeStartupSplash();
        },
      },

      // -------------------------------------------------------------------
      // app:started → close startup splash if there's no workspace to wait
      // for. With workspaces present, the splash stays up until the first
      // agent:status-updated above (or the 10s timeout falls through).
      // -------------------------------------------------------------------
      [EVENT_APP_STARTED]: {
        handler: async (): Promise<void> => {
          if (!startupSplashActive) return;
          if (cachedActiveRef === null) {
            closeStartupSplash();
          }
        },
      },
    },
  };

  return module;
}
