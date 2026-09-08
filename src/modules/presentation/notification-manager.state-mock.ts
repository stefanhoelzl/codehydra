/**
 * State mock for NotificationManager. Mirrors the production API and tracks
 * all opened/updated/closed notifications plus their event listeners so tests
 * can drive the user-event side via emitEvent().
 *
 * Collapsing is mirrored too, using the production `dedupKey`: an open that
 * matches a live card returns that card's handle and bumps its count instead of
 * pushing a new entry. A mock that stacked duplicates would show tests a
 * notification-per-occurrence the real sidebar never renders.
 */
import type { NotificationConfig, NotificationUserEvent } from "../../shared/notification-types";
import { dedupKey } from "./sessions";
import type { NotificationHandle, NotificationManager } from "./sessions";
import type { UiPresenter } from "./presentation-module";

/** Per-notification state exposed for assertions. */
export interface MockNotification {
  readonly id: string;
  /** The config passed to open(). */
  readonly opened: NotificationConfig;
  /** All configs passed to handle.update(), in order. */
  updates: NotificationConfig[];
  /** Latest config — initial open + any updates applied. */
  latestConfig: NotificationConfig;
  /** Opens that collapsed into this card. */
  count: number;
  /** True once the last hold on the card was released. */
  closed: boolean;
  /** Internal: listeners registered via handle.onEvent(). */
  listeners: Set<(event: NotificationUserEvent) => void>;
  /** Internal: current identity, kept in step with latestConfig. */
  key: string;
  /** Internal: the handle every open of this card shares. */
  handle: NotificationHandle;
}

export interface MockNotificationManager {
  /** The real NotificationManager-shaped object to inject into the SUT. */
  readonly manager: NotificationManager;
  /** UiPresenter notification surface to inject into modules (`ui.notification()`). */
  readonly ui: Pick<UiPresenter, "notification">;
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
      const key = dedupKey(config);
      const live = items.find((n) => !n.closed && n.key === key);
      if (live) {
        live.count += 1;
        return live.handle;
      }
      const id = `ntf-${items.length + 1}`;
      const handle: NotificationHandle = {
        id,
        update(next: NotificationConfig) {
          if (slot.closed) return;
          slot.updates.push(next);
          slot.latestConfig = next;
          slot.key = dedupKey(next);
        },
        close() {
          if (slot.closed) return;
          if (slot.count > 1) {
            slot.count -= 1;
            return;
          }
          slot.closed = true;
        },
        onEvent(handler) {
          slot.listeners.add(handler);
          return () => {
            slot.listeners.delete(handler);
          };
        },
      };
      const slot: MockNotification = {
        id,
        opened: config,
        updates: [],
        latestConfig: config,
        count: 1,
        closed: false,
        listeners: new Set(),
        key,
        handle,
      };
      items.push(slot);
      return handle;
    },
    routeEvent() {},
    // The mock has no buffering — notifications are tracked immediately.
    markUIReady() {},
  } as unknown as NotificationManager;

  return {
    manager,
    ui: {
      notification: (config: NotificationConfig) => manager.open(config),
    },
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
      // A dismiss retires the whole card, however many opens it stands for.
      if (event.actionId === "dismiss") slot.count = 1;
      const full: NotificationUserEvent = { notificationId: slot.id, ...event };
      for (const handler of slot.listeners) handler(full);
    },
  };
}
