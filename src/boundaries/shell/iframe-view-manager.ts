/**
 * Iframe-based implementation of IViewManager.
 *
 * One shared host `WebContentsView` (`workspace-host.html`) holds one
 * `<iframe>` per workspace, keyed by workspace path. All workspaces share
 * a single renderer process — the main memory win over per-view rendering.
 *
 * Trade-offs vs `WebContentsViewManager`:
 *   - Per-iframe `did-fail-load` retry uses the host's webContents event
 *     (filtered to subframes, mapped back to a workspace by URL). There
 *     is no per-iframe `render-process-gone` — all iframes share the host
 *     renderer.
 *   - DevTools and keyboard input are routed to the host view; workspaces
 *     share both.
 *
 * Loading semantics mirror per-view backends: when the active workspace
 * is in the loading set, the host view is detached from the window so the
 * UI's loading overlay is visible. The iframe inside is still
 * `display: block` (set during `swapActiveSurface`) so workbench can lay
 * out while we wait — otherwise `terminal.focus` would land on an
 * unrendered terminal at agent-idle time.
 */

import { basename } from "node:path";
import type { AppBoundary } from "./app";
import type { Logger } from "../platform/logging";
import { getErrorMessage } from "../../shared/error-utils";
import type { FailLoadDetails, ViewBoundary, WindowOpenDetails } from "./view";
import type { SessionBoundary } from "./session";
import type { WindowBoundaryInternal } from "./window";
import type { SessionHandle, ViewHandle, WindowHandle } from "./types";
import { BaseViewManager, type CreatedWorkspaceView } from "./view-manager-base";
import {
  Z_UI_BOTTOM,
  computeWorkspaceRect,
  type DevtoolsTarget,
  type KeyboardTarget,
  type Rect,
  type WorkspaceState,
} from "./view-manager-types";
import type { WindowManager } from "./window-manager";

const GLOBAL_SESSION_PARTITION = "persist:codehydra-global";

/**
 * Script injected into every workspace iframe to preserve focus across
 * show/hide cycles. Records the last-focused element via `focusin` and
 * re-focuses it whenever the iframe's window receives focus (which the
 * host triggers via `iframe.contentWindow.focus()` when showing).
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

export interface IframeViewManagerConfig {
  /** Path to the UI layer preload script */
  readonly uiPreloadPath: string;
  /** Code-server port number */
  readonly codeServerPort: number;
  /** Path to the workspace host HTML page that holds per-workspace iframes */
  readonly workspaceHostHtmlPath: string;
}

export interface IframeViewManagerDeps {
  readonly windowManager: WindowManager;
  readonly windowLayer: WindowBoundaryInternal;
  readonly viewLayer: ViewBoundary;
  readonly sessionLayer: SessionBoundary;
  readonly appLayer: Pick<AppBoundary, "openUrl">;
  readonly config: IframeViewManagerConfig;
  readonly logger: Logger;
}

export class IframeViewManager extends BaseViewManager {
  private readonly windowLayer: WindowBoundaryInternal;
  private readonly viewLayer: ViewBoundary;
  private readonly sessionLayer: SessionBoundary;
  private readonly appLayer: Pick<AppBoundary, "openUrl">;
  private readonly config: IframeViewManagerConfig;
  private windowHandle!: WindowHandle;

  private workspaceHostHandle!: ViewHandle;
  private hostReady = false;
  private hostAttachedToWindow = false;
  private readonly pendingHostScripts: string[] = [];
  private sharedSessionHandle!: SessionHandle;

  constructor(deps: IframeViewManagerDeps) {
    super({
      windowManager: deps.windowManager,
      logger: deps.logger,
      codeServerPort: deps.config.codeServerPort,
    });
    this.windowLayer = deps.windowLayer;
    this.viewLayer = deps.viewLayer;
    this.sessionLayer = deps.sessionLayer;
    this.appLayer = deps.appLayer;
    this.config = deps.config;
  }

  /**
   * Returns the handle for the shared workspace-host view. Exposed for
   * tests that need to drive `did-finish-load` or inspect the host.
   */
  getWorkspaceHostHandle(): ViewHandle {
    return this.workspaceHostHandle;
  }

  // ---------------------------------------------------------------------------
  // UI view
  // ---------------------------------------------------------------------------

  protected createUIView(): ViewHandle {
    const { viewLayer, config } = this;

    const uiViewHandle = viewLayer.createView({
      label: "ui",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: config.uiPreloadPath,
      },
    });

    viewLayer.setWindowOpenHandler(uiViewHandle, (details: WindowOpenDetails) => {
      this.appLayer.openUrl(details.url).catch((error: unknown) => {
        this.logger.warn("Failed to open external URL from UI", {
          url: details.url,
          error: getErrorMessage(error),
        });
      });
      return { action: "deny" };
    });

    viewLayer.setBackgroundColor(uiViewHandle, "#00000000");

    this.windowHandle = this.windowManager.getWindowHandle();

    this.createWorkspaceHost();

    viewLayer.attachToWindow(uiViewHandle, this.windowHandle);

    return uiViewHandle;
  }

  /**
   * Creates the single workspace-host WebContentsView that holds all
   * workspace iframes. Wires session-level header/permission handlers,
   * loads `workspace-host.html`, and installs the in-frame focus tracker.
   */
  private createWorkspaceHost(): void {
    const { viewLayer, sessionLayer, config } = this;

    this.workspaceHostHandle = viewLayer.createView({
      label: "workspace-host",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: GLOBAL_SESSION_PARTITION,
        focusOnNavigation: false,
        backgroundThrottling: false,
      },
    });
    viewLayer.setBackgroundColor(this.workspaceHostHandle, "#00000000");

    this.sharedSessionHandle = sessionLayer.fromPartition(GLOBAL_SESSION_PARTITION);

    // Strip frame-blocking headers so code-server loads inside iframes.
    sessionLayer.setHeadersReceivedHandler(this.sharedSessionHandle, (headers) => {
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

    sessionLayer.setPermissionRequestHandler(this.sharedSessionHandle, (permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    );
    sessionLayer.setPermissionCheckHandler(this.sharedSessionHandle, (permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    );

    viewLayer.setWindowOpenHandler(this.workspaceHostHandle, (details: WindowOpenDetails) => {
      this.appLayer.openUrl(details.url).catch((error: unknown) => {
        this.logger.warn("Failed to open external URL from host", {
          url: details.url,
          error: getErrorMessage(error),
        });
      });
      return { action: "deny" };
    });

    // Host starts detached. attachViewImpl attaches it when the active
    // workspace has finished loading, mirroring the per-WCV pattern.
    // Set initial bounds on the detached host so workbench inside the
    // iframes still has a viewport and can lay out while loading.
    viewLayer.setBounds(
      this.workspaceHostHandle,
      computeWorkspaceRect(this.windowManager.getBounds())
    );
    viewLayer.installChildFrameScript(this.workspaceHostHandle, CHILD_FRAME_FOCUS_TRACKER);

    const off = viewLayer.onDidFinishLoad(this.workspaceHostHandle, () => {
      off();
      this.hostReady = true;
      const pending = this.pendingHostScripts.splice(0);
      for (const code of pending) this.hostExec(code);
    });

    // Subframe load failures: Electron's `did-fail-load` fires on the host's
    // webContents for both the host page (isMainFrame=true) and any iframe
    // inside it (isMainFrame=false). For subframes we map the failing URL
    // back to a workspace and delegate to the shared backoff scheduler
    // (`scheduleLoadRetry` in `BaseViewManager`).
    viewLayer.onDidFailLoad(this.workspaceHostHandle, (details: FailLoadDetails) => {
      if (details.isMainFrame) return;
      const failingPath = this.findWorkspacePathByUrl(details.validatedURL);
      if (failingPath === undefined) return;
      this.scheduleLoadRetry(failingPath, details);
    });

    void viewLayer.loadURL(this.workspaceHostHandle, `file://${config.workspaceHostHtmlPath}`);
  }

  protected destroyUIView(): void {
    this.viewLayer.destroy(this.uiViewHandle);
    try {
      this.viewLayer.destroy(this.workspaceHostHandle);
    } catch {
      // host may already be destroyed
    }
  }

  protected isUIViewAvailable(): boolean {
    return this.viewLayer.isAvailable(this.uiViewHandle);
  }

  protected sendToUIView(channel: string, args: unknown[]): void {
    this.viewLayer.send(this.uiViewHandle, channel, ...args);
  }

  protected loadUIContentImpl(htmlPath: string): Promise<void> {
    return this.viewLayer.loadURL(this.uiViewHandle, htmlPath);
  }

  protected capturePNG(handle: ViewHandle): Promise<Buffer | null> {
    // For per-workspace capture, the host view shows only the active
    // iframe; capture returns the active workspace's pixels regardless of
    // which handle is asked for. Inactive workspaces are invisible.
    return this.viewLayer.capturePNG(handle);
  }

  protected isWindowAlive(): boolean {
    return !this.windowLayer.isDestroyed(this.windowHandle);
  }

  // ---------------------------------------------------------------------------
  // Workspace view (iframe inside the host)
  // ---------------------------------------------------------------------------

  protected createWorkspaceViewImpl(workspacePath: string): CreatedWorkspaceView {
    const workspaceName = basename(workspacePath);
    this.logger.debug("Workspace iframe registered", { workspace: workspaceName });
    // All workspaces share the host view's handle and session — the only
    // per-workspace identity is the iframe inside the host page (keyed by
    // path), created lazily on first `startLoadingUrl` (= loadViewUrl).
    return {
      handle: this.workspaceHostHandle,
      sessionHandle: this.sharedSessionHandle,
      partitionName: GLOBAL_SESSION_PARTITION,
    };
  }

  protected async destroyWorkspaceViewImpl(state: WorkspaceState): Promise<void> {
    // Remove the iframe from the host page. The host view itself is
    // shared and stays alive until UI shutdown.
    const path = this.findWorkspacePathByState(state);
    if (path !== undefined) {
      this.hostExec(`window.__host.remove(${jsStr(path)})`);
    }

    // Clear any pending retry timer for this iframe.
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    // If no workspaces remain (e.g. hibernating the last awake workspace),
    // detach the host view so the UI overlay (HibernatedOverlay, empty
    // backdrop) is visible. The base class deletes from `workspaceStates`
    // BEFORE calling this, so an empty map means "no iframes left to show".
    // Without this detach the host's dark `#1e1e1e` body would cover the
    // UI view sitting at z-bottom — the symptom in PostHog issue 019e3bd1.
    if (this.workspaceStates.size === 0 && this.hostAttachedToWindow) {
      try {
        this.viewLayer.detachFromWindow(this.workspaceHostHandle);
      } catch {
        // window may be closing
      }
      this.hostAttachedToWindow = false;
    }
  }

  protected startLoadingUrl(state: WorkspaceState): void {
    const path = this.findWorkspacePathByState(state);
    if (path === undefined) return;
    this.hostExec(`window.__host.add(${jsStr(path)}, ${jsStr(state.url)})`);
  }

  protected swapActiveSurface(prev: WorkspaceState | null, next: WorkspaceState | null): void {
    // Shared-surface backend: hide the outgoing iframe and reveal the
    // incoming one. Host attachment is left as-is — attach/detachSurface
    // own that based on the new workspace's loading state.
    if (prev) {
      const prevPath = this.findWorkspacePathByState(prev);
      if (prevPath !== undefined) {
        this.hostExec(`window.__host.hide(${jsStr(prevPath)})`);
      }
    }
    if (next) {
      const nextPath = this.findWorkspacePathByState(next);
      if (nextPath !== undefined) {
        this.hostExec(`window.__host.show(${jsStr(nextPath)})`);
      }
      // Force a host re-composite so the now-visible iframe repaints
      // correctly on Windows — the same DirectComposition trick the UI
      // view uses via `bringUIToBottom(true)`.
      if (this.hostAttachedToWindow) {
        try {
          this.viewLayer.attachToWindow(this.workspaceHostHandle, this.windowHandle, undefined, {
            force: true,
          });
        } catch {
          // window may be closing
        }
      }
    }
  }

  protected attachSurface(): void {
    if (this.hostAttachedToWindow) return;
    this.viewLayer.attachToWindow(this.workspaceHostHandle, this.windowHandle);
    this.hostAttachedToWindow = true;
  }

  protected detachSurface(): void {
    if (!this.hostAttachedToWindow) return;
    this.viewLayer.detachFromWindow(this.workspaceHostHandle);
    this.hostAttachedToWindow = false;
  }

  protected applyBounds(handle: ViewHandle, rect: Rect): void {
    // Single host view holds all workspace iframes; size it once. The base
    // calls applyBounds per workspace; collapsing to one setBounds call on
    // the host is harmless because every state.handle === workspaceHostHandle.
    this.viewLayer.setBounds(handle, rect);
  }

  protected focusHandle(handle: ViewHandle): void {
    this.viewLayer.focus(handle);
    if (handle === this.workspaceHostHandle) {
      // After focusing the host webContents, focus the active iframe
      // element inside it so VS Code receives keystrokes. The in-frame
      // tracker installed via installChildFrameScript restores the
      // iframe's last-focused element on its window's focus event.
      this.hostExec(`window.__host.focusActive()`);
    }
  }

  protected bringUIToTop(): void {
    this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle);
  }

  protected bringUIToBottom(forceRedraw: boolean): void {
    if (forceRedraw) {
      this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle, Z_UI_BOTTOM, {
        force: true,
      });
    } else {
      this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle, Z_UI_BOTTOM);
    }
  }

  protected reloadWorkspaceView(state: WorkspaceState): void {
    // No per-iframe reload primitive — reload the entire host renderer.
    // Cheap because all workspaces share it, but coarse (affects all).
    const path = this.findWorkspacePathByState(state);
    if (path !== undefined) {
      this.hostExec(`window.__host.add(${jsStr(path)}, ${jsStr(state.url)})`);
    }
  }

  protected makeDevtoolsTarget(handle: ViewHandle): DevtoolsTarget {
    // All workspace iframes share the host's webContents devtools.
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

  protected makeKeyboardTarget(handle: ViewHandle): KeyboardTarget {
    const viewLayer = this.viewLayer;
    return {
      id: handle.id,
      onBeforeInput: (callback) => viewLayer.onBeforeInputEvent(handle, callback),
      onDestroyed: (callback) => viewLayer.onDestroyed(handle, callback),
    };
  }

  // ---------------------------------------------------------------------------
  // Iframe host helpers
  // ---------------------------------------------------------------------------

  /**
   * Run a script inside the workspace-host page. When the host page hasn't
   * finished loading yet (window.__host not defined), the call is queued
   * and drained in order when did-finish-load fires.
   *
   * Synchronous through to `viewLayer.executeJavaScript` once ready, so
   * tests can observe the call without awaiting microtasks.
   */
  private hostExec(code: string): void {
    if (this.destroying) return;
    if (!this.hostReady) {
      this.pendingHostScripts.push(code);
      return;
    }
    if (!this.viewLayer.isAvailable(this.workspaceHostHandle)) return;
    this.viewLayer.executeJavaScript(this.workspaceHostHandle, code).catch((error: unknown) => {
      this.logger.warn("hostExec failed", { error: getErrorMessage(error) });
    });
  }

  /** Reverse-lookup a workspace path from its state object. */
  private findWorkspacePathByState(state: WorkspaceState): string | undefined {
    for (const [path, candidate] of this.workspaceStates) {
      if (candidate === state) return path;
    }
    return undefined;
  }

  /** Reverse-lookup a workspace path from its iframe URL. */
  private findWorkspacePathByUrl(url: string): string | undefined {
    for (const [path, state] of this.workspaceStates) {
      if (state.url === url) return path;
    }
    return undefined;
  }

  /**
   * Re-issue the iframe's `src` via the host page. `__host.add` with
   * `force: true` bounces through `about:blank` so Chromium actually
   * re-requests the URL even when it matches the previous (failed)
   * navigation.
   */
  protected retryLoad(state: WorkspaceState): void {
    const path = this.findWorkspacePathByState(state);
    if (path === undefined) return;
    this.hostExec(`window.__host.add(${jsStr(path)}, ${jsStr(state.url)}, { force: true })`);
  }
}

/** Escapes a string for safe embedding in single-quoted JS string. */
function jsStr(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
