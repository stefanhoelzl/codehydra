/**
 * The `notification:show` / `notification:close` hook handlers, over a
 * NotificationManager.
 *
 * The presenter registers these for the manager it owns. They live apart from
 * the presenter so the test harness for producer modules
 * (`notification-manager.state-mock.ts`) runs the same handlers over a real
 * manager, and a producer test exercises the contract the app ships.
 */

import type { HookDeclarations } from "../../intents/lib/module";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import {
  SHOW_NOTIFICATION_OPERATION_ID,
  toNotificationConfig,
  type ShowNotificationHookInput,
  type ShowNotificationHookResult,
} from "../../intents/show-notification";
import {
  CLOSE_NOTIFICATION_OPERATION_ID,
  type CloseNotificationHookInput,
} from "../../intents/close-notification";
import type { NotificationManager } from "./sessions";

export function createNotificationHooks(
  notifications: Pick<
    NotificationManager,
    "isOpen" | "show" | "showAndWait" | "close" | "releaseWaiter"
  >
): HookDeclarations {
  return {
    [SHOW_NOTIFICATION_OPERATION_ID]: {
      show: {
        handler: async (ctx: HookContext): Promise<HookOutput<ShowNotificationHookResult>> => {
          const { config, id, workspacePath, wait, timeoutMs, waiter } = (
            ctx as ShowNotificationHookInput
          ).intent.payload;
          // A card that is gone is an answer, not a failure (see the intent).
          if (id !== undefined && !notifications.isOpen(id)) {
            return { result: { result: { missing: true } } };
          }
          const request = {
            config: toNotificationConfig(config),
            ...(id !== undefined && { id }),
            ...(workspacePath !== undefined && { workspacePath }),
          };
          if (!wait) return { result: { result: { id: notifications.show(request) } } };
          const choice = await notifications.showAndWait(request, {
            ...(timeoutMs !== undefined && { timeoutMs }),
            ...(waiter !== undefined && { waiter }),
          });
          return { result: { result: { choice } } };
        },
      },
    },
    [CLOSE_NOTIFICATION_OPERATION_ID]: {
      close: {
        handler: async (ctx: HookContext): Promise<void> => {
          const payload = (ctx as CloseNotificationHookInput).intent.payload;
          if ("id" in payload) notifications.close(payload.id);
          else notifications.releaseWaiter(payload.waiter);
        },
      },
    },
  };
}
