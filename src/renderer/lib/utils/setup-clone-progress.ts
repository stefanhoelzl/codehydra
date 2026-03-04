/**
 * Setup function for clone progress events.
 * Subscribes to clone progress and clone-failed events, updating the clone-progress store.
 *
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe
 */
import type { CloneProgress } from "@shared/api/types";
import { updateCloneProgress, completeClone } from "$lib/stores/clone-progress.svelte.js";
import { on as apiOn } from "$lib/api";

/**
 * API interface for clone progress events.
 * Constrained to the specific event types for type safety.
 */
export interface CloneProgressApi {
  on(event: "project:clone-progress", handler: (payload: CloneProgress) => void): () => void;
  on(
    event: "project:clone-failed",
    handler: (payload: { reason: string; url?: string }) => void
  ): () => void;
}

// Default API implementation
const defaultApi: CloneProgressApi = { on: apiOn };

/**
 * Setup clone progress event subscription.
 * Updates clone-progress store on each progress event.
 * Clears clone state on failure.
 *
 * @param apiImpl - API implementation (defaults to window.api)
 * @returns Cleanup function to unsubscribe
 */
export function setupCloneProgress(apiImpl: CloneProgressApi = defaultApi): () => void {
  const cleanupProgress = apiImpl.on("project:clone-progress", (payload) => {
    updateCloneProgress(payload.url, payload.stage, payload.progress, payload.name);
  });

  const cleanupFailed = apiImpl.on("project:clone-failed", (payload) => {
    if (payload.url) {
      completeClone(payload.url);
    }
  });

  return () => {
    cleanupProgress();
    cleanupFailed();
  };
}
