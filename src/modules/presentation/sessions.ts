/**
 * Unified session registries backing the presenter's dialog + notification
 * frameworks. Both are in-process registries of open declarative sessions,
 * owned privately by the UiPresenter; neither touches IPC. On every mutation
 * (open/update/close) a session calls `notifyChange` (the presenter's
 * coalescing snapshot scheduler), and the presenter folds `getSnapshot()` into
 * the ui:state snapshot. User events arrive via the presenter (dialog /
 * notification ui:events) and are routed to handles by id.
 *
 * The shared registry mechanics (id minting, the handle map, snapshot
 * projection, routing) live in `SessionRegistry`. Dialogs and notifications
 * differ only in their handle richness: a dialog carries a `kind` and a
 * full action/change/dismiss/await contract; a notification is a lightweight
 * sidebar indicator with a single event channel.
 */

import type {
  DialogConfig,
  DialogKind,
  DialogUserEvent,
  DialogActionEvent,
  DialogFieldChangeEvent,
  DialogDismissEvent,
} from "../../shared/dialog-types";
import type { NotificationConfig, NotificationUserEvent } from "../../shared/notification-types";
import type { UiDialog, UiNotification } from "../../shared/ui-state";
import type { Logger } from "../../boundaries/platform/logging";

// =============================================================================
// Shared registry core
// =============================================================================

/** Minimal shape the registry needs from any session handle. */
interface RegistrySession<S> {
  readonly id: string;
  /** Render-ready projection folded into the ui:state snapshot. */
  toSnapshot(): S;
}

/**
 * In-process registry of open declarative sessions. Owns id minting, the
 * handle map, and snapshot projection; subclasses add the handle type, the
 * `open()` surface, and event routing. Every registration calls `notifyChange`.
 */
abstract class SessionRegistry<S, H extends RegistrySession<S>> {
  private readonly handles = new Map<string, H>();
  private seq = 1;

  constructor(
    private readonly idPrefix: string,
    protected readonly notifyChange: () => void,
    protected readonly logger?: Logger
  ) {}

  /** Render-ready snapshot of every open session, in open order. */
  getSnapshot(): readonly S[] {
    return [...this.handles.values()].map((handle) => handle.toSnapshot());
  }

  /**
   * Mint an id, build the handle (wired to self-removal), register it, and
   * notify. The factory receives the id and an `onRemove` it must call on close.
   */
  protected register(make: (id: string, onRemove: () => void) => H): H {
    const id = `${this.idPrefix}-${this.seq++}`;
    const handle = make(id, () => this.handles.delete(id));
    this.handles.set(id, handle);
    this.notifyChange();
    return handle;
  }

  /** Open sessions, for subclass predicates (e.g. isModalOpen). */
  protected get openSessions(): Iterable<H> {
    return this.handles.values();
  }

  /** Look up a handle by id for event routing. */
  protected lookup(id: string): H | undefined {
    return this.handles.get(id);
  }
}

// =============================================================================
// Dialogs
// =============================================================================

/**
 * Handle to an open dialog. Allows updating, closing, and receiving user events.
 */
export interface DialogHandle {
  readonly id: string;
  /** Replace dialog config (full state replacement). */
  update(config: DialogConfig): void;
  /** Close dialog from backend. */
  close(): void;
  /** Subscribe to action (submit) events. Returns unsubscribe function. */
  onEvent(handler: (event: DialogActionEvent) => void): () => void;
  /**
   * Subscribe to field-change events emitted before submit by fields that opt
   * in via `changeEvent`. Use this to react (validation, dependent options) and
   * push handle.update(). Returns unsubscribe function.
   */
  onChange(handler: (event: DialogFieldChangeEvent) => void): () => void;
  /**
   * Subscribe to dismiss events (Escape in the panel surface). The shell only
   * reports the intent; this session owner decides what dismissing means
   * (typically close + reopen with fresh config = clear). Returns unsubscribe
   * function.
   */
  onDismiss(handler: (event: DialogDismissEvent) => void): () => void;
  /**
   * Await the next user response: an action (button click) or a dismiss
   * (Escape). For sequential hook flows. Callers that require a specific
   * action must loop until they get it (e.g. a mandatory selection ignoring
   * dismisses). Rejects on timeout if specified.
   */
  nextEvent(timeoutMs?: number): Promise<DialogActionEvent | DialogDismissEvent>;
  /** Promise that resolves when the dialog closes. */
  readonly closed: Promise<void>;
}

/**
 * DialogManager tracks open dialog sessions and exposes a render-ready
 * snapshot. It also exposes a synchronous "modal open" signal (a blocking modal
 * dialog is currently open), consumed by the presenter (mode computation:
 * dialog beats hover/workspace) and the shortcut guard (Alt+X). Only
 * kind === "modal" counts; "modeless" (creation) and "panel" (deletion) do NOT
 * — they are non-blocking and the sidebar stays live.
 */
export class DialogManager extends SessionRegistry<UiDialog, DialogHandleImpl> {
  constructor(notifyChange: () => void, logger?: Logger) {
    super("dlg", notifyChange, logger);
  }

  /** True while at least one blocking modal dialog (kind === "modal") is open. Synchronous. */
  isModalOpen(): boolean {
    for (const handle of this.openSessions) {
      if (handle.kind === "modal") return true;
    }
    return false;
  }

  /**
   * Open a dialog. Returns a handle for updates and events.
   *
   * The kind is a session property set once here — update commands carry
   * only the config and cannot move a session between kinds.
   */
  open(config: DialogConfig, options?: { kind?: DialogKind }): DialogHandle {
    // Default kind is "modal" (matches the renderer DialogHost default).
    const kind: DialogKind = options?.kind ?? "modal";
    return this.register(
      (id, onRemove) => new DialogHandleImpl(id, kind, config, this.notifyChange, onRemove)
    );
  }

  /**
   * Route an incoming user event to the correct handle.
   * Called by the presenter when a dialog ui:event arrives.
   */
  routeEvent(event: DialogUserEvent): void {
    const handle = this.lookup(event.dialogId);
    if (handle) {
      handle.emit(event);
    } else {
      this.logger?.debug("Dialog event for unknown dialog", {
        dialogId: event.dialogId,
        ...(event.kind === "change"
          ? { kind: "change", fieldId: event.fieldId }
          : event.kind === "dismiss"
            ? { kind: "dismiss" }
            : { kind: "action", actionId: event.actionId }),
      });
    }
  }
}

/**
 * Internal implementation of DialogHandle.
 */
class DialogHandleImpl implements DialogHandle, RegistrySession<UiDialog> {
  readonly id: string;
  readonly kind: DialogKind;
  readonly closed: Promise<void>;

  /** Current render config — read by toSnapshot(). */
  config: DialogConfig;

  private readonly notifyChange: () => void;
  private readonly onRemove: () => void;
  private readonly actionListeners = new Set<(event: DialogActionEvent) => void>();
  private readonly changeListeners = new Set<(event: DialogFieldChangeEvent) => void>();
  private readonly dismissListeners = new Set<(event: DialogDismissEvent) => void>();
  private resolveClosed!: () => void;
  private isClosed = false;

  constructor(
    id: string,
    kind: DialogKind,
    config: DialogConfig,
    notifyChange: () => void,
    onRemove: () => void
  ) {
    this.id = id;
    this.kind = kind;
    this.config = config;
    this.notifyChange = notifyChange;
    this.onRemove = onRemove;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  toSnapshot(): UiDialog {
    return { id: this.id, kind: this.kind, config: this.config };
  }

  update(config: DialogConfig): void {
    if (this.isClosed) return;
    this.config = config;
    this.notifyChange();
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onRemove();
    this.resolveClosed();
    this.actionListeners.clear();
    this.changeListeners.clear();
    this.dismissListeners.clear();
    this.notifyChange();
  }

  onEvent(handler: (event: DialogActionEvent) => void): () => void {
    this.actionListeners.add(handler);
    return () => {
      this.actionListeners.delete(handler);
    };
  }

  onChange(handler: (event: DialogFieldChangeEvent) => void): () => void {
    this.changeListeners.add(handler);
    return () => {
      this.changeListeners.delete(handler);
    };
  }

  onDismiss(handler: (event: DialogDismissEvent) => void): () => void {
    this.dismissListeners.add(handler);
    return () => {
      this.dismissListeners.delete(handler);
    };
  }

  nextEvent(timeoutMs?: number): Promise<DialogActionEvent | DialogDismissEvent> {
    const eventPromise = new Promise<DialogActionEvent | DialogDismissEvent>((resolve) => {
      const settle = (event: DialogActionEvent | DialogDismissEvent): void => {
        unsubAction();
        unsubDismiss();
        resolve(event);
      };
      const unsubAction = this.onEvent(settle);
      const unsubDismiss = this.onDismiss(settle);
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

  /**
   * Called by DialogManager when a user event arrives for this dialog. Routed by
   * `kind` with specific positive checks: a "change" goes to change listeners, a
   * "dismiss" to dismiss listeners, an "action" (or absent kind, for backward
   * compatibility) goes to action listeners. Any future kind is ignored rather
   * than leaking into either path.
   */
  emit(event: DialogUserEvent): void {
    if (event.kind === "change") {
      for (const listener of this.changeListeners) {
        listener(event);
      }
    } else if (event.kind === "dismiss") {
      for (const listener of this.dismissListeners) {
        listener(event);
      }
    } else if (event.kind === "action" || event.kind === undefined) {
      for (const listener of this.actionListeners) {
        listener(event);
      }
    }
  }
}

// =============================================================================
// Notifications
// =============================================================================

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
 * ui:events) and are routed to handles. Mirrors DialogManager but for
 * lightweight, non-modal sidebar indicators (no surface, single event channel).
 */
export class NotificationManager extends SessionRegistry<UiNotification, NotificationHandleImpl> {
  constructor(notifyChange: () => void, logger?: Logger) {
    super("ntf", notifyChange, logger);
  }

  /**
   * Open a notification. Returns a handle for updates and events.
   */
  open(config: NotificationConfig): NotificationHandle {
    return this.register(
      (id, onRemove) => new NotificationHandleImpl(id, config, this.notifyChange, onRemove)
    );
  }

  /**
   * Route an incoming user event to the correct handle.
   * Called by the presenter when a notification ui:event arrives.
   */
  routeEvent(event: NotificationUserEvent): void {
    const handle = this.lookup(event.notificationId);
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
class NotificationHandleImpl implements NotificationHandle, RegistrySession<UiNotification> {
  readonly id: string;

  /** Current render config — read by toSnapshot(). */
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

  toSnapshot(): UiNotification {
    return { id: this.id, config: this.config };
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
