/**
 * UI state contract: the full semantic UI snapshot pushed main → renderer on
 * the api:ui:state channel (planning/UI_STATE_ARCHITECTURE.md).
 *
 * The shape is the final render-ready view-model: regions are self-contained
 * (the renderer never joins), rows carry presenter-assigned opaque keys, and
 * `main` describes what the main view shows.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import type { AgentStatus, WorkspaceTag } from "./api/types";
import type { UIMode } from "./ipc";
import type { DialogConfig, DialogSurface } from "./dialog-types";
import type { NotificationConfig } from "./notification-types";

/** Resolved OS theme (mirrors the shell Theme type without importing it). */
export type UiTheme = "dark" | "light";

/**
 * Clamp an expanded-sidebar width (px) to the grow-only floor (250) — the
 * historical default, so resizing can never make the sidebar narrower than it
 * was before this feature. The window-relative maximum is enforced
 * renderer-side (main can't see the window size); the config default is inlined
 * in main.ts.
 */
export function clampSidebarWidthMin(width: number): number {
  return Math.max(250, Math.round(width));
}

/**
 * How an overflowing sidebar row label scrolls horizontally (config
 * `sidebar.label-scroll`). `always` = overflowing lines scroll continuously,
 * `hover` = only while the row is hovered, `off` = clip (no motion).
 */
export type SidebarLabelScroll = "always" | "hover" | "off";

/**
 * An open dialog session, render-ready. The presenter owns the registry (via
 * its internal DialogManager) and folds it into the snapshot; the renderer
 * renders each declaratively and echoes the opaque `id` back in dialog ui:events.
 */
export interface UiDialog {
  readonly id: string;
  readonly surface: DialogSurface;
  readonly config: DialogConfig;
}

/** An open sidebar notification, render-ready (presenter-owned, echoed by id). */
export interface UiNotification {
  readonly id: string;
  readonly config: NotificationConfig;
}

/** Display status of a single workspace-deletion operation. */
export type UiDeletionOpStatus = "pending" | "in-progress" | "done" | "error";

/** A single deletion-pipeline step, render-ready (no domain identifiers). */
export interface UiDeletionOp {
  readonly id: string;
  readonly label: string;
  readonly status: UiDeletionOpStatus;
  readonly error?: string;
}

/**
 * Render-ready deletion progress for a workspace row. Present only while a
 * workspace is deleting or its deletion has failed; the row's `status` is
 * derived from it (deleting vs delete-failed). The renderer detail-consumer
 * (the deletion confirmation surface) reads `operations`; until that lands the
 * field rides along carrying the data the presenter already derives `status`
 * from. Carries no WorkspacePath/ProjectId/PIDs — opaque-key invariant holds.
 */
export interface UiDeletionProgress {
  readonly operations: readonly UiDeletionOp[];
  readonly completed: boolean;
  readonly hasErrors: boolean;
  /** Count of processes blocking deletion (Windows EBUSY/EACCES/EPERM). */
  readonly blockingProcessCount: number;
}

export interface UiWorkspaceRow {
  /**
   * Opaque presenter-assigned identity; stable across the creating → ready
   * swap. The renderer must never parse or construct keys — it only echoes
   * them back in ui:events.
   */
  readonly key: string;
  readonly name: string;
  /**
   * User-given display title (workspace metadata `title`). Sidebar-only: the
   * branch `name` stays the identity used for keys, sorting, and shortcut
   * numbering. Absent when no title is set, in which case the row falls back to
   * showing `name`.
   */
  readonly title?: string;
  readonly status: "creating" | "ready" | "deleting" | "delete-failed";
  /**
   * Orthogonal to `status`: a hibernated workspace is still `ready` (or even
   * `deleting`) — hibernation is a sleep flag layered on the lifecycle, not a
   * lifecycle phase. Drives the dimmed sidebar row, wake-on-click, and
   * shortcut numbering (hibernated rows are unnumbered).
   */
  readonly hibernated: boolean;
  readonly agent: AgentStatus;
  readonly tags: readonly WorkspaceTag[];
  readonly active: boolean;
  /** Present while `status` is `deleting`/`delete-failed`; absent otherwise. */
  readonly deletionProgress?: UiDeletionProgress;
}

export interface UiProjectRow {
  readonly id: string;
  readonly name: string;
  /** Tooltip text: the project's remote URL when cloned, else its local path. */
  readonly title: string;
  /** True for projects cloned from a git URL (drives the project icon). */
  readonly remote: boolean;
  readonly workspaces: readonly UiWorkspaceRow[];
}

/**
 * What the main view shows. The hibernated screen carries no workspace
 * identity: it always shows the active workspace, which main knows.
 * The creation panel is the ground state: it shows whenever no workspace is
 * active (there is no separate empty state).
 *
 * `starting` is the single pre-`app:started` marker: main shows nothing (a
 * blank base) while the presenter drives the boot splash, first-run setup,
 * agent picker, and workspace loading as modal dialogs layered on top (see
 * `dialogs`). The renderer shows MainView only once `main.kind !== "starting"`.
 * Mid-session workspace loading (a still-creating active workspace) is also a
 * dialog — `main` then reads `workspace` with a frameKey whose iframe is not
 * mounted yet, so the workspace area is blank behind the loading dialog.
 */
export type UiMainView =
  | { readonly kind: "starting" }
  | { readonly kind: "workspace"; readonly frameKey: string }
  | { readonly kind: "hibernated"; readonly screenshot: string | null }
  | { readonly kind: "creation" };

export interface UiState {
  readonly sidebar: {
    readonly projects: readonly UiProjectRow[];
    /** Persisted expanded-sidebar width (px), clamped to the shared minimum. */
    readonly width: number;
  };
  /**
   * Mounted workspace iframes: key → code-server URL. Every workspace with a
   * runtime stays mounted (keep-alive); `main` references at most one of them.
   */
  readonly frames: Readonly<Record<string, string>>;
  readonly main: UiMainView;
  readonly theme: UiTheme;
  /** How overflowing sidebar row labels scroll (config `sidebar.label-scroll`). */
  readonly labelScroll: SidebarLabelScroll;
  /**
   * The single UI mode, computed by the presenter (main-owned) with priority
   * shortcut > dialog > hover > workspace. The renderer reads mode only from
   * this field: ShortcutOverlay visibility, sidebar expansion + hover
   * eligibility, and z-order all derive from it.
   */
  readonly mode: UIMode;
  /**
   * True only while the presenter is capturing the active workspace's
   * hibernation screenshot. Forces the sidebar to its collapsed resting state
   * (overriding `mode`) so it is not baked into the screenshot; the existing
   * `.sidebar:not(.expanded)` rule makes that collapse instant. Main-owned,
   * set by the hibernate `prepare-capture` hook and always cleared by
   * `cleanup-capture` (runs in the operation's finally).
   */
  readonly capturing: boolean;
  /** Open dialog sessions (modal cards + non-modal panels), in open order. */
  readonly dialogs: readonly UiDialog[];
  /** Open sidebar notifications, in open order. */
  readonly notifications: readonly UiNotification[];
}

/**
 * Display-order comparator (AaBbCc ordering) for project and workspace names.
 * Shared so presenter (main) and renderer always agree on sidebar order.
 */
export function compareDisplayNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { caseFirst: "upper" });
}
