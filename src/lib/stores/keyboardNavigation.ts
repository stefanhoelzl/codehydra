import { writable, derived, get } from 'svelte/store';
import { projects, activeWorkspace, setActiveWorkspace, type ActiveWorkspaceId } from './projects';
import type { Workspace } from '$lib/types/project';

/**
 * Whether the Chime shortcut mode is active (Alt held after Alt+X).
 * When true, the overlay is shown and workspace numbers are visible.
 */
export const chimeShortcutActive = writable<boolean>(false);

/**
 * Whether a modal dialog is open.
 * When true, global shortcuts are disabled to avoid conflicts.
 */
export const modalOpen = writable<boolean>(false);

/**
 * Request to open the create workspace dialog for a specific project.
 * Set to project handle when triggered via keyboard shortcut.
 */
export const createDialogRequest = writable<string | null>(null);

/**
 * Request to open the remove workspace dialog for a specific workspace.
 * Set to active workspace ID when triggered via keyboard shortcut.
 */
export const removeDialogRequest = writable<ActiveWorkspaceId | null>(null);

/**
 * Entry in the flat workspace list with project context.
 */
export interface FlatWorkspaceEntry {
  projectHandle: string;
  workspace: Workspace;
}

/**
 * Derived store that flattens all workspaces across all projects into a single list.
 * Used for keyboard navigation (up/down, jump to index).
 */
export const flatWorkspaceList = derived(projects, ($projects): FlatWorkspaceEntry[] => {
  const flat: FlatWorkspaceEntry[] = [];
  for (const project of $projects) {
    for (const workspace of project.workspaces) {
      flat.push({
        projectHandle: project.handle,
        workspace,
      });
    }
  }
  return flat;
});

// Navigation throttle state
let lastNavigationTime = 0;
const NAVIGATION_THROTTLE_MS = 75;

/**
 * Check if navigation is throttled.
 */
function isThrottled(): boolean {
  const now = Date.now();
  if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
    return true;
  }
  lastNavigationTime = now;
  return false;
}

/**
 * Find the current index in the flat list, or -1 if not found.
 */
function findCurrentIndex(): number {
  const active = get(activeWorkspace);
  if (!active) return -1;

  const flat = get(flatWorkspaceList);
  return flat.findIndex(
    (entry) =>
      entry.projectHandle === active.projectHandle && entry.workspace.path === active.workspacePath
  );
}

/**
 * Navigate to the previous workspace in the flat list.
 * Wraps around to the last workspace when at the first.
 */
export function navigateUp(): void {
  if (isThrottled()) return;

  const flat = get(flatWorkspaceList);
  if (flat.length === 0) return;

  const currentIndex = findCurrentIndex();

  if (currentIndex === -1) {
    // No active workspace, select first
    const first = flat[0];
    setActiveWorkspace(first.projectHandle, first.workspace.path);
    return;
  }

  // Wrap around: if at first, go to last; otherwise go to previous
  const prevIndex = currentIndex === 0 ? flat.length - 1 : currentIndex - 1;
  const prev = flat[prevIndex];
  setActiveWorkspace(prev.projectHandle, prev.workspace.path);
}

/**
 * Navigate to the next workspace in the flat list.
 * Wraps around to the first workspace when at the last.
 */
export function navigateDown(): void {
  if (isThrottled()) return;

  const flat = get(flatWorkspaceList);
  if (flat.length === 0) return;

  const currentIndex = findCurrentIndex();

  if (currentIndex === -1) {
    // No active workspace, select first
    const first = flat[0];
    setActiveWorkspace(first.projectHandle, first.workspace.path);
    return;
  }

  // Wrap around: if at last, go to first; otherwise go to next
  const nextIndex = currentIndex === flat.length - 1 ? 0 : currentIndex + 1;
  const next = flat[nextIndex];
  setActiveWorkspace(next.projectHandle, next.workspace.path);
}

/**
 * Jump to a workspace by 1-based index.
 * Index 1-10 corresponds to display keys 1-9, 0.
 */
export function jumpToIndex(index: number): void {
  if (index < 1 || index > 10) return;

  const flat = get(flatWorkspaceList);
  const arrayIndex = index - 1; // Convert to 0-based

  if (arrayIndex >= flat.length) return;

  const entry = flat[arrayIndex];
  setActiveWorkspace(entry.projectHandle, entry.workspace.path);
}

/**
 * Get the 1-based index of a workspace by its path.
 * Returns null if not found.
 */
export function getWorkspaceIndex(workspacePath: string): number | null {
  const flat = get(flatWorkspaceList);
  const index = flat.findIndex((entry) => entry.workspace.path === workspacePath);
  return index === -1 ? null : index + 1;
}

// Note: Action key handling has moved to +layout.svelte via Tauri events.
// The handleActionKey function is no longer needed since Tauri registers
// all Alt+{ActionKey} shortcuts and emits specific events for each action.

/**
 * Check if the active workspace is the main workspace of its project.
 * Returns false if no active workspace.
 */
export function isActiveWorkspaceMain(): boolean {
  const active = get(activeWorkspace);
  if (!active) return false;

  const allProjects = get(projects);
  const project = allProjects.find((p) => p.handle === active.projectHandle);
  if (!project) return false;

  return project.workspaces[0]?.path === active.workspacePath;
}

/**
 * Reset keyboard navigation state.
 * Used for testing and cleanup.
 */
export function resetKeyboardNavigationState(): void {
  chimeShortcutActive.set(false);
  modalOpen.set(false);
  createDialogRequest.set(null);
  removeDialogRequest.set(null);
  lastNavigationTime = 0;
}
