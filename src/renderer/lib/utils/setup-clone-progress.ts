/**
 * Setup function for clone progress events.
 * Subscribes to clone progress events and updates the clone-progress store.
 *
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe
 */
import type { CloneProgress } from "@shared/api/types";
import { updateCloneProgress } from "$lib/stores/clone-progress.svelte.js";
import { on as apiOn } from "$lib/api";

/**
 * API interface for clone progress events.
 * Constrained to the specific event type for type safety.
 */
export interface CloneProgressApi {
  on(event: "project:clone-progress", handler: (payload: CloneProgress) => void): () => void;
}

// Default API implementation
const defaultApi: CloneProgressApi = { on: apiOn };

/**
 * Setup clone progress event subscription.
 * Updates clone-progress store on each progress event.
 *
 * @param apiImpl - API implementation (defaults to window.api)
 * @returns Cleanup function to unsubscribe
 */
export function setupCloneProgress(apiImpl: CloneProgressApi = defaultApi): () => void {
  return apiImpl.on("project:clone-progress", (payload) => {
    updateCloneProgress(payload.stage, payload.progress, payload.name);
  });
}
