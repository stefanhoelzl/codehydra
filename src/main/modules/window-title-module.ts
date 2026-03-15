/**
 * WindowTitleModule - Lifecycle and event subscriber module for the window title.
 *
 * Hooks:
 * - app:start → "start": sets the initial window title via updateTitle()
 *
 * Subscribes to:
 * - workspace:switched: updates internal project/workspace names, calls updateTitle()
 * - update:available: sets hasUpdate flag, calls updateTitle()
 *
 * Tracks its own state via domain events -- no external queries needed.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import { EVENT_UPDATE_AVAILABLE } from "../operations/update-available";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type { WindowManager } from "../managers/window-manager";
/**
 * Formats the window title based on current workspace.
 *
 * Format: "CodeHydra - <project> / <workspace> - (<version>) - (update available)"
 * No workspace: "CodeHydra - (<version>)" or "CodeHydra"
 *
 * @param projectName - Name of the active project, or undefined
 * @param workspaceName - Name of the active workspace, or undefined
 * @param version - Version suffix (branch in dev mode, version in packaged mode), or undefined
 * @param hasUpdate - Whether an update is available
 * @returns Formatted window title
 */
export function formatWindowTitle(
  projectName: string | undefined,
  workspaceName: string | undefined,
  version?: string,
  hasUpdate?: boolean
): string {
  const base = "CodeHydra";
  const versionSuffix = version ? ` - (${version})` : "";
  const updateSuffix = hasUpdate ? ` - (update available)` : "";

  if (projectName && workspaceName) {
    return `${base} - ${projectName} / ${workspaceName}${versionSuffix}${updateSuffix}`;
  }

  return `${base}${versionSuffix}${updateSuffix}`;
}

// =============================================================================
// Dependency Interface
// =============================================================================

export interface WindowTitleModuleDeps {
  readonly windowManager: Pick<WindowManager, "setTitle">;
  readonly titleVersion: string | undefined;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a window title module that sets the initial title on startup and
 * subscribes to workspace switch and update-available events.
 */
export function createWindowTitleModule(deps: WindowTitleModuleDeps): IntentModule {
  let currentProjectName: string | undefined;
  let currentWorkspaceName: string | undefined;
  let hasUpdate = false;

  function updateTitle(): void {
    const title = formatWindowTitle(
      currentProjectName,
      currentWorkspaceName,
      deps.titleVersion,
      hasUpdate
    );
    deps.windowManager.setTitle(title);
  }

  return {
    name: "window-title",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            updateTitle();
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceSwitchedEvent).payload;

          if (payload === null) {
            currentProjectName = undefined;
            currentWorkspaceName = undefined;
          } else {
            currentProjectName = payload.projectName;
            currentWorkspaceName = payload.workspaceName;
          }

          updateTitle();
        },
      },
      [EVENT_UPDATE_AVAILABLE]: {
        handler: async (): Promise<void> => {
          hasUpdate = true;
          updateTitle();
        },
      },
    },
  };
}
