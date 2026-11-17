/**
 * HibernationModule - What a workspace's hibernation leaves behind: its
 * `hibernated` / `hibernated-at` metadata and its screenshot.
 *
 * Responsibilities:
 * - workspace:hibernate / capture hook → capture the active workspace iframe
 *   (full-view capture clipped to its rect; only possible while visible, so
 *   background hibernations are skipped) and write the PNG to
 *   <data>/screenshots/<projectId>/<workspaceName>.png.
 *   Best-effort: failures (not visible, capture failed, write failed) are
 *   logged and never propagate to the operation.
 * - workspace:hibernate / mark hook → write `hibernated-at` (now), then
 *   `hibernated="true"`: the time first, so whoever sees the flag also sees
 *   when it was set.
 * - workspace:wake / unmark hook → clear `hibernated`, then `hibernated-at`.
 * - workspace:wake / cleanup hook → delete the screenshot file (best-effort).
 * - workspace:deleted event → delete the screenshot file (best-effort).
 * - project:open / backfill hook → give every hibernated workspace without a
 *   valid `hibernated-at` one: its screenshot's modification time (written at
 *   hibernation), or now when it has none. Workspaces hibernated before the key
 *   existed (v2026.10.31) are the ones without.
 *   TODO(2027): remove the backfill — by then every such workspace has been
 *   opened (and filled) or the readers' fallback to now covers it.
 *
 * Provides a `buildScreenshotPath()` helper used by the presenter to inline
 * the screenshot into UiState snapshots.
 */

import type { IntentModule } from "../intents/lib/module";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { HookOutput } from "../intents/lib/operation";
import type { Logger } from "../boundaries/platform/logging";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import { Path } from "../utils/path/path";
import { makeWorkspaceRef } from "../utils/ref";
import { getErrorMessage } from "../shared/error-utils";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  HIBERNATED_AT_METADATA_KEY,
  HIBERNATED_METADATA_KEY,
  readHibernatedAt,
  type CaptureHookResult,
  type MarkHookResult,
} from "../intents/hibernate-workspace";
import {
  WAKE_WORKSPACE_OPERATION_ID,
  type CleanupHookResult,
  type UnmarkHookResult,
} from "../intents/wake-workspace";
import { OPEN_PROJECT_OPERATION_ID, type BackfillHookResult } from "../intents/open-project";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../intents/set-metadata";
import type { WorkspaceRef } from "../intents/contract";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { defineEvents, defineHooks } from "../intents/declarations";

export interface HibernationModuleDeps {
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly fileSystem: FileSystemBoundary;
  readonly pathProvider: PathProvider;
  readonly viewManager: IViewManager;
  readonly logger: Logger;
  /** The clock; injected so tests can pin it. */
  readonly now?: () => Date;
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

export function createHibernationModule(deps: HibernationModuleDeps): IntentModule {
  const { dispatcher, fileSystem, pathProvider, viewManager, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());

  async function deletePath(filePath: Path): Promise<void> {
    try {
      await fileSystem.rm(filePath, { force: true });
    } catch (error) {
      logger
        .scoped({ path: filePath.toString() })
        .debug("hibernation: screenshot rm failed (ignored)", { error: getErrorMessage(error) });
    }
  }

  async function setMetadata(
    workspaceRef: WorkspaceRef,
    key: string,
    value: string | null
  ): Promise<void> {
    await dispatcher.dispatch<SetMetadataIntent>({
      type: INTENT_SET_METADATA,
      payload: { workspaceRef, key, value },
    });
  }

  /** When a workspace without a recorded time went to sleep, as well as we can tell. */
  async function hibernatedSince(projectId: string, workspaceName: string): Promise<string> {
    try {
      const shot = await fileSystem.stat(
        buildScreenshotPath(pathProvider, projectId, workspaceName)
      );
      return shot.mtime.toISOString();
    } catch {
      // No screenshot (hibernated in the background, or never captured).
      return now().toISOString();
    }
  }

  return {
    name: "hibernation",
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
              logger.debug("hibernation: capture failed (ignored)", {
                error: getErrorMessage(error),
              });
              return { result: {} };
            }
          },
        },
        mark: {
          handler: async (ctx): Promise<HookOutput<MarkHookResult>> => {
            await setMetadata(ctx.workspaceRef, HIBERNATED_AT_METADATA_KEY, now().toISOString());
            await setMetadata(ctx.workspaceRef, HIBERNATED_METADATA_KEY, "true");
            return { result: {} };
          },
        },
      },
      [WAKE_WORKSPACE_OPERATION_ID]: {
        unmark: {
          handler: async (ctx): Promise<HookOutput<UnmarkHookResult>> => {
            await setMetadata(ctx.workspaceRef, HIBERNATED_METADATA_KEY, null);
            await setMetadata(ctx.workspaceRef, HIBERNATED_AT_METADATA_KEY, null);
            return { result: {} };
          },
        },
        cleanup: {
          handler: async (ctx): Promise<HookOutput<CleanupHookResult>> => {
            const { projectId, workspaceName } = ctx;
            const filePath = buildScreenshotPath(pathProvider, projectId, workspaceName);
            await deletePath(filePath);
            return { result: {} };
          },
        },
      },
      [OPEN_PROJECT_OPERATION_ID]: {
        backfill: {
          handler: async (ctx): Promise<HookOutput<BackfillHookResult>> => {
            const metadata: Record<string, Record<string, string>> = {};
            for (const workspace of ctx.workspaces) {
              if (workspace.metadata[HIBERNATED_METADATA_KEY] !== "true") continue;
              if (readHibernatedAt(workspace.metadata[HIBERNATED_AT_METADATA_KEY])) continue;
              const at = await hibernatedSince(ctx.projectId, workspace.name);
              const ref = makeWorkspaceRef(ctx.projectRef, workspace.name);
              try {
                await setMetadata(ref, HIBERNATED_AT_METADATA_KEY, at);
              } catch (error) {
                // Readers fall back to now; the next open tries again.
                logger.warn("hibernation: backfilling hibernated-at failed", {
                  workspace: ref,
                  error: getErrorMessage(error),
                });
                continue;
              }
              metadata[workspace.name] = { [HIBERNATED_AT_METADATA_KEY]: at };
            }
            return { result: { metadata } };
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
