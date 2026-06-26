/**
 * Notification store: a read-only view over the open sidebar notifications in
 * the ui:state snapshot. The backend (UiPresenter) owns notification lifecycle;
 * the renderer renders this derived view and echoes user interactions back as
 * ui:events.
 */

import { SvelteMap } from "svelte/reactivity";
import type { NotificationConfig } from "@shared/notification-types";
import { uiState } from "./ui-state.svelte.js";

// ============ Types ============

export interface NotificationEntry {
  readonly notificationId: string;
  readonly config: NotificationConfig;
}

function snapshotEntries(): NotificationEntry[] {
  return (uiState.value?.notifications ?? []).map((n) => ({
    notificationId: n.id,
    config: n.config,
  }));
}

// ============ Reactive Getters ============

/**
 * Reactive access to all open notifications, keyed by id (in open order).
 */
export const notifications = {
  get value(): ReadonlyMap<string, NotificationEntry> {
    return new SvelteMap(snapshotEntries().map((entry) => [entry.notificationId, entry]));
  },
};

/**
 * Reactive getter for whether any spinner-type notifications are active.
 * Used to suppress auto-show-create-dialog while background work runs.
 */
export const hasSpinnerNotifications = {
  get value(): boolean {
    return snapshotEntries().some((entry) => entry.config.type === "spinner");
  },
};
