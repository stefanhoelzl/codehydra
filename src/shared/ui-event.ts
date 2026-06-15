/**
 * UI event contract: renderer → main fire-and-forget events on the
 * api:ui:event channel (planning/UI_STATE_ARCHITECTURE.md).
 *
 * `log` is the renderer's logging channel (replacement for the former
 * api:log:* channels). `ui-connected` is the startup handshake: the renderer
 * emits it once after subscribing to ui:state, and the presenter responds by
 * flushing buffered notifications and dispatching app:ready (which loads
 * projects → emits app:started → opens the snapshot stream).
 *
 * All gesture events are load-bearing: the presenter resolves their identity
 * (the opaque workspace `key` / `projectId`) against its model and dispatches
 * the matching intent. `remove-workspace` and `close-project` run their
 * confirmation dialog main-side (`interactive: true`); `switch-workspace` and
 * `wake-workspace` dispatch directly. Identity fields are presenter-minted and
 * merely echoed back from the UiState snapshot — the renderer never generates
 * identifiers itself. (Hibernate and open-project have no renderer gesture:
 * the `h` shortcut and the creation panel drive them entirely main-side.)
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import { z } from "zod/v4";

const logContextSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const uiEventSchema = z.discriminatedUnion("kind", [
  // Startup handshake: emitted once after the renderer subscribes to ui:state.
  z.object({ kind: z.literal("ui-connected") }),
  // key is the snapshot row's presenter-assigned workspace key, echoed back.
  // Switch to a workspace (sidebar/status-cell click); key null = deselect
  // (the creation panel becomes the main view).
  z.object({ kind: z.literal("switch-workspace"), key: z.string().nullable() }),
  // Wake a hibernated workspace (status-cell / overlay click).
  z.object({ kind: z.literal("wake-workspace"), key: z.string() }),
  // Requests the remove flow (confirmation dialog opens main-side).
  z.object({ kind: z.literal("remove-workspace"), key: z.string() }),
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
