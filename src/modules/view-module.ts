/**
 * ViewModule - Manages the UI shell lifecycle and shell layer disposal.
 *
 * Workspace surfaces are iframes inside the UI renderer's DOM, derived from
 * the UiState snapshot — this module no longer creates or destroys views per
 * workspace. The four startup surfaces (boot splash, setup progress,
 * agent-selection, workspace loading) are owned by the presenter now (pushed
 * as UiState `main` kinds), not DialogManager dialogs. Active-workspace
 * bookkeeping moved to workspace-lifecycle-module, which owns the transient
 * per-workspace facts contributed to workspace:resolve. What remains here:
 * - app-start `init` hook (window + UI view creation, HTML load, focus)
 * - delete-workspace `shutdown` (reports wasActive, driving the auto-switch)
 * - open-project `select-folder` (native folder picker)
 * - app-shutdown/stop (UI view + layer disposal)
 *
 */

import type { DialogBoundary } from "../boundaries/shell/dialog";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { Logger } from "../boundaries/platform/logging";
import type { ViewBoundary } from "../boundaries/shell/view";
import type { WindowBoundary } from "../boundaries/shell/window";
import type { SessionBoundary } from "../boundaries/shell/session";
import type { WebPreferences } from "../boundaries/shell/types";
import { GLOBAL_SESSION_PARTITION } from "../boundaries/shell/ui-view-manager";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import type { ShutdownHookResult, DeletePipelineHookInput } from "../intents/delete-workspace";
import type { SelectFolderHookResult } from "../intents/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { EVENT_IDE_SERVER_RESTARTED } from "../intents/app-resume";
import { projectPathSchema } from "../intents/contract";

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
  readonly dialogLayer?: Pick<DialogBoundary, "showDialog"> | null;
  readonly menuLayer?: { setApplicationMenu(menu: null): void } | null;
  readonly windowManager?: {
    create(webPreferences?: WebPreferences): void;
    maximizeAsync(): Promise<void>;
    focus(): void;
  } | null;
  readonly uiHtmlPath?: string | null;
  /** Preload script for the UI page hosted directly by the window. */
  readonly uiPreloadPath?: string | null;
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
          handler: async (): Promise<HookOutput> => {
            // Disable application menu
            if (deps.menuLayer) {
              deps.menuLayer.setApplicationMenu(null);
            }

            // Create the window as a BrowserWindow hosting the UI page directly:
            // its webContents (UI preload + shared partition) auto-fills the
            // window, so there is no child view to size. viewManager.create()
            // then adopts that webContents for the UI's webContents concerns.
            if (deps.windowManager) {
              deps.windowManager.create({
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                partition: GLOBAL_SESSION_PARTITION,
                ...(deps.uiPreloadPath ? { preload: deps.uiPreloadPath } : {}),
              });
            }
            viewManager.create();

            // Load the UI HTML into the window's own webContents.
            if (deps.uiHtmlPath) {
              await viewManager.loadUIContent(deps.uiHtmlPath);
            }

            // Maximize and focus window
            if (deps.windowManager) {
              await deps.windowManager.maximizeAsync();
              deps.windowManager.focus();
            }

            // Focus UI
            viewManager.focus();

            return { provides: { "ui-ready": true } };
          },
        },
      },

      // -------------------------------------------------------------------
      // delete-workspace → shutdown: report whether the deleted workspace was
      // the active one, which drives the post-delete auto-switch. The active
      // bookkeeping itself belongs to workspace-lifecycle-module; the iframe
      // unmounts in the renderer off the presenter snapshot.
      // -------------------------------------------------------------------
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<ShutdownHookResult>> => {
            const { active } = ctx as DeletePipelineHookInput;
            return { result: { ...(active && { wasActive: true }) } };
          },
        },
      },

      // -------------------------------------------------------------------
      // open-project → select-folder: show folder dialog
      // -------------------------------------------------------------------
      [OPEN_PROJECT_OPERATION_ID]: {
        "select-folder": {
          handler: async (): Promise<HookOutput<SelectFolderHookResult>> => {
            if (!deps.dialogLayer) {
              return { result: { folderPath: null } };
            }
            const result = await deps.dialogLayer.showDialog({
              properties: ["openDirectory"] as const,
            });
            if (result.canceled || result.filePaths.length === 0) {
              return { result: { folderPath: null } };
            }
            // The OS dialog hands back a raw string — one of the few genuine external
            // edges, so the project-path brand is minted here by parsing.
            return {
              result: { folderPath: projectPathSchema.parse(result.filePaths[0]!.toString()) },
            };
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
      // ide-server:restarted → reload every workspace iframe. A resume
      // restart replaced the IDE server process, so each frame's connection
      // to the old server is dead; reloading reconnects them to the fresh
      // server instead of leaving the IDE server's "Reload" dialog in each one.
      // -------------------------------------------------------------------
      [EVENT_IDE_SERVER_RESTARTED]: {
        handler: async (): Promise<void> => {
          viewManager.reloadFrames();
        },
      },
    },
  };

  return module;
}
