/**
 * Shortcut navigation (ported from the renderer's shortcuts store).
 *
 * The shortcut-module forwards every key press while shortcut mode is active
 * as a shortcut:key intent → shortcut:key-pressed event. The presenter runs
 * navigation over the SAME ordered rows it renders, and dispatches the existing
 * intents directly with focus:false (so shortcut mode stays active across
 * keyboard navigation).
 */

import type { UiWorkspaceRow } from "../../shared/ui-state";
import { jumpKeyToIndex, type JumpKey } from "../../shared/shortcuts";
import {
  INTENT_SWITCH_WORKSPACE,
  type SwitchWorkspaceIntent,
} from "../../intents/switch-workspace";
import {
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateWorkspaceIntent,
} from "../../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "../../intents/wake-workspace";
import type { WorkspaceRef } from "../../intents/contract";
import type { PresentationModel, ProjectModel, RowEntry, WorkspaceModel } from "./view-model";

export interface ShortcutNavigationDeps {
  readonly model: PresentationModel;
  /** Every row in sidebar display order (collapsed projects included). */
  readonly rows: () => readonly RowEntry[];
  readonly rowStatus: (workspace: WorkspaceModel) => UiWorkspaceRow["status"];
  /** Whether a project's card is collapsed (its rows are skipped). */
  readonly collapsed: (project: ProjectModel) => boolean;
  /** Dispatch fire-and-forget. */
  readonly dispatch: (
    intent: SwitchWorkspaceIntent | HibernateWorkspaceIntent | WakeWorkspaceIntent
  ) => void;
  /** The interactive remove flow. */
  readonly deleteWorkspace: (workspaceRef: WorkspaceRef) => void;
  /**
   * Cycle the hibernated view (t key): Find's, for every project, while Find is
   * open; else the active workspace's project's.
   */
  readonly cycleHibernatedView: () => void;
  /** Collapse or expand the active workspace's project, as a header click does (c key). */
  readonly toggleActiveCollapsed: () => void;
  /** Open the sidebar's Find field (f key). */
  readonly openFind: () => void;
  readonly toggleSidebarMode: () => void;
  /** Show/hide each row's CPU and memory (`sidebar.process-summary`). */
  readonly toggleProcessSummary: () => void;
}

/** Awake and switchable: neither hibernated nor a still-creating placeholder. */
function isAwake(entry: RowEntry): boolean {
  return !entry.row.hibernated && entry.workspace.phase !== "creating";
}

/**
 * An idle agent, or — on an open workspace — none at all: nothing there is
 * working. (A row still opening has no agent yet either, but is not idle.)
 */
function isIdle(entry: RowEntry): boolean {
  const agent = entry.row.agent.type;
  return agent === "idle" || (agent === "none" && entry.row.status === "ready");
}

/** Create the shortcut-key handler. Takes a normalized shortcut key. */
export function createShortcutNavigation(deps: ShortcutNavigationDeps): (key: string) => void {
  const { model } = deps;

  /** Switch to a workspace (placeholders are skipped upstream). */
  function navigateSwitch(workspaceRef: WorkspaceRef): void {
    deps.dispatch({
      type: INTENT_SWITCH_WORKSPACE,
      payload: { workspaceRef, focus: false },
    });
  }

  /**
   * The rows the arrows walk: those of expanded projects in sidebar order,
   * rotated to start just after the active one (reversed for a step backwards).
   * Without an active row the walk starts at the top (backwards: at the bottom).
   */
  function rotation(direction: -1 | 1): RowEntry[] {
    const rows = deps.rows().filter((entry) => !deps.collapsed(entry.project));
    const index = rows.findIndex((entry) => entry.row.active);
    const forward = index === -1 ? rows : [...rows.slice(index + 1), ...rows.slice(0, index)];
    return direction === 1 ? forward : forward.reverse();
  }

  /** Up/down: the next awake workspace of an expanded project, wrapping. */
  function handleNavigation(direction: -1 | 1): void {
    const target = rotation(direction).find(isAwake);
    if (target) navigateSwitch(target.workspace.ref);
  }

  /** Left/right: the next idle workspace (no agent counts as idle), else the next busy one. */
  function handleStatusNavigation(direction: -1 | 1): void {
    const candidates = rotation(direction).filter(isAwake);
    const target =
      candidates.find(isIdle) ?? candidates.find((entry) => entry.row.agent.type === "busy");
    if (target) navigateSwitch(target.workspace.ref);
  }

  /**
   * Jump to the Nth awake workspace of the expanded projects (hibernated
   * workspaces are unnumbered, a collapsed project shows no rows).
   *
   * A still-creating placeholder keeps its number and the jump is a no-op:
   * skipping it would renumber every row below it the instant the creation
   * completes, and numbering that shifts under the user's fingers is worse than
   * one temporarily dead key.
   */
  function handleJump(key: JumpKey): void {
    const index = jumpKeyToIndex(key);
    const target = deps
      .rows()
      .filter((entry) => !entry.row.hibernated && !deps.collapsed(entry.project))[index];
    if (!target || target.workspace.phase === "creating") return;
    navigateSwitch(target.workspace.ref);
  }

  /** Toggle hibernation on the active workspace (h key). */
  function handleHibernateToggle(): void {
    const workspace = model.active()?.workspace;
    // Hibernating needs a running workspace; one still creating or opening has
    // nothing to stop.
    if (workspace === undefined || workspace.phase !== "ready") return;
    if (workspace.hibernated) {
      deps.dispatch({
        type: INTENT_WAKE_WORKSPACE,
        payload: { workspaceRef: workspace.ref, source: "ui-ipc" },
      });
    } else {
      deps.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspaceRef: workspace.ref },
      });
    }
  }

  /**
   * Enter: deselect (switch to null) so the creation panel becomes the main
   * view — unless it is already showing. Mode auto-computes to hover.
   */
  function handleEnter(): void {
    if (model.activeRef === null) return; // creation panel already showing
    deps.dispatch({
      type: INTENT_SWITCH_WORKSPACE,
      payload: { workspaceRef: null },
    });
  }

  /**
   * Delete: trigger the interactive remove flow for the active workspace (the
   * same path the remove-workspace ui:event uses), unless it is still creating
   * or loading, or already deleting.
   */
  function handleDelete(): void {
    const workspace = model.active()?.workspace;
    if (workspace === undefined || workspace.phase === "creating") return;
    const status = deps.rowStatus(workspace);
    if (status === "creating" || status === "loading" || status === "deleting") return;
    deps.deleteWorkspace(workspace.ref);
  }

  return (key: string): void => {
    switch (key) {
      case "up":
        handleNavigation(-1);
        break;
      case "down":
        handleNavigation(1);
        break;
      case "left":
        handleStatusNavigation(-1);
        break;
      case "right":
        handleStatusNavigation(1);
        break;
      case "enter":
        handleEnter();
        break;
      case "delete":
        handleDelete();
        break;
      case "h":
        handleHibernateToggle();
        break;
      case "t":
        deps.cycleHibernatedView();
        break;
      case "c":
        deps.toggleActiveCollapsed();
        break;
      case "f":
        deps.openFind();
        break;
      case "p":
        deps.toggleProcessSummary();
        break;
      case "d":
        deps.toggleSidebarMode();
        break;
      default:
        if (/^[0-9]$/.test(key)) handleJump(key as JumpKey);
    }
  };
}
