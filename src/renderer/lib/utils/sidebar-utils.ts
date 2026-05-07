import type { Project } from "$lib/api";

/**
 * Calculate the global index of a workspace across all projects, counting
 * only awake workspaces. Hibernated workspaces are skipped in the sequence
 * and the function returns null when the target workspace itself is hibernated.
 */
export function getWorkspaceGlobalIndex(
  projects: readonly Project[],
  projectIndex: number,
  workspaceIndex: number
): number | null {
  const target = projects[projectIndex]?.workspaces[workspaceIndex];
  if (target?.metadata?.["hibernated"] === "true") return null;

  let globalIndex = 0;
  for (let p = 0; p < projectIndex; p++) {
    for (const w of projects[p]?.workspaces ?? []) {
      if (w.metadata?.["hibernated"] !== "true") globalIndex++;
    }
  }
  const currentProjectWorkspaces = projects[projectIndex]?.workspaces ?? [];
  for (let i = 0; i < workspaceIndex; i++) {
    if (currentProjectWorkspaces[i]?.metadata?.["hibernated"] !== "true") globalIndex++;
  }
  return globalIndex;
}

/**
 * Format a global index as a shortcut key display.
 * Returns "1"-"9" for indices 0-8, "0" for index 9, null for 10+ or hibernated (null input).
 */
export function formatIndexDisplay(globalIndex: number | null): string | null {
  if (globalIndex === null) return null;
  if (globalIndex > 9) return null;
  return globalIndex === 9 ? "0" : String(globalIndex + 1);
}

/**
 * Get the shortcut hint for a workspace at a given global index.
 */
export function getShortcutHint(globalIndex: number | null): string {
  if (globalIndex === null) return "";
  if (globalIndex > 9) return "";
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
