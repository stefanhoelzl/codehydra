/**
 * Shortcut mode state store using Svelte 5 runes.
 * Manages keyboard shortcut overlay visibility and handlers.
 *
 * UI mode state is centralized in ui-mode.svelte.ts.
 * This module provides the handleModeChange function to update the central store.
 */

import * as api from "$lib/api";
import { createLogger } from "$lib/logging";
import { getErrorMessage } from "@shared/error-utils";
import type { UIModeChangedEvent } from "@shared/ipc";
import { openRemoveDialog } from "./dialogs.svelte";
import {
  newWorkspaceView,
  openNewWorkspaceView,
  closeNewWorkspaceView,
  requestSubmit,
} from "./new-workspace-view.svelte";
import { getLifecycle } from "./workspace-lifecycle.svelte";
import {
  getAllWorkspaces,
  getWorkspaceRefByIndex,
  getAwakeWorkspaceRefByIndex,
  findWorkspaceIndex,
  wrapIndex,
  activeWorkspacePath,
  activeWorkspace,
  projects,
  setActiveWorkspace,
} from "./projects.svelte";
import { getStatus } from "./agent-status.svelte";
import {
  jumpKeyToIndex,
  isShortcutKey,
  type NavigationKey,
  type JumpKey,
  type DialogKey,
  type ShortcutKey,
} from "@shared/shortcuts";

// Import from central ui-mode store (one-way dependency: shortcuts → ui-mode)
import { shortcutModeActive, setModeFromMain, reset as resetUiMode } from "./ui-mode.svelte.js";

// Create logger for this module
const logger = createLogger("ui");

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
export function exitShortcutMode(): void {
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
  if (!isShortcutKey(key)) {
    logger.warn("Unknown shortcut key", { key });
    return;
  }

  void executeShortcutAction(key);
}

/**
 * Execute action for a normalized ShortcutKey.
 * Maps normalized keys to action handlers.
 */
async function executeShortcutAction(key: ShortcutKey): Promise<void> {
  switch (key) {
    case "up":
      await handleNavigation("ArrowUp");
      break;
    case "down":
      await handleNavigation("ArrowDown");
      break;
    case "left":
      await handleStatusNavigation(-1);
      break;
    case "right":
      await handleStatusNavigation(1);
      break;
    case "enter":
      handleDialog("Enter");
      break;
    case "delete":
      handleDialog("Delete");
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
 * Wraps around at boundaries. No-op if <=1 workspaces or switch in progress.
 * Does not focus workspace to keep shortcut mode active.
 */
async function handleNavigation(key: NavigationKey): Promise<void> {
  const workspaces = getAllWorkspaces();
  if (workspaces.length === 0) return;
  if (_switchingWorkspace) return;

  const direction = key === "ArrowUp" ? -1 : 1;
  const currentIndex = findWorkspaceIndex(activeWorkspacePath.value);
  // When the active workspace is null (e.g. coming from the New workspace
  // view), Up → last and Down → first.
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : workspaces.length - 1
      : wrapIndex(currentIndex + direction, workspaces.length);
  // No-op when the only workspace is already current.
  if (nextIndex === currentIndex) return;
  const targetWorkspaceRef = getWorkspaceRefByIndex(nextIndex);

  if (!targetWorkspaceRef) return;

  // Leaving the New workspace view by navigating to a workspace.
  // Set active eagerly so the sidebar/empty-backdrop don't flicker during the
  // IPC round-trip to the main process.
  closeNewWorkspaceView();
  setActiveWorkspace(targetWorkspaceRef.path);

  _switchingWorkspace = true;
  try {
    // Pass false to keep UI focused (shortcut mode active)
    await api.ui.switchWorkspace(targetWorkspaceRef.path, false);
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

  const workspaces = getAllWorkspaces();
  if (workspaces.length === 0) return;

  const currentIndex = findWorkspaceIndex(activeWorkspacePath.value);

  // Try idle first, fall back to busy only when the current workspace isn't
  // already idle (or when there's no current workspace — e.g. from the New
  // workspace view — in which case we always allow the busy fallback).
  let targetIndex = findNextByStatusType(workspaces, currentIndex, direction, "idle");
  if (targetIndex === -1) {
    const currentPath = currentIndex === -1 ? undefined : workspaces[currentIndex]?.path;
    const currentStatus = currentPath ? getStatus(currentPath) : undefined;
    if (currentStatus?.type !== "idle") {
      targetIndex = findNextByStatusType(workspaces, currentIndex, direction, "busy");
    }
  }
  if (targetIndex === -1) return;

  const targetWorkspaceRef = getWorkspaceRefByIndex(targetIndex);
  if (!targetWorkspaceRef) return;

  // Leaving the New workspace view by navigating to a workspace.
  closeNewWorkspaceView();
  setActiveWorkspace(targetWorkspaceRef.path);

  _switchingWorkspace = true;
  try {
    await api.ui.switchWorkspace(targetWorkspaceRef.path, false);
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
  workspaces: { path: string; metadata?: Readonly<Record<string, string>> }[],
  currentIndex: number,
  direction: -1 | 1,
  statusType: string
): number {
  const count = workspaces.length;
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
    const workspace = workspaces[index];
    if (!workspace) continue;
    if (workspace.metadata?.["hibernated"] === "true") continue;
    const status = getStatus(workspace.path);
    if (status.type === statusType) {
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
  const workspaceRef = getAwakeWorkspaceRefByIndex(index);
  if (!workspaceRef) return;
  if (_switchingWorkspace) return;

  // Leaving the New workspace view by jumping to a workspace.
  closeNewWorkspaceView();
  setActiveWorkspace(workspaceRef.path);

  _switchingWorkspace = true;
  try {
    // Pass false to keep UI focused (shortcut mode active)
    await api.ui.switchWorkspace(workspaceRef.path, false);
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
  // Opening the New workspace view clears the active workspace, so this is
  // naturally inert while the panel is showing.
  const ref = activeWorkspace.value;
  if (!ref) return;

  const project = projects.value.find((p) => p.id === ref.projectId);
  const workspace = project?.workspaces.find((w) => w.path === ref.path);
  if (!workspace) return;

  const isHibernated = workspace.metadata?.["hibernated"] === "true";
  try {
    if (isHibernated) {
      // wake clears the hibernated flag AND brings the workspace back online
      // (the operation reopens it internally), so a single call suffices.
      await api.workspaces.wake(ref.path);
    } else {
      await api.workspaces.hibernate(ref.path);
    }
  } catch (error) {
    logWorkspaceSwitchError(isHibernated ? "wake workspace" : "hibernate workspace", error);
  }
}

/**
 * Handle dialog opening keys (Enter, Delete, Backspace).
 * Sets mode to "workspace" locally for immediate UI feedback.
 * - Enter opens the New workspace view, or creates the workspace if it's already open.
 * - Delete/Backspace opens the remove dialog for the active workspace.
 */
function handleDialog(key: DialogKey): void {
  if (key === "Enter") {
    if (newWorkspaceView.isOpen) {
      // Already on the New workspace view: Alt+X+Enter creates the workspace.
      requestSubmit();
      return;
    }
    // Deactivate shortcut mode locally for immediate UI feedback. The New
    // workspace view forces hover-level z-order (UI on top) via ui-mode.
    setModeFromMain("workspace");
    openNewWorkspaceView();
    // Push hover mode to main eagerly (don't wait for the syncMode microtask).
    // Otherwise: when the user releases Alt, main's keyUp still sees
    // currentMode === "shortcut" and dispatches setMode("workspace"), which
    // sends the UI to the bottom AND focuses the workspace view — throttling
    // the renderer so the follow-up setMode("hover") can be delayed until the
    // workspace finishes loading, leaving the panel hidden behind a loading
    // workspace view for seconds.
    void api.ui.setMode("hover");
  } else {
    // Delete or Backspace — opening the New workspace view clears the active
    // workspace, so there's nothing to remove from there.
    const workspaceRef = activeWorkspace.value;
    if (!workspaceRef) return;
    // Skip if the workspace is still creating or already being deleted
    // (delete-failed stays allowed so the user can retry).
    const lifecycle = getLifecycle(workspaceRef.path);
    if (lifecycle === "creating" || lifecycle === "deleting") return;
    setModeFromMain("workspace");
    openRemoveDialog(workspaceRef);
  }
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  resetUiMode();
  _switchingWorkspace = false;
}
