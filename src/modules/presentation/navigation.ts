/**
 * Shortcut navigation (ported from the renderer's shortcuts store).
 *
 * The shortcut-module forwards every key press while shortcut mode is active
 * as a shortcut:key intent → shortcut:key-pressed event. The presenter runs
 * navigation over the SAME ordered rows it renders, and dispatches the existing
 * intents directly with focus:false (so shortcut mode stays active across
 * keyboard navigation).
 */

import type { AgentStatus } from "../../shared/api/types";
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
import type { PresentationModel, RowEntry, WorkspaceModel } from "./view-model";

export interface ShortcutNavigationDeps {
  readonly model: PresentationModel;
  /** Rows in sidebar display order, hidden hibernated rows left out. */
  readonly rows: () => readonly RowEntry[];
  readonly rowStatus: (workspace: WorkspaceModel) => UiWorkspaceRow["status"];
  /** Dispatch fire-and-forget. */
  readonly dispatch: (
    intent: SwitchWorkspaceIntent | HibernateWorkspaceIntent | WakeWorkspaceIntent
  ) => void;
  /** The interactive remove flow. */
  readonly deleteWorkspace: (workspaceRef: WorkspaceRef) => void;
  readonly toggleHideHibernated: () => void;
  readonly toggleSidebarMode: () => void;
}

/** Wrap an index into [0, length). */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** Where a walk in `direction` starts: one step from the current row, or an end without one. */
function startIndex(currentIndex: number, direction: -1 | 1, length: number): number {
  if (currentIndex === -1) return direction === 1 ? 0 : length - 1;
  return wrapIndex(currentIndex + direction, length);
}

/**
 * Find the next workspace index matching a status type in the given
 * direction. Hibernated workspaces are always skipped — idle nav targets
 * workspaces the user can immediately work in. Returns -1 if none.
 */
function findNextByStatusType(
  entries: readonly RowEntry[],
  currentIndex: number,
  direction: -1 | 1,
  statusType: AgentStatus["type"]
): number {
  const count = entries.length;
  const start = startIndex(currentIndex, direction, count);
  const iterations = currentIndex === -1 ? count : count - 1;
  for (let i = 0; i < iterations; i++) {
    const index = wrapIndex(start + i * direction, count);
    const entry = entries[index];
    if (!entry) continue;
    if (entry.row.hibernated) continue;
    if (entry.row.agent.type === statusType) return index;
  }
  return -1;
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
   * Up/down navigation. Wraps at boundaries; when nothing is active (creation
   * panel) Up → last and Down → first. Targets the workspace's real path; a
   * still-creating placeholder (null path) is not a valid target, so it is
   * stepped over rather than stopped on — placeholders stay in the list for the
   * whole creation now, so one can sit anywhere between two navigable rows.
   */
  function handleNavigation(direction: -1 | 1): void {
    const entries = deps.rows();
    if (entries.length === 0) return;
    const currentIndex = entries.findIndex((e) => e.row.active);
    const start = startIndex(currentIndex, direction, entries.length);
    for (let i = 0; i < entries.length; i++) {
      const index = wrapIndex(start + i * direction, entries.length);
      // Wrapped back to where we started: nothing else is navigable.
      if (index === currentIndex) return;
      const target = entries[index];
      if (target && target.workspace.phase !== "creating") {
        navigateSwitch(target.workspace.ref);
        return;
      }
    }
  }

  /**
   * Left/right navigation by status: prefer idle workspaces, fall back to busy
   * only when the current workspace isn't already idle (or there is none).
   */
  function handleStatusNavigation(direction: -1 | 1): void {
    const entries = deps.rows();
    if (entries.length === 0) return;
    const currentIndex = entries.findIndex((e) => e.row.active);

    let targetIndex = findNextByStatusType(entries, currentIndex, direction, "idle");
    if (targetIndex === -1) {
      const currentStatus = currentIndex === -1 ? undefined : entries[currentIndex]?.row.agent;
      if (currentStatus?.type !== "idle") {
        targetIndex = findNextByStatusType(entries, currentIndex, direction, "busy");
      }
    }
    if (targetIndex === -1) return;
    const target = entries[targetIndex];
    if (!target || target.workspace.phase === "creating") return;
    navigateSwitch(target.workspace.ref);
  }

  /**
   * Jump to the Nth awake workspace (hibernated workspaces are unnumbered).
   *
   * A still-creating placeholder keeps its number and the jump is a no-op:
   * skipping it would renumber every row below it the instant the creation
   * completes, and numbering that shifts under the user's fingers is worse than
   * one temporarily dead key.
   */
  function handleJump(key: JumpKey): void {
    const index = jumpKeyToIndex(key);
    const target = deps.rows().filter((e) => !e.row.hibernated)[index];
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
        deps.toggleHideHibernated();
        break;
      case "p":
        deps.toggleSidebarMode();
        break;
      default:
        if (/^[0-9]$/.test(key)) handleJump(key as JumpKey);
    }
  };
}
