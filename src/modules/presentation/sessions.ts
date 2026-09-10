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
 * How a dialog session is opened.
 *
 * `workspacePath` names the workspace the dialog is *about*. It never reaches
 * the renderer — dialogs are positioned by kind, not by workspace — but it is
 * what lets `needsAttention` mark a sidebar row, so a question raised while the
 * user is looking elsewhere still says which workspace raised it.
 */
export interface DialogOpenOptions {
  readonly kind?: DialogKind;
  readonly workspacePath?: string;
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
  open(config: DialogConfig, options?: DialogOpenOptions): DialogHandle {
    // Default kind is "modal" (matches the renderer DialogHost default).
    const kind: DialogKind = options?.kind ?? "modal";
    const workspacePath = options?.workspacePath;
    return this.register(
      (id, onRemove) =>
        new DialogHandleImpl(id, kind, config, this.notifyChange, onRemove, workspacePath)
    );
  }

  /**
   * True while an open dialog opened against this workspace is asking for an
   * answer — its *current* config carries `needsAttention`.
   *
   * Asked per row while the presenter builds the sidebar, so it answers without
   * allocating. A session flips the flag through ordinary update() calls, which
   * means this follows the dialog's state with nothing pushed here.
   */
  needsAttentionFor(workspacePath: string): boolean {
    for (const handle of this.openSessions) {
      if (handle.workspacePath === workspacePath && handle.config.needsAttention === true) {
        return true;
      }
    }
    return false;
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
  /** Workspace this dialog is about, when it is about one. See DialogOpenOptions. */
  readonly workspacePath: string | undefined;
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
    onRemove: () => void,
    workspacePath?: string
  ) {
    this.id = id;
    this.kind = kind;
    this.workspacePath = workspacePath;
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
  /**
   * Release this opener's hold on the card. Opens that collapsed into one card
   * each hold it, so the card disappears on the last close, not the first — a
   * clone finishing must not take another clone's indicator with it. A user
   * dismiss overrides that and drops the count to one, so the owner's close
   * finishes the card off.
   */
  close(): void;
  /** Subscribe to user events. Returns unsubscribe function. */
  onEvent(handler: (event: NotificationUserEvent) => void): () => void;
}

/**
 * Identity of a notification, for collapsing repeats.
 *
 * Everything the user can tell apart, and nothing else: `progress` is a live
 * measurement rather than an identity, and including it would rekey a spinner on
 * every frame. Two callers that describe the same thing the same way are saying
 * the same thing, so they share a card and a count.
 *
 * Structural, so a caller with a distinction its visible text does not carry has
 * no way to express it — the fix is to put the distinction in the text, as the
 * clone card does with the URL the user typed.
 */
export function dedupKey(config: NotificationConfig): string {
  return JSON.stringify([
    config.title,
    config.message ?? null,
    config.type,
    config.dismissible ?? false,
    config.actions ?? null,
  ]);
}

/**
 * NotificationManager tracks open notification sessions and exposes a
 * render-ready snapshot. User events arrive via the presenter (notification
 * ui:events) and are routed to handles. Mirrors DialogManager but for
 * lightweight, non-modal sidebar indicators (no surface, single event channel).
 *
 * Opens whose configs are identical collapse into one card with a count, so a
 * condition that repeats does not fill the sidebar with copies of itself.
 */
export class NotificationManager extends SessionRegistry<UiNotification, NotificationHandleImpl> {
  /** Open cards by identity, so a repeat collapses instead of stacking. */
  private readonly byKey = new Map<string, NotificationHandleImpl>();

  constructor(notifyChange: () => void, logger?: Logger) {
    super("ntf", notifyChange, logger);
  }

  /**
   * Open a notification, or collapse into the open card that already says this.
   *
   * Returns a handle either way, so a caller cannot tell the difference — which
   * is the point: a condition that repeats once a minute (an auto-workspace
   * create that keeps failing) yields one card with a count, not a stack that
   * fills the sidebar.
   */
  open(config: NotificationConfig): NotificationHandle {
    const key = dedupKey(config);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.absorb();
      return existing;
    }
    const handle = this.register(
      (id, onRemove) =>
        new NotificationHandleImpl(id, config, key, this.notifyChange, {
          // Re-file a card whose config changed, so it is matched by what it now
          // says rather than by what it said when it opened — otherwise a card
          // that has moved on would still swallow a fresh open of its old text.
          rekey: (from, to, self) => {
            if (this.byKey.get(from) === self) this.byKey.delete(from);
            if (!this.byKey.has(to)) this.byKey.set(to, self);
          },
          release: (self) => {
            if (this.byKey.get(self.key) === self) this.byKey.delete(self.key);
            onRemove();
          },
        })
    );
    this.byKey.set(key, handle);
    return handle;
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

/** How the registry re-files and retires a handle as its identity changes. */
interface NotificationRegistryHooks {
  rekey(from: string, to: string, self: NotificationHandleImpl): void;
  release(self: NotificationHandleImpl): void;
}

/**
 * Internal implementation of NotificationHandle.
 */
class NotificationHandleImpl implements NotificationHandle, RegistrySession<UiNotification> {
  readonly id: string;

  /** Current render config — read by toSnapshot(). */
  config: NotificationConfig;

  /** Current identity, kept in step with `config` — read by the registry. */
  key: string;

  /** Opens that collapsed into this card; the card retires when it hits zero. */
  private count = 1;

  private readonly notifyChange: () => void;
  private readonly hooks: NotificationRegistryHooks;
  private readonly listeners = new Set<(event: NotificationUserEvent) => void>();
  private isClosed = false;

  constructor(
    id: string,
    config: NotificationConfig,
    key: string,
    notifyChange: () => void,
    hooks: NotificationRegistryHooks
  ) {
    this.id = id;
    this.config = config;
    this.key = key;
    this.notifyChange = notifyChange;
    this.hooks = hooks;
  }

  toSnapshot(): UiNotification {
    return { id: this.id, config: this.config, count: this.count };
  }

  /** Another open said exactly this. Take it on rather than stacking a duplicate. */
  absorb(): void {
    if (this.isClosed) return;
    this.count += 1;
    this.notifyChange();
  }

  update(config: NotificationConfig): void {
    if (this.isClosed) return;
    this.config = config;
    const next = dedupKey(config);
    this.hooks.rekey(this.key, next, this);
    this.key = next;
    this.notifyChange();
  }

  close(): void {
    if (this.isClosed) return;
    if (this.count > 1) {
      // One of several opens is done with this card; the others still hold it.
      this.count -= 1;
      this.notifyChange();
      return;
    }
    this.isClosed = true;
    this.hooks.release(this);
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
    if (event.actionId === "dismiss") {
      // The user is done with the whole card, however many opens it stands for.
      // Dropping to one lets the owner's close() finish it off, rather than
      // peeling off a single hold and leaving the card sitting there.
      this.count = 1;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
