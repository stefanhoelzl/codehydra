/**
 * UI state contract: the full semantic UI snapshot pushed main → renderer on
 * the api:ui:state channel (planning/UI_STATE_ARCHITECTURE.md).
 *
 * The shape is the final render-ready view-model: regions are self-contained
 * (the renderer never joins), rows carry opaque keys (workspace refs), and
 * `main` describes what the main view shows.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import type { AgentStatus, WorkspaceTag } from "./api/types";
import type { UIMode } from "./ipc";
import type { DialogConfig, DialogKind } from "./dialog-types";
import type { NotificationConfig } from "./notification-types";
import type { SubtitleIcon } from "../intents/contract";

/** Resolved OS theme (mirrors the shell Theme type without importing it). */
export type UiTheme = "dark" | "light";

/**
 * Clamp an expanded-sidebar width (px) to the floor (288): the sidebar is a
 * 272px card inside an 8px margin, the narrowest its rows are laid out for.
 * The window-relative maximum is enforced renderer-side (main can't see the
 * window size); the config default is inlined in main.ts.
 */
export function clampSidebarWidthMin(width: number): number {
  return Math.max(288, Math.round(width));
}

/**
 * How the sidebar shares the window with the workspace (config
 * `sidebar.mode`). `overlay` = a collapsed strip that expands over the
 * workspace; `docked` = always expanded, the workspace shrinks to the space
 * beside it.
 */
export const SIDEBAR_MODES = ["overlay", "docked"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

/**
 * The sidebar's process summary (config `sidebar.process-summary`): `off`, or
 * on with the process bar above the footer at one of three levels — `total`
 * (one row), `breakdown` (workspaces, code server, CodeHydra) or `tree` (every
 * process).
 */
export const PROCESS_SUMMARY_MODES = ["off", "total", "breakdown", "tree"] as const;
export type ProcessSummaryMode = (typeof PROCESS_SUMMARY_MODES)[number];
/** The process bar's levels: every mode but `off`. */
export const PROCESS_BAR_LEVELS = ["total", "breakdown", "tree"] as const;
export type ProcessBarLevel = (typeof PROCESS_BAR_LEVELS)[number];
/** The process tree's height, as a fraction of the sidebar's: before any drag, and its bounds. */
export const PROCESS_TREE_DEFAULT_HEIGHT = 0.25;
export const PROCESS_TREE_MIN_HEIGHT = 0.1;
export const PROCESS_TREE_MAX_HEIGHT = 0.7;

/**
 * How much of a project's hibernated list the sidebar shows: `hidden` (none,
 * the resting state), `manual` (the hibernated workspaces without a wakeup
 * script) or `all` (the automated ones too). Main-owned, not persisted: the
 * project's moon button, its "Show automated workspaces" item and
 * Alt+X, T change it; leaving the project card resets it to `hidden`.
 */
export const HIBERNATED_VIEWS = ["hidden", "manual", "all"] as const;
export type HibernatedView = (typeof HIBERNATED_VIEWS)[number];

/**
 * How many badge colors the sidebar's project palette has. Main hands each
 * open project an index below this (UiProjectRow.colorIndex); the renderer
 * owns the colors themselves.
 */
export const PROJECT_COLOR_COUNT = 12;

/**
 * An open dialog session, render-ready. The presenter owns the registry (via
 * its internal DialogManager) and folds it into the snapshot; the renderer
 * renders each declaratively and echoes the opaque `id` back in dialog ui:events.
 */
export interface UiDialog {
  readonly id: string;
  readonly kind: DialogKind;
  readonly config: DialogConfig;
}

/** An open sidebar notification, render-ready (presenter-owned, echoed by id). */
export interface UiNotification {
  readonly id: string;
  readonly config: NotificationConfig;
  /**
   * How many opens this card stands for. NotificationManager collapses opens
   * whose configs are identical, so a condition that repeats produces one card
   * with a rising count rather than a stack of duplicates. Manager-owned render
   * state, deliberately not part of NotificationConfig: a caller says what to
   * show, not how many times it has been said. 1 for an ordinary notification.
   */
  readonly count?: number;
  /**
   * The workspace this card is about, when it is attached to one: `key` is the
   * row's opaque key (echoed back in `switch-workspace` when the card is
   * clicked), `name` is what the row shows. Absent for app-wide cards.
   */
  readonly workspace?: { readonly key: string; readonly name: string };
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
   * The row's identity: the workspace's ref (`ch::<machine>::<project>::<name>`),
   * known from the start and so stable across the creating → ready swap. Also
   * the key of its frame in `frames`. Opaque to the renderer: it must never
   * parse or construct keys — it only echoes them back in ui:events.
   */
  readonly key: string;
  readonly name: string;
  /**
   * User-given display title (workspace metadata `title`). Sidebar-only: the
   * workspace `name` stays the identity used for keys, sorting, and shortcut
   * numbering. Absent when no title is set, in which case the row falls back to
   * showing `name`.
   */
  readonly title?: string;
  /**
   * The workspace's subtitle as its project type gives it (git: the branch),
   * shown on a titled row's second line. Absent when the type gives none.
   */
  readonly subtitle?: string;
  /** The icon before the subtitle; absent for none. */
  readonly subtitleIcon?: SubtitleIcon;
  /**
   * `creating`: a new worktree is being made. `loading`: an existing worktree
   * is being opened (startup, project open). `open-failed`: that open failed —
   * `openError` says why; Retry echoes the key as `wake-workspace`.
   */
  readonly status: "creating" | "loading" | "ready" | "open-failed" | "deleting" | "delete-failed";
  /**
   * Orthogonal to `status`: a hibernated workspace is still `ready` (or even
   * `deleting`) — hibernation is a sleep flag layered on the lifecycle, not a
   * lifecycle phase. Drives the dimmed sidebar row, wake-on-click, and
   * shortcut numbering (hibernated rows are unnumbered).
   */
  readonly hibernated: boolean;
  /**
   * When the workspace was hibernated (ISO-8601). Present only while
   * `hibernated` and the time is known — a workspace hibernated before the
   * time was recorded has none. The renderer derives the age it shows.
   */
  readonly hibernatedAt?: string;
  /**
   * The wakeup script of a hibernated workspace that has one (an "automated"
   * workspace: it wakes by itself). Present only while `hibernated`. The
   * sidebar lists these after the other hibernated workspaces, behind their
   * own "Show automated workspaces" item.
   */
  readonly wakeupScript?: string;
  readonly agent: AgentStatus;
  /**
   * Something here is new to the user: its agent finished (went from busy to
   * idle) or connected idle since the user last saw it — saw meaning it was the
   * active workspace while the window had focus — or a question or dialog about
   * it is waiting. Only true while `agent` reads idle; the sidebar shows such
   * an idle dot with a halo, a seen one without.
   */
  readonly fresh: boolean;
  readonly tags: readonly WorkspaceTag[];
  readonly active: boolean;
  /** Why the open failed; present while `status` is `open-failed`. */
  readonly openError?: string;
  /** Present while `status` is `deleting`/`delete-failed`; absent otherwise. */
  readonly deletionProgress?: UiDeletionProgress;
  /**
   * The workspace's processes, totalled, while `sidebar.processSummary` is on
   * and a scan has found any. Absent when hibernated.
   */
  readonly processes?: UiProcessSummary;
}

/** A workspace's processes, totalled (the sidebar's process summary). */
export interface UiProcessSummary {
  /**
   * Percent of the whole machine (all logical CPUs, 0–100) over the last few
   * seconds; null until a second scan.
   */
  readonly cpuPercent: number | null;
  /** Resident memory, in bytes. */
  readonly rssBytes: number;
  readonly count: number;
}

/** CodeHydra's whole footprint: its own process tree and every workspace's processes. */
export interface UiProcessTotals {
  /** `workspaces`, `codeServer` and `codehydra` together, each process once. */
  readonly all: UiProcessSummary;
  /** Every process attributed to a workspace, wherever it runs. */
  readonly workspaces: UiProcessSummary;
  /** The IDE server and what it runs, less what belongs to a workspace. */
  readonly codeServer: UiProcessSummary;
  /** The rest of CodeHydra's process tree: the app and its helpers. */
  readonly codehydra: UiProcessSummary;
}

/** One process in the sidebar's process tree. */
export interface UiProcessNode {
  readonly pid: number;
  /** ISO 8601; with `pid`, what tells it apart from a later process reusing the pid. */
  readonly startedAt: string | null;
  readonly name: string;
  readonly commandLine: string | null;
  readonly cwd: string | null;
  /** Ports it listens on, ascending. */
  readonly ports: readonly number[];
  /** The process itself and everything below it. */
  readonly subtree: UiProcessSummary;
  readonly children: readonly UiProcessNode[];
}

/** A workspace's processes in the tree. */
export interface UiProcessTreeWorkspace {
  readonly key: string;
  readonly name: string;
  readonly total: UiProcessSummary;
  readonly processes: readonly UiProcessNode[];
}

/** A project's workspaces that run something, in sidebar order. */
export interface UiProcessTreeProject {
  readonly id: string;
  readonly name: string;
  readonly total: UiProcessSummary;
  readonly workspaces: readonly UiProcessTreeWorkspace[];
}

/** Every process CodeHydra accounts for, as a tree (the process bar's `tree` level). */
export interface UiProcessTree {
  readonly projects: readonly UiProcessTreeProject[];
  readonly codeServer: readonly UiProcessNode[];
  readonly codehydra: readonly UiProcessNode[];
}

export interface UiProjectRow {
  readonly id: string;
  readonly name: string;
  /** Tooltip text: the project's remote URL when cloned, else its local path. */
  readonly title: string;
  /** True for projects cloned from a git URL (drives the project icon). */
  readonly remote: boolean;
  /**
   * The project's badge color: an index into the sidebar's palette of
   * PROJECT_COLOR_COUNT colors. Assigned when the project is opened (the lowest
   * index no other open project has) and kept in its record until it is closed.
   */
  readonly colorIndex: number;
  /**
   * Every workspace of the project, in sidebar order: the hibernated ones
   * without a wakeup script (most recently hibernated first), then the
   * automated ones (likewise), then the awake ones by name. The renderer shows
   * or folds them away; keyboard navigation walks the same order.
   */
  readonly workspaces: readonly UiWorkspaceRow[];
  /**
   * The project card is collapsed to its header (persisted
   * `sidebar.collapsed-projects` state). Keyboard navigation skips the
   * workspaces of a collapsed project.
   */
  readonly collapsed: boolean;
  /** How much of the hibernated list is shown (see HibernatedView). */
  readonly hibernatedView: HibernatedView;
}

/**
 * The sidebar's Find field while it has the focus: every project is expanded
 * and the rows filter as the user types (the text stays renderer-local).
 * `hibernatedView` applies to every project at once and starts at `manual`;
 * Alt+X, T cycles it.
 */
export interface UiSidebarFind {
  readonly hibernatedView: HibernatedView;
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
  | {
      readonly kind: "hibernated";
      readonly screenshot: string | null;
      /** When it was hibernated (ISO-8601); null when unrecorded. */
      readonly hibernatedAt: string | null;
    }
  | { readonly kind: "creation" };

export interface UiState {
  readonly sidebar: {
    readonly projects: readonly UiProjectRow[];
    /** Persisted expanded-sidebar width (px), clamped to the shared minimum. */
    readonly width: number;
    /** How the sidebar shares the window with the workspace (config `sidebar.mode`). */
    readonly mode: SidebarMode;
    /**
     * The Find field is focused (null otherwise). Main owns it so Alt+X, F can
     * open it, Alt+X, T can cycle its hibernated view, and the overlay sidebar
     * stays expanded while it is open.
     */
    readonly find: UiSidebarFind | null;
    /**
     * Whether rows show their workspace's CPU and memory, and the process
     * bar's level (config `sidebar.process-summary`).
     */
    readonly processSummary: ProcessSummaryMode;
    /**
     * The level the pulse button turns the summary back on at: the current
     * one while on, the last one used while off (state `sidebar.process-level`).
     */
    readonly processLevel: ProcessBarLevel;
    /** The process tree's height, a fraction of the sidebar's (state `sidebar.process-tree-height`). */
    readonly processTreeHeight: number;
    /**
     * Everything CodeHydra accounts for (the process bar), while
     * `processSummary` is on and a scan has finished.
     */
    readonly processTotals?: UiProcessTotals;
    /** Every process as a tree, while `processSummary` is `tree` and a scan has finished. */
    readonly processTree?: UiProcessTree;
  };
  /**
   * Mounted workspace iframes: key → IDE server URL. Every workspace with a
   * runtime stays mounted (keep-alive); `main` references at most one of them.
   */
  readonly frames: Readonly<Record<string, string>>;
  readonly main: UiMainView;
  readonly theme: UiTheme;
  /** Suppress the chime played when an agent goes idle (config `silent`). */
  readonly silent: boolean;
  /**
   * The single UI mode, computed by the presenter (main-owned) with priority
   * shortcut > dialog > hover > workspace. The renderer reads mode only from
   * this field: ShortcutOverlay visibility, sidebar expansion + hover
   * eligibility, and z-order all derive from it.
   */
  readonly mode: UIMode;
  /**
   * True only while the presenter is capturing the active workspace's
   * hibernation screenshot. Forces an overlay sidebar to its collapsed resting
   * state (overriding `mode`) so it is not baked into the screenshot (a docked
   * sidebar never covers the workspace, so it stays put); the existing
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
