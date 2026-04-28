/**
 * HibernationScreenshotModule - Captures and persists workspace view
 * screenshots for hibernation.
 *
 * Responsibilities:
 * - workspace:hibernate / capture hook → call viewManager.captureWorkspaceView
 *   and write the PNG to <data>/screenshots/<projectId>/<workspaceName>.png.
 *   Best-effort: failures (no view, capture failed, write failed) are logged
 *   and never propagate to the operation.
 * - workspace:wake / cleanup hook → delete the screenshot file (best-effort).
 * - workspace:deleted event → delete the screenshot file (best-effort).
 *
 * Provides a `getScreenshotPath()` helper used by the IPC layer to expose the
 * screenshot URL to the renderer.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { Logger } from "../boundaries/platform/logging";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { DomainEvent } from "../intents/lib/types";
import { Path } from "../utils/path/path";
import { extractWorkspaceName } from "../shared/api/id-utils";
import { getErrorMessage } from "../shared/error-utils";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type CaptureHookResult,
  type HibernatePipelineHookInput,
} from "../intents/hibernate-workspace";
import {
  WAKE_WORKSPACE_OPERATION_ID,
  type CleanupHookResult,
  type WakePipelineHookInput,
} from "../intents/wake-workspace";
import { EVENT_WORKSPACE_DELETED, type WorkspaceDeletedEvent } from "../intents/delete-workspace";

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
      logger.debug("hibernation-screenshot: rm failed (ignored)", {
        path: filePath.toString(),
        error: getErrorMessage(error),
      });
    }
  }

  return {
    name: "hibernation-screenshot",
    hooks: {
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        capture: {
          handler: async (ctx: HookContext): Promise<CaptureHookResult> => {
            const { workspacePath, projectId, workspaceName } = ctx as HibernatePipelineHookInput;
            try {
              const png = await viewManager.captureWorkspaceView(workspacePath);
              if (!png) {
                return { captured: false };
              }
              const filePath = buildScreenshotPath(pathProvider, projectId, workspaceName);
              await fileSystem.mkdir(filePath.dirname, { recursive: true });
              await fileSystem.writeFileBuffer(filePath, png);
              return { captured: true };
            } catch (error) {
              logger.debug("hibernation-screenshot: capture failed (ignored)", {
                error: getErrorMessage(error),
              });
              return { captured: false };
            }
          },
        },
      },
      [WAKE_WORKSPACE_OPERATION_ID]: {
        cleanup: {
          handler: async (ctx: HookContext): Promise<CleanupHookResult> => {
            const { projectId, workspaceName } = ctx as WakePipelineHookInput;
            const filePath = buildScreenshotPath(pathProvider, projectId, workspaceName);
            await deletePath(filePath);
            return {};
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceDeletedEvent).payload;
          const workspaceName = extractWorkspaceName(payload.workspacePath);
          const filePath = buildScreenshotPath(pathProvider, payload.projectId, workspaceName);
          await deletePath(filePath);
        },
      },
    },
  };
}
