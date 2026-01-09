/**
 * View manager for managing WebContentsViews.
 * Handles UI layer, workspace views, bounds, and focus management.
 */

import type { WebContents } from "electron";
import { basename } from "node:path";
import type { IViewManager, Unsubscribe, LoadingChangeCallback } from "./view-manager.interface";
import { WORKSPACE_LOADING_TIMEOUT_MS } from "./view-manager.interface";
import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type { WindowManager } from "./window-manager";
import { openExternal } from "../utils/external-url";
import { ShortcutController } from "../shortcut-controller";
import { projectDirName } from "../../services/platform/paths";
import type { WorkspaceName } from "../../shared/api/types";
import type { Logger } from "../../services/logging";
import { getErrorMessage } from "../../shared/error-utils";
import type { ViewLayer, WindowOpenDetails } from "../../services/shell/view";
import type { SessionLayer } from "../../services/shell/session";
import type { WindowLayerInternal } from "../../services/shell/window";
import type { ViewHandle, SessionHandle, WindowHandle } from "../../services/shell/types";

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
 * Dependencies for ViewManager.
 */
export interface ViewManagerDeps {
  /** Window manager for the main window */
  readonly windowManager: WindowManager;
  /** Window layer for accessing raw window */
  readonly windowLayer: WindowLayerInternal;
  /** View layer for view operations */
  readonly viewLayer: ViewLayer;
  /** Session layer for session operations */
  readonly sessionLayer: SessionLayer;
  /** Configuration */
  readonly config: ViewManagerConfig;
  /** Logger */
  readonly logger: Logger;
}

/**
 * Workspace state tracking.
 */
interface WorkspaceState {
  /** Handle to the view */
  handle: ViewHandle;
  /** Handle to the session */
  sessionHandle: SessionHandle;
  /** URL to load (stored for lazy loading) */
  url: string;
  /** Whether URL has been loaded */
  urlLoaded: boolean;
  /** Partition name for cleanup */
  partitionName: string;
}

/**
 * Manages WebContentsViews for the application.
 * Implements the IViewManager interface.
 */
export class ViewManager implements IViewManager {
  private readonly windowManager: WindowManager;
  private readonly windowLayer: WindowLayerInternal;
  private readonly viewLayer: ViewLayer;
  private readonly sessionLayer: SessionLayer;
  private readonly uiViewHandle: ViewHandle;
  private readonly shortcutController: ShortcutController;
  private codeServerPort: number;
  private readonly windowHandle: WindowHandle;
  /**
   * Map of workspace paths to their state.
   */
  private readonly workspaceStates: Map<string, WorkspaceState> = new Map();
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
   * Callbacks for workspace change events.
   */
  private readonly workspaceChangeCallbacks: Set<(path: string | null) => void> = new Set();
  /**
   * Reentrant guard to prevent concurrent workspace changes.
   */
  private isChangingWorkspace = false;
  private readonly unsubscribeResize: Unsubscribe;
  private readonly logger: Logger;
  /**
   * Tracks workspaces that are loading (waiting for OpenCode client to attach).
   * Maps workspace path to the timeout handle for cleanup.
   */
  private readonly loadingWorkspaces: Map<string, NodeJS.Timeout> = new Map();
  /**
   * Callbacks for loading state changes.
   */
  private readonly loadingChangeCallbacks: Set<LoadingChangeCallback> = new Set();

  private constructor(
    deps: ViewManagerDeps,
    uiViewHandle: ViewHandle,
    windowHandle: WindowHandle,
    shortcutController: ShortcutController
  ) {
    this.windowManager = deps.windowManager;
    this.windowLayer = deps.windowLayer;
    this.viewLayer = deps.viewLayer;
    this.sessionLayer = deps.sessionLayer;
    this.uiViewHandle = uiViewHandle;
    this.windowHandle = windowHandle;
    this.shortcutController = shortcutController;
    this.codeServerPort = deps.config.codeServerPort;
    this.logger = deps.logger;

    // Subscribe to resize events
    this.unsubscribeResize = this.windowManager.onResize(() => {
      this.updateBounds();
    });
  }

  /**
   * Creates a new ViewManager with a UI layer view.
   *
   * @param deps - Dependencies
   * @returns A new ViewManager instance
   */
  static create(deps: ViewManagerDeps): ViewManager {
    const { windowManager, windowLayer, viewLayer, config } = deps;

    // Create UI layer with security settings
    const uiViewHandle = viewLayer.createView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: config.uiPreloadPath,
      },
    });

    // Set transparent background for UI layer
    viewLayer.setBackgroundColor(uiViewHandle, "#00000000");

    // Get window handle
    const windowHandle = windowManager.getWindowHandle();

    // Add UI layer to window
    viewLayer.attachToWindow(uiViewHandle, windowHandle);

    // Use a holder object to break the circular dependency:
    // ShortcutController needs ViewManager methods, ViewManager needs ShortcutController
    const viewManagerHolder: { instance: ViewManager | null } = { instance: null };

    // Get raw window for ShortcutController (internal API)
    const rawWindow = windowLayer._getRawWindow(windowHandle);

    // Create ShortcutController with deps that reference the holder
    const shortcutController = new ShortcutController(rawWindow, {
      focusUI: () => viewManagerHolder.instance?.focusUI(),
      getUIWebContents: () => viewManagerHolder.instance?.getUIWebContents() ?? null,
      setMode: (mode) => viewManagerHolder.instance?.setMode(mode),
      getMode: () => viewManagerHolder.instance?.getMode() ?? "workspace",
      // Shortcut key callback - sends IPC event to renderer
      onShortcut: (key) => {
        viewManagerHolder.instance?.sendToUI(ApiIpcChannels.SHORTCUT_KEY, key);
      },
      logger: deps.logger,
    });

    const viewManager = new ViewManager(deps, uiViewHandle, windowHandle, shortcutController);
    viewManagerHolder.instance = viewManager;

    // Register UI view's webContents with shortcut controller for keyboard shortcuts
    const uiWebContents = viewManager.getUIWebContents();
    if (uiWebContents) {
      shortcutController.registerView(uiWebContents);
    }

    // Don't call updateBounds() here - let the resize event from maximize() trigger it.
    // On Linux, maximize() is async and bounds aren't available immediately.

    return viewManager;
  }

  /**
   * Returns the UI layer view handle.
   */
  getUIViewHandle(): ViewHandle {
    return this.uiViewHandle;
  }

  /**
   * Returns the UI layer WebContents for IPC communication.
   * Returns null if the view is destroyed.
   *
   * @deprecated Use sendToUI() for IPC communication when possible.
   */
  getUIWebContents(): WebContents | null {
    return this.viewLayer.getWebContents(this.uiViewHandle);
  }

  /**
   * Sends an IPC message to the UI layer.
   *
   * @param channel - IPC channel name
   * @param args - Arguments to send
   */
  sendToUI(channel: string, ...args: unknown[]): void {
    try {
      this.viewLayer.send(this.uiViewHandle, channel, ...args);
    } catch {
      // Ignore errors - view may be destroyed
    }
  }

  /**
   * Creates a new workspace view.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @param url - URL to load in the view (code-server URL)
   * @param projectPath - Absolute path to the project directory (for partition naming)
   * @param isNew - If true, marks workspace as loading until OpenCode client attaches.
   *                Defaults to false (existing workspaces loaded on startup skip loading state).
   * @returns Handle to the created view
   */
  createWorkspaceView(
    workspacePath: string,
    url: string,
    projectPath: string,
    isNew = false
  ): ViewHandle {
    // Generate partition name for session isolation
    // Format: persist:<projectDirName>/<workspaceName>
    // Using persist: prefix to enable persistent storage across app restarts
    const workspaceName = basename(workspacePath) as WorkspaceName;
    const partitionName = `persist:${projectDirName(projectPath)}/${workspaceName}`;

    // Get or create session for this partition
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

    // Create workspace view with security settings and partition for session isolation
    // Note: No preload script - keyboard capture is handled via main-process before-input-event
    const viewHandle = this.viewLayer.createView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: partitionName,
      },
    });

    // Set dark background to prevent white flash while VS Code loads
    this.viewLayer.setBackgroundColor(viewHandle, VIEW_BACKGROUND_COLOR);

    // Configure window open handler to open external URLs
    this.viewLayer.setWindowOpenHandler(viewHandle, (details: WindowOpenDetails) => {
      openExternal(details.url).catch((error: unknown) => {
        this.logger.warn("Failed to open external URL", {
          url: details.url,
          error: getErrorMessage(error),
        });
      });
      return { action: "deny" };
    });

    // Configure navigation handler to prevent navigation away from code-server
    this.viewLayer.onWillNavigate(viewHandle, (navigationUrl) => {
      const codeServerOrigin = `http://127.0.0.1:${this.codeServerPort}`;
      if (!navigationUrl.startsWith(codeServerOrigin)) {
        openExternal(navigationUrl).catch((error: unknown) => {
          this.logger.warn("Failed to open external URL", {
            url: navigationUrl,
            error: getErrorMessage(error),
          });
        });
        return false; // Prevent navigation to external URLs
      }
      return true; // Allow navigation within code-server
    });

    // Store workspace state
    this.workspaceStates.set(workspacePath, {
      handle: viewHandle,
      sessionHandle,
      url,
      urlLoaded: false,
      partitionName,
    });

    // Register with shortcut controller for Alt+X detection
    const webContents = this.getWorkspaceWebContents(viewHandle);
    if (webContents) {
      this.shortcutController.registerView(webContents);
    } else {
      this.logger.warn("Failed to register workspace view with ShortcutController", {
        workspace: workspaceName,
        viewId: viewHandle.id,
      });
    }

    // Only mark as loading for newly created workspaces (not existing ones loaded on startup)
    if (isNew) {
      const timeout = setTimeout(
        () => this.setWorkspaceLoaded(workspacePath),
        WORKSPACE_LOADING_TIMEOUT_MS
      );
      this.loadingWorkspaces.set(workspacePath, timeout);
      this.notifyLoadingChange(workspacePath, true);
    }

    // Note: No attachToWindow() - view starts detached
    // Note: No loadURL() - URL is loaded on first activation
    // Note: No setBounds() - detached views don't need bounds

    this.logger.debug("View created", { workspace: workspaceName });
    return viewHandle;
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
    const state = this.workspaceStates.get(workspacePath);
    if (!state) {
      return;
    }

    const workspaceName = basename(workspacePath);

    // Remove from maps FIRST to prevent re-entry during async operations
    // This makes the operation idempotent even if called concurrently
    this.workspaceStates.delete(workspacePath);

    // Clean up loading state
    const timeout = this.loadingWorkspaces.get(workspacePath);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      this.loadingWorkspaces.delete(workspacePath);
      this.notifyLoadingChange(workspacePath, false);
    }

    // Unregister from shortcut controller (safe even if view is destroyed)
    try {
      const webContents = this.getWorkspaceWebContents(state.handle);
      if (webContents) {
        this.shortcutController.unregisterView(webContents);
      }
    } catch {
      // Ignore errors - view may be in inconsistent state
    }

    // If this was the active workspace, clear it via setActiveWorkspace to trigger callbacks
    if (this.activeWorkspacePath === workspacePath) {
      this.setActiveWorkspace(null, false);
    }

    // If this was the attached workspace, clear it
    if (this.attachedWorkspacePath === workspacePath) {
      this.attachedWorkspacePath = null;
    }

    try {
      // Detach from window if attached
      try {
        this.viewLayer.detachFromWindow(state.handle);
      } catch {
        // View might already be detached - ignore
      }

      // Navigate to about:blank before closing (to release resources)
      try {
        // Create a timeout promise that resolves (not rejects) after NAVIGATION_TIMEOUT_MS
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, NAVIGATION_TIMEOUT_MS);
        });

        // Race navigation against timeout - both resolve, so no unhandled rejections
        await Promise.race([this.viewLayer.loadURL(state.handle, "about:blank"), timeoutPromise]);
      } catch {
        // Navigation failed - continue with cleanup
      }

      // Destroy the view
      try {
        this.viewLayer.destroy(state.handle);
      } catch {
        // View might already be destroyed - ignore
      }

      // Clear partition storage (best-effort - log errors and continue)
      try {
        await this.sessionLayer.clearStorageData(state.sessionHandle);
      } catch {
        // Intentional empty catch: Best-effort cleanup - storage clearing may fail
        // if session is in use or already cleared. We continue regardless.
      }
    } catch {
      // Ignore errors during cleanup - view may be in an inconsistent state
    }

    this.logger.debug("View destroyed", { workspace: workspaceName });
  }

  /**
   * Gets a workspace view handle by path.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns The ViewHandle or undefined if not found
   */
  getWorkspaceView(workspacePath: string): ViewHandle | undefined {
    return this.workspaceStates.get(workspacePath)?.handle;
  }

  /**
   * Updates view bounds for UI layer and active workspace only.
   * Called on window resize.
   *
   * Note: Only the active workspace needs bounds updated (O(1) not O(n)).
   * Inactive workspaces are detached from contentView and don't need bounds.
   */
  updateBounds(): void {
    // Guard: skip if window is destroyed (happens during app shutdown)
    if (this.windowLayer.isDestroyed(this.windowHandle)) {
      return;
    }

    const bounds = this.windowManager.getBounds();

    // Clamp to minimum dimensions
    const width = Math.max(bounds.width, MIN_WIDTH);
    const height = Math.max(bounds.height, MIN_HEIGHT);

    // UI layer: full window (so dialogs can overlay everything)
    this.viewLayer.setBounds(this.uiViewHandle, {
      x: 0,
      y: 0,
      width,
      height,
    });

    // Only update active workspace bounds (O(1) - inactive views are detached)
    if (this.activeWorkspacePath !== null) {
      const state = this.workspaceStates.get(this.activeWorkspacePath);
      if (state) {
        this.viewLayer.setBounds(state.handle, {
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
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;

    // Skip if already loaded (ensures URL is only loaded on first activation)
    if (state.urlLoaded) return;

    // Mark as loaded first to prevent re-entry
    state.urlLoaded = true;

    const workspaceName = basename(workspacePath);
    this.logger.info("Loading URL", { workspace: workspaceName, url: state.url });

    // Load the URL (fire-and-forget)
    void this.viewLayer.loadURL(state.handle, state.url);
  }

  /**
   * Attaches a workspace view to the contentView.
   * Handles errors gracefully.
   *
   * @param workspacePath - Path to the workspace
   */
  private attachView(workspacePath: string): void {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;

    try {
      if (!this.windowLayer.isDestroyed(this.windowHandle)) {
        this.viewLayer.attachToWindow(state.handle, this.windowHandle);
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
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;

    const workspaceName = basename(workspacePath);

    try {
      this.viewLayer.detachFromWindow(state.handle);
      this.logger.debug("View detached", { workspace: workspaceName });
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
    if (this.isChangingWorkspace) {
      return;
    }

    // Same workspace is no-op
    if (this.activeWorkspacePath === workspacePath) {
      return;
    }

    try {
      this.isChangingWorkspace = true;
      const previousPath = this.activeWorkspacePath;

      // Update state first
      this.activeWorkspacePath = workspacePath;

      // Load URL and attach new view FIRST (visual continuity - no gap)
      // But if workspace is loading, only load URL - don't attach until loaded
      if (workspacePath !== null) {
        this.loadViewUrl(workspacePath);
        // Only attach if workspace is not loading (loading workspaces stay detached)
        if (!this.loadingWorkspaces.has(workspacePath)) {
          this.attachView(workspacePath);
        }
      }

      // Then detach previous
      if (previousPath !== null && previousPath !== workspacePath) {
        this.detachView(previousPath);
      }

      // Maintain z-order if in dialog, shortcut, or hover mode
      // The new workspace view was just attached to the top, so we need to
      // re-add the UI layer to keep it on top. Must directly manipulate z-order
      // since setMode is idempotent and won't re-apply if mode hasn't changed.
      if (this.mode === "dialog" || this.mode === "shortcut" || this.mode === "hover") {
        try {
          if (!this.windowLayer.isDestroyed(this.windowHandle)) {
            // Re-attach UI view to move it to top
            this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle);
            // In shortcut mode, restore focus to UI layer (lost during re-attach)
            if (this.mode === "shortcut") {
              this.focusUI();
            }
          }
        } catch {
          // Ignore errors during z-order change - window may be closing
        }
      }

      this.updateBounds();

      // Focus after everything is set up
      // But NOT in shortcut mode - UI layer needs to keep focus for Alt key detection
      const willFocus = focus && workspacePath !== null && this.mode !== "shortcut";
      this.logger.debug("Focus decision", {
        focus,
        workspacePath: workspacePath ? basename(workspacePath) : null,
        mode: this.mode,
        willFocus,
      });
      if (willFocus) {
        const state = this.workspaceStates.get(workspacePath);
        if (state) {
          this.viewLayer.focus(state.handle);
        }
      }

      // Notify subscribers of workspace change
      for (const callback of this.workspaceChangeCallbacks) {
        try {
          callback(workspacePath);
        } catch (error) {
          this.logger.error(
            "Error in workspace change callback",
            {},
            error instanceof Error ? error : undefined
          );
        }
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

    const state = this.workspaceStates.get(this.activeWorkspacePath);
    if (state) {
      this.viewLayer.focus(state.handle);
    }
  }

  /**
   * Focuses the UI layer view.
   */
  focusUI(): void {
    this.viewLayer.focus(this.uiViewHandle);
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
      if (this.windowLayer.isDestroyed(this.windowHandle)) return;

      switch (newMode) {
        case "workspace":
          // Move UI to bottom (index 0) - workspace on top
          this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle, 0);
          // Focus the active workspace
          this.focusActiveWorkspace();
          break;

        case "shortcut":
          // Move UI to top (no index = append to top)
          this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle);
          // Focus UI layer so it receives keyboard events
          this.focusUI();
          break;

        case "hover":
        case "dialog":
          // Move UI to top (no index = append to top)
          this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle);
          // Do NOT change focus - hover/dialog component will manage focus
          break;

        default: {
          const _exhaustive: never = newMode;
          this.logger.warn("Unhandled UI mode", { mode: _exhaustive });
        }
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
        this.logger.error(
          "Error in mode change callback",
          { mode: newMode },
          error instanceof Error ? error : undefined
        );
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
   * Subscribe to workspace change events.
   *
   * @param callback - Called when active workspace changes
   * @returns Unsubscribe function
   */
  onWorkspaceChange(callback: (path: string | null) => void): Unsubscribe {
    this.workspaceChangeCallbacks.add(callback);
    return () => {
      this.workspaceChangeCallbacks.delete(callback);
    };
  }

  /**
   * Checks if a workspace is currently loading.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns True if the workspace is loading, false otherwise
   */
  isWorkspaceLoading(workspacePath: string): boolean {
    return this.loadingWorkspaces.has(workspacePath);
  }

  /**
   * Marks a workspace as loaded, attaching its view if active.
   * Called when the first OpenCode client attaches or the timeout expires.
   * Idempotent: safe to call multiple times or for non-loading workspaces.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  setWorkspaceLoaded(workspacePath: string): void {
    // Guard: no-op if workspace isn't loading
    if (!this.loadingWorkspaces.has(workspacePath)) {
      return;
    }

    // Clear the timeout
    const timeout = this.loadingWorkspaces.get(workspacePath);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    // Remove from loading map
    this.loadingWorkspaces.delete(workspacePath);

    // Notify listeners
    this.notifyLoadingChange(workspacePath, false);

    // If this workspace is active, attach the view and focus it
    if (this.activeWorkspacePath === workspacePath) {
      this.attachView(workspacePath);

      // Maintain z-order if in dialog, shortcut, or hover mode
      // (UI must stay on top of workspace views)
      if (this.mode === "dialog" || this.mode === "shortcut" || this.mode === "hover") {
        try {
          if (!this.windowLayer.isDestroyed(this.windowHandle)) {
            this.viewLayer.attachToWindow(this.uiViewHandle, this.windowHandle);
            // Restore focus to UI layer (may have been lost during re-attach)
            // Dialog's focus trap will restore focus to the correct element
            this.focusUI();
          }
        } catch {
          // Ignore errors - window may be closing
        }
      }

      // Only focus if not in dialog mode (native dialog may be open)
      if (this.mode !== "dialog") {
        const state = this.workspaceStates.get(workspacePath);
        if (state) {
          this.viewLayer.focus(state.handle);
        }
      }
    }

    const workspaceName = basename(workspacePath);
    this.logger.debug("Workspace loaded", { workspace: workspaceName });
  }

  /**
   * Subscribe to loading state changes.
   *
   * @param callback - Called with (path, loading) when loading state changes
   * @returns Unsubscribe function
   */
  onLoadingChange(callback: LoadingChangeCallback): Unsubscribe {
    this.loadingChangeCallbacks.add(callback);
    return () => {
      this.loadingChangeCallbacks.delete(callback);
    };
  }

  /**
   * Notifies listeners of a loading state change.
   * @param path - Workspace path
   * @param loading - True if workspace is now loading, false if loaded
   */
  private notifyLoadingChange(path: string, loading: boolean): void {
    for (const callback of this.loadingChangeCallbacks) {
      try {
        callback(path, loading);
      } catch (error) {
        this.logger.error(
          "Error in loading change callback",
          { path, loading },
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Preloads a workspace's URL without attaching the view.
   *
   * Loads the code-server URL in the background so the workspace is ready
   * when the user navigates to it. The view remains detached (no GPU usage)
   * until setActiveWorkspace() is called.
   *
   * Idempotent: delegates to loadViewUrl() which checks urlLoaded flag.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  preloadWorkspaceUrl(workspacePath: string): void {
    const workspaceName = basename(workspacePath);
    this.logger.debug("Preloading URL", { workspace: workspaceName });
    this.loadViewUrl(workspacePath);
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
    for (const path of this.workspaceStates.keys()) {
      void this.destroyWorkspaceView(path);
    }

    // Destroy UI view
    try {
      this.viewLayer.destroy(this.uiViewHandle);
    } catch {
      // Ignore errors during cleanup - view may be in an inconsistent state
    }
  }

  /**
   * Gets the WebContents for a workspace view handle.
   * This is a helper for ShortcutController registration.
   */
  private getWorkspaceWebContents(handle: ViewHandle): WebContents | null {
    return this.viewLayer.getWebContents(handle);
  }
}
