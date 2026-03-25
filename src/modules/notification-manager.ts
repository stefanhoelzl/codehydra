/**
 * NotificationManager - Backend service for managing sidebar notifications.
 *
 * Opens, updates, and closes notifications by sending commands to the renderer via IViewManager.
 * Each notification is tracked via a NotificationHandle that supports updates, event subscriptions,
 * and awaiting user interactions.
 *
 * Mirrors DialogManager but for lightweight, non-modal sidebar indicators.
 */

import type {
  NotificationConfig,
  NotificationCommand,
  NotificationUserEvent,
} from "../shared/notification-types";
import { ApiIpcChannels } from "../shared/ipc";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
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
  /** Await next user event (for sequential flows). Rejects on timeout if specified. */
  nextEvent(timeoutMs?: number): Promise<NotificationUserEvent>;
  /** Promise that resolves when the notification closes. */
  readonly closed: Promise<void>;
}

/**
 * NotificationManager sends typed commands to the renderer for notification lifecycle.
 */
export class NotificationManager {
  private readonly viewManager: IViewManager;
  private readonly handles = new Map<string, NotificationHandleImpl>();
  private readonly logger: Logger | undefined;
  private nextId = 1;

  constructor(viewManager: IViewManager, logger?: Logger) {
    this.viewManager = viewManager;
    this.logger = logger;
  }

  /**
   * Open a notification. Returns a handle for updates and events.
   */
  open(config: NotificationConfig): NotificationHandle {
    const notificationId = `ntf-${this.nextId++}`;
    const handle = new NotificationHandleImpl(notificationId, this.viewManager, () => {
      this.handles.delete(notificationId);
    });
    this.handles.set(notificationId, handle);

    const command: NotificationCommand = { action: "open", notificationId, config };
    this.viewManager.sendToUI(ApiIpcChannels.NOTIFICATION_COMMAND, command);

    return handle;
  }

  /**
   * Route an incoming user event from IPC to the correct handle.
   * Called by the IPC bridge when api:notification:event arrives.
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
  readonly closed: Promise<void>;

  private readonly viewManager: IViewManager;
  private readonly onRemove: () => void;
  private readonly listeners = new Set<(event: NotificationUserEvent) => void>();
  private resolveClosed!: () => void;
  private isClosed = false;

  constructor(id: string, viewManager: IViewManager, onRemove: () => void) {
    this.id = id;
    this.viewManager = viewManager;
    this.onRemove = onRemove;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  update(config: NotificationConfig): void {
    if (this.isClosed) return;
    const command: NotificationCommand = { action: "update", notificationId: this.id, config };
    this.viewManager.sendToUI(ApiIpcChannels.NOTIFICATION_COMMAND, command);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const command: NotificationCommand = { action: "close", notificationId: this.id };
    this.viewManager.sendToUI(ApiIpcChannels.NOTIFICATION_COMMAND, command);
    this.resolveClosed();
    this.listeners.clear();
    this.onRemove();
  }

  onEvent(handler: (event: NotificationUserEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  nextEvent(timeoutMs?: number): Promise<NotificationUserEvent> {
    const eventPromise = new Promise<NotificationUserEvent>((resolve) => {
      const unsub = this.onEvent((event) => {
        unsub();
        resolve(event);
      });
    });
    if (timeoutMs === undefined) return eventPromise;
    return Promise.race([
      eventPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Notification ${this.id}: no response within ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /** Called by NotificationManager when a user event arrives for this notification. */
  emit(event: NotificationUserEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
