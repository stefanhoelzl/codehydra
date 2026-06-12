/**
 * Setup function for the surviving domain event subscriptions.
 *
 * Since the read cutover, all read-model state arrives via ui:state
 * snapshots (see lib/stores/ui-state.svelte.ts) — the only domain events the
 * renderer still consumes drive the agent notification chime, which is
 * renderer-local behavior (audio), not view state.
 *
 * @param notificationService - Service for agent completion chimes
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe from all events
 */
import type { Unsubscribe } from "@shared/electron-api";
import type { ApiEvents } from "@shared/api/interfaces";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";

/**
 * API interface for event subscriptions.
 * Supports all events from the ApiEvents interface.
 */
export interface DomainEventApi {
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;
}

// Default API implementation - cast to DomainEventApi for type-safe event subscriptions.
const defaultApi: DomainEventApi = api as DomainEventApi;

/**
 * Setup domain event subscriptions for the notification chime:
 * - workspace:status-changed → chime when idle count increases
 * - workspace:removed → drop the chime service's per-workspace tracking
 */
export function setupDomainEventBindings(
  notificationService: AgentNotificationService,
  apiImpl: DomainEventApi = defaultApi
): () => void {
  const unsubscribes: (() => void)[] = [];

  unsubscribes.push(
    apiImpl.on("workspace:status-changed", (event) => {
      // Play chime when idle count increases (agent finished work).
      // Treat "none" (agent gone — e.g. agent terminal closed) as zero idle so a
      // later gray → green transition (reopening the terminal) registers as an
      // idle increase and chimes. The "none" variant carries no counts.
      const counts =
        "counts" in event.status.agent ? event.status.agent.counts : { idle: 0, busy: 0 };
      notificationService.handleStatusChange(event.path, counts);
    })
  );

  unsubscribes.push(
    apiImpl.on("workspace:removed", (event) => {
      notificationService.removeWorkspace(event.path);
    })
  );

  return () => {
    unsubscribes.forEach((unsub) => unsub());
  };
}
