/**
 * Clone Notification Module - Shows clone progress as sidebar notifications.
 *
 * Subscribes to clone progress domain events and manages notification handles
 * via NotificationManager. Each active clone gets its own notification that
 * updates with progress and stage information.
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type {
  CloneProgressEvent,
  ProjectOpenedEvent,
  ProjectOpenFailedEvent,
} from "../intents/open-project";
import {
  EVENT_CLONE_PROGRESS,
  EVENT_PROJECT_OPENED,
  EVENT_PROJECT_OPEN_FAILED,
} from "../intents/open-project";
import type { NotificationHandle } from "./notification-manager";
import type { UiPresenter } from "./presentation-module";
import type { NotificationConfig } from "../shared/notification-types";

/**
 * Format a git stage name for display.
 */
function stageLabel(stage: string): string {
  switch (stage) {
    case "receiving":
      return "Receiving objects...";
    case "resolving":
      return "Resolving deltas...";
    case "counting":
      return "Counting objects...";
    case "compressing":
      return "Compressing objects...";
    default:
      return stage.charAt(0).toUpperCase() + stage.slice(1) + "...";
  }
}

export interface CloneNotificationModuleDeps {
  readonly ui: Pick<UiPresenter, "notification">;
}

export function createCloneNotificationModule(deps: CloneNotificationModuleDeps): IntentModule {
  // Track notification handles by clone URL
  const handles = new Map<string, NotificationHandle>();

  function buildConfig(name: string, stage: string | null, progress: number): NotificationConfig {
    const config: NotificationConfig = {
      title: `Cloning ${name}`,
      type: "spinner",
      progress: stage ? progress : true,
    };
    if (stage) {
      return { ...config, message: stageLabel(stage) };
    }
    return config;
  }

  const events: EventDeclarations = {
    [EVENT_CLONE_PROGRESS]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as CloneProgressEvent).payload;
        const { url, stage, progress, name } = payload;

        const existing = handles.get(url);
        if (existing) {
          existing.update(buildConfig(name, stage, progress));
        } else {
          const handle = deps.ui.notification(buildConfig(name, stage, progress));
          handles.set(url, handle);
        }
      },
    },
    [EVENT_PROJECT_OPENED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as ProjectOpenedEvent).payload;
        // Close notification for completed clones (git field matches the clone URL)
        if (payload.git) {
          const handle = handles.get(payload.git);
          if (handle) {
            handle.close();
            handles.delete(payload.git);
          }
        }
      },
    },
    [EVENT_PROJECT_OPEN_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as ProjectOpenFailedEvent).payload;
        if (payload.git) {
          const handle = handles.get(payload.git);
          if (handle) {
            handle.update({
              title: "Clone failed",
              message: payload.reason,
              type: "error",
              dismissible: true,
            });
            // Listen for dismiss and clean up
            handle.onEvent(() => {
              handle.close();
              handles.delete(payload.git!);
            });
          }
        }
      },
    },
  };

  return {
    name: "clone-notification",
    events,
  };
}
