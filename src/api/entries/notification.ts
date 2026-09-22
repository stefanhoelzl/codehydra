/**
 * Sidebar notification entries: raise, update and close a card in CodeHydra's
 * own sidebar, the same cards CodeHydra uses for clone progress and errors.
 *
 * Distinct from `vscode.message` / `ch ws notify`, which raise a toast inside a
 * workspace's editor. A sidebar card is app-wide unless the caller attaches it
 * to a workspace, so these work from anywhere.
 */

import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps } from "./deps";
import { ApiError } from "../errors";
import { workspacePathSchema, type WorkspacePath } from "../../intents/contract";
import {
  INTENT_SHOW_NOTIFICATION,
  type ShowNotificationIntent,
  type ShowNotificationResult,
} from "../../intents/show-notification";
import {
  INTENT_CLOSE_NOTIFICATION,
  type CloseNotificationIntent,
} from "../../intents/close-notification";

/** Where an attached card points: the explicit path, else the caller's workspace. */
function attachmentOf(
  ctx: OperationContext,
  input: {
    readonly attach?: boolean | undefined;
    readonly workspacePath?: WorkspacePath | undefined;
  }
): WorkspacePath | undefined {
  if (input.workspacePath !== undefined) return input.workspacePath;
  if (!input.attach) return undefined;
  if (ctx.workspacePath === null) {
    throw new ApiError("no-workspace", "No workspace to attach the notification to.");
  }
  return ctx.workspacePath;
}

export function notificationEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;

  // Names each wait so a caller that disconnects can release it. Per registry,
  // not per call site: tokens only have to be unique among live waits.
  let waiterSeq = 0;

  const show = defineEntry({
    name: "notification.show",
    kind: "command",
    description: "Show or update a notification in CodeHydra's sidebar.",
    instructions:
      "Returns { id } for a new or updated card; pass that id back to update it (progress, " +
      "a new message) or to notification.close. A card is app-wide unless attach is set (the " +
      "calling workspace) or workspacePath is given: an attached card names the workspace, " +
      "switches to it when clicked, and closes when the workspace is deleted. A card that says " +
      "exactly what an open card says joins it (a repeat counter) and returns its id. With " +
      "wait, blocks until the user answers and returns { choice }: the clicked action, or " +
      "null if dismissed, timed out, or the workspace went away; answering closes the card. " +
      "Updating a card the user already dismissed fails as not found.",
    input: z.object({
      title: z.string().min(1).max(200).describe("Card title"),
      message: z.string().max(1000).optional().describe("Secondary text under the title"),
      type: z
        .enum(["info", "warning", "error", "spinner"])
        .optional()
        .default("info")
        .describe("Icon: info, warning, error, or spinner for ongoing work"),
      // Not `progress`: that is a global `ch` flag (stderr progress display),
      // and a global flag wins over a field of the same name.
      percent: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Progress bar, 0 to 100. Omit for none"),
      dismissible: z
        .boolean()
        .optional()
        .default(true)
        .describe("Show a dismiss button (default true)"),
      actions: z
        .array(z.string().min(1).max(50))
        .max(5)
        .optional()
        .describe("Action buttons; the clicked one is returned as the choice"),
      id: z.string().min(1).optional().describe("Card to update instead of opening a new one"),
      attach: z.boolean().optional().describe("Attach the card to the calling workspace"),
      workspacePath: workspacePathSchema
        .min(1)
        .optional()
        .describe("Attach the card to this workspace instead"),
      wait: z.boolean().optional().describe("Block until the user answers; returns { choice }"),
      timeout: z.number().positive().optional().describe("Give up waiting after this many seconds"),
    }),
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const workspacePath = attachmentOf(ctx, input);
      const config = {
        title: input.title,
        type: input.type,
        dismissible: input.dismissible,
        ...(input.message !== undefined && { message: input.message }),
        ...(input.percent !== undefined && { progress: input.percent / 100 }),
        ...(input.actions !== undefined && {
          actions: input.actions.map((label) => ({ id: label, label })),
        }),
      };
      const payload = {
        config,
        ...(input.id !== undefined && { id: input.id }),
        ...(workspacePath !== undefined && { workspacePath }),
      };

      /** A card that is gone reaches the caller as not-found (CLI exit 6). */
      const answer = (result: ShowNotificationResult): ShowNotificationResult => {
        if ("missing" in result) {
          throw new ApiError("not-found", `No open notification "${input.id ?? ""}".`);
        }
        return result;
      };

      if (!input.wait) {
        return answer(
          await dispatcher.dispatch<ShowNotificationIntent>({
            type: INTENT_SHOW_NOTIFICATION,
            payload,
          })
        );
      }

      // A wait lives as long as its caller: when the connection goes (Ctrl+C on
      // `ch`, an aborted agent turn) the wait is released and gives up its hold
      // on the card, which closes once nobody else holds it.
      const waiter = `waiter-${++waiterSeq}`;
      const release = (): void => {
        void dispatcher
          .dispatch<CloseNotificationIntent>({
            type: INTENT_CLOSE_NOTIFICATION,
            payload: { waiter },
          })
          .catch(() => undefined);
      };
      if (ctx.signal.aborted) return { choice: null };
      ctx.signal.addEventListener("abort", release, { once: true });
      try {
        return answer(
          await dispatcher.dispatch<ShowNotificationIntent>({
            type: INTENT_SHOW_NOTIFICATION,
            payload: {
              ...payload,
              wait: true,
              waiter,
              ...(input.timeout !== undefined && { timeoutMs: input.timeout * 1000 }),
            },
          })
        );
      } finally {
        ctx.signal.removeEventListener("abort", release);
      }
    },
  });

  const close = defineEntry({
    name: "notification.close",
    kind: "command",
    description: "Close a notification in CodeHydra's sidebar.",
    instructions:
      "Takes the id notification.show returned. Closing an id that is no longer open does " +
      "nothing. A card several identical shows joined stays until each has closed it.",
    input: z.object({
      id: z.string().min(1).describe("Card id from notification.show"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      await dispatcher.dispatch<CloseNotificationIntent>({
        type: INTENT_CLOSE_NOTIFICATION,
        payload: { id: input.id },
      });
      return { closed: true };
    },
  });

  return [show, close];
}
