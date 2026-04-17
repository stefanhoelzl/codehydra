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
import type { AppResumeFailedEvent } from "../intents/app-resume";
import { EVENT_APP_RESUME_FAILED } from "../intents/app-resume";
import type { NotificationManager } from "./notification-manager";

export interface ErrorNotificationModuleDeps {
  readonly notificationManager: NotificationManager;
}

export function createErrorNotificationModule(deps: ErrorNotificationModuleDeps): IntentModule {
  const events: EventDeclarations = {
    [EVENT_WORKSPACE_CREATE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspaceName, error, source } = (event as WorkspaceCreateFailedEvent).payload;
        if (source === "mcp") return;
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
    [EVENT_APP_RESUME_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { error } = (event as AppResumeFailedEvent).payload;
        const handle = deps.notificationManager.open({
          type: "error",
          title: "Failed to recover after system resume",
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
