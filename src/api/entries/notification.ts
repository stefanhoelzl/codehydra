/**
 * Sidebar notification entries: raise, update and close a card in CodeHydra's
 * own sidebar, the same cards CodeHydra uses for clone progress and errors.
 *
 * Distinct from `vscode.message` / `ch ws notify`, which raise a toast inside a
 * workspace's editor. A sidebar card is app-wide unless the caller attaches it
 * to a workspace, so these work from anywhere. A card here never waits: a
 * question on a card is `vscode.ask` with `sidebar`.
 */

import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps } from "./deps";
import { ApiError } from "../errors";
import type { WorkspaceRef } from "../../intents/contract";
import { createReferenceResolver, targetFields } from "./target";
import {
  INTENT_SHOW_NOTIFICATION,
  type ShowNotificationIntent,
} from "../../intents/show-notification";
import {
  INTENT_CLOSE_NOTIFICATION,
  type CloseNotificationIntent,
} from "../../intents/close-notification";

/**
 * Where an attached card points: the workspace the input names, else — with
 * `attach` — the one the call is scoped to.
 */
async function attachmentOf(
  resolveReference: ReturnType<typeof createReferenceResolver>,
  ctx: OperationContext,
  input: {
    readonly attach?: boolean | undefined;
    readonly workspace?: string | undefined;
    readonly project?: string | undefined;
  }
): Promise<WorkspaceRef | undefined> {
  if (input.workspace !== undefined) {
    return resolveReference(ctx, input.workspace, input.project);
  }
  if (input.project !== undefined) {
    throw new ApiError("usage", "project only says where to look a workspace name up: name one.");
  }
  if (!input.attach) return undefined;
  if (ctx.workspaceRef === null) {
    throw new ApiError("no-workspace", "No workspace to attach the notification to.");
  }
  return ctx.workspaceRef;
}

export function notificationEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;
  const resolveReference = createReferenceResolver(dispatcher);

  const show = defineEntry({
    name: "notification.show",
    kind: "command",
    description: "Show or update a notification for the user in CodeHydra's sidebar.",
    instructions:
      "For the USER — the agent never sees it; to tell the agent something, use " +
      "agent.message. Returns { id } for a new or updated card; pass that id back to update it (progress, " +
      "a new message) or to notification.close. A card is app-wide unless attach is set (the " +
      "calling workspace) or workspace is given: an attached card names the workspace, " +
      "switches to it when clicked, and closes when the workspace is deleted. A card that says " +
      "exactly what an open card says joins it (a repeat counter) and returns its id. Never " +
      "waits and has no buttons: to ask the user something, use vscode.ask (with sidebar for " +
      "a card). Updating a card the user already dismissed fails as not found.",
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
      id: z.string().min(1).optional().describe("Card to update instead of opening a new one"),
      attach: z.boolean().optional().describe("Attach the card to the calling workspace"),
      workspace: targetFields.workspace.describe(
        "Attach the card to this workspace instead: a name (your own project first) or a path"
      ),
      project: targetFields.project,
    }),
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const workspaceRef = await attachmentOf(resolveReference, ctx, input);
      const config = {
        title: input.title,
        type: input.type,
        dismissible: input.dismissible,
        ...(input.message !== undefined && { message: input.message }),
        ...(input.percent !== undefined && { progress: input.percent / 100 }),
      };
      const payload = {
        config,
        ...(input.id !== undefined && { id: input.id }),
        ...(workspaceRef !== undefined && { workspaceRef }),
      };

      const result = await dispatcher.dispatch<ShowNotificationIntent>({
        type: INTENT_SHOW_NOTIFICATION,
        payload,
      });
      // A card that is gone reaches the caller as not-found (CLI exit 6).
      if ("missing" in result) {
        throw new ApiError("not-found", `No open notification "${input.id ?? ""}".`);
      }
      return result;
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
