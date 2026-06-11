/**
 * UiViewManager — owns the application's single WebContentsView (the Svelte
 * UI). Workspace surfaces are iframes inside this view's DOM, managed by the
 * renderer; this class only provides what must live in the main process:
 *
 * - UI view lifecycle (create, load, bounds-on-resize, destroy)
 * - The shared session's header/permission handlers (x-frame-options and CSP
 *   stripping so code-server loads inside iframes)
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
import type { UIMode } from "../../shared/ipc";
import { getErrorMessage } from "../../shared/error-utils";
import type { AppBoundary } from "./app";
import type { SessionBoundary } from "./session";
import type { ViewBoundary, WindowOpenDetails } from "./view";
import type { ViewHandle } from "./types";
import type { WindowBoundary } from "./window";
import type { WindowManager } from "./window-manager";
import type { IViewManager, Unsubscribe } from "./view-manager.interface";
import { computeUIRect, type DevtoolsTarget, type KeyboardTarget } from "./view-manager-types";

const GLOBAL_SESSION_PARTITION = "persist:codehydra-global";

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

export interface UiViewManagerConfig {
  /** Path to the UI layer preload script */
  readonly uiPreloadPath: string;
}

export interface UiViewManagerDeps {
  readonly windowManager: WindowManager;
  readonly windowLayer: WindowBoundary;
  readonly viewLayer: ViewBoundary;
  readonly sessionLayer: SessionBoundary;
  readonly appLayer: Pick<AppBoundary, "openUrl">;
  readonly config: UiViewManagerConfig;
  readonly logger: Logger;
}

export class UiViewManager implements IViewManager {
  private readonly windowManager: WindowManager;
  private readonly windowLayer: WindowBoundary;
  private readonly viewLayer: ViewBoundary;
  private readonly sessionLayer: SessionBoundary;
  private readonly appLayer: Pick<AppBoundary, "openUrl">;
  private readonly config: UiViewManagerConfig;
  private readonly logger: Logger;

  private uiViewHandle: ViewHandle | null = null;
  private mode: UIMode = "workspace";
  private destroying = false;
  private unsubscribeResize: Unsubscribe | null = null;

  constructor(deps: UiViewManagerDeps) {
    this.windowManager = deps.windowManager;
    this.windowLayer = deps.windowLayer;
    this.viewLayer = deps.viewLayer;
    this.sessionLayer = deps.sessionLayer;
    this.appLayer = deps.appLayer;
    this.config = deps.config;
    this.logger = deps.logger;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  create(): void {
    if (this.uiViewHandle) return; // idempotent

    // The UI view shares the global session partition with the workspace
    // iframes inside it (iframes inherit the embedding page's session).
    // This keeps code-server's existing storage (settings, layout) intact
    // and makes the header/permission handlers below apply to iframe loads.
    const sessionHandle = this.sessionLayer.fromPartition(GLOBAL_SESSION_PARTITION);

    // Strip frame-blocking headers so code-server loads inside iframes.
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

    const uiViewHandle = this.viewLayer.createView({
      label: "ui",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: this.config.uiPreloadPath,
        partition: GLOBAL_SESSION_PARTITION,
      },
    });

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

    this.viewLayer.setBackgroundColor(uiViewHandle, "#00000000");
    this.viewLayer.installChildFrameScript(uiViewHandle, CHILD_FRAME_FOCUS_TRACKER);

    const windowHandle = this.windowManager.getWindowHandle();
    this.viewLayer.attachToWindow(uiViewHandle, windowHandle);
    this.viewLayer.setBounds(uiViewHandle, computeUIRect(this.windowManager.getBounds()));

    this.unsubscribeResize = this.windowManager.onResize(() => {
      if (!this.uiViewHandle || !this.isWindowAlive()) return;
      this.viewLayer.setBounds(this.uiViewHandle, computeUIRect(this.windowManager.getBounds()));
    });

    this.uiViewHandle = uiViewHandle;
  }

  destroy(): void {
    this.destroying = true;
    if (this.unsubscribeResize) {
      this.unsubscribeResize();
      this.unsubscribeResize = null;
    }
    if (this.uiViewHandle) {
      try {
        this.viewLayer.destroy(this.uiViewHandle);
      } catch {
        // Ignore errors during cleanup
      }
      this.uiViewHandle = null;
    }
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

  // ---------------------------------------------------------------------------
  // Focus
  // ---------------------------------------------------------------------------

  focus(): void {
    if (this.destroying || !this.uiViewHandle || !this.isWindowAlive()) return;

    switch (this.mode) {
      case "dialog":
      case "hover":
        // These modes manage their own focus via traps/handlers
        break;
      case "shortcut":
        this.logger.debug("focus", { target: "ui", mode: this.mode });
        this.viewLayer.focus(this.uiViewHandle);
        break;
      case "workspace":
        this.logger.debug("focus", { target: "workspace", mode: this.mode });
        this.viewLayer.focus(this.uiViewHandle);
        // Ask the renderer to focus the active workspace iframe. Best-effort:
        // before the WorkspaceFrames component mounts the hook is undefined.
        this.viewLayer.executeJavaScript(this.uiViewHandle, FOCUS_ACTIVE_FRAME).catch(() => {
          // UI may be mid-load
        });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------------

  setMode(newMode: UIMode): void {
    const previousMode = this.mode;
    if (newMode === previousMode) return;
    this.mode = newMode;
    this.logger.debug("Mode changed", { mode: newMode, previous: previousMode });
  }

  getMode(): UIMode {
    return this.mode;
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------

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
