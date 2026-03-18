/**
 * DialogManager - Backend service for managing declarative dialogs.
 *
 * Opens, updates, and closes dialogs by sending commands to the renderer via sendToUI.
 * Each dialog is tracked via a DialogHandle that supports updates, event subscriptions,
 * and awaiting user interactions.
 */

import type { DialogConfig, DialogCommand, DialogUserEvent } from "../shared/dialog-types";
import { ApiIpcChannels } from "../shared/ipc";
import type { Logger } from "../boundaries/platform/logging";

/**
 * Handle to an open dialog. Allows updating, closing, and receiving user events.
 */
export interface DialogHandle {
  readonly id: string;
  /** Replace dialog config (full state replacement). */
  update(config: DialogConfig): void;
  /** Close dialog from backend. */
  close(): void;
  /** Subscribe to user events. Returns unsubscribe function. */
  onEvent(handler: (event: DialogUserEvent) => void): () => void;
  /** Await next user event (for sequential hook flows). Rejects on timeout if specified. */
  nextEvent(timeoutMs?: number): Promise<DialogUserEvent>;
  /** Promise that resolves when the dialog closes. */
  readonly closed: Promise<void>;
}

type SendToUI = (channel: string, ...args: unknown[]) => void;

/**
 * DialogManager wraps sendToUI with typed helpers for dialog lifecycle.
 */
export class DialogManager {
  private readonly sendToUI: SendToUI;
  private readonly handles = new Map<string, DialogHandleImpl>();
  private readonly logger: Logger | undefined;
  private nextId = 1;

  constructor(sendToUI: SendToUI, logger?: Logger) {
    this.sendToUI = sendToUI;
    this.logger = logger;
  }

  /**
   * Open a dialog. Returns a handle for updates and events.
   */
  open(config: DialogConfig): DialogHandle {
    const dialogId = `dlg-${this.nextId++}`;
    const handle = new DialogHandleImpl(dialogId, this.sendToUI, () => {
      this.handles.delete(dialogId);
    });
    this.handles.set(dialogId, handle);

    const command: DialogCommand = { action: "open", dialogId, config };
    this.sendToUI(ApiIpcChannels.DIALOG_COMMAND, command);

    return handle;
  }

  /**
   * Route an incoming user event from IPC to the correct handle.
   * Called by the IPC bridge when api:dialog:event arrives.
   */
  routeEvent(event: DialogUserEvent): void {
    const handle = this.handles.get(event.dialogId);
    if (handle) {
      handle.emit(event);
    } else {
      this.logger?.debug("Dialog event for unknown dialog", {
        dialogId: event.dialogId,
        actionId: event.actionId,
      });
    }
  }
}

/**
 * Internal implementation of DialogHandle.
 */
class DialogHandleImpl implements DialogHandle {
  readonly id: string;
  readonly closed: Promise<void>;

  private readonly sendToUI: SendToUI;
  private readonly onRemove: () => void;
  private readonly listeners = new Set<(event: DialogUserEvent) => void>();
  private resolveClosed!: () => void;
  private isClosed = false;

  constructor(id: string, sendToUI: SendToUI, onRemove: () => void) {
    this.id = id;
    this.sendToUI = sendToUI;
    this.onRemove = onRemove;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  update(config: DialogConfig): void {
    if (this.isClosed) return;
    const command: DialogCommand = { action: "update", dialogId: this.id, config };
    this.sendToUI(ApiIpcChannels.DIALOG_COMMAND, command);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const command: DialogCommand = { action: "close", dialogId: this.id };
    this.sendToUI(ApiIpcChannels.DIALOG_COMMAND, command);
    this.resolveClosed();
    this.listeners.clear();
    this.onRemove();
  }

  onEvent(handler: (event: DialogUserEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  nextEvent(timeoutMs?: number): Promise<DialogUserEvent> {
    const eventPromise = new Promise<DialogUserEvent>((resolve) => {
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
          () => reject(new Error(`Dialog ${this.id}: no response within ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /** Called by DialogManager when a user event arrives for this dialog. */
  emit(event: DialogUserEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
