/**
 * DialogManager - in-process registry of open declarative dialog sessions.
 *
 * Owned privately by the UiPresenter. It holds session state and hands out
 * DialogHandles; it does NOT touch IPC. On every mutation (open/update/close)
 * it calls `notifyChange` (the presenter's coalescing snapshot scheduler), and
 * the presenter folds `getSnapshot()` into the ui:state snapshot. User events
 * arrive via the presenter (dialog ui:events) and are routed to handles.
 */

import type {
  DialogConfig,
  DialogSurface,
  DialogUserEvent,
  DialogActionEvent,
  DialogFieldChangeEvent,
  DialogDismissEvent,
} from "../shared/dialog-types";
import type { UiDialog } from "../shared/ui-state";
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
 * snapshot. It also exposes a synchronous "modal open" signal (a modal-surface
 * dialog is currently open), consumed by the presenter (mode computation:
 * dialog beats hover/workspace) and the shortcut guard (Alt+X). "modal" means
 * surface === "modal" (the default); panel-surface sessions do NOT count.
 */
export class DialogManager {
  private readonly notifyChange: () => void;
  private readonly handles = new Map<string, DialogHandleImpl>();
  /** Currently-open dialog ids whose surface is "modal". */
  private readonly modalIds = new Set<string>();
  private readonly logger: Logger | undefined;
  private nextId = 1;

  constructor(notifyChange: () => void, logger?: Logger) {
    this.notifyChange = notifyChange;
    this.logger = logger;
  }

  /** True while at least one modal-surface dialog is open. Synchronous. */
  isModalOpen(): boolean {
    return this.modalIds.size > 0;
  }

  /** Render-ready snapshot of every open dialog session, in open order. */
  getSnapshot(): readonly UiDialog[] {
    return [...this.handles.values()].map((handle) => ({
      id: handle.id,
      surface: handle.surface,
      config: handle.config,
    }));
  }

  /**
   * Open a dialog. Returns a handle for updates and events.
   *
   * The surface is a session property set once here — update commands carry
   * only the config and cannot move a session between surfaces.
   */
  open(config: DialogConfig, options?: { surface?: DialogSurface }): DialogHandle {
    const dialogId = `dlg-${this.nextId++}`;
    // Default surface is "modal" (matches the renderer DialogHost default).
    const surface: DialogSurface = options?.surface ?? "modal";
    const isModal = surface === "modal";
    const handle = new DialogHandleImpl(dialogId, surface, config, this.notifyChange, () => {
      this.handles.delete(dialogId);
      if (isModal) this.modalIds.delete(dialogId);
    });
    this.handles.set(dialogId, handle);
    if (isModal) this.modalIds.add(dialogId);

    this.notifyChange();

    return handle;
  }

  /**
   * Route an incoming user event to the correct handle.
   * Called by the presenter when a dialog ui:event arrives.
   */
  routeEvent(event: DialogUserEvent): void {
    const handle = this.handles.get(event.dialogId);
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
class DialogHandleImpl implements DialogHandle {
  readonly id: string;
  readonly surface: DialogSurface;
  readonly closed: Promise<void>;

  /** Current render config — read by DialogManager.getSnapshot(). */
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
    surface: DialogSurface,
    config: DialogConfig,
    notifyChange: () => void,
    onRemove: () => void
  ) {
    this.id = id;
    this.surface = surface;
    this.config = config;
    this.notifyChange = notifyChange;
    this.onRemove = onRemove;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
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
