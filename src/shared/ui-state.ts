/**
 * UI state contract: the full semantic UI snapshot pushed main → renderer on
 * the api:ui:state channel (Phase B of planning/UI_STATE_ARCHITECTURE.md).
 *
 * Phase B is a shadow: the presenter builds and pushes snapshots, but the
 * renderer does not consume them yet. The shape is the final render-ready
 * view-model: regions are self-contained (the renderer never joins), rows
 * carry presenter-assigned opaque keys, and `main` describes what the main
 * view shows.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import type { AgentStatus, WorkspaceTag } from "./api/types";

/** Resolved OS theme (mirrors the shell Theme type without importing it). */
export type UiTheme = "dark" | "light";

export interface UiWorkspaceRow {
  /**
   * Opaque presenter-assigned identity; stable across the creating → ready
   * swap. The renderer must never parse or construct keys — it only echoes
   * them back in ui:events.
   */
  readonly key: string;
  /**
   * TRANSITIONAL (read-cutover only): real worktree path, echoed back into
   * the path-keyed write invokes the renderer still makes. Creating
   * placeholders carry a synthetic `__pending__/...` path. Deleted in the
   * write-path phase, when ui:events carry `key` instead.
   */
  readonly path: string;
  readonly name: string;
  /**
   * TRANSITIONAL (until dialogs move to main): base branch the workspace was
   * created from, shown by the renderer-local remove dialog's unmerged-commits
   * warning.
   */
  readonly base?: string;
  readonly status: "creating" | "ready" | "deleting" | "delete-failed";
  readonly hibernated: boolean;
  readonly agent: AgentStatus;
  readonly tags: readonly WorkspaceTag[];
  readonly active: boolean;
}

export interface UiProjectRow {
  readonly id: string;
  /**
   * TRANSITIONAL (read-cutover only): project path, echoed back into the
   * path-keyed `projects.close` invoke. Deleted in the write-path phase.
   */
  readonly path: string;
  readonly name: string;
  /** Tooltip text: the project's remote URL when cloned, else its local path. */
  readonly title: string;
  /** True for projects cloned from a git URL (drives icon + close-dialog options). */
  readonly remote: boolean;
  readonly workspaces: readonly UiWorkspaceRow[];
}

/**
 * What the main view shows. The hibernated screen carries no workspace
 * identity: it always shows the active workspace, which main knows.
 * The creation panel is the ground state: it shows whenever no workspace is
 * active (there is no separate empty state).
 */
export type UiMainView =
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
}

/**
 * Display-order comparator (AaBbCc ordering) for project and workspace names.
 * Shared so presenter (main) and renderer always agree on sidebar order.
 */
export function compareDisplayNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { caseFirst: "upper" });
}
