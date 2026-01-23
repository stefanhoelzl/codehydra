/**
 * ViewLayer - Abstraction over Electron's WebContentsView.
 *
 * Provides an injectable interface for view management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real WebContentsView
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { ViewHandle, Rectangle, WebPreferences, WindowHandle } from "./types";
import { createViewHandle } from "./types";
import { ShellError } from "./errors";
import type { Logger } from "../logging";
import type { WindowLayer } from "./window";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a view.
 */
export interface ViewOptions {
  readonly webPreferences?: WebPreferences;
  readonly backgroundColor?: string;
}

/**
 * Details about a window.open() request.
 */
export interface WindowOpenDetails {
  readonly url: string;
  readonly frameName: string;
  readonly disposition:
    | "default"
    | "foreground-tab"
    | "background-tab"
    | "new-window"
    | "save-to-disk"
    | "other";
}

/**
 * Action to take for window.open() requests.
 */
export type WindowOpenAction = { action: "allow" } | { action: "deny" };

/**
 * Handler for window.open() requests.
 */
export type WindowOpenHandler = (details: WindowOpenDetails) => WindowOpenAction;

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's WebContentsView.
 *
 * Uses opaque ViewHandle references instead of exposing WebContentsView directly.
 * This allows testing without Electron dependencies and ensures all view
 * access goes through this abstraction.
 */
export interface ViewLayer {
  // Lifecycle
  /**
   * Create a new view.
   *
   * @param options - View creation options
   * @returns Handle to the created view
   */
  createView(options: ViewOptions): ViewHandle;

  /**
   * Destroy a view.
   *
   * @param handle - Handle to the view
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  destroy(handle: ViewHandle): void;

  /**
   * Destroy all views.
   */
  destroyAll(): void;

  // Navigation
  /**
   * Load a URL in the view.
   *
   * @param handle - Handle to the view
   * @param url - URL to load
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   * @throws ShellError with code NAVIGATION_FAILED if navigation fails
   */
  loadURL(handle: ViewHandle, url: string): Promise<void>;

  /**
   * Get the current URL of the view.
   *
   * @param handle - Handle to the view
   * @returns The current URL
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  getURL(handle: ViewHandle): string;

  // Layout
  /**
   * Set the bounds of the view.
   *
   * @param handle - Handle to the view
   * @param bounds - The new bounds
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  setBounds(handle: ViewHandle, bounds: Rectangle): void;

  /**
   * Get the bounds of the view.
   *
   * @param handle - Handle to the view
   * @returns The current bounds
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  getBounds(handle: ViewHandle): Rectangle;

  /**
   * Set the background color of the view.
   *
   * @param handle - Handle to the view
   * @param color - CSS color string
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  setBackgroundColor(handle: ViewHandle, color: string): void;

  // Focus
  /**
   * Focus the view.
   *
   * @param handle - Handle to the view
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  focus(handle: ViewHandle): void;

  // Window attachment
  /**
   * Attach the view to a window's content view.
   *
   * @param handle - Handle to the view
   * @param windowHandle - Handle to the window
   * @param index - Optional z-order index (0 = bottom, omit = top)
   * @throws ShellError with code VIEW_NOT_FOUND if view handle is invalid
   */
  attachToWindow(handle: ViewHandle, windowHandle: WindowHandle, index?: number): void;

  /**
   * Detach the view from its window's content view.
   *
   * @param handle - Handle to the view
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  detachFromWindow(handle: ViewHandle): void;

  // Events
  /**
   * Subscribe to did-finish-load events.
   *
   * @param handle - Handle to the view
   * @param callback - Called when page finishes loading
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onDidFinishLoad(handle: ViewHandle, callback: () => void): Unsubscribe;

  /**
   * Subscribe to will-navigate events.
   *
   * @param handle - Handle to the view
   * @param callback - Called with the URL when navigation is about to occur.
   *                   Return true to allow navigation, false to prevent it.
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onWillNavigate(handle: ViewHandle, callback: (url: string) => boolean): Unsubscribe;

  /**
   * Set a handler for window.open() requests.
   *
   * @param handle - Handle to the view
   * @param handler - Handler function, or null to use default behavior
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void;

  // IPC
  /**
   * Send a message to the view's renderer process.
   *
   * @param handle - Handle to the view
   * @param channel - IPC channel name
   * @param args - Arguments to send
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  send(handle: ViewHandle, channel: string, ...args: unknown[]): void;

  // Internal access
  /**
   * Get the WebContents for a view.
   *
   * @internal This is exposed for ShortcutController integration only.
   * Prefer using ViewLayer methods for normal operations.
   *
   * TODO(SHORTCUT_CONTROLLER_ABSTRACTION): This method exposes raw WebContents because
   * ShortcutController requires direct access to register keyboard handlers on webContents.
   * Once ShortcutController is abstracted behind a layer interface that handles keyboard
   * registration through ViewLayer methods, this method can be removed.
   * See planning/SHORTCUT_CONTROLLER_ABSTRACTION.md (to be created).
   *
   * @param handle - Handle to the view
   * @returns The WebContents or null if view is destroyed
   */
  getWebContents(handle: ViewHandle): Electron.WebContents | null;

  // Cleanup
  /**
   * Dispose of all resources.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { WebContentsView } from "electron";

interface ViewState {
  view: WebContentsView;
  attachedToWindow: WindowHandle | null;
  options: ViewOptions;
}

/**
 * Default implementation of ViewLayer using Electron's WebContentsView.
 */
export class DefaultViewLayer implements ViewLayer {
  private readonly views = new Map<string, ViewState>();
  private nextId = 1;

  constructor(
    private readonly windowLayer: WindowLayer,
    private readonly logger: Logger
  ) {}

  createView(options: ViewOptions): ViewHandle {
    const id = `view-${this.nextId++}`;

    // Build webPreferences, only including defined properties
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: options.webPreferences?.nodeIntegration ?? false,
      contextIsolation: options.webPreferences?.contextIsolation ?? true,
      sandbox: options.webPreferences?.sandbox ?? true,
    };
    if (options.webPreferences?.partition !== undefined) {
      webPreferences.partition = options.webPreferences.partition;
    }
    if (options.webPreferences?.preload !== undefined) {
      webPreferences.preload = options.webPreferences.preload;
    }
    if (options.webPreferences?.webviewTag !== undefined) {
      webPreferences.webviewTag = options.webPreferences.webviewTag;
    }

    const view = new WebContentsView({ webPreferences });

    if (options.backgroundColor) {
      view.setBackgroundColor(options.backgroundColor);
    }

    this.views.set(id, {
      view,
      attachedToWindow: null,
      options,
    });

    const handle = createViewHandle(id);
    this.logger.debug("View created", {
      id,
      handleId: handle.id,
      viewsCount: this.views.size,
      isDestroyed: view.webContents.isDestroyed(),
    });
    return handle;
  }

  destroy(handle: ViewHandle): void {
    const state = this.getView(handle);

    // Detach from window if attached
    if (state.attachedToWindow) {
      this.detachFromWindow(handle);
    }

    this.views.delete(handle.id);

    if (!state.view.webContents.isDestroyed()) {
      state.view.webContents.close();
    }

    this.logger.debug("View destroyed", { id: handle.id });
  }

  destroyAll(): void {
    for (const [id] of this.views) {
      this.destroy(createViewHandle(id));
    }
  }

  async loadURL(handle: ViewHandle, url: string): Promise<void> {
    const state = this.getView(handle);
    try {
      await state.view.webContents.loadURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ShellError("NAVIGATION_FAILED", `Failed to load URL: ${message}`, handle.id);
    }
  }

  getURL(handle: ViewHandle): string {
    const state = this.getView(handle);
    return state.view.webContents.getURL();
  }

  setBounds(handle: ViewHandle, bounds: Rectangle): void {
    const state = this.getView(handle);
    state.view.setBounds(bounds);
  }

  getBounds(handle: ViewHandle): Rectangle {
    const state = this.getView(handle);
    return state.view.getBounds();
  }

  setBackgroundColor(handle: ViewHandle, color: string): void {
    const state = this.getView(handle);
    state.view.setBackgroundColor(color);
  }

  focus(handle: ViewHandle): void {
    const state = this.getView(handle);
    state.view.webContents.focus();
  }

  attachToWindow(handle: ViewHandle, windowHandle: WindowHandle, index?: number): void {
    const state = this.getView(handle);

    // Get the content view from the window layer
    const contentView = this.windowLayer.getContentView(windowHandle);
    const children = contentView.children;
    const currentIndex = children.indexOf(state.view);
    const isAttached = currentIndex !== -1;

    this.logger.debug("attachToWindow called", {
      viewId: handle.id,
      windowId: windowHandle.id,
      requestedIndex: index ?? "top",
      currentIndex,
      isAttached,
      childCount: children.length,
    });

    // Check if already at the correct position (no-op to preserve focus)
    if (isAttached) {
      // For "top" position (no index), check if already at end
      if (index === undefined && currentIndex === children.length - 1) {
        this.logger.debug("View already at top, skipping attach", { viewId: handle.id });
        return; // Already at top
      }
      // For explicit index, check if already there
      if (index !== undefined && currentIndex === index) {
        this.logger.debug("View already at correct index, skipping attach", {
          viewId: handle.id,
          index,
        });
        return; // Already at correct index
      }
      // Need to move - remove first
      this.logger.debug("View needs to move, removing first", {
        viewId: handle.id,
        fromIndex: currentIndex,
        toIndex: index ?? "top",
      });
      contentView.removeChildView(state.view);
    }

    // Add at specified index or append to top
    if (index !== undefined) {
      contentView.addChildView(state.view, index);
    } else {
      contentView.addChildView(state.view);
    }

    // Track attachment in both view state and window layer
    state.attachedToWindow = windowHandle;
    this.windowLayer.trackAttachedView(windowHandle, handle);

    this.logger.debug("View attached to window", {
      viewId: handle.id,
      windowId: windowHandle.id,
      index: index ?? "top",
      newChildCount: contentView.children.length,
    });
  }

  detachFromWindow(handle: ViewHandle): void {
    const state = this.getView(handle);

    // If not attached, no-op
    if (!state.attachedToWindow) {
      return;
    }

    const windowHandle = state.attachedToWindow;

    try {
      const contentView = this.windowLayer.getContentView(windowHandle);
      contentView.removeChildView(state.view);
    } catch {
      // Window may have been destroyed - ignore
    }

    // Untrack from window layer
    try {
      this.windowLayer.untrackAttachedView(windowHandle, handle);
    } catch {
      // Window may not exist anymore - ignore
    }

    state.attachedToWindow = null;

    this.logger.debug("View detached from window", {
      viewId: handle.id,
      windowId: windowHandle.id,
    });
  }

  onDidFinishLoad(handle: ViewHandle, callback: () => void): Unsubscribe {
    const state = this.getView(handle);
    state.view.webContents.on("did-finish-load", callback);
    return () => {
      if (!state.view.webContents.isDestroyed()) {
        state.view.webContents.off("did-finish-load", callback);
      }
    };
  }

  onWillNavigate(handle: ViewHandle, callback: (url: string) => boolean): Unsubscribe {
    const state = this.getView(handle);
    const handler = (event: Electron.Event, url: string) => {
      const allow = callback(url);
      if (!allow) {
        event.preventDefault();
      }
    };
    state.view.webContents.on("will-navigate", handler);
    return () => {
      if (!state.view.webContents.isDestroyed()) {
        state.view.webContents.off("will-navigate", handler);
      }
    };
  }

  setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void {
    const state = this.getView(handle);

    if (handler === null) {
      state.view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    } else {
      state.view.webContents.setWindowOpenHandler((details) => {
        return handler({
          url: details.url,
          frameName: details.frameName,
          disposition: details.disposition as WindowOpenDetails["disposition"],
        });
      });
    }
  }

  send(handle: ViewHandle, channel: string, ...args: unknown[]): void {
    const state = this.getView(handle);
    if (!state.view.webContents.isDestroyed()) {
      state.view.webContents.send(channel, ...args);
    }
  }

  getWebContents(handle: ViewHandle): Electron.WebContents | null {
    this.logger.debug("getWebContents called", {
      viewId: handle.id,
      viewsCount: this.views.size,
      hasView: this.views.has(handle.id),
    });
    try {
      const state = this.getView(handle);
      if (state.view.webContents.isDestroyed()) {
        this.logger.warn("webContents already destroyed", { viewId: handle.id });
        return null;
      }
      return state.view.webContents;
    } catch (error) {
      // Log errors to help diagnose registration failures
      this.logger.warn("Failed to get webContents", {
        viewId: handle.id,
        error: error instanceof Error ? error.message : String(error),
        knownViews: Array.from(this.views.keys()).join(", "),
      });
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.destroyAll();
  }

  private getView(handle: ViewHandle): ViewState {
    const state = this.views.get(handle.id);
    if (!state) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    if (state.view.webContents.isDestroyed()) {
      this.views.delete(handle.id);
      throw new ShellError("VIEW_DESTROYED", `View ${handle.id} was destroyed`, handle.id);
    }
    return state;
  }
}
