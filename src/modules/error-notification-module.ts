/**
 * Error Notification Module - Shows error notifications for failed operations.
 *
 * Subscribes to failure domain events and shows dismissible error notifications
 * through `notification:show`. A dismiss closes the card on its own, so nothing
 * here keeps track of what it raised.
 */

import type { IntentModule } from "../intents/lib/module";
import { EVENT_WORKSPACE_CREATE_FAILED } from "../intents/open-workspace";
import { EVENT_APP_RESUME_FAILED } from "../intents/app-resume";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { notify } from "./presentation/notification-card";
import { defineEvents } from "../intents/declarations";

export interface ErrorNotificationModuleDeps {
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
}

export function createErrorNotificationModule(deps: ErrorNotificationModuleDeps): IntentModule {
  const events = defineEvents({
    [EVENT_WORKSPACE_CREATE_FAILED]: {
      handler: async (event): Promise<void> => {
        const { workspaceName, error, source } = event.payload;
        if (source === "mcp") return;
        notify(deps.dispatcher, {
          type: "error",
          title: `Failed to create "${workspaceName}"`,
          message: error,
          dismissible: true,
        });
      },
    },
    [EVENT_APP_RESUME_FAILED]: {
      handler: async (event): Promise<void> => {
        const { error } = event.payload;
        notify(deps.dispatcher, {
          type: "error",
          title: "Failed to recover after system resume",
          message: error,
          dismissible: true,
        });
      },
    },
  });

  return {
    name: "error-notification",
    events,
  };
}
