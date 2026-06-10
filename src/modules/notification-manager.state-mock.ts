/**
 * State mock for NotificationManager. Mirrors the production API and tracks
 * all opened/updated/closed notifications plus their event listeners so tests
 * can drive the user-event side via emitEvent().
 */
import type { NotificationConfig, NotificationUserEvent } from "../shared/notification-types";
import type { NotificationHandle, NotificationManager } from "./notification-manager";

/** Per-notification state exposed for assertions. */
export interface MockNotification {
  readonly id: string;
  /** The config passed to open(). */
  readonly opened: NotificationConfig;
  /** All configs passed to handle.update(), in order. */
  updates: NotificationConfig[];
  /** Latest config — initial open + any updates applied. */
  latestConfig: NotificationConfig;
  /** True once handle.close() was called. */
  closed: boolean;
  /** Internal: listeners registered via handle.onEvent(). */
  listeners: Set<(event: NotificationUserEvent) => void>;
}

export interface MockNotificationManager {
  /** The real NotificationManager-shaped object to inject into the SUT. */
  readonly manager: NotificationManager;
  /** All notifications opened so far, in order. Mutates live. */
  readonly notifications: MockNotification[];
  /** Convenience accessor for the most recently opened notification, or null. */
  readonly lastNotification: MockNotification | null;
  /**
   * Deliver a user event to a notification's listeners.
   * @param indexOrId notification index (0-based) or its id
   */
  emitEvent(indexOrId: number | string, event: Omit<NotificationUserEvent, "notificationId">): void;
}

export function createMockNotificationManager(): MockNotificationManager {
  const items: MockNotification[] = [];

  const manager: NotificationManager = {
    open(config: NotificationConfig): NotificationHandle {
      const id = `ntf-${items.length + 1}`;
      const slot: MockNotification = {
        id,
        opened: config,
        updates: [],
        latestConfig: config,
        closed: false,
        listeners: new Set(),
      };
      items.push(slot);
      return {
        id,
        update(next: NotificationConfig) {
          if (slot.closed) return;
          slot.updates.push(next);
          slot.latestConfig = next;
        },
        close() {
          slot.closed = true;
        },
        onEvent(handler) {
          slot.listeners.add(handler);
          return () => {
            slot.listeners.delete(handler);
          };
        },
        nextEvent() {
          return new Promise<NotificationUserEvent>(() => {});
        },
        closed: new Promise<void>(() => {}),
      } satisfies NotificationHandle;
    },
    routeEvent() {},
    // The mock has no buffering — notifications are tracked immediately.
    markUIReady() {},
  } as unknown as NotificationManager;

  return {
    manager,
    notifications: items,
    get lastNotification() {
      return items[items.length - 1] ?? null;
    },
    emitEvent(indexOrId, event) {
      const slot =
        typeof indexOrId === "number" ? items[indexOrId] : items.find((n) => n.id === indexOrId);
      if (!slot) {
        throw new Error(`No notification matching ${String(indexOrId)}`);
      }
      const full: NotificationUserEvent = { notificationId: slot.id, ...event };
      for (const handler of slot.listeners) handler(full);
    },
  };
}
