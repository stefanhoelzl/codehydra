/**
 * Behavioral mock for DialogManager/DialogHandle.
 *
 * Simulates the contract in `dialog-manager.ts`: `manager.open()` returns a
 * DialogHandle whose listeners tests fire via the captured MockDialogHandle's
 * emit helpers. `update`/`close` are tracked (config history, closed flag),
 * `closed` resolves on close(), and `nextEvent()` settles on the next action
 * or dismiss — mirroring the real handle.
 */

import { vi } from "vitest";
import type { DialogManager, DialogHandle } from "./sessions";
import type { UiPresenter } from "./presentation-module";
import type {
  DialogConfig,
  DialogKind,
  DialogUserEvent,
  DialogActionEvent,
  DialogFieldChangeEvent,
  DialogDismissEvent,
} from "../../shared/dialog-types";

/**
 * Test-side view of an open dialog: latest/full config history, kind,
 * closed flag, the handle given to the module under test, and emit helpers
 * that fire the handle's listeners.
 */
export interface MockDialogHandle {
  readonly id: string;
  /** Latest config (from open or the last update). */
  config: DialogConfig;
  /** Every config this handle has seen (open + updates), in order. */
  readonly configs: DialogConfig[];
  readonly kind: DialogKind;
  closed: boolean;
  /** The DialogHandle handed to the module under test (methods are spies). */
  readonly handle: DialogHandle;
  /** Fire an action event (button click) with an optional field-values snapshot. */
  emitAction(actionId: string, data?: Record<string, string>): void;
  /** Fire a field-change event. */
  emitChange(fieldId: string, data: Record<string, string>): void;
  /** Fire a dismiss event. */
  emitDismiss(): void;
  /** Route a raw user event by kind, like the real handle's emit(). */
  emitEvent(event: DialogUserEvent): void;
}

export interface MockDialogManager {
  /** Manager to inject into the module under test. `open` is a vi.fn spy. */
  readonly manager: DialogManager;
  /** UiPresenter dialog surface to inject into modules (`ui.dialog()`). */
  readonly ui: Pick<UiPresenter, "dialog" | "isModalOpen">;
  /** Every opened dialog, in order. */
  readonly handles: MockDialogHandle[];
  /** The most recently opened dialog, or null. */
  readonly lastHandle: MockDialogHandle | null;
  /** Opened dialogs of kind "panel" (deletion progress/failed). */
  panelHandles(): MockDialogHandle[];
  /** Opened dialogs of kind "modeless" (creation ground state). */
  modelessHandles(): MockDialogHandle[];
  /** Opened dialogs of kind "modal" (blocking). */
  modalHandles(): MockDialogHandle[];
}

/**
 * Create a behavioral DialogManager mock. Each `open()` captures a
 * MockDialogHandle in `handles` for inspection and event emission.
 */
export function createMockDialogManager(): MockDialogManager {
  const handles: MockDialogHandle[] = [];
  let nextId = 1;

  const modalIds = new Set<string>();
  const modalChangeListeners = new Set<(open: boolean) => void>();
  const notifyModal = (): void => {
    const open = modalIds.size > 0;
    for (const listener of modalChangeListeners) listener(open);
  };

  const open = vi.fn((config: DialogConfig, options?: { kind?: DialogKind }) => {
    const id = `dlg-test-${nextId++}`;
    const isModal = (options?.kind ?? "modal") === "modal";
    const mock = createMockDialogHandle(id, config, options?.kind);
    handles.push(mock);
    if (isModal) {
      const wasOpen = modalIds.size > 0;
      modalIds.add(id);
      if (modalIds.size > 0 !== wasOpen) notifyModal();
      void mock.handle.closed.then(() => {
        const stillOpen = modalIds.size > 0;
        modalIds.delete(id);
        if (modalIds.size > 0 !== stillOpen) notifyModal();
      });
    }
    return mock.handle;
  });

  const manager = {
    open,
    routeEvent: vi.fn(),
    isModalOpen: () => modalIds.size > 0,
    onModalOpenChange: (listener: (open: boolean) => void) => {
      modalChangeListeners.add(listener);
      return () => {
        modalChangeListeners.delete(listener);
      };
    },
  } as unknown as DialogManager;

  return {
    manager,
    ui: {
      dialog: open,
      isModalOpen: () => modalIds.size > 0,
    },
    handles,
    get lastHandle() {
      return handles[handles.length - 1] ?? null;
    },
    panelHandles: () => handles.filter((h) => h.kind === "panel"),
    modelessHandles: () => handles.filter((h) => h.kind === "modeless"),
    modalHandles: () => handles.filter((h) => h.kind === "modal"),
  };
}

/**
 * Create a standalone mock handle (for tests that stub the manager themselves,
 * e.g. a manager that always returns one handle).
 */
export function createMockDialogHandle(
  id: string,
  config: DialogConfig = { sections: [] },
  kind: DialogKind = "modal"
): MockDialogHandle {
  const actionListeners = new Set<(event: DialogActionEvent) => void>();
  const changeListeners = new Set<(event: DialogFieldChangeEvent) => void>();
  const dismissListeners = new Set<(event: DialogDismissEvent) => void>();

  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const handle: DialogHandle = {
    id,
    closed: closedPromise,
    update: vi.fn((newConfig: DialogConfig) => {
      if (mock.closed) return;
      mock.config = newConfig;
      mock.configs.push(newConfig);
    }),
    close: vi.fn(() => {
      if (mock.closed) return;
      mock.closed = true;
      resolveClosed();
      actionListeners.clear();
      changeListeners.clear();
      dismissListeners.clear();
    }),
    onEvent: vi.fn((handler: (event: DialogActionEvent) => void) => {
      actionListeners.add(handler);
      return () => {
        actionListeners.delete(handler);
      };
    }),
    onChange: vi.fn((handler: (event: DialogFieldChangeEvent) => void) => {
      changeListeners.add(handler);
      return () => {
        changeListeners.delete(handler);
      };
    }),
    onDismiss: vi.fn((handler: (event: DialogDismissEvent) => void) => {
      dismissListeners.add(handler);
      return () => {
        dismissListeners.delete(handler);
      };
    }),
    nextEvent: vi.fn((timeoutMs?: number) => {
      const eventPromise = new Promise<DialogActionEvent | DialogDismissEvent>((resolve) => {
        const settle = (event: DialogActionEvent | DialogDismissEvent): void => {
          unsubAction();
          unsubDismiss();
          resolve(event);
        };
        const unsubAction = handle.onEvent(settle);
        const unsubDismiss = handle.onDismiss(settle);
      });
      if (timeoutMs === undefined) return eventPromise;
      return Promise.race([
        eventPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Dialog ${id}: no response within ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);
    }),
  };

  const mock: MockDialogHandle = {
    id,
    config,
    configs: [config],
    kind,
    closed: false,
    handle,
    emitAction(actionId, data = {}) {
      mock.emitEvent({ kind: "action", dialogId: id, actionId, data });
    },
    emitChange(fieldId, data) {
      mock.emitEvent({ kind: "change", dialogId: id, fieldId, data });
    },
    emitDismiss() {
      mock.emitEvent({ kind: "dismiss", dialogId: id });
    },
    emitEvent(event) {
      // Mirror the real handle's kind routing (absent kind = action).
      if (event.kind === "change") {
        for (const listener of [...changeListeners]) listener(event);
      } else if (event.kind === "dismiss") {
        for (const listener of [...dismissListeners]) listener(event);
      } else if (event.kind === "action" || event.kind === undefined) {
        for (const listener of [...actionListeners]) listener(event);
      }
    },
  };

  return mock;
}
