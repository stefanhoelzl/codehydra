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
} from "./projects.svelte";
import {
  isActionKey,
  isNavigationKey,
  isJumpKey,
  isDialogKey,
  isProjectKey,
  jumpKeyToIndex,
  type ActionKey,
  type NavigationKey,
  type JumpKey,
  type DialogKey,
} from "@shared/shortcuts";

// ============ Constants ============

const ALT_KEY = "Alt";

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
  console.debug("Shortcuts mode:", event.previousMode, "→", event.mode);
  _shortcutModeActive = event.mode === "shortcut";
}

/**
 * Handles keyup events. Exits shortcut mode when Alt is released.
 * @param event - The keyboard event
 */
export function handleKeyUp(event: KeyboardEvent): void {
  if (event.repeat) return;
  if (event.key === ALT_KEY && _shortcutModeActive) {
    exitShortcutMode();
  }
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
 * Dispatches to appropriate action handler based on key type.
 */
export function handleKeyDown(event: KeyboardEvent): void {
  if (!_shortcutModeActive) return;

  if (isActionKey(event.key)) {
    event.preventDefault();
    void executeAction(event.key);
  }
}

async function executeAction(key: ActionKey): Promise<void> {
  if (isNavigationKey(key)) {
    await handleNavigation(key);
  } else if (isJumpKey(key)) {
    await handleJump(key);
  } else if (isDialogKey(key)) {
    handleDialog(key);
  } else if (isProjectKey(key)) {
    handleProjectOpen();
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
    const project = activeProject.value;
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
