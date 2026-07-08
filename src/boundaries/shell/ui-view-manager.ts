/**
 * UiViewManager — owns the application's single WebContentsView (the Svelte
 * UI). Workspace surfaces are iframes inside this view's DOM, managed by the
 * renderer; this class only provides what must live in the main process:
 *
 * - UI view lifecycle (create, load, bounds-on-resize, destroy)
 * - The shared session's header/permission handlers (x-frame-options and CSP
 *   stripping so the IDE server loads inside iframes)
 * - window.open interception → system browser
 * - Child-frame focus tracker injection (cross-origin iframes can't be
 *   scripted from the host document)
 * - Keyboard + devtools capability targets (webContents-level, so they cover
 *   input typed inside workspace iframes)
 * - Mode state (pure bookkeeping — the keyboard interceptor consumes it
 *   synchronously in main; the renderer mirrors it over IPC)
 * - Active-workspace screenshot capture (full-view capture clipped to the
 *   active iframe's rect)
 */

import type { Logger } from "../platform/logging";
import { getErrorMessage } from "../../shared/error-utils";
import type { AppBoundary } from "./app";
import type { SessionBoundary } from "./session";
import type { ViewBoundary, WindowOpenDetails } from "./view";
import type { ViewHandle } from "./types";
import type { WindowBoundary } from "./window";
import type { WindowManager } from "./window-manager";
import type { IViewManager, Unsubscribe } from "./view-manager.interface";
import { type DevtoolsTarget, type KeyboardTarget } from "./view-manager-types";

/**
 * Session partition shared by the UI page and the workspace iframes inside it.
 * The window's webContents is created with this partition (see WindowManager),
 * and UiViewManager installs the header/permission handlers on the same
 * partition's session.
 */
export const GLOBAL_SESSION_PARTITION = "persist:codehydra-global";

/**
 * Script injected into every workspace iframe to preserve focus across
 * show/hide cycles. Records the last-focused element via `focusin` and
 * re-focuses it whenever the iframe's window receives focus (which the
 * renderer triggers via `iframe.contentWindow.focus()` when showing).
 *
 * Runs inside the iframe's same-origin page context — bypasses cross-origin
 * focus restrictions that would block any host-side equivalent.
 */
const CHILD_FRAME_FOCUS_TRACKER = `
  (function(){
    if (window.__chFocusTracker) return;
    window.__chFocusTracker = true;
    let last = null;
    document.addEventListener('focusin', function(e){ last = e.target; }, true);
    window.addEventListener('focus', function(){
      if (last && document.contains(last)) {
        try { last.focus(); } catch(e) {}
      }
    });
  })();
`;

/**
 * Renderer hooks installed by the WorkspaceFrames component on `window`.
 * Used for main-initiated focus routing and screenshot rect lookup.
 */
const FOCUS_ACTIVE_FRAME = `window.__chFocusActiveFrame && window.__chFocusActiveFrame()`;
const ACTIVE_FRAME_RECT = `window.__chActiveFrameRect ? window.__chActiveFrameRect() : null`;
const RELOAD_FRAMES = `window.__chReloadFrames && window.__chReloadFrames()`;

// Resolves after two animation frames — one committed paint of the current UI
// state. executeJavaScript awaits the returned promise, giving main a paint
// barrier to sequence a screenshot after a state-driven layout change (e.g.
// the sidebar collapsing out of a hibernation capture) has actually rendered.
const UI_PAINT_BARRIER = `new Promise(function (resolve) {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { resolve(true); });
  });
})`;

const ALLOWED_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "clipboard-write",
  "media",
  "fullscreen",
  "notifications",
  "openExternal",
  "fileSystem",
  "hid",
  "serial",
  "usb",
]);

export interface UiViewManagerDeps {
  readonly windowManager: WindowManager;
  readonly windowLayer: WindowBoundary;
  readonly viewLayer: ViewBoundary;
  readonly sessionLayer: SessionBoundary;
  readonly appLayer: Pick<AppBoundary, "openUrl">;
  readonly logger: Logger;
}

export class UiViewManager implements IViewManager {
  private readonly windowManager: WindowManager;
  private readonly windowLayer: WindowBoundary;
  private readonly viewLayer: ViewBoundary;
  private readonly sessionLayer: SessionBoundary;
  private readonly appLayer: Pick<AppBoundary, "openUrl">;
  private readonly logger: Logger;

  private uiViewHandle: ViewHandle | null = null;
  private destroying = false;

  // Inbound IPC (renderer → main) from the UI view. Subscribers register via
  // onFromUI before the view exists; the actual webContents.ipc listener is
  // wired per channel at createView and re-wired on recreate.
  private readonly uiListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly uiIpcUnsubs = new Map<string, Unsubscribe>();

  constructor(deps: UiViewManagerDeps) {
    this.windowManager = deps.windowManager;
    this.windowLayer = deps.windowLayer;
    this.viewLayer = deps.viewLayer;
    this.sessionLayer = deps.sessionLayer;
    this.appLayer = deps.appLayer;
    this.logger = deps.logger;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  create(): void {
    if (this.uiViewHandle) return; // idempotent

    // The UI view shares the global session partition with the workspace
    // iframes inside it (iframes inherit the embedding page's session).
    // This keeps the IDE server's existing storage (settings, layout) intact
    // and makes the header/permission handlers below apply to iframe loads.
    const sessionHandle = this.sessionLayer.fromPartition(GLOBAL_SESSION_PARTITION);

    // Strip frame-blocking headers so the IDE server loads inside iframes.
    this.sessionLayer.setHeadersReceivedHandler(sessionHandle, (headers) => {
      const modified = { ...headers };
      for (const header of Object.keys(modified)) {
        const lower = header.toLowerCase();
        if (
          lower === "x-frame-options" ||
          lower === "content-security-policy" ||
          lower === "content-security-policy-report-only"
        ) {
          delete modified[header];
        }
      }
      return modified;
    });

    this.sessionLayer.setPermissionRequestHandler(sessionHandle, (permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    );
    this.sessionLayer.setPermissionCheckHandler(sessionHandle, (permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    );

    // Adopt the window's own webContents rather than creating a child view.
    // The window is a BrowserWindow whose page (loaded with the UI preload +
    // the shared partition) auto-fills the window — the compositor sizes it, so
    // there is no manual bounds management and no transparent-compositing or
    // stale-getContentBounds hazard (the Wayland fractional-scaling maximize
    // bug can't manifest because we never read window bounds to size anything).
    const windowHandle = this.windowManager.getWindowHandle();
    const uiViewHandle = this.viewLayer.adoptWindowWebContents(windowHandle);

    // window.open from the UI or any workspace iframe opens externally.
    this.viewLayer.setWindowOpenHandler(uiViewHandle, (details: WindowOpenDetails) => {
      this.appLayer.openUrl(details.url).catch((error: unknown) => {
        this.logger.warn("Failed to open external URL", {
          url: details.url,
          error: getErrorMessage(error),
        });
      });
      return { action: "deny" };
    });

    this.viewLayer.installChildFrameScript(uiViewHandle, CHILD_FRAME_FOCUS_TRACKER);

    this.uiViewHandle = uiViewHandle;
    // (Re)wire any onFromUI subscriptions onto the new view's webContents.
    for (const channel of this.uiListeners.keys()) {
      this.wireChannel(channel);
    }
  }

  destroy(): void {
    this.destroying = true;
    if (this.uiViewHandle) {
      try {
        this.viewLayer.destroy(this.uiViewHandle);
      } catch {
        // Ignore errors during cleanup
      }
      this.uiViewHandle = null;
    }
    // The webContents (and its ipc listeners) are gone; drop the stale wirings
    // so a subsequent createView re-wires from uiListeners. Subscriptions
    // themselves (uiListeners) survive a recreate.
    this.uiIpcUnsubs.clear();
  }

  // ---------------------------------------------------------------------------
  // UI view access
  // ---------------------------------------------------------------------------

  getUIViewHandle(): ViewHandle {
    return this.requireHandle();
  }

  getUIDevtoolsTarget(): DevtoolsTarget {
    const handle = this.requireHandle();
    const viewLayer = this.viewLayer;
    return {
      id: handle.id,
      toggle: () => {
        if (viewLayer.isDevToolsOpened(handle)) {
          viewLayer.closeDevTools(handle);
        } else {
          viewLayer.openDevTools(handle, { mode: "detach" });
        }
      },
      isOpen: () => viewLayer.isDevToolsOpened(handle),
    };
  }

  getUIKeyboardTarget(): KeyboardTarget {
    const handle = this.requireHandle();
    const viewLayer = this.viewLayer;
    return {
      id: handle.id,
      onBeforeInput: (callback) => viewLayer.onBeforeInputEvent(handle, callback),
      onDestroyed: (callback) => viewLayer.onDestroyed(handle, callback),
    };
  }

  isUIAvailable(): boolean {
    return this.uiViewHandle !== null && this.viewLayer.isAvailable(this.uiViewHandle);
  }

  loadUIContent(htmlPath: string): Promise<void> {
    return this.viewLayer.loadURL(this.requireHandle(), htmlPath);
  }

  sendToUI(channel: string, ...args: unknown[]): void {
    if (!this.uiViewHandle) return; // pre-create sends are dropped silently
    try {
      this.viewLayer.send(this.uiViewHandle, channel, ...args);
    } catch {
      // Ignore errors - view may be destroyed
    }
  }

  onFromUI(channel: string, listener: (...args: unknown[]) => void): Unsubscribe {
    let listeners = this.uiListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.uiListeners.set(channel, listeners);
    }
    listeners.add(listener);
    this.wireChannel(channel); // no-op if the view isn't up yet or already wired
    return () => {
      const set = this.uiListeners.get(channel);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.uiListeners.delete(channel);
        const unsub = this.uiIpcUnsubs.get(channel);
        if (unsub) {
          unsub();
          this.uiIpcUnsubs.delete(channel);
        }
      }
    };
  }

  /** Wire one webContents.ipc listener for `channel` that fans out to its subscribers. */
  private wireChannel(channel: string): void {
    if (!this.uiViewHandle || this.uiIpcUnsubs.has(channel)) return;
    const unsub = this.viewLayer.onIpc(this.uiViewHandle, channel, (...args: unknown[]) => {
      const listeners = this.uiListeners.get(channel);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        listener(...args);
      }
    });
    this.uiIpcUnsubs.set(channel, unsub);
  }

  // ---------------------------------------------------------------------------
  // Focus
  // ---------------------------------------------------------------------------

  focus(): void {
    if (this.destroying || !this.uiViewHandle || !this.isWindowAlive()) return;

    // Mode is main-owned (the presenter) and no longer mirrored here. The only
    // callers focus in a workspace context (app start, post-terminal focus):
    // focus the UI webContents, then ask the renderer to focus the active
    // workspace iframe. The renderer owns the dialog/hover/shortcut focus traps.
    this.logger.debug("focus", { target: "workspace" });
    this.viewLayer.focus(this.uiViewHandle);
    // Best-effort: before the WorkspaceFrames component mounts the hook is undefined.
    this.viewLayer.executeJavaScript(this.uiViewHandle, FOCUS_ACTIVE_FRAME).catch(() => {
      // UI may be mid-load
    });
  }

  reloadFrames(): void {
    if (!this.uiViewHandle || !this.isUIAvailable()) return;
    // Best-effort fire-and-forget: before WorkspaceFrames mounts the hook is
    // undefined, and a mid-load UI rejects executeJavaScript.
    this.viewLayer.executeJavaScript(this.uiViewHandle, RELOAD_FRAMES).catch(() => {
      // UI may be mid-load
    });
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------

  async waitForUIPaint(): Promise<void> {
    if (!this.uiViewHandle || !this.isUIAvailable()) return;
    try {
      await this.viewLayer.executeJavaScript(this.uiViewHandle, UI_PAINT_BARRIER);
    } catch {
      // UI may be mid-load; best-effort — a missed paint barrier at worst
      // captures the pre-collapse frame, never fails the hibernation.
    }
  }

  async captureActiveWorkspaceView(): Promise<Buffer | null> {
    if (!this.uiViewHandle || !this.isUIAvailable()) return null;
    try {
      const rect = (await this.viewLayer.executeJavaScript(
        this.uiViewHandle,
        ACTIVE_FRAME_RECT
      )) as { x: number; y: number; width: number; height: number } | null;
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return await this.viewLayer.capturePNG(this.uiViewHandle, rect);
    } catch (error) {
      this.logger.debug("captureActiveWorkspaceView failed", {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireHandle(): ViewHandle {
    if (!this.uiViewHandle) {
      throw new Error("UiViewManager.create() has not been called yet");
    }
    return this.uiViewHandle;
  }

  private isWindowAlive(): boolean {
    try {
      return !this.windowLayer.isDestroyed(this.windowManager.getWindowHandle());
    } catch {
      return false;
    }
  }
}
