/**
 * Behavioral mock for ViewBoundary with state inspection.
 *
 * Provides a stateful mock that simulates real ViewBoundary behavior:
 * - In-memory view state tracking
 * - Window attachment/detachment
 * - Event callback management
 * - Custom matchers for behavioral assertions
 *
 * @example Basic usage
 * const mock = createViewBoundaryMock();
 * const handle = mock.adoptWindowWebContents(windowHandle);
 * expect(mock).toHaveView(handle.id, { attachedTo: windowHandle.id });
 */

import { expect } from "vitest";
import type {
  ViewBoundary,
  WindowOpenHandler,
  Unsubscribe,
  KeyboardInput,
  RenderProcessGoneDetails,
  UncaughtExceptionDetails,
} from "./view";
import type { ViewHandle, Rectangle, WindowHandle } from "./types";
import { ShellError } from "../../shared/errors/shell-errors";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";
import { CallbackRegistry, createSnapshot } from "../../test/state-mock";

// =============================================================================
// State Types
// =============================================================================

/**
 * Read-only snapshot of a view's state.
 */
export interface ViewStateSnapshot {
  readonly url: string | null;
  readonly attachedTo: string | null;
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
  /** true = must have handler, false = must not have handler */
  hasWindowOpenHandler?: boolean;
  /** true = must be focused, false = must not be focused */
  focused?: boolean;
}

/**
 * State interface with triggers and MockState methods.
 */
export interface ViewBoundaryMockState extends MockState {
  /**
   * Simulates Electron's 'before-input-event' event.
   * Invokes all registered handlers for the specified view.
   *
   * @returns Object with defaultPrevented boolean
   */
  triggerBeforeInputEvent(handle: ViewHandle, input: KeyboardInput): { defaultPrevented: boolean };

  /**
   * Simulates a view being destroyed.
   * Invokes all registered destroyed handlers and removes the view.
   */
  triggerDestroyed(handle: ViewHandle): void;

  /**
   * Simulates an uncaught exception in the view's page (CDP
   * Runtime.exceptionThrown). Invokes all registered handlers.
   *
   * @example
   * mock.onUncaughtException(handle, (details) => console.log(details.message));
   * mock.$.triggerUncaughtException(handle, { message: "Error: boom", stack: "", isPromiseRejection: false });
   */
  triggerUncaughtException(handle: ViewHandle, details: UncaughtExceptionDetails): void;

  /**
   * Simulates Electron's 'render-process-gone' event.
   * Invokes all registered handlers for the specified view.
   */
  triggerRenderProcessGone(handle: ViewHandle, details: RenderProcessGoneDetails): void;

  /**
   * Simulates a fire-and-forget IPC message from the view's renderer
   * (`webContents.ipc`). Invokes all onIpc listeners for the view + channel.
   */
  triggerIpc(handle: ViewHandle, channel: string, ...args: unknown[]): void;

  /**
   * Get a read-only snapshot of a view's state for assertions.
   */
  getViewSnapshot(id: string): ViewStateSnapshot | undefined;

  snapshot(): Snapshot;
  toString(): string;
}

/**
 * Mock ViewBoundary with state access via $ property.
 */
export type MockViewBoundary = ViewBoundary & MockWithState<ViewBoundaryMockState>;

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal mutable state for a view.
 */
interface ViewState {
  url: string | null;
  attachedTo: string | null;
  hasWindowOpenHandler: boolean;
  focused: boolean;
}

// =============================================================================
// State Implementation
// =============================================================================

class ViewBoundaryMockStateImpl implements ViewBoundaryMockState {
  private readonly _views: Map<string, ViewState>;
  private readonly _devToolsOpen: Set<string>;

  readonly beforeInputEventCallbacks = new CallbackRegistry<[KeyboardInput, () => void]>();
  readonly destroyedCallbacks = new CallbackRegistry();
  readonly uncaughtExceptionCallbacks = new CallbackRegistry<[UncaughtExceptionDetails]>();
  readonly renderProcessGoneCallbacks = new CallbackRegistry<[RenderProcessGoneDetails]>();
  /** Keyed by `${handle.id}::${channel}`. */
  readonly ipcCallbacks = new CallbackRegistry<unknown[]>();

  constructor() {
    this._views = new Map();
    this._devToolsOpen = new Set();
  }

  // Expose internals for the mock layer to mutate
  get views(): Map<string, ViewState> {
    return this._views;
  }

  get devToolsOpen(): Set<string> {
    return this._devToolsOpen;
  }

  triggerBeforeInputEvent(handle: ViewHandle, input: KeyboardInput): { defaultPrevented: boolean } {
    let defaultPrevented = false;
    const preventDefault = () => {
      defaultPrevented = true;
    };
    this.beforeInputEventCallbacks.trigger(handle.id, input, preventDefault);
    return { defaultPrevented };
  }

  triggerDestroyed(handle: ViewHandle): void {
    const callbacks = this.destroyedCallbacks.get(handle.id);
    if (callbacks) {
      for (const callback of [...callbacks]) {
        callback();
      }
    }
    // Clean up callbacks for the destroyed view
    this.beforeInputEventCallbacks.delete(handle.id);
    this.destroyedCallbacks.delete(handle.id);
  }

  triggerUncaughtException(handle: ViewHandle, details: UncaughtExceptionDetails): void {
    this.uncaughtExceptionCallbacks.trigger(handle.id, details);
  }

  triggerRenderProcessGone(handle: ViewHandle, details: RenderProcessGoneDetails): void {
    this.renderProcessGoneCallbacks.trigger(handle.id, details);
  }

  triggerIpc(handle: ViewHandle, channel: string, ...args: unknown[]): void {
    this.ipcCallbacks.trigger(`${handle.id}::${channel}`, ...args);
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
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
      if (state.hasWindowOpenHandler) {
        props.push("windowOpenHandler");
      }
      lines.push(`view:${id}{${props.join(",")}}`);
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
      attachedTo: state.attachedTo,
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
 * Create a behavioral mock for ViewBoundary.
 *
 * @example Basic usage
 * const mock = createViewBoundaryMock();
 * const handle = mock.adoptWindowWebContents(windowHandle);
 * expect(mock).toHaveView(handle.id);
 *
 * @example Snapshot comparison
 * const before = mock.$.snapshot();
 * mock.adoptWindowWebContents(windowHandle);
 * expect(mock).not.toBeUnchanged(before);
 */
export function createViewBoundaryMock(): MockViewBoundary {
  const state = new ViewBoundaryMockStateImpl();
  const registries = [
    state.beforeInputEventCallbacks,
    state.destroyedCallbacks,
    state.uncaughtExceptionCallbacks,
    state.renderProcessGoneCallbacks,
    state.ipcCallbacks,
  ];
  let nextId = 1;

  function getView(handle: ViewHandle): ViewState {
    const view = state.views.get(handle.id);
    if (!view) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    return view;
  }

  const layer: ViewBoundary = {
    adoptWindowWebContents(windowHandle: WindowHandle): ViewHandle {
      const id = `view-${nextId++}`;
      state.views.set(id, {
        url: null,
        attachedTo: windowHandle.id,
        hasWindowOpenHandler: false,
        focused: false,
      });
      for (const registry of registries) {
        registry.init(id);
      }
      return { id, __brand: "ViewHandle" };
    },

    destroy(handle: ViewHandle): void {
      const view = state.views.get(handle.id);
      if (!view) {
        throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
      }
      state.views.delete(handle.id);
      for (const registry of registries) {
        registry.delete(handle.id);
      }
    },

    destroyAll(): void {
      state.views.clear();
      for (const registry of registries) {
        registry.clear();
      }
    },

    async loadURL(handle: ViewHandle, url: string): Promise<void> {
      const view = getView(handle);
      view.url = url;
    },

    async capturePNG(handle: ViewHandle, _rect?: Rectangle): Promise<Buffer | null> {
      getView(handle); // Validate handle exists
      // Return a tiny non-empty buffer to simulate a successful capture in tests.
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
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

    setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void {
      const view = getView(handle);
      view.hasWindowOpenHandler = handler !== null;
    },

    async executeJavaScript(_handle: ViewHandle, _code: string): Promise<unknown> {
      getView(_handle); // Validate handle exists
      return undefined;
    },

    installChildFrameScript(_handle: ViewHandle, _script: string): void {
      getView(_handle); // Validate handle exists
      // No-op in mock - did-frame-finish-load is not simulated
    },

    send(_handle: ViewHandle, _channel: string, ..._args: unknown[]): void {
      getView(_handle); // Validate handle exists
      // No-op in mock - IPC is not simulated
    },

    onIpc(
      handle: ViewHandle,
      channel: string,
      listener: (...args: unknown[]) => void
    ): Unsubscribe {
      getView(handle); // Validate handle exists
      const key = `${handle.id}::${channel}`;
      // CallbackRegistry.add is a no-op until the key is initialized; the ipc
      // key is per (view, channel), so init lazily on first subscription.
      if (!state.ipcCallbacks.get(key)) state.ipcCallbacks.init(key);
      return state.ipcCallbacks.add(key, listener);
    },

    onBeforeInputEvent(
      handle: ViewHandle,
      callback: (input: KeyboardInput, preventDefault: () => void) => void
    ): Unsubscribe {
      getView(handle); // Validate handle exists
      return state.beforeInputEventCallbacks.add(handle.id, callback);
    },

    onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe {
      getView(handle); // Validate handle exists
      return state.destroyedCallbacks.add(handle.id, callback);
    },

    onUncaughtException(
      handle: ViewHandle,
      callback: (details: UncaughtExceptionDetails) => void
    ): Unsubscribe {
      getView(handle); // Validate handle exists
      return state.uncaughtExceptionCallbacks.add(handle.id, callback);
    },

    onRenderProcessGone(
      handle: ViewHandle,
      callback: (details: RenderProcessGoneDetails) => void
    ): Unsubscribe {
      getView(handle); // Validate handle exists
      return state.renderProcessGoneCallbacks.add(handle.id, callback);
    },

    onUnresponsive(handle: ViewHandle, _callback: () => void): Unsubscribe {
      getView(handle); // Validate handle exists
      return () => {};
    },

    isAvailable(handle: ViewHandle): boolean {
      return state.views.has(handle.id);
    },

    openDevTools(handle: ViewHandle, _options?: { mode?: string }): void {
      getView(handle); // Validate handle exists
      state.devToolsOpen.add(handle.id);
    },

    closeDevTools(handle: ViewHandle): void {
      getView(handle); // Validate handle exists
      state.devToolsOpen.delete(handle.id);
    },

    isDevToolsOpened(handle: ViewHandle): boolean {
      getView(handle); // Validate handle exists
      return state.devToolsOpen.has(handle.id);
    },

    async dispose(): Promise<void> {
      state.views.clear();
      for (const registry of registries) {
        registry.clear();
      }
    },
  };

  return Object.assign(layer, { $: state as ViewBoundaryMockState });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for ViewBoundary mock assertions.
 */
interface ViewBoundaryMatchers {
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
   *   hasWindowOpenHandler: true
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
  interface Assertion<T> extends ViewBoundaryMatchers {}
}

export const viewBoundaryMatchers: MatcherImplementationsFor<
  MockViewBoundary,
  ViewBoundaryMatchers
> = {
  toHaveView(received, id, expected?) {
    const state = received.$ as ViewBoundaryMockStateImpl;
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
    const state = received.$ as ViewBoundaryMockStateImpl;
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
expect.extend(viewBoundaryMatchers);
