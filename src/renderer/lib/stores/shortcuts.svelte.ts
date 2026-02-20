/**
 * Shortcut mode state store using Svelte 5 runes.
 * Manages keyboard shortcut overlay visibility and handlers.
 *
 * Note: UI mode state is now centralized in ui-mode.svelte.ts.
 * This module re-exports uiMode and shortcutModeActive for backward compatibility,
 * and provides the handleModeChange function to update the central store.
 */

import * as api from "$lib/api";
import { createLogger } from "$lib/logging";
import { getErrorMessage } from "@shared/error-utils";
import type { UIModeChangedEvent } from "@shared/ipc";
import { openCreateDialog, openRemoveDialog } from "./dialogs.svelte";
import { getDeletionStatus } from "./deletion.svelte";
import {
  getAllWorkspaces,
  getWorkspaceRefByIndex,
  findWorkspaceIndex,
  wrapIndex,
  activeWorkspacePath,
  activeProject,
  activeWorkspace,
  projects,
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
      await handleIdleNavigation(-1);
      break;
    case "right":
      await handleIdleNavigation(1);
      break;
    case "enter":
      handleDialog("Enter");
      break;
    case "delete":
      handleDialog("Delete");
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
  if (workspaces.length <= 1) return;
  if (_switchingWorkspace) return;

  const direction = key === "ArrowUp" ? -1 : 1;
  const currentIndex = findWorkspaceIndex(activeWorkspacePath.value);
  const nextIndex = wrapIndex(currentIndex + direction, workspaces.length);
  const targetWorkspaceRef = getWorkspaceRefByIndex(nextIndex);

  if (!targetWorkspaceRef) return;

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
 * Handle left/right arrow navigation to next idle workspace.
 * Direction: -1 for previous (left), 1 for next (right).
 * Wraps around if needed. No-op if no other idle workspace exists.
 */
async function handleIdleNavigation(direction: -1 | 1): Promise<void> {
  if (_switchingWorkspace) return;

  const workspaces = getAllWorkspaces();
  if (workspaces.length <= 1) return;

  const currentIndex = findWorkspaceIndex(activeWorkspacePath.value);
  if (currentIndex === -1) return;

  // Find next idle workspace in the given direction
  const targetIndex = findNextIdleIndex(workspaces, currentIndex, direction);
  if (targetIndex === -1) return;

  const targetWorkspaceRef = getWorkspaceRefByIndex(targetIndex);
  if (!targetWorkspaceRef) return;

  _switchingWorkspace = true;
  try {
    await api.ui.switchWorkspace(targetWorkspaceRef.path, false);
  } catch (error) {
    logWorkspaceSwitchError("navigate to idle workspace", error);
  } finally {
    _switchingWorkspace = false;
  }
}

/**
 * Find next idle workspace index in the given direction.
 * Returns -1 if no other idle workspace exists.
 */
function findNextIdleIndex(
  workspaces: { path: string }[],
  currentIndex: number,
  direction: -1 | 1
): number {
  const count = workspaces.length;
  for (let i = 1; i < count; i++) {
    const index = wrapIndex(currentIndex + i * direction, count);
    const workspace = workspaces[index];
    if (!workspace) continue;
    const status = getStatus(workspace.path);
    if (status.type === "idle") {
      return index;
    }
  }
  return -1;
}

/**
 * Handle number key jump to specific workspace.
 * No-op if index out of range or switch in progress.
 * Does not focus workspace to keep shortcut mode active.
 */
async function handleJump(key: JumpKey): Promise<void> {
  const index = jumpKeyToIndex(key);
  const workspaceRef = getWorkspaceRefByIndex(index);
  if (!workspaceRef) return;
  if (_switchingWorkspace) return;

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
 * Handle dialog opening keys (Enter, Delete, Backspace).
 * Sets mode to "workspace" locally for immediate UI feedback before opening dialog.
 * The ui-mode store will compute desiredMode="dialog" when dialog opens.
 */
function handleDialog(key: DialogKey): void {
  if (key === "Enter") {
    // Deactivate shortcut mode locally for immediate UI feedback
    // The ui-mode store will compute desiredMode="dialog" when dialog opens
    setModeFromMain("workspace");
    // Use active project, or fallback to first project if none active
    const project = activeProject.value ?? projects.value[0];
    openCreateDialog(project?.id);
  } else {
    // Delete or Backspace
    const workspaceRef = activeWorkspace.value;
    if (!workspaceRef) return;
    // Skip if deletion already in progress for this workspace
    if (getDeletionStatus(workspaceRef.path) === "in-progress") return;
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
