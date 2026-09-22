/**
 * ShowNotificationOperation - Raise or update a CodeHydra sidebar notification.
 *
 * The one way anything raises a sidebar card: in-process modules dispatch it,
 * and the registry exposes it (`notification.show`) to `ch`, MCP and the plugin
 * wire. The presenter owns the cards and does the work in the "show" hook.
 *
 * Runs two steps:
 * 1. When the card is attached to a workspace, dispatch workspace:resolve to
 *    validate the path (a card about a workspace that does not exist would
 *    never be cleaned up by its deletion)
 * 2. "show" hook — the presenter opens, collapses or updates the card
 *
 * Semantics (implemented by the presenter's NotificationManager):
 * - Without `id`: opens a card, or joins the open card that says exactly the
 *   same thing (same text and same workspace), and returns its id.
 * - With `id`: replaces that card's content. An id that is not open returns
 *   `{ missing: true }`, so a producer learns its card was dismissed. That is an
 *   answer, not a failure: the user dismissing a card is an ordinary outcome,
 *   and a failed dispatch is logged as an app error.
 * - With `wait`: blocks until the user answers and returns `{ choice }` — the
 *   clicked button's id, or null on dismiss, `timeoutMs`, the attached
 *   workspace going away, or the waiter being released (`notification:close`
 *   with its `waiter` token). A choice or a dismiss closes the card. With both
 *   `id` and `wait`, the waiter takes the card over.
 *
 * Contract schemas: zod is the single source of truth. The payload/result/hook
 * schemas are declared once and hung on the operation's `schemas` field; the
 * `Intent` and result types are derived from that bundle via `IntentOf`/`z.infer`.
 */

import { z } from "zod/v4";
import type { HookContext, Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { lastDefined, requireResult, throwHookErrors } from "./lib/hook-helpers";
import { hookCtxSchema, workspacePathSchema } from "./contract";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import type { NotificationConfig } from "../shared/notification-types";
import type { DialogButton } from "../shared/dialog-types";

export const INTENT_SHOW_NOTIFICATION = "notification:show" as const;
export const SHOW_NOTIFICATION_OPERATION_ID = "show-notification";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/** A notification action button — the subset of DialogButton a card renders. */
export const notificationButtonSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    icon: z.string().optional(),
    variant: z.enum(["primary", "secondary"]).optional(),
    disabled: z.boolean().optional(),
    busy: z.boolean().optional(),
    busyLabel: z.string().optional(),
    title: z.string().optional(),
  })
  .readonly();

/** What a card says. Mirrors `NotificationConfig` in shared/notification-types. */
export const notificationConfigSchema = z
  .object({
    title: z.string().min(1),
    message: z.string().optional(),
    type: z.enum(["info", "warning", "error", "spinner"]),
    /** 0-1 for determinate, true for indeterminate, omitted for none. */
    progress: z.union([z.number().min(0).max(1), z.literal(true)]).optional(),
    dismissible: z.boolean().optional(),
    actions: z.array(notificationButtonSchema).readonly().optional(),
  })
  .readonly();

export const showNotificationPayloadSchema = z
  .object({
    config: notificationConfigSchema,
    /** Card to update. Omit to open a new one (or join an identical open card). */
    id: z.string().min(1).optional(),
    /**
     * Workspace the card is about. It names the workspace, a click on it
     * switches there, and it closes when the workspace is deleted. Ignored on
     * an update: a card keeps the attachment it was opened with.
     */
    workspacePath: workspacePathSchema.optional(),
    /** Block until the user answers; the result is `{ choice }`. */
    wait: z.boolean().optional(),
    /** Give up waiting after this long (choice null). Only with `wait`. */
    timeoutMs: z.number().positive().optional(),
    /**
     * Opaque token naming this wait, so a caller that goes away can release it
     * with `notification:close { waiter }`. Minted by the registry entry per
     * call; in-process callers have no connection to lose and leave it out.
     */
    waiter: z.string().min(1).optional(),
  })
  .readonly();

export const showNotificationResultSchema = z.union([
  z.object({ id: z.string() }).readonly(),
  z.object({ choice: z.string().nullable() }).readonly(),
  /** The `id` given is not an open card (dismissed, or closed). */
  z.object({ missing: z.literal(true) }).readonly(),
]);

/** Per-handler result for the "show" hook point. */
export const showNotificationHookResultSchema = z
  .object({
    result: showNotificationResultSchema.optional(),
  })
  .readonly();

/** Runtime whole-context validation schema for "show" (no enrichment). */
export const showNotificationHookInputSchema = hookCtxSchema(showNotificationPayloadSchema, {});

export const schemas = {
  type: INTENT_SHOW_NOTIFICATION,
  payload: showNotificationPayloadSchema,
  result: showNotificationResultSchema,
  hooks: {
    show: { input: showNotificationHookInputSchema, result: showNotificationHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type ShowNotificationPayload = z.infer<typeof showNotificationPayloadSchema>;
export type ShowNotificationIntent = IntentOf<typeof schemas>;
export type ShowNotificationResult = z.infer<typeof showNotificationResultSchema>;
export type ShowNotificationHookResult = z.infer<typeof showNotificationHookResultSchema>;

/** Whole input context for "show" handlers. */
export type ShowNotificationHookInput = HookContext & { readonly intent: ShowNotificationIntent };

/**
 * The shared `NotificationConfig` a parsed payload describes.
 *
 * zod infers optional members as `T | undefined`; the shared type spells them
 * as absent-or-present (`exactOptionalPropertyTypes`), so the members that are
 * set are copied across and the rest are left out.
 */
export function toNotificationConfig(
  config: ShowNotificationPayload["config"]
): NotificationConfig {
  const actions = config.actions?.map((action): DialogButton => {
    const { id, label, icon, variant, disabled, busy, busyLabel, title } = action;
    return {
      id,
      ...(label !== undefined && { label }),
      ...(icon !== undefined && { icon }),
      ...(variant !== undefined && { variant }),
      ...(disabled !== undefined && { disabled }),
      ...(busy !== undefined && { busy }),
      ...(busyLabel !== undefined && { busyLabel }),
      ...(title !== undefined && { title }),
    };
  });
  return {
    title: config.title,
    type: config.type,
    ...(config.message !== undefined && { message: config.message }),
    ...(config.progress !== undefined && { progress: config.progress }),
    ...(config.dismissible !== undefined && { dismissible: config.dismissible }),
    ...(actions !== undefined && { actions }),
  };
}

/** The id of the card a non-waiting show opened or updated; null when its card was missing. */
export function notificationIdOf(result: ShowNotificationResult): string | null {
  if ("missing" in result) return null;
  if (!("id" in result)) throw new Error("notification:show waited; it has no id to return");
  return result.id;
}

// =============================================================================
// Operation
// =============================================================================

export class ShowNotificationOperation implements Operation<typeof schemas> {
  readonly id = SHOW_NOTIFICATION_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<ShowNotificationIntent, typeof schemas>
  ): Promise<ShowNotificationResult> {
    const { workspacePath, id } = ctx.intent.payload;

    // An update keeps its attachment, so only a new card needs its workspace checked.
    if (workspacePath !== undefined && id === undefined) {
      await ctx.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath },
      });
    }

    const { results, errors } = await ctx.hooks.collect("show", { intent: ctx.intent });
    throwHookErrors(errors, "notification:show hooks failed");
    return requireResult(
      lastDefined(results, (r) => r.result),
      "notification:show: no handler showed the notification"
    );
  }
}
