/**
 * WindowTitleModule - Event subscriber module for updating the window title.
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
import { formatWindowTitle } from "../ipc/api-handlers";

/**
 * Create a window title module that subscribes to workspace switch and update-available events.
 *
 * @param setTitle - Callback to set the window title
 * @param titleVersion - Version suffix (branch in dev, version in packaged), or undefined
 * @returns IntentModule with event subscriptions
 */
export function createWindowTitleModule(
  setTitle: (title: string) => void,
  titleVersion: string | undefined
): IntentModule {
  let currentProjectName: string | undefined;
  let currentWorkspaceName: string | undefined;
  let hasUpdate = false;

  function updateTitle(): void {
    const title = formatWindowTitle(
      currentProjectName,
      currentWorkspaceName,
      titleVersion,
      hasUpdate
    );
    setTitle(title);
  }

  return {
    events: {
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
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
      [EVENT_UPDATE_AVAILABLE]: () => {
        hasUpdate = true;
        updateTitle();
      },
    },
  };
}
