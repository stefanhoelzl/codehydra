/**
 * Setup function for workspace deletion progress events.
 * Subscribes to deletion events and updates the deletion store.
 *
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe
 */
import type { DeletionProgress } from "@shared/api/types";
import { setDeletionState, clearDeletion } from "$lib/stores/deletion.svelte.js";
import { on as apiOn } from "$lib/api";

/**
 * API interface for deletion progress events.
 * Constrained to the specific event type for type safety.
 */
export interface DeletionProgressApi {
  on(
    event: "workspace:deletion-progress",
    handler: (payload: DeletionProgress) => void
  ): () => void;
}

// Default API implementation
const defaultApi: DeletionProgressApi = { on: apiOn };

/**
 * Setup deletion progress event subscription.
 * Updates deletion store and auto-clears on successful completion.
 *
 * @param apiImpl - API implementation (defaults to window.api)
 * @returns Cleanup function to unsubscribe
 */
export function setupDeletionProgress(apiImpl: DeletionProgressApi = defaultApi): () => void {
  return apiImpl.on("workspace:deletion-progress", (progress) => {
    setDeletionState(progress);
    // Auto-clear on successful completion
    if (progress.completed && !progress.hasErrors) {
      clearDeletion(progress.workspacePath);
    }
  });
}
