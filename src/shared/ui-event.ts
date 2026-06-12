/**
 * UI event contract: renderer → main fire-and-forget events on the
 * api:ui:event channel (Phase A of planning/UI_STATE_ARCHITECTURE.md).
 *
 * The events are purely observational — the renderer dual-fires them
 * alongside the existing invokes — except `log`, which is load-bearing and
 * replaces the former api:log:* channels. Workspace-targeting events carry
 * no identity yet: identity fields (presenter-assigned keys) arrive with the
 * snapshot phase, echoed back from backend-provided state. The renderer
 * never generates identifiers itself.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import { z } from "zod/v4";

const logContextSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const uiEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("switch-workspace") }),
  z.object({ kind: z.literal("wake-workspace") }),
  z.object({ kind: z.literal("hibernate-workspace") }),
  z.object({ kind: z.literal("remove-workspace") }),
  z.object({ kind: z.literal("open-project") }),
  // projectId is backend-minted and merely echoed back by the renderer.
  z.object({ kind: z.literal("close-project"), projectId: z.string() }),
  z.object({ kind: z.literal("panel-visibility"), open: z.boolean() }),
  // Debounced semantic hover (sidebar expanded by pointer), not raw mouse moves.
  z.object({ kind: z.literal("hover"), region: z.literal("sidebar").nullable() }),
  z.object({
    kind: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    logger: z.string(),
    message: z.string(),
    context: logContextSchema.optional(),
  }),
]);

/** Discriminated union of all renderer→main UI events. */
export type UiEvent = z.infer<typeof uiEventSchema>;
