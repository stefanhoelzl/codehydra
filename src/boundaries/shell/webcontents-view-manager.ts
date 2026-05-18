/**
 * WebContentsView-based implementation of IViewManager.
 *
 * Subclass of BaseViewManager. The base owns the UI/state-machine layer
 * (mode, active workspace, loading bookkeeping, focus routing, z-order
 * rules, bounds math). This class supplies all Electron `WebContentsView`-
 * specific I/O: view creation with security/partition settings, event
 * handler wiring, URL load + exponential-backoff retry, render-process-gone
 * recovery, the reload watchdog, and the Windows DirectComposition
 * re-composite workaround.
 */

import { basename } from "node:path";
import type { AppBoundary } from "./app";
import type { Logger } from "../platform/logging";
import { getErrorMessage } from "../../shared/error-utils";
import type { FailLoadDetails, ViewBoundary, WindowOpenDetails } from "./view";
import type { SessionBoundary } from "./session";
import type { WindowBoundaryInternal } from "./window";
import type { ViewHandle, WindowHandle } from "./types";
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

/**
 * Global session partition name shared by all workspaces.
 * Using a single partition enables extension storage (globalState, secrets)
 * to be shared across all workspaces.
 *
 * The `persist:` prefix ensures data survives app restarts.
 */
const GLOBAL_SESSION_PARTITION = "persist:codehydra-global";

/**
 * Timeout for navigation to about:blank before closing a view.
 */
const NAVIGATION_TIMEOUT_MS = 2000;

/**
 * How long to wait for did-finish-load after a resume-triggered reload
 * before assuming the renderer is wedged and recreating the view.
 *
 * Code-server is local (127.0.0.1) so a reload should complete in well
 * under a second; 15s is generous enough to avoid false positives on
 * heavily-loaded systems while still catching the zombie-renderer case
 * we see on Windows after multiple suspend/resume cycles.
 */
const RELOAD_WATCHDOG_MS = 15000;

export interface WebContentsViewManagerConfig {
  /** Path to the UI layer preload script */
  readonly uiPreloadPath: string;
  /** Code-server port number */
  readonly codeServerPort: number;
}

export interface WebContentsViewManagerDeps {
  readonly windowManager: WindowManager;
  readonly windowLayer: WindowBoundaryInternal;
  readonly viewLayer: ViewBoundary;
  readonly sessionLayer: SessionBoundary;
  readonly appLayer: Pick<AppBoundary, "openUrl">;
  readonly config: WebContentsViewManagerConfig;
  readonly logger: Logger;
}

export class WebContentsViewManager extends BaseViewManager {
  private readonly windowLayer: WindowBoundaryInternal;
  private readonly viewLayer: ViewBoundary;
  private readonly sessionLayer: SessionBoundary;
  private readonly appLayer: Pick<AppBoundary, "openUrl">;
  private readonly config: WebContentsViewManagerConfig;
  private windowHandle!: WindowHandle;

  constructor(deps: WebContentsViewManagerDeps) {
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

    // Open external URLs from the UI view in the system browser
    viewLayer.setWindowOpenHandler(uiViewHandle, (details: WindowOpenDetails) => {
      this.appLayer.openUrl(details.url).catch((error: unknown) => {
        this.logger.warn("Failed to open external URL from UI", {
          url: details.url,
          error: getErrorMessage(error),
        });
      });
      return { action: "deny" };
    });

    // Set transparent background for UI layer — the window's own backgroundColor
    // shows through, keeping the backdrop in sync with the OS theme.
    viewLayer.setBackgroundColor(uiViewHandle, "#00000000");

    this.windowHandle = this.windowManager.getWindowHandle();
    viewLayer.attachToWindow(uiViewHandle, this.windowHandle);

    // Don't call updateBounds() here - let the resize event from maximize() trigger it.
    // On Linux, maximize() is async and bounds aren't available immediately.

    return uiViewHandle;
  }

  protected destroyUIView(): void {
    this.viewLayer.destroy(this.uiViewHandle);
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
    return this.viewLayer.capturePNG(handle);
  }

  protected isWindowAlive(): boolean {
    return !this.windowLayer.isDestroyed(this.windowHandle);
  }

  // ---------------------------------------------------------------------------
  // Workspace view
  // ---------------------------------------------------------------------------

  protected createWorkspaceViewImpl(workspacePath: string): CreatedWorkspaceView {
    const workspaceName = basename(workspacePath);
    const partitionName = GLOBAL_SESSION_PARTITION;
    const sessionHandle = this.sessionLayer.fromPartition(partitionName);

    // Configure permission handlers for this session
    // Both handlers are needed: request handler for async permission requests,
    // check handler for synchronous permission checks (e.g., document.execCommand('copy'))
    //
    // Allowed permissions:
    // - clipboard-*: Copy/paste operations in terminal and editor
    // - media: Microphone access for dictation extension
    // - fullscreen: VS Code fullscreen mode
    // - notifications: Build completion, agent status notifications
    // - openExternal: Opening URLs from terminal/code
    // - fileSystem: Modern file handling (drag/drop, file pickers)
    // - hid: Stream decks, macro pads, custom input devices
    // - serial: Arduino, microcontroller development, serial monitors
    // - usb: Firmware flashing, Android ADB, hardware debugging
    this.sessionLayer.setPermissionRequestHandler(sessionHandle, (permission) => {
      return (
        permission === "clipboard-read" ||
        permission === "clipboard-sanitized-write" ||
        permission === "clipboard-write" ||
        permission === "media" ||
        permission === "fullscreen" ||
        permission === "notifications" ||
        permission === "openExternal" ||
        permission === "fileSystem" ||
        permission === "hid" ||
        permission === "serial" ||
        permission === "usb"
      );
    });
    this.sessionLayer.setPermissionCheckHandler(sessionHandle, (permission) => {
      return (
        permission === "clipboard-read" ||
        permission === "clipboard-sanitized-write" ||
        permission === "clipboard-write" ||
        permission === "media" ||
        permission === "fullscreen" ||
        permission === "notifications" ||
        permission === "openExternal" ||
        permission === "fileSystem" ||
        permission === "hid" ||
        permission === "serial" ||
        permission === "usb"
      );
    });

    // Strip headers that block iframe embedding (VS Code's simple browser
    // embeds external sites that ship X-Frame-Options / CSP frame-ancestors).
    this.sessionLayer.setHeadersReceivedHandler(sessionHandle, (headers) => {
      const modifiedHeaders = { ...headers };
      for (const header of Object.keys(modifiedHeaders)) {
        const lower = header.toLowerCase();
        if (
          lower === "x-frame-options" ||
          lower === "content-security-policy" ||
          lower === "content-security-policy-report-only"
        ) {
          delete modifiedHeaders[header];
        }
      }
      return modifiedHeaders;
    });

    const handle = this.createAndWireView(workspacePath, workspaceName, partitionName);

    return { handle, sessionHandle, partitionName };
  }

  /**
   * Creates a fresh WebContentsView for a workspace and wires all event
   * handlers + initial bounds. Does NOT register the workspace in
   * `workspaceStates` or change loading state — the caller owns that.
   *
   * Used by both initial creation and recreation after a wedged renderer.
   */
  private createAndWireView(
    workspacePath: string,
    workspaceName: string,
    partitionName: string
  ): ViewHandle {
    const viewHandle = this.viewLayer.createView({
      label: workspaceName,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: partitionName,
        webviewTag: true,
        focusOnNavigation: false,
        backgroundThrottling: false,
      },
    });

    // Transparent background — window backgroundColor shows through while
    // code-server loads, keeping the backdrop in sync with the OS theme.
    this.viewLayer.setBackgroundColor(viewHandle, "#00000000");

    this.viewLayer.setWindowOpenHandler(viewHandle, (details: WindowOpenDetails) => {
      this.appLayer.openUrl(details.url).catch((error: unknown) => {
        this.logger.warn("Failed to open external URL", {
          url: details.url,
          error: getErrorMessage(error),
        });
      });
      return { action: "deny" };
    });

    this.viewLayer.onWillNavigate(viewHandle, (navigationUrl) => {
      const codeServerOrigin = `http://127.0.0.1:${this.codeServerPort}`;
      if (!navigationUrl.startsWith(codeServerOrigin)) {
        this.appLayer.openUrl(navigationUrl).catch((error: unknown) => {
          this.logger.warn("Failed to open external URL", {
            url: navigationUrl,
            error: getErrorMessage(error),
          });
        });
        return false;
      }
      return true;
    });

    this.viewLayer.onDidFailLoad(viewHandle, (details: FailLoadDetails) => {
      this.handleLoadFailure(workspacePath, details);
    });

    this.viewLayer.onRenderProcessGone(viewHandle, (details) => {
      this.logger.warn("Workspace renderer process gone", {
        workspace: workspaceName,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      // Force a reload next time the view is attached so the user gets a
      // fresh page instead of a permanently dead WebContents.
      const currentState = this.workspaceStates.get(workspacePath);
      if (currentState) {
        currentState.needsReloadOnAttach = true;
      }
    });
    this.viewLayer.onUnresponsive(viewHandle, () => {
      this.logger.warn("Workspace renderer unresponsive", { workspace: workspaceName });
    });
    this.viewLayer.onResponsive(viewHandle, () => {
      this.logger.info("Workspace renderer responsive again", { workspace: workspaceName });
    });

    // did-finish-load: reset retry state, clear reload watchdog.
    this.viewLayer.onDidFinishLoad(viewHandle, () => {
      this.logger.debug("View did-finish-load", { workspace: workspaceName });
      const currentState = this.workspaceStates.get(workspacePath);
      if (currentState) {
        currentState.retryCount = 0;
        if (currentState.retryTimer !== null) {
          clearTimeout(currentState.retryTimer);
          currentState.retryTimer = null;
        }
        if (currentState.reloadWatchdogTimer !== null) {
          clearTimeout(currentState.reloadWatchdogTimer);
          currentState.reloadWatchdogTimer = null;
        }
      }
    });

    // Set workspace bounds on detached view so code-server renders at correct size.
    this.viewLayer.setBounds(viewHandle, computeWorkspaceRect(this.windowManager.getBounds()));

    this.logger.debug("View created", { workspace: workspaceName });
    return viewHandle;
  }

  protected async destroyWorkspaceViewImpl(state: WorkspaceState): Promise<void> {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
    }
    if (state.reloadWatchdogTimer !== null) {
      clearTimeout(state.reloadWatchdogTimer);
    }

    try {
      try {
        this.viewLayer.detachFromWindow(state.handle);
      } catch {
        // View might already be detached - ignore
      }

      try {
        // Race navigation against timeout - both resolve, so no unhandled rejections
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, NAVIGATION_TIMEOUT_MS);
        });
        await Promise.race([this.viewLayer.loadURL(state.handle, "about:blank"), timeoutPromise]);
      } catch {
        // Navigation failed - continue with cleanup
      }

      try {
        this.viewLayer.destroy(state.handle);
      } catch {
        // View might already be destroyed - ignore
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  protected startLoadingUrl(state: WorkspaceState): void {
    void this.viewLayer.loadURL(state.handle, state.url);
  }

  protected swapActiveSurface(prev: WorkspaceState | null): void {
    // Per-view backend: each workspace owns its own WebContentsView, so
    // "swapping" means removing the previous one from the window. The
    // incoming workspace's view is attached separately via attachSurface.
    if (prev) {
      try {
        this.viewLayer.detachFromWindow(prev.handle);
      } catch {
        // Window may be closing
      }
    }
  }

  protected attachSurface(state: WorkspaceState): void {
    this.viewLayer.attachToWindow(state.handle, this.windowHandle);

    // Force a fresh paint if this view sat detached across a system
    // suspend/resume (or its renderer crashed). On Windows, a detached
    // WebContentsView whose URL was reloaded while invisible can come
    // back unfocusable and blank; reload() recreates the renderer view.
    if (state.needsReloadOnAttach) {
      state.needsReloadOnAttach = false;
      this.logger.debug("Reloading view on attach", { workspace: basename(state.url) });
      this.viewLayer.reload(state.handle);
    }
  }

  protected detachSurface(state: WorkspaceState): void {
    this.viewLayer.detachFromWindow(state.handle);
  }

  protected applyBounds(handle: ViewHandle, rect: Rect): void {
    this.viewLayer.setBounds(handle, rect);
  }

  protected focusHandle(handle: ViewHandle): void {
    this.viewLayer.focus(handle);
  }

  protected bringUIToTop(): void {
    // No index = append to top
    this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle);
  }

  protected makeDevtoolsTarget(handle: ViewHandle): DevtoolsTarget {
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

  protected bringUIToBottom(forceRedraw: boolean): void {
    if (forceRedraw) {
      // Windows DirectComposition workaround: force UI view re-composite
      // so the transparent sidebar strip is rendered correctly.
      this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle, Z_UI_BOTTOM, {
        force: true,
      });
    } else {
      this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle, Z_UI_BOTTOM);
    }
  }

  // ---------------------------------------------------------------------------
  // WebContents-specific retry + reload watchdog
  // ---------------------------------------------------------------------------

  /**
   * Handles a load failure for a workspace view. Subframe failures are
   * ignored — they're sub-resources (extensions, web workers) that
   * Chromium will retry on its own. Main-frame failures schedule a
   * backoff retry via the shared `scheduleLoadRetry` in the base class.
   */
  private handleLoadFailure(workspacePath: string, details: FailLoadDetails): void {
    if (!details.isMainFrame) return;
    // Pre-emptively mark the URL as not-loaded so any concurrent attach/
    // loadViewUrl path doesn't think it's still in flight while we wait
    // for the retry. `retryLoad` re-sets it to true before re-issuing.
    const state = this.workspaceStates.get(workspacePath);
    if (state) state.urlLoaded = false;
    this.scheduleLoadRetry(workspacePath, details);
  }

  protected retryLoad(state: WorkspaceState): void {
    state.urlLoaded = true;
    void this.viewLayer.loadURL(state.handle, state.url);
  }

  protected reloadWorkspaceView(state: WorkspaceState): void {
    // Reset retry state for fresh reload attempt
    state.retryCount = 0;
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    void this.viewLayer.loadURL(state.handle, state.url);

    // Arm a watchdog: if did-finish-load doesn't fire within
    // RELOAD_WATCHDOG_MS the renderer is assumed wedged (the white-tab
    // bug we see on Windows after multiple suspend/resume cycles when
    // loadURL is called on a detached WebContentsView) and we recreate
    // the view from scratch.
    if (state.reloadWatchdogTimer !== null) {
      clearTimeout(state.reloadWatchdogTimer);
    }
    // Recover the workspace path by looking it up — state is keyed in the
    // map by path. We need the path for recreateWorkspaceView().
    const workspacePath = this.findWorkspacePathByHandle(state.handle);
    state.reloadWatchdogTimer = setTimeout(() => {
      const currentState = workspacePath ? this.workspaceStates.get(workspacePath) : undefined;
      if (!currentState || !workspacePath) return;
      currentState.reloadWatchdogTimer = null;
      this.logger.warn("Reload watchdog fired — recreating view", {
        workspace: basename(workspacePath),
        watchdogMs: RELOAD_WATCHDOG_MS,
      });
      this.recreateWorkspaceView(workspacePath);
    }, RELOAD_WATCHDOG_MS);
  }

  private findWorkspacePathByHandle(handle: ViewHandle): string | undefined {
    for (const [path, state] of this.workspaceStates) {
      if (state.handle === handle) return path;
    }
    return undefined;
  }

  /**
   * Destroys the workspace's current WebContentsView and creates a fresh
   * one in its place, then re-triggers loadURL. Used as the last-resort
   * recovery when a renderer becomes wedged (e.g. detached loadURL after
   * suspend/resume that never produces a did-finish-load).
   *
   * Preserves the workspace's logical identity (workspaceStates entry,
   * url, session/partition) — only the underlying view handle changes.
   */
  private recreateWorkspaceView(workspacePath: string): void {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;

    const workspaceName = basename(workspacePath);
    const wasAttached = this.attachedWorkspacePath === workspacePath;

    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.reloadWatchdogTimer !== null) {
      clearTimeout(state.reloadWatchdogTimer);
      state.reloadWatchdogTimer = null;
    }

    try {
      if (wasAttached) {
        this.viewLayer.detachFromWindow(state.handle);
        this.attachedWorkspacePath = null;
      }
    } catch {
      // ignore
    }
    try {
      this.viewLayer.destroy(state.handle);
    } catch (error) {
      this.logger.warn("Failed to destroy view during recreate", {
        workspace: workspaceName,
        error: getErrorMessage(error),
      });
    }

    const newHandle = this.createAndWireView(workspacePath, workspaceName, state.partitionName);
    state.handle = newHandle;
    state.urlLoaded = false;
    state.retryCount = 0;
    state.needsReloadOnAttach = false;

    state.urlLoaded = true;
    void this.viewLayer.loadURL(newHandle, state.url);

    if (wasAttached) {
      this.attachView(workspacePath);
    }
  }
}
