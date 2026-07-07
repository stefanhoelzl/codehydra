/**
 * ViewBoundary - Abstraction over Electron's WebContentsView.
 *
 * Provides an injectable interface for view management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real WebContentsView
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { ViewHandle, Rectangle, WindowHandle } from "./types";
import { createViewHandle } from "./types";
import { guardedUnsubscribe } from "./subscription";
import { ShellError } from "../../shared/errors/shell-errors";
import type { Logger } from "../platform/logging";
import type { WindowBoundary } from "./window";

// ============================================================================
// Types
// ============================================================================

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

/**
 * Details about a render-process-gone event.
 */
export interface RenderProcessGoneDetails {
  /** Reason as reported by Electron (e.g. "crashed", "killed", "oom"). */
  readonly reason: string;
  /** Process exit code, if known. */
  readonly exitCode: number;
}

/**
 * Details about an uncaught JavaScript exception in a view's page.
 */
export interface UncaughtExceptionDetails {
  /** Human-readable message (e.g. "Error: boom"). */
  readonly message: string;
  /** Stack trace in V8 `error.stack` format; empty string when unavailable. */
  readonly stack: string;
  /** True when the exception came from an unhandled promise rejection. */
  readonly isPromiseRejection: boolean;
}

/**
 * Keyboard input descriptor (no Electron types).
 */
export interface KeyboardInput {
  readonly type: "keyDown" | "keyUp";
  readonly key: string;
  readonly isAutoRepeat: boolean;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

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
export interface ViewBoundary {
  // Lifecycle
  /**
   * Adopt a window's own webContents as a view handle, so the UI's webContents
   * concerns (load, IPC, keyboard, devtools, capture, exceptions) route through
   * this abstraction without owning a child WebContentsView. The window's page
   * auto-fills the window, so there is nothing to size or attach.
   *
   * The returned handle does not own the webContents: destroy() unregisters it
   * but does not close it (the window owns its lifecycle).
   *
   * @param windowHandle - Handle to the BrowserWindow whose webContents to adopt
   * @returns Handle addressing the window's webContents
   */
  adoptWindowWebContents(windowHandle: WindowHandle): ViewHandle;

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
   */
  loadURL(handle: ViewHandle, url: string): Promise<void>;

  // Focus
  /**
   * Focus the view.
   *
   * @param handle - Handle to the view
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  focus(handle: ViewHandle): void;

  // Events
  /**
   * Set a handler for window.open() requests.
   *
   * @param handle - Handle to the view
   * @param handler - Handler function, or null to use default behavior
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void;

  // Execution
  /**
   * Execute JavaScript in the view's renderer process.
   *
   * @param handle - Handle to the view
   * @param code - JavaScript code to execute
   * @returns Promise resolving with the result of the executed code
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  executeJavaScript(handle: ViewHandle, code: string): Promise<unknown>;

  /**
   * Capture a PNG screenshot of the view's current visual content.
   *
   * Best-effort: returns null if the view has no rendered content, is detached,
   * or capture fails for any reason. Does not throw.
   *
   * @param handle - Handle to the view
   * @param rect - Optional region (view-local CSS pixels) to clip the capture to
   * @returns PNG-encoded bytes, or null on failure / no content
   */
  capturePNG(handle: ViewHandle, rect?: Rectangle): Promise<Buffer | null>;

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

  /**
   * Subscribe to fire-and-forget IPC messages sent from the view's renderer
   * (via `ipcRenderer.send`), scoped to this view's webContents. The Electron
   * event is swallowed; the listener receives only the message arguments.
   *
   * @param handle - Handle to the view
   * @param channel - IPC channel name
   * @param listener - Called with the message arguments on each send
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onIpc(handle: ViewHandle, channel: string, listener: (...args: unknown[]) => void): Unsubscribe;

  // Events (continued)
  /**
   * Subscribe to before-input-event for keyboard interception.
   *
   * @param handle - Handle to the view
   * @param callback - Called with keyboard input and a preventDefault function
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onBeforeInputEvent(
    handle: ViewHandle,
    callback: (input: KeyboardInput, preventDefault: () => void) => void
  ): Unsubscribe;

  /**
   * Subscribe to view destruction.
   *
   * @param handle - Handle to the view
   * @param callback - Called when the view is destroyed
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe;

  /**
   * Subscribe to render-process-gone events (renderer crash / killed / OOM).
   *
   * @param handle - Handle to the view
   * @param callback - Called with the reason and exit code
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onRenderProcessGone(
    handle: ViewHandle,
    callback: (details: RenderProcessGoneDetails) => void
  ): Unsubscribe;

  /**
   * Subscribe to uncaught JavaScript exceptions (and unhandled promise
   * rejections) thrown inside the view's page.
   *
   * Implemented via the Chrome DevTools Protocol (webContents.debugger +
   * Runtime.exceptionThrown), so it needs no code inside the page and fires
   * even for errors thrown before the page's own handlers could register.
   *
   * Known limitation: opening DevTools for the view takes over the CDP
   * session and detaches the debugger — exceptions thrown while DevTools is
   * open are not delivered. The subscription re-attaches when DevTools closes.
   *
   * @param handle - Handle to the view
   * @param callback - Called with exception details
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onUncaughtException(
    handle: ViewHandle,
    callback: (details: UncaughtExceptionDetails) => void
  ): Unsubscribe;

  /**
   * Subscribe to renderer unresponsive events (event loop hang).
   *
   * @param handle - Handle to the view
   * @param callback - Called when the renderer stops responding
   * @returns Unsubscribe function
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  onUnresponsive(handle: ViewHandle, callback: () => void): Unsubscribe;

  /**
   * Check if a view handle refers to a valid, non-destroyed view.
   *
   * @param handle - Handle to the view
   * @returns True if the view exists and is not destroyed
   */
  isAvailable(handle: ViewHandle): boolean;

  // DevTools
  /**
   * Open DevTools for a view.
   *
   * @param handle - Handle to the view
   * @param options - DevTools options
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  openDevTools(handle: ViewHandle, options?: { mode?: string }): void;

  /**
   * Close DevTools for a view.
   *
   * @param handle - Handle to the view
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  closeDevTools(handle: ViewHandle): void;

  /**
   * Check if DevTools are open for a view.
   *
   * @param handle - Handle to the view
   * @returns True if DevTools are open
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  isDevToolsOpened(handle: ViewHandle): boolean;

  /**
   * Install a script in every child frame (non-top) that finishes loading
   * inside this view. The script runs same-origin inside each child frame.
   *
   * Used to inject in-frame helpers that can't be installed from the host
   * document due to cross-origin restrictions (e.g., focus trackers that
   * need to observe and call focus on elements inside the iframe).
   *
   * The subscription is established immediately and applies to every future
   * frame load — call once during view setup.
   *
   * @param handle - Handle to the host view
   * @param script - JavaScript source to execute in each child frame
   * @throws ShellError with code VIEW_NOT_FOUND if handle is invalid
   */
  installChildFrameScript(handle: ViewHandle, script: string): void;

  // Cleanup
  /**
   * Dispose of all resources.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Default Implementation
// ============================================================================

import type { WebContents } from "electron";

interface ViewState {
  webContents: WebContents;
  label: string;
}

/** Minimal slice of CDP's Runtime.exceptionThrown payload. */
interface CdpExceptionDetails {
  readonly text?: string;
  readonly exception?: { readonly description?: string; readonly value?: unknown };
  readonly stackTrace?: {
    readonly callFrames?: readonly {
      readonly functionName: string;
      readonly url: string;
      readonly lineNumber: number;
      readonly columnNumber: number;
    }[];
  };
}

/**
 * Map a CDP exceptionDetails payload to UncaughtExceptionDetails.
 *
 * For thrown Error objects, `exception.description` is already in V8
 * `error.stack` format (message line + frames). For non-Error throws the
 * frames are synthesized from `stackTrace`.
 */
function toUncaughtExceptionDetails(
  cdp: CdpExceptionDetails | undefined
): UncaughtExceptionDetails {
  const text = cdp?.text ?? "Uncaught";
  const isPromiseRejection = text.includes("(in promise)");
  const description = cdp?.exception?.description ?? "";
  const firstLine = description.split("\n", 1)[0] ?? "";
  const thrownValue = cdp?.exception?.value;
  const message =
    firstLine !== ""
      ? firstLine
      : thrownValue !== undefined
        ? `${text} ${String(thrownValue)}`
        : text;
  const stack = description.includes("\n")
    ? description
    : (cdp?.stackTrace?.callFrames ?? [])
        .map(
          (f) =>
            `    at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`
        )
        .join("\n");
  return { message, stack, isPromiseRejection };
}

/**
 * Default implementation of ViewBoundary using Electron's WebContentsView.
 */
export class DefaultViewBoundary implements ViewBoundary {
  private readonly views = new Map<string, ViewState>();
  private readonly exceptionCallbacks = new Map<
    string,
    Set<(details: UncaughtExceptionDetails) => void>
  >();
  private nextId = 1;

  constructor(
    private readonly windowLayer: WindowBoundary,
    private readonly logger: Logger
  ) {}

  adoptWindowWebContents(windowHandle: WindowHandle): ViewHandle {
    const id = `view-${this.nextId++}`;
    const webContents = this.windowLayer.getWebContents(windowHandle);
    const label = "ui";

    this.views.set(id, {
      webContents,
      label,
    });

    webContents.on("blur", () => {
      this.logger.debug(`blur ${label}`);
    });
    webContents.on("focus", () => {
      this.logger.debug(`focus ${label}`);
    });

    const handle = createViewHandle(id);
    this.logger.debug("Window webContents adopted as view", {
      id,
      windowId: windowHandle.id,
    });
    return handle;
  }

  destroy(handle: ViewHandle): void {
    // Validate the handle. An adopted window webContents is owned by the window
    // and closed with it, so destroy() only unregisters our tracking.
    this.getView(handle);

    this.views.delete(handle.id);
    this.exceptionCallbacks.delete(handle.id);

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
      await state.webContents.loadURL(url);
    } catch (error) {
      // Navigation failures are transient (network changes, sleep/resume, etc.)
      // and already handled by the did-fail-load event which triggers retry with backoff.
      // Swallow the rejection to prevent unhandled promise rejections in fire-and-forget callers.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug("Navigation failed (handled via did-fail-load)", {
        id: handle.id,
        url,
        error: message,
      });
    }
  }

  async capturePNG(handle: ViewHandle, rect?: Rectangle): Promise<Buffer | null> {
    try {
      const state = this.getView(handle);
      const wc = state.webContents;
      if (!wc || wc.isDestroyed()) return null;
      const image = await (rect
        ? wc.capturePage({
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          })
        : wc.capturePage());
      if (image.isEmpty()) return null;
      return image.toPNG();
    } catch (error) {
      this.logger.debug("capturePNG failed", {
        id: handle.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  focus(handle: ViewHandle): void {
    const state = this.getView(handle);
    state.webContents.focus();
  }

  setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void {
    const state = this.getView(handle);

    if (handler === null) {
      state.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    } else {
      state.webContents.setWindowOpenHandler((details) => {
        return handler({
          url: details.url,
          frameName: details.frameName,
          disposition: details.disposition as WindowOpenDetails["disposition"],
        });
      });
    }
  }

  executeJavaScript(handle: ViewHandle, code: string): Promise<unknown> {
    const state = this.getView(handle);
    // userGesture=true so scripted cross-origin iframe focus
    // (iframe.contentWindow.focus()) isn't silently blocked by Chromium.
    return state.webContents.executeJavaScript(code, true);
  }

  send(handle: ViewHandle, channel: string, ...args: unknown[]): void {
    const state = this.getView(handle);
    const wc = state.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, ...args);
    }
  }

  onIpc(handle: ViewHandle, channel: string, listener: (...args: unknown[]) => void): Unsubscribe {
    const state = this.getView(handle);
    const handler = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
      listener(...args);
    };
    state.webContents.ipc.on(channel, handler);
    return guardedUnsubscribe(state.webContents, () =>
      state.webContents.ipc.removeListener(channel, handler)
    );
  }

  onBeforeInputEvent(
    handle: ViewHandle,
    callback: (input: KeyboardInput, preventDefault: () => void) => void
  ): Unsubscribe {
    const state = this.getView(handle);
    const handler = (event: Electron.Event, electronInput: Electron.Input) => {
      const input: KeyboardInput = {
        type: electronInput.type as "keyDown" | "keyUp",
        key: electronInput.key,
        isAutoRepeat: electronInput.isAutoRepeat,
        control: electronInput.control,
        shift: electronInput.shift,
        alt: electronInput.alt,
        meta: electronInput.meta,
      };
      callback(input, () => event.preventDefault());
    };
    state.webContents.on("before-input-event", handler);
    return guardedUnsubscribe(state.webContents, () =>
      state.webContents.off("before-input-event", handler)
    );
  }

  onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe {
    const state = this.getView(handle);
    state.webContents.on("destroyed", callback);
    return guardedUnsubscribe(state.webContents, () =>
      state.webContents.off("destroyed", callback)
    );
  }

  onRenderProcessGone(
    handle: ViewHandle,
    callback: (details: RenderProcessGoneDetails) => void
  ): Unsubscribe {
    const state = this.getView(handle);
    const handler = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      callback({ reason: details.reason, exitCode: details.exitCode });
    };
    state.webContents.on("render-process-gone", handler);
    return guardedUnsubscribe(state.webContents, () =>
      state.webContents.off("render-process-gone", handler)
    );
  }

  onUncaughtException(
    handle: ViewHandle,
    callback: (details: UncaughtExceptionDetails) => void
  ): Unsubscribe {
    const state = this.getView(handle);
    let callbacks = this.exceptionCallbacks.get(handle.id);
    if (!callbacks) {
      callbacks = new Set();
      this.exceptionCallbacks.set(handle.id, callbacks);
      this.wireExceptionDebugger(handle.id, state);
    }
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  }

  /**
   * Attach the CDP debugger once per view and fan Runtime.exceptionThrown
   * events out to the registered callbacks.
   */
  private wireExceptionDebugger(id: string, state: ViewState): void {
    const wc = state.webContents;

    const attach = (): void => {
      if (wc.isDestroyed() || wc.debugger.isAttached()) return;
      try {
        wc.debugger.attach("1.3");
        void wc.debugger.sendCommand("Runtime.enable");
      } catch (error) {
        this.logger.warn("Failed to attach exception debugger", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    wc.debugger.on("message", (_event, method, params) => {
      if (method !== "Runtime.exceptionThrown") return;
      const cdp = (params as { exceptionDetails?: CdpExceptionDetails }).exceptionDetails;
      const details = toUncaughtExceptionDetails(cdp);
      for (const callback of this.exceptionCallbacks.get(id) ?? []) {
        callback(details);
      }
    });

    // Opening DevTools for this view takes over the CDP session and detaches
    // the debugger (exceptions thrown while DevTools is open are lost) —
    // re-attach once DevTools closes.
    wc.on("devtools-closed", attach);

    attach();
  }

  onUnresponsive(handle: ViewHandle, callback: () => void): Unsubscribe {
    const state = this.getView(handle);
    state.webContents.on("unresponsive", callback);
    return guardedUnsubscribe(state.webContents, () =>
      state.webContents.off("unresponsive", callback)
    );
  }

  isAvailable(handle: ViewHandle): boolean {
    const state = this.views.get(handle.id);
    if (!state) return false;
    const wc = state.webContents;
    return !!wc && !wc.isDestroyed();
  }

  openDevTools(handle: ViewHandle, options?: { mode?: string }): void {
    const state = this.getView(handle);
    state.webContents.openDevTools(options as Electron.OpenDevToolsOptions);
  }

  closeDevTools(handle: ViewHandle): void {
    const state = this.getView(handle);
    state.webContents.closeDevTools();
  }

  isDevToolsOpened(handle: ViewHandle): boolean {
    const state = this.getView(handle);
    return state.webContents.isDevToolsOpened();
  }

  async dispose(): Promise<void> {
    this.destroyAll();
  }

  installChildFrameScript(handle: ViewHandle, script: string): void {
    const state = this.getView(handle);
    const wc = state.webContents;
    wc.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return;
      const frame = wc.mainFrame.framesInSubtree.find(
        (f) => f.processId === frameProcessId && f.routingId === frameRoutingId
      );
      if (!frame) return;
      frame.executeJavaScript(script).catch(() => {
        // Frame may be gone before the script runs ("Script not run")
      });
    });
  }

  private getView(handle: ViewHandle): ViewState {
    const state = this.views.get(handle.id);
    if (!state) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    const wc = state.webContents;
    if (!wc || wc.isDestroyed()) {
      this.views.delete(handle.id);
      throw new ShellError("VIEW_DESTROYED", `View ${handle.id} was destroyed`, handle.id);
    }
    return state;
  }
}
