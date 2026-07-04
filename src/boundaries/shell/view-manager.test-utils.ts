/**
 * Test utilities for the UI view manager.
 *
 * Provides a stateful mock implementing `IViewManager` with sensible no-op
 * defaults for every method. Tests override only the slices they care about
 * via the `overrides` argument.
 */
import { vi } from "vitest";
import type { IViewManager, Unsubscribe } from "./view-manager.interface";

export interface CreateMockViewManagerOptions {
  /** Override any subset of the IViewManager API. */
  overrides?: Partial<IViewManager>;
}

/** Mock ViewManager with a test helper for driving inbound onFromUI messages. */
export interface MockViewManager extends IViewManager {
  /** Simulate a fire-and-forget IPC message from the UI renderer on `channel`. */
  __emitFromUI(channel: string, ...args: unknown[]): void;
}

/**
 * Create a mock ViewManager with no-op defaults for every method.
 *
 * The returned object satisfies IViewManager. `onFromUI` is behavioral —
 * register listeners and drive them via `__emitFromUI`. Pass `overrides` to
 * plug in specific behavior for methods your test exercises.
 */
export function createMockViewManager(options?: CreateMockViewManagerOptions): MockViewManager {
  const uiListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const base: IViewManager = {
    create: vi.fn(),
    getUIViewHandle: vi.fn().mockReturnValue({ id: "ui-view", __brand: "ViewHandle" }),
    getUIDevtoolsTarget: vi.fn(),
    getUIKeyboardTarget: vi.fn(),
    isUIAvailable: vi.fn().mockReturnValue(true),
    loadUIContent: vi.fn().mockResolvedValue(undefined),
    sendToUI: vi.fn(),
    onFromUI: (channel: string, listener: (...args: unknown[]) => void): Unsubscribe => {
      let listeners = uiListeners.get(channel);
      if (!listeners) {
        listeners = new Set();
        uiListeners.set(channel, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus: vi.fn(),
    reloadFrames: vi.fn(),
    waitForUIPaint: vi.fn().mockResolvedValue(undefined),
    captureActiveWorkspaceView: vi.fn().mockResolvedValue(null),
    destroy: vi.fn(),
  } as IViewManager;

  return {
    ...base,
    ...(options?.overrides ?? {}),
    __emitFromUI(channel: string, ...args: unknown[]): void {
      const listeners = uiListeners.get(channel);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
  };
}
