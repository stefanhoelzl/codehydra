/**
 * ViewModule - Manages the UI shell lifecycle, active-workspace bookkeeping,
 * and shell layer disposal.
 *
 * Workspace surfaces are iframes inside the UI renderer's DOM, derived from
 * the UiState snapshot — this module no longer creates or destroys views per
 * workspace. The four startup surfaces (boot splash, setup progress,
 * agent-selection, workspace loading) are owned by the presenter now (pushed
 * as UiState `main` kinds), not DialogManager dialogs. What remains here:
 * - app-start `init` hook (window + UI view creation, HTML load, focus)
 * - active-workspace bookkeeping (resolve/get-active/switch/delete/hibernate)
 * - open-project `select-folder` (native folder picker)
 * - app-shutdown/stop (UI view + layer disposal)
 *
 * Internal state: cachedActiveRef, activeWorkspacePath.
 */

import type { DialogBoundary } from "../boundaries/shell/dialog";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { DomainEvent } from "../intents/lib/types";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { Logger } from "../boundaries/platform/logging";
import type { ViewBoundary } from "../boundaries/shell/view";
import type { WindowBoundary } from "../boundaries/shell/window";
import type { SessionBoundary } from "../boundaries/shell/session";
import type { WorkspaceRef } from "../shared/api/types";
import { APP_START_OPERATION_ID } from "../intents/app-start";
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
import { HIBERNATE_WORKSPACE_OPERATION_ID } from "../intents/hibernate-workspace";
import type { SelectFolderHookResult } from "../intents/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { GET_ACTIVE_WORKSPACE_OPERATION_ID } from "../intents/get-active-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../intents/switch-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { EVENT_CODE_SERVER_RESTARTED } from "../intents/app-resume";

// =============================================================================
// Types
// =============================================================================

/**
 * Dependencies for ViewModule.
 *
 * Shell layers are nullable because they may not exist in test environments
 * or when the app quits before full initialization.
 *
 * Lifecycle deps (menuLayer, windowManager, uiHtmlPath) are nullable
 * so existing call sites that don't need them pass unchanged.
 */
export interface ViewModuleDeps {
  readonly viewManager: IViewManager & { create(): void };
  readonly logger: Logger;
  readonly viewLayer: ViewBoundary | null;
  readonly windowLayer: WindowBoundary | null;
  readonly sessionLayer: SessionBoundary | null;
  readonly dialogLayer?: Pick<DialogBoundary, "showOpenDialog"> | null;
  readonly menuLayer?: { setApplicationMenu(menu: null): void } | null;
  readonly windowManager?: {
    create(): void;
    maximizeAsync(): Promise<void>;
    focus(): void;
  } | null;
  readonly uiHtmlPath?: string | null;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ViewModule that manages workspace views, UI modes, loading states,
 * and shell layer disposal.
 */
export function createViewModule(deps: ViewModuleDeps): IntentModule {
  const { viewManager } = deps;

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

  const module: IntentModule = {
    name: "view",
    hooks: {
      // -------------------------------------------------------------------
      // app-start → init: Shell creation + UI loading (post-ready)
      //
      // The startup surfaces (boot splash, setup progress, agent-selection,
      // workspace loading) are owned by the presenter now — pushed as UiState
      // `main` kinds, not DialogManager dialogs. This module keeps only the
      // shell lifecycle (window/view creation, HTML load, focus) and the
      // per-workspace bookkeeping below.
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

            // Deselect: clear the active-workspace bookkeeping so a later
            // switch back to it isn't short-circuited as already-active.
            if (workspacePath === null) {
              activeWorkspacePath = null;
              return {};
            }

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
      // workspace:switched → update cachedActiveRef + handle null (clear).
      // The startup/loading surfaces are presenter-owned now; this handler
      // keeps only the active-surface bookkeeping the switch pipeline reads.
      // -------------------------------------------------------------------
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceSwitchedEvent).payload;

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
      // code-server:restarted → reload every workspace iframe. A resume
      // restart replaced the code-server process, so each frame's connection
      // to the old server is dead; reloading reconnects them to the fresh
      // server instead of leaving code-server's "Reload" dialog in each one.
      // -------------------------------------------------------------------
      [EVENT_CODE_SERVER_RESTARTED]: {
        handler: async (): Promise<void> => {
          viewManager.reloadFrames();
        },
      },
    },
  };

  return module;
}
