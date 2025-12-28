/**
 * ID utilities for the renderer.
 *
 * NOTE: Project IDs come from the v2 API and should NOT be generated client-side.
 * The main process uses SHA-256 for deterministic ID generation; the renderer
 * should always use IDs from API responses.
 */

import type { WorkspaceRef } from "@shared/api/types";

/**
 * Creates a composite string key from a workspace reference.
 * Useful for Map keys or Set lookups.
 * @param ref - The workspace reference
 * @returns A string in the format "projectId/workspaceName"
 */
export function workspaceRefKey(ref: WorkspaceRef): string {
  return `${ref.projectId}/${ref.workspaceName}`;
}
