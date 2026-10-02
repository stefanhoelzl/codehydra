/**
 * HibernationScreenshotModule - Captures and persists workspace view
 * screenshots for hibernation.
 *
 * Responsibilities:
 * - workspace:hibernate / capture hook → capture the active workspace iframe
 *   (full-view capture clipped to its rect; only possible while visible, so
 *   background hibernations are skipped) and write the PNG to
 *   <data>/screenshots/<projectId>/<workspaceName>.png.
 *   Best-effort: failures (not visible, capture failed, write failed) are
 *   logged and never propagate to the operation.
 * - workspace:wake / cleanup hook → delete the screenshot file (best-effort).
 * - workspace:deleted event → delete the screenshot file (best-effort).
 *
 * Provides a `buildScreenshotPath()` helper used by the presenter to inline
 * the screenshot into UiState snapshots.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { Logger } from "../boundaries/platform/logging";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import { Path } from "../utils/path/path";
import { getErrorMessage } from "../shared/error-utils";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type CaptureHookResult,
} from "../intents/hibernate-workspace";
import { WAKE_WORKSPACE_OPERATION_ID, type CleanupHookResult } from "../intents/wake-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { defineEvents, defineHooks } from "../intents/declarations";

export interface HibernationScreenshotModuleDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly pathProvider: PathProvider;
  readonly viewManager: IViewManager;
  readonly logger: Logger;
}

/**
 * Build the absolute on-disk path for a workspace's hibernation screenshot.
 * Sharded by projectId to avoid one giant flat directory.
 */
export function buildScreenshotPath(
  pathProvider: PathProvider,
  projectId: string,
  workspaceName: string
): Path {
  return pathProvider.dataPath(`screenshots/${projectId}/${workspaceName}.png`);
}

export function createHibernationScreenshotModule(
  deps: HibernationScreenshotModuleDeps
): IntentModule {
  const { fileSystem, pathProvider, viewManager, logger } = deps;

  async function deletePath(filePath: Path): Promise<void> {
    try {
      await fileSystem.rm(filePath, { force: true });
    } catch (error) {
      logger
        .scoped({ path: filePath.toString() })
        .debug("hibernation-screenshot: rm failed (ignored)", { error: getErrorMessage(error) });
    }
  }

  return {
    name: "hibernation-screenshot",
    hooks: defineHooks({
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        capture: {
          handler: async (ctx): Promise<HookOutput<CaptureHookResult>> => {
            const { active, projectId, workspaceName } = ctx;
            try {
              // Only the visible iframe has pixels to capture; a background
              // workspace's iframe is display:none. (Previously this captured
              // the shared host view, which showed the active workspace's
              // pixels regardless of which workspace was hibernating.)
              if (!active) {
                return { result: {} };
              }
              const png = await viewManager.captureActiveWorkspaceView();
              if (!png) {
                return { result: {} };
              }
              const filePath = buildScreenshotPath(pathProvider, projectId, workspaceName);
              await fileSystem.mkdir(filePath.dirname);
              await fileSystem.writeFileBuffer(filePath, png);
              return { result: {} };
            } catch (error) {
              logger.debug("hibernation-screenshot: capture failed (ignored)", {
                error: getErrorMessage(error),
              });
              return { result: {} };
            }
          },
        },
      },
      [WAKE_WORKSPACE_OPERATION_ID]: {
        cleanup: {
          handler: async (ctx): Promise<HookOutput<CleanupHookResult>> => {
            const { projectId, workspaceName } = ctx;
            const filePath = buildScreenshotPath(pathProvider, projectId, workspaceName);
            await deletePath(filePath);
            return { result: {} };
          },
        },
      },
    }),
    events: defineEvents({
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event): Promise<void> => {
          const payload = event.payload;
          const filePath = buildScreenshotPath(
            pathProvider,
            payload.projectId,
            payload.workspaceName
          );
          await deletePath(filePath);
        },
      },
    }),
  };
}
