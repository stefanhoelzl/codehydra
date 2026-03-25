/**
 * Notification store using Svelte 5 runes.
 * Manages active notifications driven by the backend via IPC commands.
 * This is a pure state container - IPC subscriptions are handled by NotificationHost.
 */

import { SvelteMap } from "svelte/reactivity";
import type { NotificationConfig, NotificationCommand } from "@shared/notification-types";

// ============ Types ============

export interface NotificationEntry {
  readonly notificationId: string;
  readonly config: NotificationConfig;
}

// ============ State ============

const _notifications = new SvelteMap<string, NotificationEntry>();

// ============ Actions ============

/**
 * Process a notification command from the main process.
 * - open: add notification to the map
 * - update: replace config for existing notification
 * - close: remove notification from the map
 */
export function processCommand(command: NotificationCommand): void {
  switch (command.action) {
    case "open":
      _notifications.set(command.notificationId, {
        notificationId: command.notificationId,
        config: command.config,
      });
      break;
    case "update":
      if (_notifications.has(command.notificationId)) {
        _notifications.set(command.notificationId, {
          notificationId: command.notificationId,
          config: command.config,
        });
      }
      break;
    case "close":
      _notifications.delete(command.notificationId);
      break;
  }
}

// ============ Reactive Getters ============

/**
 * Reactive access to all active notifications.
 */
export const notifications = {
  get value(): ReadonlyMap<string, NotificationEntry> {
    return _notifications;
  },
};

/**
 * Reactive getter for whether any notifications are active.
 */
export const hasNotifications = {
  get value(): boolean {
    return _notifications.size > 0;
  },
};

/**
 * Reactive getter for whether any spinner-type notifications are active.
 * Replaces hasActiveClones — used to suppress auto-show-create-dialog while background work runs.
 */
export const hasSpinnerNotifications = {
  get value(): boolean {
    for (const entry of _notifications.values()) {
      if (entry.config.type === "spinner") return true;
    }
    return false;
  },
};

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _notifications.clear();
}
