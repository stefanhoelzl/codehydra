/**
 * View manager for managing WebContentsViews.
 * Handles UI layer, workspace views, bounds, and focus management.
 */

import { WebContentsView, type WebContents } from "electron";
import type { IViewManager, Unsubscribe } from "./view-manager.interface";
import type { WindowManager } from "./window-manager";
import { openExternal } from "../utils/external-url";
import { ShortcutController } from "../shortcut-controller";

/**
 * Sidebar width in pixels.
 */
export const SIDEBAR_WIDTH = 250;

/**
 * Minimum window dimensions.
 */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/**
 * Default background color for views (VS Code dark theme).
 * Used to prevent white flash while content loads.
 * Matches --ch-background fallback in variables.css.
 */
const VIEW_BACKGROUND_COLOR = "#1e1e1e";

/**
 * Configuration for creating a ViewManager.
 */
export interface ViewManagerConfig {
  /** Path to the UI layer preload script */
  readonly uiPreloadPath: string;
  /** Code-server port number */
  readonly codeServerPort: number;
}

/**
 * Manages WebContentsViews for the application.
 * Implements the IViewManager interface.
 */
export class ViewManager implements IViewManager {
  private readonly windowManager: WindowManager;
  private readonly uiView: WebContentsView;
  private readonly shortcutController: ShortcutController;
  private codeServerPort: number;
  /**
   * Map of workspace paths to their WebContentsViews.
   *
   * Note: Uses `string` instead of branded `WorkspacePath` type because:
   * 1. Paths come from various sources (IPC payloads, providers, app state)
   * 2. Using WorkspacePath would require type guards at every entry point
   * 3. The validation happens at the IPC boundary, so paths here are already validated
   */
  private readonly workspaceViews: Map<string, WebContentsView> = new Map();
  private activeWorkspacePath: string | null = null;
  private readonly unsubscribeResize: Unsubscribe;

  private constructor(
    windowManager: WindowManager,
    codeServerPort: number,
    uiView: WebContentsView,
    shortcutController: ShortcutController
  ) {
    this.windowManager = windowManager;
    this.uiView = uiView;
    this.shortcutController = shortcutController;
    this.codeServerPort = codeServerPort;

    // Subscribe to resize events
    this.unsubscribeResize = this.windowManager.onResize(() => {
      this.updateBounds();
    });
  }

  /**
   * Creates a new ViewManager with a UI layer view.
   *
   * @param windowManager - The WindowManager instance
   * @param config - Configuration options
   * @returns A new ViewManager instance
   */
  static create(windowManager: WindowManager, config: ViewManagerConfig): ViewManager {
    // Create UI layer with security settings
    const uiView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: config.uiPreloadPath,
      },
    });

    // Set transparent background for UI layer
    uiView.setBackgroundColor("#00000000");

    // Add UI layer to window
    windowManager.getWindow().contentView.addChildView(uiView);

    // Use a holder object to break the circular dependency:
    // ShortcutController needs ViewManager methods, ViewManager needs ShortcutController
    const viewManagerHolder: { instance: ViewManager | null } = { instance: null };

    // Create ShortcutController with deps that reference the holder
    const shortcutController = new ShortcutController(windowManager.getWindow(), {
      setDialogMode: (isOpen) => viewManagerHolder.instance?.setDialogMode(isOpen),
      focusUI: () => viewManagerHolder.instance?.focusUI(),
      getUIWebContents: () => viewManagerHolder.instance?.getUIWebContents() ?? null,
    });

    const viewManager = new ViewManager(
      windowManager,
      config.codeServerPort,
      uiView,
      shortcutController
    );
    viewManagerHolder.instance = viewManager;

    // Don't call updateBounds() here - let the resize event from maximize() trigger it.
    // On Linux, maximize() is async and bounds aren't available immediately.

    return viewManager;
  }

  /**
   * Returns the UI layer WebContentsView.
   */
  getUIView(): WebContentsView {
    return this.uiView;
  }

  /**
   * Returns the UI layer WebContents for IPC communication.
   * Used by ShortcutController to send events to the UI.
   */
  getUIWebContents(): WebContents | null {
    if (this.uiView.webContents.isDestroyed()) {
      return null;
    }
    return this.uiView.webContents;
  }

  /**
   * Creates a new workspace view.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @param url - URL to load in the view (code-server URL)
   * @returns The created WebContentsView
   */
  createWorkspaceView(workspacePath: string, url: string): WebContentsView {
    // Create workspace view with security settings
    // Note: No preload script - keyboard capture is handled via main-process before-input-event
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // Set dark background to prevent white flash while VS Code loads
    view.setBackgroundColor(VIEW_BACKGROUND_COLOR);

    // Configure window open handler to open external URLs
    view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      openExternal(targetUrl);
      return { action: "deny" };
    });

    // Configure navigation handler to prevent navigation away from code-server
    view.webContents.on("will-navigate", (event, navigationUrl) => {
      const codeServerOrigin = `http://localhost:${this.codeServerPort}`;
      if (!navigationUrl.startsWith(codeServerOrigin)) {
        event.preventDefault();
        openExternal(navigationUrl);
      }
    });

    // Configure permission handler
    view.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      // Allow clipboard access, deny everything else
      if (permission === "clipboard-read" || permission === "clipboard-sanitized-write") {
        callback(true);
      } else {
        callback(false);
      }
    });

    // Load the URL
    void view.webContents.loadURL(url);

    // Add to window (on top of UI layer - normal state, workspace receives events)
    this.windowManager.getWindow().contentView.addChildView(view);

    // Store in map
    this.workspaceViews.set(workspacePath, view);

    // Register with shortcut controller for Alt+X detection
    this.shortcutController.registerView(view.webContents);

    // Update bounds
    this.updateBounds();

    return view;
  }

  /**
   * Destroys a workspace view.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  destroyWorkspaceView(workspacePath: string): void {
    const view = this.workspaceViews.get(workspacePath);
    if (!view) {
      return;
    }

    // Unregister from shortcut controller
    this.shortcutController.unregisterView(view.webContents);

    // Remove from map first to ensure cleanup even if view is destroyed
    this.workspaceViews.delete(workspacePath);

    // If this was the active workspace, clear it
    if (this.activeWorkspacePath === workspacePath) {
      this.activeWorkspacePath = null;
    }

    try {
      // Remove from window only if window is not destroyed
      const window = this.windowManager.getWindow();
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(view);
      }

      // Close webContents only if not already destroyed
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch {
      // Ignore errors during cleanup - view may be in an inconsistent state
      // This can happen when the view or its webContents is already destroyed
    }
  }

  /**
   * Gets a workspace view by path.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns The WebContentsView or undefined if not found
   */
  getWorkspaceView(workspacePath: string): WebContentsView | undefined {
    return this.workspaceViews.get(workspacePath);
  }

  /**
   * Updates all view bounds.
   * Called on window resize.
   */
  updateBounds(): void {
    const bounds = this.windowManager.getBounds();

    // Clamp to minimum dimensions
    const width = Math.max(bounds.width, MIN_WIDTH);
    const height = Math.max(bounds.height, MIN_HEIGHT);

    // UI layer: full window (so dialogs can overlay everything)
    this.uiView.setBounds({
      x: 0,
      y: 0,
      width,
      height,
    });

    // Workspace views
    for (const [path, view] of this.workspaceViews) {
      if (path === this.activeWorkspacePath) {
        // Active workspace: content area
        view.setBounds({
          x: SIDEBAR_WIDTH,
          y: 0,
          width: width - SIDEBAR_WIDTH,
          height,
        });
      } else {
        // Inactive workspace: zero bounds (hidden)
        view.setBounds({
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        });
      }
    }
  }

  /**
   * Sets the active workspace.
   * Active workspace has full content bounds, others have zero bounds.
   *
   * @param workspacePath - Path to the workspace to activate, or null for none
   */
  setActiveWorkspace(workspacePath: string | null): void {
    this.activeWorkspacePath = workspacePath;
    this.updateBounds();
  }

  /**
   * Focuses the active workspace view.
   */
  focusActiveWorkspace(): void {
    if (!this.activeWorkspacePath) {
      return;
    }

    const view = this.workspaceViews.get(this.activeWorkspacePath);
    if (view) {
      view.webContents.focus();
    }
  }

  /**
   * Focuses the UI layer view.
   */
  focusUI(): void {
    this.uiView.webContents.focus();
  }

  /**
   * Sets whether the UI layer should be in dialog mode.
   * In dialog mode, the UI is moved to the top to overlay workspace views.
   *
   * @param isOpen - True to enable dialog mode (UI on top), false for normal mode (UI behind)
   */
  setDialogMode(isOpen: boolean): void {
    try {
      const window = this.windowManager.getWindow();
      if (window.isDestroyed()) return;

      const contentView = window.contentView;
      if (isOpen) {
        // Move UI to top (adding existing child moves it to end = top)
        contentView.addChildView(this.uiView);
      } else {
        // Move UI to bottom (index 0 = behind workspaces)
        contentView.addChildView(this.uiView, 0);
      }
    } catch {
      // Ignore errors during z-order change - window may be closing
    }
  }

  /**
   * Updates the code-server port.
   * Used after setup completes to update the port for origin checking.
   *
   * @param port - The new code-server port
   */
  updateCodeServerPort(port: number): void {
    this.codeServerPort = port;
  }

  /**
   * Destroys the ViewManager and cleans up all views.
   * Called on application shutdown.
   */
  destroy(): void {
    // Unsubscribe from resize events
    this.unsubscribeResize();

    // Dispose shortcut controller
    this.shortcutController.dispose();

    // Destroy all workspace views
    for (const path of this.workspaceViews.keys()) {
      this.destroyWorkspaceView(path);
    }

    // Close UI view only if not already destroyed (can happen during window close)
    try {
      if (!this.uiView.webContents.isDestroyed()) {
        this.uiView.webContents.close();
      }
    } catch {
      // Ignore errors during cleanup - view may be in an inconsistent state
    }
  }
}
