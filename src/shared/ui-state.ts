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

/** Resolved OS theme (mirrors the shell Theme type without importing it). */
export type UiTheme = "dark" | "light";

export interface UiWorkspaceRow {
  /**
   * Opaque presenter-assigned identity; stable across the creating → ready
   * swap. The renderer must never parse or construct keys — it only echoes
   * them back in ui:events.
   */
  readonly key: string;
  readonly name: string;
  readonly status: "creating" | "ready" | "deleting" | "delete-failed";
  readonly hibernated: boolean;
  readonly agent: AgentStatus;
  readonly tags: readonly WorkspaceTag[];
  readonly active: boolean;
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
}

/**
 * Display-order comparator (AaBbCc ordering) for project and workspace names.
 * Shared so presenter (main) and renderer always agree on sidebar order.
 */
export function compareDisplayNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { caseFirst: "upper" });
}
