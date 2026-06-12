/**
 * Shortcut mode state store using Svelte 5 runes.
 * Manages keyboard shortcut overlay visibility and handlers.
 *
 * UI mode state is centralized in ui-mode.svelte.ts.
 * This module provides the handleModeChange function to update the central store.
 */

import * as api from "$lib/api";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "$lib/api";
import { createLogger } from "$lib/logging";
import { getErrorMessage } from "@shared/error-utils";
import type { UIModeChangedEvent } from "@shared/ipc";
import type { UiWorkspaceRow } from "@shared/ui-state";
import { openRemoveDialog } from "./dialogs.svelte";
import { uiState } from "./ui-state.svelte";
import { jumpKeyToIndex, type JumpKey, type ShortcutKey } from "@shared/shortcuts";

// Import from central ui-mode store (one-way dependency: shortcuts → ui-mode)
import { shortcutModeActive, setModeFromMain, reset as resetUiMode } from "./ui-mode.svelte.js";

// Create logger for this module
const logger = createLogger("ui");

// ============ Snapshot access ============

/** A workspace row plus its owning project's id (for WorkspaceRef building). */
interface NavEntry {
  readonly row: UiWorkspaceRow;
  readonly projectId: string;
}

/** All workspace rows in sidebar display order (matches visual navigation). */
function allEntries(): NavEntry[] {
  const projects = uiState.value?.sidebar.projects ?? [];
  return projects.flatMap((project) =>
    project.workspaces.map((row) => ({ row, projectId: project.id }))
  );
}

function activeEntry(): NavEntry | undefined {
  return allEntries().find((entry) => entry.row.active);
}

function refOf(entry: NavEntry): WorkspaceRef {
  return {
    projectId: entry.projectId as ProjectId,
    workspaceName: entry.row.name as WorkspaceName,
    path: entry.row.path,
  };
}

/** True while the creation panel is the main view (nothing selected). */
function creationPanelShown(): boolean {
  return uiState.value?.main.kind === "creation";
}

/** Wrap an index into [0, length). */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

// ============ Actions ============

/**
 * Handles ui:mode-changed event from main process.
 * Delegates to central ui-mode store.
 * @param event - The mode change event with mode and previousMode
 */
export function handleModeChange(event: UIModeChangedEvent): void {
  setModeFromMain(event.mode);
}

// ============ Action Handlers ============

// Guard to prevent concurrent workspace switches during rapid key presses
let _switchingWorkspace = false;

/**
 * Handles window blur events. Exits shortcut mode when window loses focus.
 * Does not exit if we're actively switching workspaces (Electron triggers blur
 * events when updating view bounds during workspace switches).
 */
export function handleWindowBlur(): void {
  // Don't exit shortcut mode if we're actively switching workspaces
  // (Electron triggers blur events when updating view bounds)
  if (shortcutModeActive.value && !_switchingWorkspace) {
    exitShortcutMode();
  }
}

/**
 * Exits shortcut mode and restores normal state.
 * Sets local state immediately for responsive UI, then syncs with main process.
 */
function exitShortcutMode(): void {
  // Set local state immediately for responsive UI
  setModeFromMain("workspace");
  // Fire-and-forget pattern - see AGENTS.md IPC Patterns
  void api.ui.setMode("workspace");
}

/**
 * Logs workspace switch errors with consistent formatting.
 */
function logWorkspaceSwitchError(action: string, error: unknown): void {
  logger.error(`Failed to ${action}`, {
    error: getErrorMessage(error),
  });
}

/**
 * Handle keydown events during shortcut mode.
 * Only handles Escape key - other action keys come via events from main process.
 * (See Design Decisions: Escape is handled by renderer because it's a UI-level action.)
 *
 * @param event - The keyboard event
 */
export function handleKeyDown(event: KeyboardEvent): void {
  if (!shortcutModeActive.value) return;

  // Only handle Escape - other keys come via onShortcut events from main process
  if (event.key === "Escape") {
    event.preventDefault();
    exitShortcutMode();
  }
}

/**
 * Handle shortcut key events from main process.
 * This is the new event-based handler for Stage 2 (main process detects keys, emits events).
 *
 * @param key - Normalized shortcut key from main process (e.g., "up", "down", "enter", "0"-"9")
 */
export function handleShortcutKey(key: ShortcutKey): void {
  void executeShortcutAction(key);
}

/**
 * Execute action for a normalized ShortcutKey.
 * Maps normalized keys to action handlers.
 */
async function executeShortcutAction(key: ShortcutKey): Promise<void> {
  switch (key) {
    case "up":
      await handleNavigation(-1);
      break;
    case "down":
      await handleNavigation(1);
      break;
    case "left":
      await handleStatusNavigation(-1);
      break;
    case "right":
      await handleStatusNavigation(1);
      break;
    case "enter":
      handleDialog("enter");
      break;
    case "delete":
      handleDialog("delete");
      break;
    case "h":
      await handleHibernateToggle();
      break;
    default:
      // Digit keys: "0"-"9"
      if (/^[0-9]$/.test(key)) {
        await handleJump(key as JumpKey);
      }
  }
}

/**
 * Handle arrow key navigation between workspaces.
 * Direction: -1 for previous (up), 1 for next (down).
 * Wraps around at boundaries. No-op if <=1 workspaces or switch in progress.
 * Does not focus workspace to keep shortcut mode active.
 */
async function handleNavigation(direction: -1 | 1): Promise<void> {
  const entries = allEntries();
  if (entries.length === 0) return;
  if (_switchingWorkspace) return;

  const currentIndex = entries.findIndex((entry) => entry.row.active);
  // When no workspace is active (e.g. coming from the creation panel),
  // Up → last and Down → first.
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : entries.length - 1
      : wrapIndex(currentIndex + direction, entries.length);
  // No-op when the only workspace is already current.
  if (nextIndex === currentIndex) return;
  const target = entries[nextIndex];
  if (!target) return;

  _switchingWorkspace = true;
  try {
    // Pass false to keep UI focused (shortcut mode active). The snapshot
    // push following workspace:switched updates sidebar + frame (and leaves
    // the creation panel when it was showing).
    await api.ui.switchWorkspace(target.row.path, false);
  } catch (error) {
    logWorkspaceSwitchError("switch workspace", error);
  } finally {
    _switchingWorkspace = false;
  }
}

/**
 * Handle left/right arrow navigation to next workspace by status.
 * Prefers idle workspaces; falls back to busy when no idle targets exist.
 * Direction: -1 for previous (left), 1 for next (right).
 * Wraps around if needed. No-op if no targetable workspace exists.
 */
async function handleStatusNavigation(direction: -1 | 1): Promise<void> {
  if (_switchingWorkspace) return;

  const entries = allEntries();
  if (entries.length === 0) return;

  const currentIndex = entries.findIndex((entry) => entry.row.active);

  // Try idle first, fall back to busy only when the current workspace isn't
  // already idle (or when there's no current workspace — e.g. from the
  // creation panel — in which case we always allow the busy fallback).
  let targetIndex = findNextByStatusType(entries, currentIndex, direction, "idle");
  if (targetIndex === -1) {
    const currentStatus = currentIndex === -1 ? undefined : entries[currentIndex]?.row.agent;
    if (currentStatus?.type !== "idle") {
      targetIndex = findNextByStatusType(entries, currentIndex, direction, "busy");
    }
  }
  if (targetIndex === -1) return;

  const target = entries[targetIndex];
  if (!target) return;

  _switchingWorkspace = true;
  try {
    await api.ui.switchWorkspace(target.row.path, false);
  } catch (error) {
    logWorkspaceSwitchError("navigate workspace", error);
  } finally {
    _switchingWorkspace = false;
  }
}

/**
 * Find next workspace index matching the given status type in the given direction.
 * Hibernated workspaces are always skipped — idle nav targets workspaces the
 * user can immediately work in.
 * Returns -1 if no matching workspace exists.
 */
function findNextByStatusType(
  entries: readonly NavEntry[],
  currentIndex: number,
  direction: -1 | 1,
  statusType: string
): number {
  const count = entries.length;
  // No active workspace: iterate ALL `count` indices starting from the end
  // appropriate for the direction (Right → 0, Left → last).
  // Active workspace: iterate the other `count - 1` indices, skipping current.
  const startIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : count - 1
      : wrapIndex(currentIndex + direction, count);
  const iterations = currentIndex === -1 ? count : count - 1;
  for (let i = 0; i < iterations; i++) {
    const index = wrapIndex(startIndex + i * direction, count);
    const entry = entries[index];
    if (!entry) continue;
    if (entry.row.hibernated) continue;
    if (entry.row.agent.type === statusType) {
      return index;
    }
  }
  return -1;
}

/**
 * Handle number key jump to specific workspace.
 * Targets the Nth awake workspace (hibernated workspaces are unnumbered).
 * No-op if index out of range or switch in progress.
 * Does not focus workspace to keep shortcut mode active.
 */
async function handleJump(key: JumpKey): Promise<void> {
  const index = jumpKeyToIndex(key);
  // The Nth awake workspace (hibernated workspaces are unnumbered).
  const target = allEntries().filter((entry) => !entry.row.hibernated)[index];
  if (!target) return;
  if (_switchingWorkspace) return;

  _switchingWorkspace = true;
  try {
    // Pass false to keep UI focused (shortcut mode active)
    await api.ui.switchWorkspace(target.row.path, false);
  } catch (error) {
    logWorkspaceSwitchError("jump to workspace", error);
  } finally {
    _switchingWorkspace = false;
  }
}

/**
 * Toggle hibernation on the currently-active workspace.
 * Awake → hibernate (workspace stays in sidebar with sleeping indicator).
 * Hibernated → wake + re-open via workspace:open existingWorkspace flow.
 */
export async function handleHibernateToggle(): Promise<void> {
  // The creation panel shows when no workspace is active, so this is
  // naturally inert while the panel is showing.
  const entry = activeEntry();
  if (!entry) return;

  const isHibernated = entry.row.hibernated;
  try {
    if (isHibernated) {
      // wake clears the hibernated flag AND brings the workspace back online
      // (the operation reopens it internally), so a single call suffices.
      await api.workspaces.wake(entry.row.path);
    } else {
      await api.workspaces.hibernate(entry.row.path);
    }
  } catch (error) {
    logWorkspaceSwitchError(isHibernated ? "wake workspace" : "hibernate workspace", error);
  }
}

/**
 * Handle dialog opening keys.
 * Sets mode to "workspace" locally for immediate UI feedback.
 * - "enter" opens the New workspace view.
 * - "delete" opens the remove dialog for the active workspace.
 */
function handleDialog(key: "enter" | "delete"): void {
  if (key === "enter") {
    if (creationPanelShown()) {
      // Already on the creation panel: nothing to open. Keyboard submit
      // is Cmd/Ctrl+Enter, owned by the form itself.
      return;
    }
    // Deactivate shortcut mode locally for immediate UI feedback. Deselecting
    // (switch to null) makes the creation panel the main view; it forces
    // hover-level z-order (UI on top) via ui-mode.
    setModeFromMain("workspace");
    void api.ui.switchWorkspace(null);
    // Push hover mode to main eagerly (don't wait for the syncMode microtask).
    // Otherwise: when the user releases Alt, main's keyUp still sees
    // currentMode === "shortcut" and dispatches setMode("workspace"), which
    // sends the UI to the bottom AND focuses the workspace view — throttling
    // the renderer so the follow-up setMode("hover") can be delayed until the
    // workspace finishes loading, leaving the panel hidden behind a loading
    // workspace view for seconds.
    void api.ui.setMode("hover");
  } else {
    // Delete — the creation panel shows when no workspace is active, so
    // there's nothing to remove from there.
    const entry = activeEntry();
    if (!entry) return;
    // Skip if the workspace is still creating or already being deleted
    // (delete-failed stays allowed so the user can retry).
    if (entry.row.status === "creating" || entry.row.status === "deleting") return;
    setModeFromMain("workspace");
    openRemoveDialog(refOf(entry));
  }
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  resetUiMode();
  _switchingWorkspace = false;
}
