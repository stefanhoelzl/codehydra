/**
 * Behavioral mock for WindowBoundary with in-memory state.
 *
 * Provides a stateful mock that simulates real WindowBoundary behavior:
 * - In-memory window storage with state tracking
 * - Event simulation via trigger methods
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const mock = createWindowBoundaryMock();
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
import type { WindowBoundary, WindowOptions, ContentView, Unsubscribe } from "./window";
import type { WindowHandle, Rectangle } from "./types";
import type { ImageHandle } from "./image-types";
import { ShellError } from "../../shared/errors/shell-errors";
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
  readonly backgroundColor: string | null;
  readonly isMaximized: boolean;
  readonly isDestroyed: boolean;
}

/**
 * State interface for the window layer mock.
 * Provides read access to windows and trigger methods for event simulation.
 */
export interface WindowBoundaryMockState extends MockState {
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
 * WindowBoundary with behavioral mock state access via `$` property.
 */
export type MockWindowBoundary = WindowBoundary & MockWithState<WindowBoundaryMockState>;

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
  backgroundColor: string | null;
  isMaximized: boolean;
  isDestroyed: boolean;
  options: WindowOptions;
}

/**
 * Implementation of WindowBoundaryMockState.
 */
class WindowBoundaryMockStateImpl implements WindowBoundaryMockState {
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
        backgroundColor: state.backgroundColor,
        isMaximized: state.isMaximized,
        isDestroyed: state.isDestroyed,
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
      const flags = [state.isMaximized ? "maximized" : null, state.isDestroyed ? "destroyed" : null]
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
 * Create a behavioral mock for WindowBoundary.
 *
 * The mock maintains state and validates operations just like the real
 * implementation, making it suitable for integration tests.
 *
 * @example Basic usage
 * const mock = createWindowBoundaryMock();
 * const handle = mock.createWindow({ title: "Test" });
 *
 * // Custom matchers (no direct state access)
 * expect(mock).toHaveWindowCount(1);
 * expect(mock).toHaveWindowTitle(handle.id, "Test");
 *
 * // Event simulation via $.triggerX()
 * mock.$.triggerResize(handle);
 */
export function createWindowBoundaryMock(): MockWindowBoundary {
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

  const state = new WindowBoundaryMockStateImpl(
    windows,
    resizeCallbacks,
    maximizeCallbacks,
    unmaximizeCallbacks,
    closeCallbacks,
    blurCallbacks
  );

  const layer: WindowBoundary = {
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
        backgroundColor: options.backgroundColor ?? null,
        isMaximized: false,
        isDestroyed: false,
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

    getContentBounds(handle: WindowHandle): Rectangle {
      const window = getWindow(handle);
      return { ...window.contentBounds };
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

    setBackgroundColor(handle: WindowHandle, color: string): void {
      const window = getWindow(handle);
      window.backgroundColor = color;
    },

    focus(handle: WindowHandle): void {
      getWindow(handle); // Validate handle exists
      // No-op in mock - focus is an OS-level operation
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

    async dispose(): Promise<void> {
      // Destroy all windows
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

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for WindowBoundary mock assertions.
 */
interface WindowBoundaryMatchers {
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
}

declare module "vitest" {
  interface Assertion<T> extends WindowBoundaryMatchers {}
}

export const windowBoundaryMatchers: MatcherImplementationsFor<
  MockWindowBoundary,
  WindowBoundaryMatchers
> = {
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
};

// Register matchers with expect
expect.extend(windowBoundaryMatchers);
