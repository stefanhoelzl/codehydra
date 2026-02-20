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
import { APP_START_OPERATION_ID, type StartHookResult } from "../operations/app-start";
import { formatWindowTitle } from "../ipc/api-handlers";

/**
 * Create a window title module that sets the initial title on startup and
 * subscribes to workspace switch and update-available events.
 *
 * @param setTitle - Callback to set the window title
 * @param titleVersion - Version suffix (branch in dev, version in packaged), or undefined
 * @returns IntentModule with hooks and event subscriptions
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
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            updateTitle();
            return {};
          },
        },
      },
    },
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
