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
 * differ in how they are addressed: a dialog hands its opener a handle with a
 * full action/change/dismiss/await contract; a notification is a lightweight
 * sidebar indicator addressed by id through `notification:show` /
 * `notification:close`, and hands out no handle at all.
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
import type { UiDialog } from "../../shared/ui-state";
import type { Logger } from "../../boundaries/platform/logging";
import { Path } from "../../utils/path/path";
import { ApiError } from "../../api/errors";

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
 *
 * `projectPath` names that workspace's project. Pass it when the workspace may
 * still be being created: its sidebar row is then a placeholder with no path
 * yet, and project + workspace name is the only identity the two share.
 */
export interface DialogOpenOptions {
  readonly kind?: DialogKind;
  readonly workspacePath?: string;
  readonly projectPath?: string;
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
    const projectPath = options?.projectPath;
    return this.register(
      (id, onRemove) =>
        new DialogHandleImpl(
          id,
          kind,
          config,
          this.notifyChange,
          onRemove,
          workspacePath,
          projectPath
        )
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
   * needsAttentionFor for a workspace still being created, whose row has no
   * path to match yet: matches an attention dialog opened with this project and
   * a workspace path whose last segment is this name (a managed workspace is
   * named after its directory). A dialog opened without `projectPath` never
   * matches here — a bare name could belong to another project.
   */
  needsAttentionForPending(projectPath: string, workspaceName: string): boolean {
    for (const handle of this.openSessions) {
      if (
        handle.config.needsAttention === true &&
        handle.projectPath !== undefined &&
        handle.workspacePath !== undefined &&
        new Path(handle.projectPath).equals(projectPath) &&
        new Path(handle.workspacePath).basename === workspaceName
      ) {
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
  /** Project of that workspace, when given. See DialogOpenOptions. */
  readonly projectPath: string | undefined;
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
    workspacePath?: string,
    projectPath?: string
  ) {
    this.id = id;
    this.kind = kind;
    this.workspacePath = workspacePath;
    this.projectPath = projectPath;
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
 * A card as the registry projects it: the render config plus the domain facts
 * the presenter turns into render-ready fields (the workspace path becomes the
 * row key and display name — paths never reach the renderer).
 */
export interface NotificationSnapshot {
  readonly id: string;
  readonly config: NotificationConfig;
  readonly count: number;
  readonly workspacePath?: string;
}

/** What `notification:show` asks the registry for. */
export interface NotificationShowRequest {
  readonly config: NotificationConfig;
  /** Card to update; omit to open (or join) one. */
  readonly id?: string;
  /** Workspace the card is about. Only read when a card is opened. */
  readonly workspacePath?: string;
}

/** How a wait may end without the user answering. */
export interface NotificationWaitOptions {
  readonly timeoutMs?: number;
  /** Token that `releaseWaiter` can end this wait with. */
  readonly waiter?: string;
}

/**
 * Identity of a notification, for collapsing repeats.
 *
 * Everything the user can tell apart, and nothing else: `progress` is a live
 * measurement rather than an identity, and including it would rekey a spinner on
 * every frame. Two callers that describe the same thing the same way are saying
 * the same thing, so they share a card and a count.
 *
 * The attached workspace is part of the identity: a card is about one
 * workspace (it names it and a click switches there), so the same words from
 * two workspaces are two cards. Unattached cards collapse among themselves.
 *
 * Structural, so a caller with a distinction its visible text does not carry has
 * no way to express it — the fix is to put the distinction in the text, as the
 * clone card does with the URL the user typed.
 */
export function dedupKey(config: NotificationConfig, workspacePath?: string): string {
  return JSON.stringify([
    config.title,
    config.message ?? null,
    config.type,
    config.dismissible ?? false,
    config.actions ?? null,
    workspacePath ?? null,
  ]);
}

/** One blocked `notification:show { wait }`. */
interface Waiter {
  readonly resolve: (choice: string | null) => void;
  readonly token: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * NotificationManager tracks open sidebar cards and exposes a snapshot the
 * presenter folds into ui:state. It is the state behind `notification:show` /
 * `notification:close`, addressed by the ids it mints — no handles leave it.
 *
 * Holds: every open that lands on a card (a fresh open, or one that collapsed
 * into an identical card) holds it, and the card closes when the last hold is
 * released — a clone finishing must not take another clone's indicator with it.
 *
 * Waits: a waiting show holds the card for as long as it waits. The user
 * answering (a button, or dismiss) closes the card outright and answers every
 * waiter with the same choice; a waiter that times out or is released gives up
 * only its own hold.
 */
export class NotificationManager extends SessionRegistry<NotificationSnapshot, NotificationCard> {
  /** Open cards by identity, so a repeat collapses instead of stacking. */
  private readonly byKey = new Map<string, NotificationCard>();
  /** Waits that can be released by token (the registry's disconnect path). */
  private readonly byToken = new Map<string, { card: NotificationCard; waiter: Waiter }>();

  constructor(notifyChange: () => void, logger?: Logger) {
    super("ntf", notifyChange, logger);
  }

  /**
   * Open a card, collapse into the open card that already says this, or — with
   * `id` — replace an open card's content. Returns the card's id.
   *
   * @throws ApiError `not-found` when `id` names no open card
   */
  show(request: NotificationShowRequest): string {
    return this.land(request).id;
  }

  /**
   * `show`, then block until the card is answered.
   *
   * With `id` the waiter takes the card over: its hold replaces every other,
   * so the card is the waiter's question and goes when the waiter does.
   *
   * @returns the clicked button's id, or null (dismiss, timeout, release, the
   *   card closing for any other reason)
   * @throws ApiError `not-found` when `id` names no open card
   */
  showAndWait(
    request: NotificationShowRequest,
    options: NotificationWaitOptions
  ): Promise<string | null> {
    const card = this.land(request);
    if (request.id !== undefined) card.takeOver();
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve, token: options.waiter, timer: undefined };
      card.addWaiter(waiter);
      if (waiter.token !== undefined) this.byToken.set(waiter.token, { card, waiter });
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => this.leave(card, waiter), options.timeoutMs);
      }
    });
  }

  /** Whether `id` names an open card. */
  isOpen(id: string): boolean {
    return this.lookup(id) !== undefined;
  }

  /** Release one hold on a card. No-op for an id that is not open. */
  close(id: string): void {
    this.lookup(id)?.release();
  }

  /** End the wait registered under `token` (choice null). No-op when it already ended. */
  releaseWaiter(token: string): void {
    const entry = this.byToken.get(token);
    if (entry) this.leave(entry.card, entry.waiter);
  }

  /** Close every card attached to a workspace that is gone. */
  closeWorkspace(workspacePath: string): void {
    for (const card of [...this.openSessions]) {
      if (card.workspacePath === workspacePath) card.finish(null);
    }
  }

  /**
   * Route a user interaction. "dismiss" closes the card with no choice; a
   * button closes it with that button's id. Either way every waiter is told.
   */
  routeEvent(event: NotificationUserEvent): void {
    const card = this.lookup(event.notificationId);
    if (!card) {
      this.logger?.debug("Notification event for unknown notification", {
        notificationId: event.notificationId,
        actionId: event.actionId,
      });
      return;
    }
    if (event.actionId === "dismiss") {
      card.finish(null);
      return;
    }
    if (card.config.actions?.some((action) => action.id === event.actionId)) {
      card.finish(event.actionId);
      return;
    }
    this.logger?.debug("Notification event for unknown action", {
      notificationId: event.notificationId,
      actionId: event.actionId,
    });
  }

  /** Resolve a request to the card it lands on, taking a hold on a fresh or joined card. */
  private land(request: NotificationShowRequest): NotificationCard {
    if (request.id !== undefined) {
      const card = this.lookup(request.id);
      if (!card) {
        throw new ApiError("not-found", `No open notification "${request.id}".`);
      }
      card.update(request.config);
      return card;
    }

    const key = dedupKey(request.config, request.workspacePath);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.absorb();
      return existing;
    }
    const card = this.register(
      (id, onRemove) =>
        new NotificationCard(id, request.config, request.workspacePath, this.notifyChange, {
          // Re-file a card whose config changed, so it is matched by what it now
          // says rather than by what it said when it opened — otherwise a card
          // that has moved on would still swallow a fresh open of its old text.
          rekey: (from, to, self) => {
            if (this.byKey.get(from) === self) this.byKey.delete(from);
            if (!this.byKey.has(to)) this.byKey.set(to, self);
          },
          release: (self) => {
            if (this.byKey.get(self.key) === self) this.byKey.delete(self.key);
            for (const [token, entry] of this.byToken) {
              if (entry.card === self) this.byToken.delete(token);
            }
            onRemove();
          },
        })
    );
    this.byKey.set(key, card);
    return card;
  }

  /** A waiter gives up (timeout or release): answer it null, drop its hold. */
  private leave(card: NotificationCard, waiter: Waiter): void {
    if (!card.removeWaiter(waiter)) return;
    if (waiter.token !== undefined) this.byToken.delete(waiter.token);
    waiter.resolve(null);
    card.release();
  }
}

/** How the registry re-files and retires a card as its identity changes. */
interface NotificationRegistryHooks {
  rekey(from: string, to: string, self: NotificationCard): void;
  release(self: NotificationCard): void;
}

/** One open sidebar card. Internal to NotificationManager. */
class NotificationCard implements RegistrySession<NotificationSnapshot> {
  /** Current identity, kept in step with `config` — read by the registry. */
  key: string;

  /** Opens (and waits) holding this card; it retires when this hits zero. */
  private holds = 1;
  private readonly waiters = new Set<Waiter>();
  private isClosed = false;

  constructor(
    readonly id: string,
    public config: NotificationConfig,
    readonly workspacePath: string | undefined,
    private readonly notifyChange: () => void,
    private readonly hooks: NotificationRegistryHooks
  ) {
    this.key = dedupKey(config, workspacePath);
  }

  toSnapshot(): NotificationSnapshot {
    return {
      id: this.id,
      config: this.config,
      count: this.holds,
      ...(this.workspacePath !== undefined && { workspacePath: this.workspacePath }),
    };
  }

  /** Another open said exactly this. Take it on rather than stacking a duplicate. */
  absorb(): void {
    if (this.isClosed) return;
    this.holds += 1;
    this.notifyChange();
  }

  /** A waiter claims the card for itself: its hold is now the only one. */
  takeOver(): void {
    if (this.isClosed) return;
    this.holds = 1;
    this.notifyChange();
  }

  update(config: NotificationConfig): void {
    if (this.isClosed) return;
    this.config = config;
    const next = dedupKey(config, this.workspacePath);
    this.hooks.rekey(this.key, next, this);
    this.key = next;
    this.notifyChange();
  }

  addWaiter(waiter: Waiter): void {
    this.waiters.add(waiter);
  }

  /** @returns whether the waiter was still waiting */
  removeWaiter(waiter: Waiter): boolean {
    if (!this.waiters.delete(waiter)) return false;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    return true;
  }

  /** Drop one hold; the last one closes the card. */
  release(): void {
    if (this.isClosed) return;
    if (this.holds > 1) {
      this.holds -= 1;
      this.notifyChange();
      return;
    }
    this.finish(null);
  }

  /** Close the card outright, answering every waiter with `choice`. */
  finish(choice: string | null): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.hooks.release(this);
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(choice);
    }
    this.notifyChange();
  }
}
