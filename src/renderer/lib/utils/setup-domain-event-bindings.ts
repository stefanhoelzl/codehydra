/**
 * Setup function for the agent notification chime.
 *
 * All read-model state arrives via ui:state snapshots, so the chime is driven
 * off the snapshot too: on each push, every workspace's idle/busy counts are
 * fed to the chime service (which only chimes on an idle-count increase), and
 * tracking is dropped for workspaces that have disappeared. The chime is
 * renderer-local behavior (audio), not view state.
 *
 * @param notificationService - Service for agent completion chimes
 * @param onState - ui:state subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe
 */
import type { Unsubscribe } from "@shared/electron-api";
import type { UiState } from "@shared/ui-state";
import type { AgentNotificationService } from "$lib/services/agent-notifications";
import * as api from "$lib/api";

/** Subscribe to ui:state snapshots. */
export type OnState = (callback: (state: UiState) => void) => Unsubscribe;

export function setupDomainEventBindings(
  notificationService: AgentNotificationService,
  onState: OnState = api.onState
): () => void {
  // Per-workspace tracking key is the snapshot's opaque workspace key (stable
  // across the creating → ready swap), used purely as the chime's identity.
  let prevKeys = new Set<string>();

  return onState((state) => {
    const currentKeys = new Set<string>();
    for (const project of state.sidebar.projects) {
      for (const workspace of project.workspaces) {
        currentKeys.add(workspace.key);
        // Treat "none" (agent gone) as zero idle so a later gray → green
        // transition registers as an idle increase and chimes.
        const counts = "counts" in workspace.agent ? workspace.agent.counts : { idle: 0, busy: 0 };
        notificationService.handleStatusChange(workspace.key, counts);
      }
    }
    for (const key of prevKeys) {
      if (!currentKeys.has(key)) {
        notificationService.removeWorkspace(key);
      }
    }
    prevKeys = currentKeys;
  });
}
