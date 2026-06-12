/**
 * UI event contract: renderer → main fire-and-forget events on the
 * api:ui:event channel (planning/UI_STATE_ARCHITECTURE.md).
 *
 * `log` is the renderer's logging channel (replacement for the former
 * api:log:* channels). `remove-workspace` and `close-project` are
 * load-bearing requests: the presenter resolves their identity against its
 * model and dispatches the matching intent with `interactive: true` (the
 * confirmation dialog runs main-side). Identity fields are presenter-minted
 * and merely echoed back from the UiState snapshot — the renderer never
 * generates identifiers itself. The remaining events are observational; they
 * become load-bearing in the write-path phase.
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
  // key is the snapshot row's presenter-assigned workspace key, echoed back.
  // Requests the remove flow (confirmation dialog opens main-side).
  z.object({ kind: z.literal("remove-workspace"), key: z.string() }),
  z.object({ kind: z.literal("open-project") }),
  // projectId is backend-minted and merely echoed back by the renderer.
  // Requests the close flow (confirmation dialog opens main-side).
  z.object({ kind: z.literal("close-project"), projectId: z.string() }),
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
