/**
 * Shortcut mode state store using Svelte 5 runes.
 * Manages keyboard shortcut overlay visibility and handlers.
 */

import * as api from "$lib/api";
import type { UIModeChangedEvent } from "@shared/ipc";
import { openCreateDialog, openRemoveDialog } from "./dialogs.svelte";
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
import {
  jumpKeyToIndex,
  isShortcutKey,
  type NavigationKey,
  type JumpKey,
  type DialogKey,
  type ShortcutKey,
} from "@shared/shortcuts";

// ============ State ============

let _shortcutModeActive = $state(false);

// ============ Getters ============

export const shortcutModeActive = {
  get value() {
    return _shortcutModeActive;
  },
};

// ============ Actions ============

/**
 * Handles ui:mode-changed event from main process.
 * Updates shortcut mode state based on the new mode.
 * @param event - The mode change event with mode and previousMode
 */
export function handleModeChange(event: UIModeChangedEvent): void {
  _shortcutModeActive = event.mode === "shortcut";
}

/**
 * Handles window blur events. Exits shortcut mode when window loses focus.
 * Does not exit if we're actively switching workspaces (Electron triggers blur
 * events when updating view bounds during workspace switches).
 */
export function handleWindowBlur(): void {
  // Don't exit shortcut mode if we're actively switching workspaces
  // (Electron triggers blur events when updating view bounds)
  if (_shortcutModeActive && !_switchingWorkspace) {
    exitShortcutMode();
  }
}

/**
 * Exits shortcut mode and restores normal state.
 * Calls setMode("workspace") to restore z-order and focus.
 */
export function exitShortcutMode(): void {
  _shortcutModeActive = false;
  // Fire-and-forget pattern - see AGENTS.md IPC Patterns
  void api.ui.setMode("workspace");
}

// ============ Action Handlers ============

// Guard to prevent concurrent workspace switches during rapid key presses
let _switchingWorkspace = false;

/**
 * Logs workspace switch errors with consistent formatting.
 */
function logWorkspaceSwitchError(action: string, error: unknown): void {
  console.error(`Failed to ${action}:`, error);
}

/**
 * Handle keydown events during shortcut mode.
 * Only handles Escape key - other action keys come via events from main process.
 * (See Design Decisions: Escape is handled by renderer because it's a UI-level action.)
 *
 * @param event - The keyboard event
 */
export function handleKeyDown(event: KeyboardEvent): void {
  if (!_shortcutModeActive) return;

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
    console.warn("Unknown shortcut key:", key);
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
    case "enter":
      handleDialog("Enter");
      break;
    case "delete":
      handleDialog("Delete");
      break;
    case "o":
      handleProjectOpen();
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
    await api.ui.switchWorkspace(
      targetWorkspaceRef.projectId,
      targetWorkspaceRef.workspaceName,
      false
    );
  } catch (error) {
    logWorkspaceSwitchError("switch workspace", error);
  } finally {
    _switchingWorkspace = false;
  }
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
    await api.ui.switchWorkspace(workspaceRef.projectId, workspaceRef.workspaceName, false);
  } catch (error) {
    logWorkspaceSwitchError("jump to workspace", error);
  } finally {
    _switchingWorkspace = false;
  }
}

/**
 * Handle dialog opening keys (Enter, Delete, Backspace).
 * Deactivates shortcut mode before opening dialog.
 */
function handleDialog(key: DialogKey): void {
  if (key === "Enter") {
    // Use active project, or fallback to first project if none active
    const project = activeProject.value ?? projects.value[0];
    if (!project) return;
    // Deactivate mode without calling full exitShortcutMode to avoid z-order thrashing
    _shortcutModeActive = false;
    openCreateDialog(project.id);
  } else {
    // Delete or Backspace
    const workspaceRef = activeWorkspace.value;
    if (!workspaceRef) return;
    _shortcutModeActive = false;
    openRemoveDialog(workspaceRef);
  }
}

/**
 * Handle O key to open project folder picker.
 */
function handleProjectOpen(): void {
  exitShortcutMode();
  void api.ui.selectFolder().then((path: string | null) => {
    if (path) void api.projects.open(path);
  });
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _shortcutModeActive = false;
  _switchingWorkspace = false;
}
