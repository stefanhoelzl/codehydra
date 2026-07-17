/**
 * WindowTitleModule - Lifecycle and event subscriber module for the window title.
 *
 * Hooks:
 * - app:start → "start": sets the initial window title via updateTitle()
 *
 * Subscribes to:
 * - workspace:switched: adopts the new workspace's names and display title,
 *   calls updateTitle()
 * - workspace:metadata-changed: retitles when the *active* workspace's `title`
 *   changes (a rename emits no workspace:switched, so this is the only signal)
 *
 * Tracks its own state via domain events -- no external queries needed.
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type { MetadataChangedEvent } from "../intents/set-metadata";
import { EVENT_METADATA_CHANGED } from "../intents/set-metadata";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { readTitle, TITLE_METADATA_KEY } from "../shared/api/types";
import type { WindowManager } from "../boundaries/shell/window-manager";

/**
 * Formats the window title based on the current workspace.
 *
 * Format: "<title> / <workspace> / <project> - CodeHydra (<version>)"
 * No title: "<workspace> / <project> - CodeHydra (<version>)"
 * No workspace: "CodeHydra (<version>)" or "CodeHydra"
 *
 * Most-specific-first so the part the user cares about survives taskbar
 * truncation. The user-given title does not replace the workspace name -- both
 * are shown, since the branch stays the identity.
 *
 * @param projectName - Name of the active project, or undefined
 * @param workspaceName - Name of the active workspace, or undefined
 * @param title - User-given display title of the active workspace, or undefined
 * @param version - Version suffix (branch in dev mode, version in packaged mode), or undefined
 * @returns Formatted window title
 */
function formatWindowTitle(
  projectName: string | undefined,
  workspaceName: string | undefined,
  title: string | undefined,
  version?: string
): string {
  const app = version ? `CodeHydra (${version})` : "CodeHydra";

  if (projectName && workspaceName) {
    const titlePrefix = title ? `${title} / ` : "";
    return `${titlePrefix}${workspaceName} / ${projectName} - ${app}`;
  }

  return app;
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
 * subscribes to workspace switch and metadata-change events.
 */
export function createWindowTitleModule(deps: WindowTitleModuleDeps): IntentModule {
  let currentProjectName: string | undefined;
  let currentWorkspaceName: string | undefined;
  // Identity of the active workspace, used to match metadata changes. Keyed on
  // (projectId, workspaceName) rather than path: the two events carry paths from
  // different sources, and Path normalizes case on Windows.
  let currentProjectId: string | undefined;
  // Interpreted at intake -- the raw metadata map is never stored.
  let currentTitle: string | undefined;

  function updateTitle(): void {
    const title = formatWindowTitle(
      currentProjectName,
      currentWorkspaceName,
      currentTitle,
      deps.titleVersion
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
            currentProjectId = undefined;
            currentTitle = undefined;
          } else {
            currentProjectName = payload.projectName;
            currentWorkspaceName = payload.workspaceName;
            currentProjectId = payload.projectId;
            currentTitle = readTitle(payload.metadata[TITLE_METADATA_KEY]);
          }

          updateTitle();
        },
      },
      [EVENT_METADATA_CHANGED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { projectId, workspaceName, key, value } = (event as MetadataChangedEvent).payload;

          // Only the active workspace's title shows in the window title.
          if (key !== TITLE_METADATA_KEY) return;
          if (currentProjectId === undefined) return;
          if (projectId !== currentProjectId || workspaceName !== currentWorkspaceName) return;

          // A cleared title reverts the window title to the workspace name.
          currentTitle = readTitle(value);
          updateTitle();
        },
      },
    },
  };
}
