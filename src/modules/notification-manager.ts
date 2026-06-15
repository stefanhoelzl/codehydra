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
}

/**
 * NotificationManager sends typed commands to the renderer for notification lifecycle.
 *
 * Commands are buffered until markUIReady() is called: the renderer's
 * NotificationHost only subscribes to notification commands once MainView
 * mounts, so anything sent earlier (e.g. from app:start hooks) would be
 * silently dropped. The buffer is flushed in order when the renderer emits
 * the `ui-connected` ui:event (the presenter calls markUIReady()).
 */
export class NotificationManager {
  private readonly viewManager: IViewManager;
  private readonly handles = new Map<string, NotificationHandleImpl>();
  private readonly logger: Logger | undefined;
  private nextId = 1;
  private uiReady = false;
  private pendingCommands: NotificationCommand[] = [];

  constructor(viewManager: IViewManager, logger?: Logger) {
    this.viewManager = viewManager;
    this.logger = logger;
  }

  /**
   * Open a notification. Returns a handle for updates and events.
   */
  open(config: NotificationConfig): NotificationHandle {
    const notificationId = `ntf-${this.nextId++}`;
    const handle = new NotificationHandleImpl(
      notificationId,
      (command) => this.send(command),
      () => {
        this.handles.delete(notificationId);
      }
    );
    this.handles.set(notificationId, handle);

    this.send({ action: "open", notificationId, config });

    return handle;
  }

  /**
   * Flush buffered commands and switch to direct delivery. Idempotent.
   * Called once the renderer's NotificationHost is mounted (on `ui-connected`).
   * Notifications that were already closed while buffered are skipped entirely.
   */
  markUIReady(): void {
    if (this.uiReady) return;
    this.uiReady = true;
    const buffered = this.pendingCommands;
    this.pendingCommands = [];
    const closedIds = new Set(
      buffered.filter((c) => c.action === "close").map((c) => c.notificationId)
    );
    for (const command of buffered) {
      if (closedIds.has(command.notificationId)) continue;
      this.viewManager.sendToUI(ApiIpcChannels.NOTIFICATION_COMMAND, command);
    }
  }

  private send(command: NotificationCommand): void {
    if (!this.uiReady) {
      this.pendingCommands.push(command);
      return;
    }
    this.viewManager.sendToUI(ApiIpcChannels.NOTIFICATION_COMMAND, command);
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

  private readonly send: (command: NotificationCommand) => void;
  private readonly onRemove: () => void;
  private readonly listeners = new Set<(event: NotificationUserEvent) => void>();
  private isClosed = false;

  constructor(id: string, send: (command: NotificationCommand) => void, onRemove: () => void) {
    this.id = id;
    this.send = send;
    this.onRemove = onRemove;
  }

  update(config: NotificationConfig): void {
    if (this.isClosed) return;
    this.send({ action: "update", notificationId: this.id, config });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.send({ action: "close", notificationId: this.id });
    this.listeners.clear();
    this.onRemove();
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
