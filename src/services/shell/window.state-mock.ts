/**
 * Behavioral mock for WindowLayer with in-memory state.
 *
 * Provides a stateful mock that simulates real WindowLayer behavior:
 * - In-memory window storage with state tracking
 * - Event simulation via trigger methods
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const mock = createWindowLayerMock();
 * const handle = mock.createWindow({ title: "Test" });
 *
 * // Use custom matchers (no direct state access)
 * expect(mock).toHaveWindowCount(1);
 * expect(mock).toHaveWindowTitle(handle.id, "Test");
 *
 * // Trigger events via $.triggerX()
 * mock.$.triggerResize(handle);
 */

import { expect } from "vitest";
import type {
  WindowLayer,
  WindowOptions,
  ContentView,
  Unsubscribe,
  WindowLayerInternal,
} from "./window";
import type { WindowHandle, Rectangle, ViewHandle } from "./types";
import type { ImageHandle } from "../platform/types";
import { ShellError } from "./errors";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// State Types
// =============================================================================

/**
 * State for a single window in the mock.
 * All properties are readonly to prevent accidental mutation.
 */
export interface WindowMockState {
  readonly bounds: Rectangle;
  readonly contentBounds: Rectangle;
  readonly title: string;
  readonly isMaximized: boolean;
  readonly isDestroyed: boolean;
  readonly attachedViews: ReadonlySet<string>;
}

/**
 * State interface for the window layer mock.
 * Provides read access to windows and trigger methods for event simulation.
 */
export interface WindowLayerMockState extends MockState {
  /**
   * Read-only access to all windows.
   * Keys are window handle IDs.
   */
  readonly windows: ReadonlyMap<string, WindowMockState>;

  /**
   * Trigger a resize callback for a window.
   * Used in tests to simulate Electron resize events.
   *
   * @example
   * mock.$.triggerResize(handle);
   */
  triggerResize(handle: WindowHandle): void;

  /**
   * Trigger a maximize callback for a window.
   * Also sets isMaximized=true.
   *
   * @example
   * mock.$.triggerMaximize(handle);
   */
  triggerMaximize(handle: WindowHandle): void;

  /**
   * Trigger an unmaximize callback for a window.
   * Also sets isMaximized=false.
   *
   * @example
   * mock.$.triggerUnmaximize(handle);
   */
  triggerUnmaximize(handle: WindowHandle): void;

  /**
   * Trigger a close callback for a window.
   * Note: This fires the callback but does not destroy the window.
   *
   * @example
   * mock.$.triggerClose(handle);
   */
  triggerClose(handle: WindowHandle): void;

  /**
   * Trigger a blur callback for a window (window loses OS focus).
   *
   * @example
   * mock.$.triggerBlur(handle);
   */
  triggerBlur(handle: WindowHandle): void;

  /**
   * Capture current state as snapshot for later comparison.
   */
  snapshot(): Snapshot;

  /**
   * Human-readable representation of window state.
   */
  toString(): string;
}

// =============================================================================
// Mock Types
// =============================================================================

/**
 * WindowLayer with behavioral mock state access via `$` property.
 */
export type MockWindowLayer = WindowLayer & MockWithState<WindowLayerMockState>;

/**
 * WindowLayerInternal with behavioral mock state access via `$` property.
 * Used for manager tests that need WindowLayerInternal._getRawWindow.
 */
export type MockWindowLayerInternal = WindowLayerInternal & MockWithState<WindowLayerMockState>;

// =============================================================================
// Internal State Implementation
// =============================================================================

/**
 * Internal mutable state for a window.
 */
interface WindowStateInternal {
  bounds: Rectangle;
  contentBounds: Rectangle;
  title: string;
  isMaximized: boolean;
  isDestroyed: boolean;
  attachedViews: Set<string>;
  options: WindowOptions;
}

/**
 * Implementation of WindowLayerMockState.
 */
class WindowLayerMockStateImpl implements WindowLayerMockState {
  constructor(
    private readonly _windows: Map<string, WindowStateInternal>,
    private readonly _resizeCallbacks: Map<string, Set<() => void>>,
    private readonly _maximizeCallbacks: Map<string, Set<() => void>>,
    private readonly _unmaximizeCallbacks: Map<string, Set<() => void>>,
    private readonly _closeCallbacks: Map<string, Set<() => void>>,
    private readonly _blurCallbacks: Map<string, Set<() => void>>
  ) {}

  get windows(): ReadonlyMap<string, WindowMockState> {
    // Return a snapshot with readonly views
    const result = new Map<string, WindowMockState>();
    for (const [id, state] of this._windows) {
      result.set(id, {
        bounds: { ...state.bounds },
        contentBounds: { ...state.contentBounds },
        title: state.title,
        isMaximized: state.isMaximized,
        isDestroyed: state.isDestroyed,
        attachedViews: new Set(state.attachedViews),
      });
    }
    return result;
  }

  triggerResize(handle: WindowHandle): void {
    const callbacks = this._resizeCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  triggerMaximize(handle: WindowHandle): void {
    const window = this._windows.get(handle.id);
    if (window) {
      window.isMaximized = true;
    }
    const callbacks = this._maximizeCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  triggerUnmaximize(handle: WindowHandle): void {
    const window = this._windows.get(handle.id);
    if (window) {
      window.isMaximized = false;
    }
    const callbacks = this._unmaximizeCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  triggerClose(handle: WindowHandle): void {
    const callbacks = this._closeCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  triggerBlur(handle: WindowHandle): void {
    const callbacks = this._blurCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() } as Snapshot;
  }

  toString(): string {
    const sorted = [...this._windows.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines = sorted.map(([id, state]) => {
      const flags = [
        state.isMaximized ? "maximized" : null,
        state.isDestroyed ? "destroyed" : null,
        state.attachedViews.size > 0 ? `views:${state.attachedViews.size}` : null,
      ]
        .filter(Boolean)
        .join(",");
      const flagStr = flags ? ` [${flags}]` : "";
      return `${id}: "${state.title}" ${state.bounds.width}x${state.bounds.height}${flagStr}`;
    });
    return lines.join("\n") || "(no windows)";
  }
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for WindowLayer.
 *
 * The mock maintains state and validates operations just like the real
 * implementation, making it suitable for integration tests.
 *
 * @example Basic usage
 * const mock = createWindowLayerMock();
 * const handle = mock.createWindow({ title: "Test" });
 *
 * // Custom matchers (no direct state access)
 * expect(mock).toHaveWindowCount(1);
 * expect(mock).toHaveWindowTitle(handle.id, "Test");
 *
 * // Event simulation via $.triggerX()
 * mock.$.triggerResize(handle);
 */
export function createWindowLayerMock(): MockWindowLayer {
  const windows = new Map<string, WindowStateInternal>();
  const resizeCallbacks = new Map<string, Set<() => void>>();
  const maximizeCallbacks = new Map<string, Set<() => void>>();
  const unmaximizeCallbacks = new Map<string, Set<() => void>>();
  const closeCallbacks = new Map<string, Set<() => void>>();
  const blurCallbacks = new Map<string, Set<() => void>>();
  const contentViews = new Map<string, ContentView>();
  let nextId = 1;

  function getWindow(handle: WindowHandle): WindowStateInternal {
    const window = windows.get(handle.id);
    if (!window) {
      throw new ShellError("WINDOW_NOT_FOUND", `Window ${handle.id} not found`, handle.id);
    }
    if (window.isDestroyed) {
      throw new ShellError("WINDOW_DESTROYED", `Window ${handle.id} was destroyed`, handle.id);
    }
    return window;
  }

  function createContentView(): ContentView {
    const children: unknown[] = [];
    return {
      addChildView(view: unknown, index?: number): void {
        // Remove if already present (for re-ordering)
        const existingIndex = children.indexOf(view);
        if (existingIndex !== -1) {
          children.splice(existingIndex, 1);
        }
        // Add at specified index or append to end
        if (index !== undefined && index >= 0 && index <= children.length) {
          children.splice(index, 0, view);
        } else {
          children.push(view);
        }
      },
      removeChildView(view: unknown): void {
        const index = children.indexOf(view);
        if (index !== -1) {
          children.splice(index, 1);
        }
      },
      get children(): readonly unknown[] {
        return [...children];
      },
    };
  }

  const state = new WindowLayerMockStateImpl(
    windows,
    resizeCallbacks,
    maximizeCallbacks,
    unmaximizeCallbacks,
    closeCallbacks,
    blurCallbacks
  );

  const layer: WindowLayer = {
    createWindow(options: WindowOptions): WindowHandle {
      const id = `window-${nextId++}`;
      const bounds: Rectangle = {
        x: 0,
        y: 0,
        width: options.width ?? 800,
        height: options.height ?? 600,
      };
      windows.set(id, {
        bounds,
        contentBounds: { ...bounds },
        title: options.title ?? "",
        isMaximized: false,
        isDestroyed: false,
        attachedViews: new Set(),
        options,
      });
      contentViews.set(id, createContentView());
      resizeCallbacks.set(id, new Set());
      maximizeCallbacks.set(id, new Set());
      unmaximizeCallbacks.set(id, new Set());
      closeCallbacks.set(id, new Set());
      blurCallbacks.set(id, new Set());
      return { id, __brand: "WindowHandle" };
    },

    destroy(handle: WindowHandle): void {
      const window = getWindow(handle);
      if (window.attachedViews.size > 0) {
        throw new ShellError(
          "WINDOW_HAS_ATTACHED_VIEWS",
          `Window ${handle.id} has ${window.attachedViews.size} attached views`,
          handle.id
        );
      }
      window.isDestroyed = true;
      windows.delete(handle.id);
      contentViews.delete(handle.id);
      resizeCallbacks.delete(handle.id);
      maximizeCallbacks.delete(handle.id);
      unmaximizeCallbacks.delete(handle.id);
      closeCallbacks.delete(handle.id);
      blurCallbacks.delete(handle.id);
    },

    destroyAll(): void {
      // Check for attached views first
      for (const [id, window] of windows) {
        if (window.attachedViews.size > 0) {
          throw new ShellError(
            "WINDOW_HAS_ATTACHED_VIEWS",
            `Window ${id} has ${window.attachedViews.size} attached views`,
            id
          );
        }
      }

      // Now destroy all
      for (const window of windows.values()) {
        window.isDestroyed = true;
      }
      windows.clear();
      contentViews.clear();
      resizeCallbacks.clear();
      maximizeCallbacks.clear();
      unmaximizeCallbacks.clear();
      closeCallbacks.clear();
      blurCallbacks.clear();
    },

    getBounds(handle: WindowHandle): Rectangle {
      const window = getWindow(handle);
      return { ...window.bounds };
    },

    getContentBounds(handle: WindowHandle): Rectangle {
      const window = getWindow(handle);
      return { ...window.contentBounds };
    },

    setBounds(handle: WindowHandle, bounds: Rectangle): void {
      const window = getWindow(handle);
      window.bounds = { ...bounds };
      window.contentBounds = { ...bounds };
    },

    setOverlayIcon(handle: WindowHandle, _image: ImageHandle | null, _description: string): void {
      getWindow(handle); // Validate handle exists
      // No-op in mock - overlay icon is Windows-only
    },

    setIcon(handle: WindowHandle, _image: ImageHandle): void {
      getWindow(handle); // Validate handle exists
      // No-op in mock
    },

    maximize(handle: WindowHandle): void {
      const window = getWindow(handle);
      window.isMaximized = true;
    },

    isMaximized(handle: WindowHandle): boolean {
      const window = getWindow(handle);
      return window.isMaximized;
    },

    isDestroyed(handle: WindowHandle): boolean {
      const window = windows.get(handle.id);
      if (!window) {
        return true;
      }
      return window.isDestroyed;
    },

    setTitle(handle: WindowHandle, title: string): void {
      const window = getWindow(handle);
      window.title = title;
    },

    close(handle: WindowHandle): void {
      const window = getWindow(handle);
      // Trigger close callbacks before marking destroyed
      const callbacks = closeCallbacks.get(handle.id);
      if (callbacks) {
        for (const callback of callbacks) {
          callback();
        }
      }
      window.isDestroyed = true;
    },

    onResize(handle: WindowHandle, callback: () => void): Unsubscribe {
      getWindow(handle); // Validate handle exists
      const callbacks = resizeCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    onMaximize(handle: WindowHandle, callback: () => void): Unsubscribe {
      getWindow(handle); // Validate handle exists
      const callbacks = maximizeCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    onUnmaximize(handle: WindowHandle, callback: () => void): Unsubscribe {
      getWindow(handle); // Validate handle exists
      const callbacks = unmaximizeCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    onClose(handle: WindowHandle, callback: () => void): Unsubscribe {
      getWindow(handle); // Validate handle exists
      const callbacks = closeCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    onBlur(handle: WindowHandle, callback: () => void): Unsubscribe {
      getWindow(handle); // Validate handle exists
      const callbacks = blurCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    getContentView(handle: WindowHandle): ContentView {
      getWindow(handle); // Validate handle exists
      const contentView = contentViews.get(handle.id);
      if (!contentView) {
        throw new ShellError(
          "WINDOW_NOT_FOUND",
          `Content view for ${handle.id} not found`,
          handle.id
        );
      }
      return contentView;
    },

    trackAttachedView(handle: WindowHandle, viewHandle: ViewHandle): void {
      const window = getWindow(handle);
      window.attachedViews.add(viewHandle.id);
    },

    untrackAttachedView(handle: WindowHandle, viewHandle: ViewHandle): void {
      const window = getWindow(handle);
      window.attachedViews.delete(viewHandle.id);
    },

    async dispose(): Promise<void> {
      // Destroy all windows without checking for attached views
      for (const window of windows.values()) {
        window.isDestroyed = true;
      }
      windows.clear();
      contentViews.clear();
      resizeCallbacks.clear();
      maximizeCallbacks.clear();
      unmaximizeCallbacks.clear();
      closeCallbacks.clear();
      blurCallbacks.clear();
    },
  };

  return Object.assign(layer, { $: state });
}

/**
 * Create a behavioral mock for WindowLayerInternal.
 *
 * Extends createWindowLayerMock() with _getRawWindow that throws by default.
 * Used in manager tests where WindowLayerInternal is needed for ShortcutController.
 *
 * @example
 * const mock = createWindowLayerInternalMock();
 * const handle = mock.createWindow({ title: "Test" });
 *
 * // _getRawWindow throws in behavioral mock
 * expect(() => mock._getRawWindow(handle)).toThrow();
 */
export function createWindowLayerInternalMock(): MockWindowLayerInternal {
  const layer = createWindowLayerMock();

  return Object.assign(layer, {
    _getRawWindow: (): never => {
      throw new Error("_getRawWindow not available in behavioral mock");
    },
  }) as MockWindowLayerInternal;
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for WindowLayer mock assertions.
 */
interface WindowLayerMatchers {
  /**
   * Assert that a window exists.
   *
   * @example
   * expect(mock).toHaveWindow(handle.id);
   */
  toHaveWindow(id: string): void;

  /**
   * Assert the total number of windows.
   *
   * @example
   * expect(mock).toHaveWindowCount(2);
   */
  toHaveWindowCount(count: number): void;

  /**
   * Assert a window has a specific title.
   *
   * @example
   * expect(mock).toHaveWindowTitle(handle.id, "Test Window");
   */
  toHaveWindowTitle(id: string, title: string): void;

  /**
   * Assert a window is maximized.
   *
   * @example
   * expect(mock).toBeWindowMaximized(handle.id);
   */
  toBeWindowMaximized(id: string): void;

  /**
   * Assert a window has specific bounds.
   * Supports partial matching - only specified properties are checked.
   *
   * @example Full match
   * expect(mock).toHaveWindowBounds(handle.id, { x: 0, y: 0, width: 1200, height: 800 });
   *
   * @example Partial match (only check dimensions)
   * expect(mock).toHaveWindowBounds(handle.id, { width: 1200, height: 800 });
   */
  toHaveWindowBounds(id: string, bounds: Partial<Rectangle>): void;

  /**
   * Assert a specific view is attached to a window.
   *
   * @example
   * expect(mock).toHaveAttachedView(windowHandle.id, viewHandle.id);
   */
  toHaveAttachedView(windowId: string, viewId: string): void;

  /**
   * Assert the number of views attached to a window.
   *
   * @example
   * expect(mock).toHaveAttachedViewCount(handle.id, 3);
   */
  toHaveAttachedViewCount(windowId: string, count: number): void;
}

declare module "vitest" {
  interface Assertion<T> extends WindowLayerMatchers {}
}

export const windowLayerMatchers: MatcherImplementationsFor<MockWindowLayer, WindowLayerMatchers> =
  {
    toHaveWindow(received, id) {
      const window = received.$.windows.get(id);
      if (!window) {
        return {
          pass: false,
          message: () => `Expected window ${id} to exist but it does not`,
        };
      }
      return {
        pass: true,
        message: () => `Expected window ${id} not to exist`,
      };
    },

    toHaveWindowCount(received, count) {
      const actualCount = received.$.windows.size;
      if (actualCount !== count) {
        return {
          pass: false,
          message: () => `Expected ${count} windows but found ${actualCount}`,
        };
      }
      return {
        pass: true,
        message: () => `Expected not to have ${count} windows`,
      };
    },

    toHaveWindowTitle(received, id, title) {
      const window = received.$.windows.get(id);
      if (!window) {
        return {
          pass: false,
          message: () => `Expected window ${id} to exist with title "${title}" but it does not`,
        };
      }
      if (window.title !== title) {
        return {
          pass: false,
          message: () => `Expected window ${id} to have title "${title}" but got "${window.title}"`,
        };
      }
      return {
        pass: true,
        message: () => `Expected window ${id} not to have title "${title}"`,
      };
    },

    toBeWindowMaximized(received, id) {
      const window = received.$.windows.get(id);
      if (!window) {
        return {
          pass: false,
          message: () => `Expected window ${id} to be maximized but it does not exist`,
        };
      }
      if (!window.isMaximized) {
        return {
          pass: false,
          message: () => `Expected window ${id} to be maximized but it is not`,
        };
      }
      return {
        pass: true,
        message: () => `Expected window ${id} not to be maximized`,
      };
    },

    toHaveWindowBounds(received, id, bounds) {
      const window = received.$.windows.get(id);
      if (!window) {
        return {
          pass: false,
          message: () =>
            `Expected window ${id} to have bounds ${JSON.stringify(bounds)} but it does not exist`,
        };
      }

      const mismatches: string[] = [];
      if (bounds.x !== undefined && window.bounds.x !== bounds.x) {
        mismatches.push(`x: expected ${bounds.x}, got ${window.bounds.x}`);
      }
      if (bounds.y !== undefined && window.bounds.y !== bounds.y) {
        mismatches.push(`y: expected ${bounds.y}, got ${window.bounds.y}`);
      }
      if (bounds.width !== undefined && window.bounds.width !== bounds.width) {
        mismatches.push(`width: expected ${bounds.width}, got ${window.bounds.width}`);
      }
      if (bounds.height !== undefined && window.bounds.height !== bounds.height) {
        mismatches.push(`height: expected ${bounds.height}, got ${window.bounds.height}`);
      }

      if (mismatches.length > 0) {
        return {
          pass: false,
          message: () => `Window ${id} bounds mismatch: ${mismatches.join(", ")}`,
        };
      }

      return {
        pass: true,
        message: () => `Expected window ${id} not to have bounds ${JSON.stringify(bounds)}`,
      };
    },

    toHaveAttachedView(received, windowId, viewId) {
      const window = received.$.windows.get(windowId);
      if (!window) {
        return {
          pass: false,
          message: () =>
            `Expected window ${windowId} to have attached view ${viewId} but window does not exist`,
        };
      }
      if (!window.attachedViews.has(viewId)) {
        return {
          pass: false,
          message: () =>
            `Expected window ${windowId} to have attached view ${viewId} but it does not`,
        };
      }
      return {
        pass: true,
        message: () => `Expected window ${windowId} not to have attached view ${viewId}`,
      };
    },

    toHaveAttachedViewCount(received, windowId, count) {
      const window = received.$.windows.get(windowId);
      if (!window) {
        return {
          pass: false,
          message: () =>
            `Expected window ${windowId} to have ${count} attached views but window does not exist`,
        };
      }
      const actualCount = window.attachedViews.size;
      if (actualCount !== count) {
        return {
          pass: false,
          message: () =>
            `Expected window ${windowId} to have ${count} attached views but has ${actualCount}`,
        };
      }
      return {
        pass: true,
        message: () => `Expected window ${windowId} not to have ${count} attached views`,
      };
    },
  };

// Register matchers with expect
expect.extend(windowLayerMatchers);
