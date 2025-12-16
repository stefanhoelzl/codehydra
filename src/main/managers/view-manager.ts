/**
 * View manager for managing WebContentsViews.
 * Handles UI layer, workspace views, bounds, and focus management.
 */

import { WebContentsView, session, type WebContents } from "electron";
import { basename } from "node:path";
import type { IViewManager, Unsubscribe } from "./view-manager.interface";
import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type { WindowManager } from "./window-manager";
import { openExternal } from "../utils/external-url";
import { ShortcutController } from "../shortcut-controller";
import { projectDirName } from "../../services/platform/paths";
import type { WorkspaceName } from "../../shared/api/types";
import type { Logger } from "../../services/logging";

/**
 * Sidebar minimized width in pixels.
 * Workspace views start at this offset, with expanded sidebar overlaying them.
 */
export const SIDEBAR_MINIMIZED_WIDTH = 20;

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
 * Timeout for navigation to about:blank before closing a view.
 * If navigation doesn't complete within this time, we proceed with closing.
 */
const NAVIGATION_TIMEOUT_MS = 2000;

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
  /**
   * Map of workspace paths to their code-server URLs.
   * URLs are stored during createWorkspaceView and loaded during first activation.
   */
  private readonly workspaceUrls: Map<string, string> = new Map();
  private activeWorkspacePath: string | null = null;
  /**
   * Tracks which workspace view is currently attached to the contentView.
   * Used for explicit attachment state tracking (detach optimization).
   */
  private attachedWorkspacePath: string | null = null;
  /**
   * Current UI mode. Single source of truth for UI state.
   */
  private mode: UIMode = "workspace";
  /**
   * Callbacks for mode change events.
   */
  private readonly modeChangeCallbacks: Set<(event: UIModeChangedEvent) => void> = new Set();
  /**
   * Tracks which workspaces have had their URL loaded.
   * Used to ensure URL is only loaded on first activation (lazy loading).
   */
  private readonly loadedWorkspaces: Set<string> = new Set();
  /**
   * Map of workspace paths to their Electron partition names.
   * Used for session isolation cleanup on workspace removal.
   */
  private readonly workspacePartitions: Map<string, string> = new Map();
  /**
   * Reentrant guard to prevent concurrent workspace changes.
   */
  private isChangingWorkspace = false;
  private readonly unsubscribeResize: Unsubscribe;
  private readonly logger: Logger;

  private constructor(
    windowManager: WindowManager,
    codeServerPort: number,
    uiView: WebContentsView,
    shortcutController: ShortcutController,
    logger: Logger
  ) {
    this.windowManager = windowManager;
    this.uiView = uiView;
    this.shortcutController = shortcutController;
    this.codeServerPort = codeServerPort;
    this.logger = logger;

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
   * @param logger - Logger for [view] scope
   * @returns A new ViewManager instance
   */
  static create(
    windowManager: WindowManager,
    config: ViewManagerConfig,
    logger: Logger
  ): ViewManager {
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
      focusUI: () => viewManagerHolder.instance?.focusUI(),
      getUIWebContents: () => viewManagerHolder.instance?.getUIWebContents() ?? null,
      setMode: (mode) => viewManagerHolder.instance?.setMode(mode),
      getMode: () => viewManagerHolder.instance?.getMode() ?? "workspace",
      // Shortcut key callback - sends IPC event to renderer
      onShortcut: (key) => {
        const webContents = viewManagerHolder.instance?.getUIWebContents();
        if (webContents && !webContents.isDestroyed()) {
          webContents.send(ApiIpcChannels.SHORTCUT_KEY, key);
        }
      },
    });

    const viewManager = new ViewManager(
      windowManager,
      config.codeServerPort,
      uiView,
      shortcutController,
      logger
    );
    viewManagerHolder.instance = viewManager;

    // Register UI view with shortcut controller for keyboard shortcuts
    // (Alt+X activation and action keys in shortcut mode)
    shortcutController.registerView(uiView.webContents);

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
   * @param projectPath - Absolute path to the project directory (for partition naming)
   * @returns The created WebContentsView
   */
  createWorkspaceView(workspacePath: string, url: string, projectPath: string): WebContentsView {
    // Generate partition name for session isolation
    // Format: persist:<projectDirName>/<workspaceName>
    // Using persist: prefix to enable persistent storage across app restarts
    const workspaceName = basename(workspacePath) as WorkspaceName;
    const partitionName = `persist:${projectDirName(projectPath)}/${workspaceName}`;

    // Store partition name for later cleanup
    this.workspacePartitions.set(workspacePath, partitionName);

    // Create workspace view with security settings and partition for session isolation
    // Note: No preload script - keyboard capture is handled via main-process before-input-event
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: partitionName,
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

    // Store URL for lazy loading during first activation (NOT loaded now)
    this.workspaceUrls.set(workspacePath, url);

    // Store in map (view is NOT attached to contentView yet - detached by default)
    this.workspaceViews.set(workspacePath, view);

    // Register with shortcut controller for Alt+X detection (will work when view becomes active)
    this.shortcutController.registerView(view.webContents);

    // Note: No addChildView() - view starts detached
    // Note: No loadURL() - URL is loaded on first activation
    // Note: No updateBounds() - detached views don't need bounds

    this.logger.debug("View created", { workspace: workspaceName });
    return view;
  }

  /**
   * Destroys a workspace view.
   *
   * Idempotent: safe to call multiple times for the same workspace.
   * Navigates to about:blank before closing to ensure resources are released.
   * Uses a timeout to ensure destruction completes even if navigation hangs.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  async destroyWorkspaceView(workspacePath: string): Promise<void> {
    // Idempotent: early return if workspace not in maps
    if (!this.workspaceViews.has(workspacePath)) {
      return;
    }

    const view = this.workspaceViews.get(workspacePath)!;
    const workspaceName = basename(workspacePath);

    // Save partition name before removing from map (needed for storage clearing)
    const partitionName = this.workspacePartitions.get(workspacePath);

    // Remove from maps FIRST to prevent re-entry during async operations
    // This makes the operation idempotent even if called concurrently
    this.workspaceViews.delete(workspacePath);
    this.workspaceUrls.delete(workspacePath);
    this.loadedWorkspaces.delete(workspacePath);
    this.workspacePartitions.delete(workspacePath);

    // Unregister from shortcut controller (safe even if view is destroyed)
    try {
      if (!view.webContents.isDestroyed()) {
        this.shortcutController.unregisterView(view.webContents);
      }
    } catch {
      // Ignore errors - view may be in inconsistent state
    }

    // If this was the active workspace, clear it
    if (this.activeWorkspacePath === workspacePath) {
      this.activeWorkspacePath = null;
    }

    // If this was the attached workspace, clear it and detach from window
    if (this.attachedWorkspacePath === workspacePath) {
      this.attachedWorkspacePath = null;
    }

    try {
      // Remove from window only if window is not destroyed
      // Wrap in try-catch - view might already be removed
      const window = this.windowManager.getWindow();
      if (!window.isDestroyed()) {
        try {
          window.contentView.removeChildView(view);
        } catch {
          // View might already be removed - ignore
        }
      }

      // Navigate to about:blank before closing (to release resources)
      // Only if webContents is not already destroyed
      if (!view.webContents.isDestroyed()) {
        // Create a timeout promise that resolves (not rejects) after NAVIGATION_TIMEOUT_MS
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, NAVIGATION_TIMEOUT_MS);
        });

        // Race navigation against timeout - both resolve, so no unhandled rejections
        await Promise.race([view.webContents.loadURL("about:blank"), timeoutPromise]);

        // Close webContents after navigation (or timeout)
        // Re-check isDestroyed() since navigation might have completed or view might have been destroyed
        if (!view.webContents.isDestroyed()) {
          view.webContents.close();
        }
      }

      // Clear partition storage (best-effort - log errors and continue)
      if (partitionName) {
        try {
          const sess = session.fromPartition(partitionName);
          await sess.clearStorageData();
        } catch {
          // Intentional empty catch: Best-effort cleanup - storage clearing may fail
          // if session is in use or already cleared. We continue regardless.
        }
      }
    } catch {
      // Ignore errors during cleanup - view may be in an inconsistent state
      // This can happen when the view or its webContents is already destroyed
    }

    this.logger.debug("View destroyed", { workspace: workspaceName });
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
   * Updates view bounds for UI layer and active workspace only.
   * Called on window resize.
   *
   * Note: Only the active workspace needs bounds updated (O(1) not O(n)).
   * Inactive workspaces are detached from contentView and don't need bounds.
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

    // Only update active workspace bounds (O(1) - inactive views are detached)
    if (this.activeWorkspacePath !== null) {
      const activeView = this.workspaceViews.get(this.activeWorkspacePath);
      if (activeView) {
        activeView.setBounds({
          x: SIDEBAR_MINIMIZED_WIDTH,
          y: 0,
          width: width - SIDEBAR_MINIMIZED_WIDTH,
          height,
        });
      }
    }
  }

  /**
   * Loads the URL for a workspace view if not already loaded.
   * Called during first activation.
   *
   * @param workspacePath - Path to the workspace
   */
  private loadViewUrl(workspacePath: string): void {
    // Skip if already loaded (ensures URL is only loaded on first activation)
    if (this.loadedWorkspaces.has(workspacePath)) return;

    const view = this.workspaceViews.get(workspacePath);
    const url = this.workspaceUrls.get(workspacePath);

    if (!view || !url) return;

    // Mark as loaded first to prevent re-entry
    this.loadedWorkspaces.add(workspacePath);

    const workspaceName = basename(workspacePath);
    this.logger.debug("Loading URL", { workspace: workspaceName });

    // Load the URL
    void view.webContents.loadURL(url);
  }

  /**
   * Attaches a workspace view to the contentView.
   * Handles errors gracefully.
   *
   * @param workspacePath - Path to the workspace
   */
  private attachView(workspacePath: string): void {
    const view = this.workspaceViews.get(workspacePath);
    if (!view) return;

    try {
      const window = this.windowManager.getWindow();
      if (!window.isDestroyed()) {
        window.contentView.addChildView(view);
        this.attachedWorkspacePath = workspacePath;
        const workspaceName = basename(workspacePath);
        this.logger.debug("View attached", { workspace: workspaceName });
      }
    } catch {
      // Ignore errors during attach - window may be closing
    }
  }

  /**
   * Detaches a workspace view from the contentView.
   * Handles errors gracefully.
   *
   * @param workspacePath - Path to the workspace
   */
  private detachView(workspacePath: string): void {
    const view = this.workspaceViews.get(workspacePath);
    if (!view) return;

    const workspaceName = basename(workspacePath);

    try {
      const window = this.windowManager.getWindow();
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(view);
        this.logger.debug("View detached", { workspace: workspaceName });
      }
    } catch {
      // Ignore errors during detach - window may be closing
    }

    // Clear attachment state if this was the attached view
    if (this.attachedWorkspacePath === workspacePath) {
      this.attachedWorkspacePath = null;
    }
  }

  /**
   * Sets the active workspace.
   * Active workspace is attached with full content bounds, others are detached.
   * By default, focuses the workspace view so it receives keyboard input.
   *
   * @param workspacePath - Path to the workspace to activate, or null for none
   * @param focus - Whether to focus the workspace view (default: true)
   */
  setActiveWorkspace(workspacePath: string | null, focus: boolean = true): void {
    // Reentrant guard
    if (this.isChangingWorkspace) return;

    // Same workspace is no-op
    if (this.activeWorkspacePath === workspacePath) return;

    try {
      this.isChangingWorkspace = true;
      const previousPath = this.activeWorkspacePath;

      // Update state first
      this.activeWorkspacePath = workspacePath;

      // Attach new view FIRST (visual continuity - no gap)
      if (workspacePath !== null) {
        this.loadViewUrl(workspacePath);
        this.attachView(workspacePath);
      }

      // Then detach previous
      if (previousPath !== null && previousPath !== workspacePath) {
        this.detachView(previousPath);
      }

      // Maintain z-order if in dialog or shortcut mode
      // The new workspace view was just attached to the top, so we need to
      // re-add the UI layer to keep it on top. Must directly manipulate z-order
      // since setMode is idempotent and won't re-apply if mode hasn't changed.
      if (this.mode === "dialog" || this.mode === "shortcut") {
        try {
          const window = this.windowManager.getWindow();
          if (!window.isDestroyed()) {
            window.contentView.addChildView(this.uiView);
          }
        } catch {
          // Ignore errors during z-order change - window may be closing
        }
      }

      this.updateBounds();

      // Focus after everything is set up
      if (focus && workspacePath) {
        const view = this.workspaceViews.get(workspacePath);
        view?.webContents.focus();
      }
    } finally {
      this.isChangingWorkspace = false;
    }
  }

  /**
   * Gets the active workspace path.
   *
   * @returns The active workspace path or null if none
   */
  getActiveWorkspacePath(): string | null {
    return this.activeWorkspacePath;
  }

  /**
   * Focuses the active workspace view.
   * Use this to return focus to the workspace (e.g., after exiting shortcut mode).
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
   * Sets the UI mode.
   * - "workspace": UI at z-index 0, focus active workspace
   * - "shortcut": UI on top, focus UI layer
   * - "dialog": UI on top, no focus change
   *
   * Mode transitions are idempotent - setting the same mode twice does not emit an event.
   *
   * @param mode - The new UI mode
   */
  setMode(newMode: UIMode): void {
    const previousMode = this.mode;

    // Idempotent: no-op if same mode
    if (newMode === previousMode) {
      return;
    }

    this.mode = newMode;

    try {
      const window = this.windowManager.getWindow();
      if (window.isDestroyed()) return;

      const contentView = window.contentView;

      switch (newMode) {
        case "workspace":
          // Move UI to bottom (index 0 = behind workspaces)
          contentView.addChildView(this.uiView, 0);
          // Focus the active workspace
          this.focusActiveWorkspace();
          break;

        case "shortcut":
          // Move UI to top so overlay is visible above workspace views
          contentView.addChildView(this.uiView);
          // Focus UI layer so it receives keyboard events (including Alt release)
          // UI layer is always attached (never detached), so it reliably receives before-input-event
          this.focusUI();
          break;

        case "dialog":
          // Move UI to top (adding existing child moves it to end = top)
          contentView.addChildView(this.uiView);
          // Do NOT change focus - dialog component will manage focus
          break;
      }
    } catch {
      // Ignore errors during mode change - window may be closing
    }

    this.logger.debug("Mode changed", { mode: newMode, previous: previousMode });

    // Emit event to subscribers
    const event: UIModeChangedEvent = { mode: newMode, previousMode };
    for (const callback of this.modeChangeCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error("Error in mode change callback:", error);
      }
    }
  }

  /**
   * Gets the current UI mode.
   *
   * @returns The current UI mode
   */
  getMode(): UIMode {
    return this.mode;
  }

  /**
   * Subscribe to mode change events.
   *
   * @param callback - Called when mode changes, receives mode and previousMode
   * @returns Unsubscribe function
   */
  onModeChange(callback: (event: UIModeChangedEvent) => void): Unsubscribe {
    this.modeChangeCallbacks.add(callback);
    return () => {
      this.modeChangeCallbacks.delete(callback);
    };
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

    // Destroy all workspace views (fire-and-forget - app is shutting down)
    for (const path of this.workspaceViews.keys()) {
      void this.destroyWorkspaceView(path);
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
