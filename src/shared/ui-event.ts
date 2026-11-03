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
 * confirmation dialog main-side (`interactive: true`); `switch-workspace`,
 * `wake-workspace` and `hibernate-workspace` dispatch directly. Identity fields
 * are presenter-minted and merely echoed back from the UiState snapshot — the
 * renderer never generates identifiers itself. (Open-project has no renderer
 * gesture: the creation panel drives it entirely main-side.)
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import { z } from "zod/v4";
import { HIBERNATED_VIEWS, SIDEBAR_MODES } from "./ui-state";

const logContextSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const uiEventSchema = z.discriminatedUnion("kind", [
  // Startup handshake: emitted once after the renderer subscribes to ui:state.
  z.object({ kind: z.literal("ui-connected") }),
  // key is the snapshot row's key (its workspace ref), echoed back.
  // Switch to a workspace (sidebar/status-cell click); key null = deselect
  // (the creation panel becomes the main view).
  z.object({ kind: z.literal("switch-workspace"), key: z.string().nullable() }),
  // Wake a hibernated workspace (status-cell / overlay click).
  z.object({ kind: z.literal("wake-workspace"), key: z.string() }),
  // Hibernate a workspace (sidebar row hover button). No confirmation, like
  // the Alt+X H shortcut.
  z.object({ kind: z.literal("hibernate-workspace"), key: z.string() }),
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
  // Dock or undock the sidebar (header button). The presenter writes the
  // `sidebar.mode` config key and echoes it back in the snapshot. The Alt+X+D
  // shortcut toggles the same key via the shortcut-key domain event.
  z.object({ kind: z.literal("set-sidebar-mode"), mode: z.enum(SIDEBAR_MODES) }),
  // Show or hide each row's process summary (header button). The presenter
  // writes the `sidebar.process-summary` config key, which also starts or stops
  // the process monitor's polling, and echoes it back in the snapshot. Alt+X+P
  // toggles the same key.
  z.object({ kind: z.literal("set-sidebar-process-summary"), enabled: z.boolean() }),
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
  // Open the user guide dialog (sidebar question-mark click). The presenter
  // forwards this to the help module.
  z.object({ kind: z.literal("open-help") }),
  // Collapse or expand a project card (its header bar). The presenter flips the
  // project in the persisted `sidebar.collapsed-projects` state. Collapsing the
  // project of the active workspace moves to the first awake workspace of the
  // next expanded project, as Alt+X, Down would from its last workspace.
  z.object({ kind: z.literal("toggle-project-collapsed"), projectId: z.string() }),
  // Show part of a project's hibernated list (its moon button, its "Show
  // automated workspaces" item) or fold it away again (the pointer leaving the
  // card, a click elsewhere in it). Alt+X, T cycles the same state main-side.
  z.object({
    kind: z.literal("set-hibernated-view"),
    projectId: z.string(),
    view: z.enum(HIBERNATED_VIEWS),
  }),
  // The sidebar's Find field gained (true) or lost (false) the focus. While it
  // has it the presenter carries `sidebar.find`, which keeps an overlay sidebar
  // expanded; Alt+X, F asks the renderer to focus it by setting that field.
  z.object({ kind: z.literal("set-find"), active: z.boolean() }),
  // Open the New workspace form (the sidebar's + buttons). projectId presets
  // its project (a project card's +); null keeps the form's own choice (the
  // footer +, which is Alt+X, Enter).
  z.object({ kind: z.literal("open-new-workspace"), projectId: z.string().nullable() }),
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
