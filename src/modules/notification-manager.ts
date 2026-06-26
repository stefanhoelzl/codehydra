/**
 * NotificationManager - in-process registry of open sidebar notifications.
 *
 * Owned privately by the UiPresenter. It holds session state and hands out
 * NotificationHandles; it does NOT touch IPC. On every mutation
 * (open/update/close) it calls `notifyChange` (the presenter's coalescing
 * snapshot scheduler), and the presenter folds `getSnapshot()` into the
 * ui:state snapshot. The presenter's `connected` gate handles pre-UI buffering
 * (the snapshot is only pushed once the renderer has connected), so this
 * manager needs no buffering of its own.
 *
 * Mirrors DialogManager but for lightweight, non-modal sidebar indicators.
 */

import type { NotificationConfig, NotificationUserEvent } from "../shared/notification-types";
import type { UiNotification } from "../shared/ui-state";
import type { Logger } from "../boundaries/platform/logging";

/**
 * Handle to an open notification. Allows updating, closing, and receiving user events.
 */
export interface NotificationHandle {
  readonly id: string;
  /** Replace notification config (full state replacement). */
  update(config: NotificationConfig): void;
  /** Close notification from backend. */
  close(): void;
  /** Subscribe to user events. Returns unsubscribe function. */
  onEvent(handler: (event: NotificationUserEvent) => void): () => void;
}

/**
 * NotificationManager tracks open notification sessions and exposes a
 * render-ready snapshot. User events arrive via the presenter (notification
 * ui:events) and are routed to handles.
 */
export class NotificationManager {
  private readonly notifyChange: () => void;
  private readonly handles = new Map<string, NotificationHandleImpl>();
  private readonly logger: Logger | undefined;
  private nextId = 1;

  constructor(notifyChange: () => void, logger?: Logger) {
    this.notifyChange = notifyChange;
    this.logger = logger;
  }

  /** Render-ready snapshot of every open notification, in open order. */
  getSnapshot(): readonly UiNotification[] {
    return [...this.handles.values()].map((handle) => ({
      id: handle.id,
      config: handle.config,
    }));
  }

  /**
   * Open a notification. Returns a handle for updates and events.
   */
  open(config: NotificationConfig): NotificationHandle {
    const notificationId = `ntf-${this.nextId++}`;
    const handle = new NotificationHandleImpl(notificationId, config, this.notifyChange, () => {
      this.handles.delete(notificationId);
    });
    this.handles.set(notificationId, handle);

    this.notifyChange();

    return handle;
  }

  /**
   * Route an incoming user event to the correct handle.
   * Called by the presenter when a notification ui:event arrives.
   */
  routeEvent(event: NotificationUserEvent): void {
    const handle = this.handles.get(event.notificationId);
    if (handle) {
      handle.emit(event);
    } else {
      this.logger?.debug("Notification event for unknown notification", {
        notificationId: event.notificationId,
        actionId: event.actionId,
      });
    }
  }
}

/**
 * Internal implementation of NotificationHandle.
 */
class NotificationHandleImpl implements NotificationHandle {
  readonly id: string;

  /** Current render config — read by NotificationManager.getSnapshot(). */
  config: NotificationConfig;

  private readonly notifyChange: () => void;
  private readonly onRemove: () => void;
  private readonly listeners = new Set<(event: NotificationUserEvent) => void>();
  private isClosed = false;

  constructor(
    id: string,
    config: NotificationConfig,
    notifyChange: () => void,
    onRemove: () => void
  ) {
    this.id = id;
    this.config = config;
    this.notifyChange = notifyChange;
    this.onRemove = onRemove;
  }

  update(config: NotificationConfig): void {
    if (this.isClosed) return;
    this.config = config;
    this.notifyChange();
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onRemove();
    this.listeners.clear();
    this.notifyChange();
  }

  onEvent(handler: (event: NotificationUserEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** Called by NotificationManager when a user event arrives for this notification. */
  emit(event: NotificationUserEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
