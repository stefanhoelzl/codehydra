/**
 * Behavioral mock for ViewLayer with state inspection.
 *
 * Provides a stateful mock that simulates real ViewLayer behavior:
 * - In-memory view state tracking
 * - Window attachment/detachment
 * - Event callback management
 * - Custom matchers for behavioral assertions
 *
 * @example Basic usage
 * const mock = createViewLayerMock();
 * const handle = mock.createView({ backgroundColor: "#1e1e1e" });
 * expect(mock).toHaveView(handle.id, { backgroundColor: "#1e1e1e" });
 *
 * @example Simulating events
 * mock.onDidFinishLoad(handle, () => console.log("loaded"));
 * mock.$.triggerDidFinishLoad(handle);
 */

import { expect } from "vitest";
import type { ViewLayer, ViewOptions, WindowOpenHandler, Unsubscribe } from "./view";
import type { ViewHandle, Rectangle, WindowHandle } from "./types";
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
 * Read-only snapshot of a view's state.
 */
export interface ViewStateSnapshot {
  readonly url: string | null;
  readonly bounds: Rectangle | null;
  readonly backgroundColor: string | null;
  readonly attachedTo: string | null;
  readonly options: ViewOptions;
  readonly hasWindowOpenHandler: boolean;
  readonly focused: boolean;
}

/**
 * Expected properties for toHaveView matcher.
 * Only specified properties are checked; omitted properties are ignored.
 */
export interface ViewExpectation {
  /** null = must be detached, string = must be attached to that window */
  attachedTo?: string | null;
  /** null = must have no URL, string = must have that URL */
  url?: string | null;
  /** Must have this background color */
  backgroundColor?: string;
  /** null = must have no bounds, Rectangle = must have those bounds */
  bounds?: Rectangle | null;
  /** true = must have handler, false = must not have handler */
  hasWindowOpenHandler?: boolean;
  /** true = must be focused, false = must not be focused */
  focused?: boolean;
}

/**
 * State interface with triggers and MockState methods.
 */
export interface ViewLayerMockState extends MockState {
  /**
   * Window children z-order for assertions.
   * Maps window ID to ordered array of view IDs (index 0 = bottom).
   */
  readonly windowChildren: Map<string, string[]>;

  /**
   * Simulates Electron's 'did-finish-load' event.
   * Invokes all registered handlers for the specified view.
   *
   * @example
   * mock.onDidFinishLoad(handle, callback);
   * mock.$.triggerDidFinishLoad(handle); // callback is invoked
   */
  triggerDidFinishLoad(handle: ViewHandle): void;

  /**
   * Simulates Electron's 'will-navigate' event.
   * Invokes all registered handlers for the specified view.
   *
   * @returns true if all handlers allow navigation, false if any handler prevents it
   *
   * @example
   * mock.onWillNavigate(handle, (url) => url.startsWith("http://allowed"));
   * mock.$.triggerWillNavigate(handle, "http://allowed/page"); // returns true
   * mock.$.triggerWillNavigate(handle, "http://blocked/page"); // returns false
   */
  triggerWillNavigate(handle: ViewHandle, url: string): boolean;

  snapshot(): Snapshot;
  toString(): string;
}

/**
 * Mock ViewLayer with state access via $ property.
 */
export type MockViewLayer = ViewLayer & MockWithState<ViewLayerMockState>;

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal mutable state for a view.
 */
interface ViewState {
  url: string | null;
  bounds: Rectangle | null;
  backgroundColor: string | null;
  attachedTo: string | null;
  options: ViewOptions;
  hasWindowOpenHandler: boolean;
  focused: boolean;
}

// =============================================================================
// State Implementation
// =============================================================================

class ViewLayerMockStateImpl implements ViewLayerMockState {
  private readonly _views: Map<string, ViewState>;
  private readonly _windowChildren: Map<string, string[]>;
  private readonly _didFinishLoadCallbacks: Map<string, Set<() => void>>;
  private readonly _willNavigateCallbacks: Map<string, Set<(url: string) => boolean>>;

  constructor() {
    this._views = new Map();
    this._windowChildren = new Map();
    this._didFinishLoadCallbacks = new Map();
    this._willNavigateCallbacks = new Map();
  }

  // Expose internals for the mock layer to mutate
  get views(): Map<string, ViewState> {
    return this._views;
  }

  get windowChildren(): Map<string, string[]> {
    return this._windowChildren;
  }

  get didFinishLoadCallbacks(): Map<string, Set<() => void>> {
    return this._didFinishLoadCallbacks;
  }

  get willNavigateCallbacks(): Map<string, Set<(url: string) => boolean>> {
    return this._willNavigateCallbacks;
  }

  triggerDidFinishLoad(handle: ViewHandle): void {
    const callbacks = this._didFinishLoadCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  triggerWillNavigate(handle: ViewHandle, url: string): boolean {
    const callbacks = this._willNavigateCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of callbacks) {
        const allow = callback(url);
        if (!allow) {
          return false; // Navigation prevented
        }
      }
    }
    return true; // Navigation allowed
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() } as Snapshot;
  }

  toString(): string {
    // Build deterministic string representation
    const lines: string[] = [];

    // Views (sorted by ID)
    const sortedViews = [...this._views.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [id, state] of sortedViews) {
      const props: string[] = [];
      if (state.url !== null) {
        props.push(`url=${JSON.stringify(state.url)}`);
      }
      if (state.attachedTo !== null) {
        props.push(`attachedTo=${state.attachedTo}`);
      }
      if (state.backgroundColor !== null) {
        props.push(`bg=${state.backgroundColor}`);
      }
      if (state.bounds !== null) {
        props.push(
          `bounds=${state.bounds.x},${state.bounds.y},${state.bounds.width},${state.bounds.height}`
        );
      }
      if (state.hasWindowOpenHandler) {
        props.push("windowOpenHandler");
      }
      lines.push(`view:${id}{${props.join(",")}}`);
    }

    // Window children (sorted by window ID)
    const sortedWindows = [...this._windowChildren.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [windowId, children] of sortedWindows) {
      if (children.length > 0) {
        lines.push(`window:${windowId}[${children.join(",")}]`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get a read-only snapshot of a view's state for matchers.
   */
  getViewSnapshot(id: string): ViewStateSnapshot | undefined {
    const state = this._views.get(id);
    if (!state) return undefined;
    return {
      url: state.url,
      bounds: state.bounds,
      backgroundColor: state.backgroundColor,
      attachedTo: state.attachedTo,
      options: state.options,
      hasWindowOpenHandler: state.hasWindowOpenHandler,
      focused: state.focused,
    };
  }

  /**
   * Get all view IDs.
   */
  getViewIds(): string[] {
    return [...this._views.keys()];
  }
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for ViewLayer.
 *
 * @example Basic usage
 * const mock = createViewLayerMock();
 * const handle = mock.createView({});
 * expect(mock).toHaveView(handle.id);
 *
 * @example Simulating events
 * mock.onDidFinishLoad(handle, () => console.log("loaded"));
 * mock.$.triggerDidFinishLoad(handle);
 *
 * @example Snapshot comparison
 * const before = mock.$.snapshot();
 * mock.createView({});
 * expect(mock).not.toBeUnchanged(before);
 */
export function createViewLayerMock(): MockViewLayer {
  const state = new ViewLayerMockStateImpl();
  let nextId = 1;

  function getView(handle: ViewHandle): ViewState {
    const view = state.views.get(handle.id);
    if (!view) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    return view;
  }

  function getWindowChildren(windowId: string): string[] {
    let children = state.windowChildren.get(windowId);
    if (!children) {
      children = [];
      state.windowChildren.set(windowId, children);
    }
    return children;
  }

  const layer: ViewLayer = {
    createView(options: ViewOptions): ViewHandle {
      const id = `view-${nextId++}`;
      state.views.set(id, {
        url: null,
        bounds: null,
        backgroundColor: options.backgroundColor ?? null,
        attachedTo: null,
        options,
        hasWindowOpenHandler: false,
        focused: false,
      });
      state.didFinishLoadCallbacks.set(id, new Set());
      state.willNavigateCallbacks.set(id, new Set());
      return { id, __brand: "ViewHandle" };
    },

    destroy(handle: ViewHandle): void {
      const view = state.views.get(handle.id);
      if (!view) {
        throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
      }
      // Remove from window children if attached
      if (view.attachedTo) {
        const children = state.windowChildren.get(view.attachedTo);
        if (children) {
          const idx = children.indexOf(handle.id);
          if (idx !== -1) {
            children.splice(idx, 1);
          }
        }
      }
      state.views.delete(handle.id);
      state.didFinishLoadCallbacks.delete(handle.id);
      state.willNavigateCallbacks.delete(handle.id);
    },

    destroyAll(): void {
      state.views.clear();
      state.didFinishLoadCallbacks.clear();
      state.willNavigateCallbacks.clear();
      state.windowChildren.clear();
    },

    async loadURL(handle: ViewHandle, url: string): Promise<void> {
      const view = getView(handle);
      view.url = url;
    },

    getURL(handle: ViewHandle): string {
      const view = getView(handle);
      return view.url ?? "";
    },

    setBounds(handle: ViewHandle, bounds: Rectangle): void {
      const view = getView(handle);
      view.bounds = bounds;
    },

    getBounds(handle: ViewHandle): Rectangle {
      const view = getView(handle);
      return view.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    },

    setBackgroundColor(handle: ViewHandle, color: string): void {
      const view = getView(handle);
      view.backgroundColor = color;
    },

    focus(handle: ViewHandle): void {
      const view = getView(handle);
      // Clear focus from all other views
      for (const v of state.views.values()) {
        v.focused = false;
      }
      // Set focus on this view
      view.focused = true;
    },

    attachToWindow(
      handle: ViewHandle,
      windowHandle: WindowHandle,
      index?: number,
      options?: { force?: boolean }
    ): void {
      const view = getView(handle);
      const children = getWindowChildren(windowHandle.id);
      const currentIndex = children.indexOf(handle.id);
      const isAttached = currentIndex !== -1;

      // Check if already at the correct position (no-op to preserve focus)
      if (isAttached && !options?.force) {
        // For "top" position (no index), check if already at end
        if (index === undefined && currentIndex === children.length - 1) {
          return; // Already at top
        }
        // For explicit index, check if already there
        if (index !== undefined && currentIndex === index) {
          return; // Already at correct index
        }
      }
      if (isAttached) {
        // Need to move (or force re-composite) - remove first
        children.splice(currentIndex, 1);
      }

      // Add at specified index or append to top
      if (index !== undefined) {
        children.splice(index, 0, handle.id);
      } else {
        children.push(handle.id);
      }

      view.attachedTo = windowHandle.id;
    },

    detachFromWindow(handle: ViewHandle): void {
      const view = getView(handle);
      if (view.attachedTo) {
        const children = state.windowChildren.get(view.attachedTo);
        if (children) {
          const idx = children.indexOf(handle.id);
          if (idx !== -1) {
            children.splice(idx, 1);
          }
        }
      }
      view.attachedTo = null;
    },

    onDidFinishLoad(handle: ViewHandle, callback: () => void): Unsubscribe {
      getView(handle); // Validate handle exists
      const callbacks = state.didFinishLoadCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    onWillNavigate(handle: ViewHandle, callback: (url: string) => boolean): Unsubscribe {
      getView(handle); // Validate handle exists
      const callbacks = state.willNavigateCallbacks.get(handle.id);
      callbacks?.add(callback);
      return () => {
        callbacks?.delete(callback);
      };
    },

    setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void {
      const view = getView(handle);
      view.hasWindowOpenHandler = handler !== null;
    },

    send(_handle: ViewHandle, _channel: string, ..._args: unknown[]): void {
      getView(_handle); // Validate handle exists
      // No-op in mock - IPC is not simulated
    },

    getWebContents(_handle: ViewHandle): Electron.WebContents | null {
      getView(_handle); // Validate handle exists
      // Return null in mock - WebContents are not available in behavioral mocks
      // Integration tests should not rely on raw WebContents access
      return null;
    },

    async dispose(): Promise<void> {
      state.views.clear();
      state.didFinishLoadCallbacks.clear();
      state.willNavigateCallbacks.clear();
      state.windowChildren.clear();
    },
  };

  return Object.assign(layer, { $: state as ViewLayerMockState });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for ViewLayer mock assertions.
 */
interface ViewLayerMatchers {
  /**
   * Assert view exists with optional property checks.
   *
   * @param id - View ID to check
   * @param expected - Optional expected properties (only specified properties are checked)
   *
   * @example Check view exists
   * expect(mock).toHaveView("view-1");
   *
   * @example Check view is detached
   * expect(mock).toHaveView("view-1", { attachedTo: null });
   *
   * @example Check multiple properties
   * expect(mock).toHaveView("view-1", {
   *   attachedTo: "window-1",
   *   url: "http://127.0.0.1:8080",
   *   backgroundColor: "#1e1e1e"
   * });
   */
  toHaveView(id: string, expected?: ViewExpectation): void;

  /**
   * Assert exactly these views exist (no more, no less).
   *
   * @param ids - Array of view IDs expected to exist
   *
   * @example Check exact views
   * expect(mock).toHaveViews(["view-1", "view-2"]);
   *
   * @example Check no views
   * expect(mock).toHaveViews([]);
   */
  toHaveViews(ids: string[]): void;
}

declare module "vitest" {
  interface Assertion<T> extends ViewLayerMatchers {}
}

export const viewLayerMatchers: MatcherImplementationsFor<MockViewLayer, ViewLayerMatchers> = {
  toHaveView(received, id, expected?) {
    const state = received.$ as ViewLayerMockStateImpl;
    const view = state.getViewSnapshot(id);

    // Check existence
    if (!view) {
      return {
        pass: false,
        message: () => `Expected view "${id}" to exist but it was not found`,
      };
    }

    // If no expected properties, just check existence
    if (expected === undefined) {
      return {
        pass: true,
        message: () => `Expected view "${id}" not to exist`,
      };
    }

    // Check each specified property
    if ("attachedTo" in expected) {
      if (view.attachedTo !== expected.attachedTo) {
        return {
          pass: false,
          message: () =>
            `Expected view "${id}" to have attachedTo ${JSON.stringify(expected.attachedTo)} but got ${JSON.stringify(view.attachedTo)}`,
        };
      }
    }

    if ("url" in expected) {
      if (view.url !== expected.url) {
        return {
          pass: false,
          message: () =>
            `Expected view "${id}" to have url ${JSON.stringify(expected.url)} but got ${JSON.stringify(view.url)}`,
        };
      }
    }

    if ("backgroundColor" in expected) {
      if (view.backgroundColor !== expected.backgroundColor) {
        return {
          pass: false,
          message: () =>
            `Expected view "${id}" to have backgroundColor ${JSON.stringify(expected.backgroundColor)} but got ${JSON.stringify(view.backgroundColor)}`,
        };
      }
    }

    if ("bounds" in expected) {
      const boundsMatch =
        expected.bounds === null
          ? view.bounds === null
          : view.bounds !== null &&
            view.bounds.x === expected.bounds.x &&
            view.bounds.y === expected.bounds.y &&
            view.bounds.width === expected.bounds.width &&
            view.bounds.height === expected.bounds.height;

      if (!boundsMatch) {
        return {
          pass: false,
          message: () =>
            `Expected view "${id}" to have bounds ${JSON.stringify(expected.bounds)} but got ${JSON.stringify(view.bounds)}`,
        };
      }
    }

    if ("hasWindowOpenHandler" in expected) {
      if (view.hasWindowOpenHandler !== expected.hasWindowOpenHandler) {
        return {
          pass: false,
          message: () =>
            `Expected view "${id}" to have hasWindowOpenHandler ${expected.hasWindowOpenHandler} but got ${view.hasWindowOpenHandler}`,
        };
      }
    }

    if ("focused" in expected) {
      if (view.focused !== expected.focused) {
        return {
          pass: false,
          message: () =>
            `Expected view "${id}" to have focused ${expected.focused} but got ${view.focused}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected view "${id}" not to match the specified properties`,
    };
  },

  toHaveViews(received, ids) {
    const state = received.$ as ViewLayerMockStateImpl;
    const actualIds = state.getViewIds().sort();
    const expectedIds = [...ids].sort();

    const actualSet = new Set(actualIds);
    const expectedSet = new Set(expectedIds);

    const missing = expectedIds.filter((id) => !actualSet.has(id));
    const extra = actualIds.filter((id) => !expectedSet.has(id));

    if (missing.length > 0 || extra.length > 0) {
      return {
        pass: false,
        message: () => {
          const parts: string[] = [
            `Expected views ${JSON.stringify(expectedIds)} but found ${JSON.stringify(actualIds)}`,
          ];
          if (missing.length > 0) {
            parts.push(`Missing: ${JSON.stringify(missing)}`);
          }
          if (extra.length > 0) {
            parts.push(`Extra: ${JSON.stringify(extra)}`);
          }
          return parts.join("\n");
        },
      };
    }

    return {
      pass: true,
      message: () =>
        `Expected views not to be exactly ${JSON.stringify(expectedIds)} but they were`,
    };
  },
};

// Register matchers with expect
expect.extend(viewLayerMatchers);
