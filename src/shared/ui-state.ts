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
 * A first-run setup progress row (vscode / agent / setup). Render-ready: the
 * presenter accumulates per-row status from setup:progress domain events.
 */
export interface UiSetupRow {
  readonly id: string;
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "error";
  readonly message?: string;
  readonly progress?: number;
}

/** An agent option for the first-run agent picker. */
export interface UiAgentOption {
  readonly agent: string;
  readonly label: string;
  readonly icon: string;
}

/**
 * What the main view shows. The hibernated screen carries no workspace
 * identity: it always shows the active workspace, which main knows.
 * The creation panel is the ground state: it shows whenever no workspace is
 * active (there is no separate empty state).
 *
 * The startup kinds (starting / setup / agent-selection / loading) are pushed
 * by the presenter during app:start, before app:started — the renderer renders
 * them via StartupView in place of MainView.
 */
export type UiMainView =
  | { readonly kind: "starting" }
  | {
      readonly kind: "setup";
      readonly rows: readonly UiSetupRow[];
      readonly error?: { readonly message: string };
    }
  | { readonly kind: "agent-selection"; readonly agents: readonly UiAgentOption[] }
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "workspace"; readonly frameKey: string }
  | { readonly kind: "hibernated"; readonly screenshot: string | null }
  | { readonly kind: "creation" };

export interface UiState {
  readonly sidebar: { readonly projects: readonly UiProjectRow[] };
  /**
   * Mounted workspace iframes: key → code-server URL. Every workspace with a
   * runtime stays mounted (keep-alive); `main` references at most one of them.
   */
  readonly frames: Readonly<Record<string, string>>;
  readonly main: UiMainView;
  readonly theme: UiTheme;
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
