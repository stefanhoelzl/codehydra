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
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type {
  DialogConfig,
  DialogSurface,
  DialogUserEvent,
  DialogActionEvent,
  DialogFieldChangeEvent,
  DialogDismissEvent,
} from "../shared/dialog-types";

/**
 * Test-side view of an open dialog: latest/full config history, surface,
 * closed flag, the handle given to the module under test, and emit helpers
 * that fire the handle's listeners.
 */
export interface MockDialogHandle {
  readonly id: string;
  /** Latest config (from open or the last update). */
  config: DialogConfig;
  /** Every config this handle has seen (open + updates), in order. */
  readonly configs: DialogConfig[];
  readonly surface: DialogSurface;
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
  /** Every opened dialog, in order. */
  readonly handles: MockDialogHandle[];
  /** The most recently opened dialog, or null. */
  readonly lastHandle: MockDialogHandle | null;
  /** Opened dialogs hosted in the panel surface. */
  panelHandles(): MockDialogHandle[];
  /** Opened dialogs hosted in the modal surface. */
  modalHandles(): MockDialogHandle[];
}

/**
 * Create a behavioral DialogManager mock. Each `open()` captures a
 * MockDialogHandle in `handles` for inspection and event emission.
 */
export function createMockDialogManager(): MockDialogManager {
  const handles: MockDialogHandle[] = [];
  let nextId = 1;

  const open = vi.fn((config: DialogConfig, options?: { surface?: DialogSurface }) => {
    const mock = createMockDialogHandle(`dlg-test-${nextId++}`, config, options?.surface);
    handles.push(mock);
    return mock.handle;
  });

  const manager = { open, routeEvent: vi.fn() } as unknown as DialogManager;

  return {
    manager,
    handles,
    get lastHandle() {
      return handles[handles.length - 1] ?? null;
    },
    panelHandles: () => handles.filter((h) => h.surface === "panel"),
    modalHandles: () => handles.filter((h) => h.surface === "modal"),
  };
}

/**
 * Create a standalone mock handle (for tests that stub the manager themselves,
 * e.g. a manager that always returns one handle).
 */
export function createMockDialogHandle(
  id: string,
  config: DialogConfig = { sections: [] },
  surface: DialogSurface = "modal"
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
    surface,
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
