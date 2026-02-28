import type { Project } from "$lib/api";

/**
 * Calculate the global index of a workspace across all projects.
 * Returns the sum of all workspaces in previous projects plus the workspace index.
 */
export function getWorkspaceGlobalIndex(
  projects: readonly Project[],
  projectIndex: number,
  workspaceIndex: number
): number {
  let globalIndex = 0;
  for (let p = 0; p < projectIndex; p++) {
    globalIndex += projects[p]?.workspaces.length ?? 0;
  }
  return globalIndex + workspaceIndex;
}

/**
 * Format a global index as a shortcut key display.
 * Returns "1"-"9" for indices 0-8, "0" for index 9, null for 10+.
 */
export function formatIndexDisplay(globalIndex: number): string | null {
  if (globalIndex > 9) return null; // No shortcut for 11+
  return globalIndex === 9 ? "0" : String(globalIndex + 1);
}

/**
 * Get the shortcut hint for a workspace at a given global index.
 */
export function getShortcutHint(globalIndex: number): string {
  if (globalIndex > 9) return ""; // No shortcut
  const key = globalIndex === 9 ? "0" : String(globalIndex + 1);
  return ` - Press ${key} to jump`;
}

/**
 * Generate status text from agent counts for aria-label.
 */
export function getStatusText(idleCount: number, busyCount: number): string {
  if (idleCount === 0 && busyCount === 0) {
    return "No agents running";
  }
  if (idleCount > 0 && busyCount === 0) {
    const noun = idleCount === 1 ? "agent" : "agents";
    return `${idleCount} ${noun} idle`;
  }
  if (idleCount === 0 && busyCount > 0) {
    const noun = busyCount === 1 ? "agent" : "agents";
    return `${busyCount} ${noun} busy`;
  }
  // mixed
  return `${idleCount} idle, ${busyCount} busy`;
}
