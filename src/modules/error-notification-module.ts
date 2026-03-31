/**
 * Error Notification Module - Shows error notifications for failed operations.
 *
 * Subscribes to failure domain events and shows dismissible error notifications
 * via NotificationManager. Currently handles workspace creation failures.
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { WorkspaceCreateFailedEvent } from "../intents/open-workspace";
import { EVENT_WORKSPACE_CREATE_FAILED } from "../intents/open-workspace";
import type { NotificationManager } from "./notification-manager";

export interface ErrorNotificationModuleDeps {
  readonly notificationManager: NotificationManager;
}

export function createErrorNotificationModule(deps: ErrorNotificationModuleDeps): IntentModule {
  const events: EventDeclarations = {
    [EVENT_WORKSPACE_CREATE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspaceName, error } = (event as WorkspaceCreateFailedEvent).payload;
        const handle = deps.notificationManager.open({
          type: "error",
          title: `Failed to create "${workspaceName}"`,
          message: error,
          dismissible: true,
        });
        handle.onEvent(() => {
          handle.close();
        });
      },
    },
  };

  return {
    name: "error-notification",
    events,
  };
}
