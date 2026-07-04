/**
 * UI event contract: renderer → main fire-and-forget events on the
 * api:ui:event channel (planning/UI_STATE_ARCHITECTURE.md).
 *
 * `log` is the renderer's logging channel. `ui-connected` is the startup handshake: the renderer
 * emits it once (on App mount, during the initializing phase) after subscribing
 * to ui:state; the presenter responds by flushing buffered notifications and
 * pushing the current snapshot immediately. app:ready is no longer driven by
 * ui-connected — it is dispatched by the presenter's app:start `start` hook.
 *
 * The first-run flow (boot splash, setup progress, agent picker, workspace
 * loading) is presented entirely through the dialog framework now: the agent
 * pick, and the setup-error Retry/Quit buttons, arrive as ordinary
 * `dialog-action` events routed to the presenter's startup dialog session.
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
  // Persist the expanded sidebar width (px) after a drag-resize on its right
  // edge. Fired once on drag release; the presenter clamps (>= min) and writes
  // it to the `sidebar.width` config key, then echoes it back in the snapshot.
  z.object({ kind: z.literal("resize-sidebar"), width: z.number().int().positive() }),
  z.object({
    kind: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    logger: z.string(),
    message: z.string(),
    context: logContextSchema.optional(),
  }),
  // Open the settings dialog (sidebar gear click). The presenter forwards this
  // to the settings module, which opens the declarative settings dialog. The
  // Alt+X+S shortcut reaches the same module via the shortcut-key domain event.
  z.object({ kind: z.literal("open-settings") }),
  // Dialog user interactions. The
  // presenter routes these to the matching open dialog session by `dialogId`
  // (the opaque id echoed from the snapshot's `dialogs`). `data` is the flat
  // field-values snapshot (keyed by field id); values are strings.
  z.object({
    kind: z.literal("dialog-action"),
    dialogId: z.string(),
    actionId: z.string(),
    data: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal("dialog-change"),
    dialogId: z.string(),
    fieldId: z.string(),
    data: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal("dialog-dismiss"), dialogId: z.string() }),
  // Notification user interactions. actionId is "dismiss" for the dismiss button, else a button id.
  z.object({
    kind: z.literal("notification-event"),
    notificationId: z.string(),
    actionId: z.string(),
  }),
]);

/** Discriminated union of all renderer→main UI events. */
export type UiEvent = z.infer<typeof uiEventSchema>;
