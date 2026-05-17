/**
 * Abstract base for IViewManager implementations.
 *
 * Owns the entire UI/state-machine layer that every implementation must share:
 * mode + active-workspace + loading bookkeeping, the attach-before-detach
 * sequencing, z-order re-raise rules, focus routing, bounds math, event
 * subscriptions, and the workspace registry. Concrete implementations only
 * need to fill in the protected primitives below — actual creation, attach/
 * detach, URL loading, focus calls into their underlying view technology.
 *
 * Two-phase init: subclass constructor calls super(deps), then `create()`
 * is called once before any other method (it creates the UI view via the
 * subclass primitive and wires the resize listener).
 */

import { basename } from "node:path";
import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";
import type { Logger } from "../platform/logging";
import type { SessionHandle, ViewHandle } from "./types";
import type { IViewManager, LoadingChangeCallback, Unsubscribe } from "./view-manager.interface";
import { WORKSPACE_LOADING_TIMEOUT_MS } from "./view-manager.interface";
import type { Rect, WorkspaceState } from "./view-manager-types";
import { computeUIRect, computeWorkspaceRect } from "./view-manager-types";
import type { WindowManager } from "./window-manager";

/**
 * Dependencies the base class needs. Concrete implementations extend this
 * with their own per-implementation dependencies.
 */
export interface BaseViewManagerDeps {
  readonly windowManager: WindowManager;
  readonly logger: Logger;
  readonly codeServerPort: number;
}

/**
 * Result of creating a workspace view's underlying primitives. Returned by
 * the `createWorkspaceViewImpl` subclass primitive and stored in the shared
 * `WorkspaceState`.
 */
export interface CreatedWorkspaceView {
  readonly handle: ViewHandle;
  readonly sessionHandle: SessionHandle;
  readonly partitionName: string;
}

export abstract class BaseViewManager implements IViewManager {
  protected readonly windowManager: WindowManager;
  protected readonly logger: Logger;
  protected codeServerPort: number;

  protected uiViewHandle!: ViewHandle;

  protected readonly workspaceStates: Map<string, WorkspaceState> = new Map();
  protected activeWorkspacePath: string | null = null;
  protected attachedWorkspacePath: string | null = null;
  protected mode: UIMode = "workspace";
  protected destroying = false;
  private isChangingWorkspace = false;
  protected readonly loadingWorkspaces: Map<string, NodeJS.Timeout> = new Map();

  private readonly modeChangeCallbacks: Set<(event: UIModeChangedEvent) => void> = new Set();
  private readonly workspaceChangeCallbacks: Set<(path: string | null) => void> = new Set();
  private readonly loadingChangeCallbacks: Set<LoadingChangeCallback> = new Set();

  private unsubscribeResize: Unsubscribe | null = null;

  constructor(deps: BaseViewManagerDeps) {
    this.windowManager = deps.windowManager;
    this.logger = deps.logger;
    this.codeServerPort = deps.codeServerPort;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  create(): void {
    this.uiViewHandle = this.createUIView();
    this.unsubscribeResize = this.windowManager.onResize(() => {
      this.updateBounds();
    });
  }

  destroy(): void {
    this.destroying = true;

    if (this.unsubscribeResize) {
      this.unsubscribeResize();
      this.unsubscribeResize = null;
    }

    // Destroy all workspace views (fire-and-forget - app is shutting down)
    for (const path of this.workspaceStates.keys()) {
      void this.destroyWorkspaceView(path);
    }

    try {
      this.destroyUIView();
    } catch {
      // Ignore errors during cleanup
    }
  }

  // ---------------------------------------------------------------------------
  // UI view accessors
  // ---------------------------------------------------------------------------

  getUIViewHandle(): ViewHandle {
    return this.uiViewHandle;
  }

  isUIAvailable(): boolean {
    return this.isUIViewAvailable();
  }

  sendToUI(channel: string, ...args: unknown[]): void {
    try {
      this.sendToUIView(channel, args);
    } catch {
      // Ignore errors - view may be destroyed
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace lifecycle
  // ---------------------------------------------------------------------------

  createWorkspaceView(
    workspacePath: string,
    url: string,
    projectPath: string,
    isNew = false
  ): ViewHandle {
    const { handle, sessionHandle, partitionName } = this.createWorkspaceViewImpl(
      workspacePath,
      url,
      projectPath
    );

    this.workspaceStates.set(workspacePath, {
      handle,
      sessionHandle,
      url,
      urlLoaded: false,
      partitionName,
      retryCount: 0,
      retryTimer: null,
      needsReloadOnAttach: false,
      reloadWatchdogTimer: null,
    });

    if (isNew) {
      const timeout = setTimeout(
        () => this.setWorkspaceLoaded(workspacePath),
        WORKSPACE_LOADING_TIMEOUT_MS
      );
      this.loadingWorkspaces.set(workspacePath, timeout);
      this.notifyLoadingChange(workspacePath, true);
    }

    return handle;
  }

  async destroyWorkspaceView(workspacePath: string): Promise<void> {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;

    // Remove from registry FIRST to make this idempotent under concurrent
    // calls and to prevent re-entry during the async teardown below.
    this.workspaceStates.delete(workspacePath);

    // Clear loading state
    const timeout = this.loadingWorkspaces.get(workspacePath);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      this.loadingWorkspaces.delete(workspacePath);
      this.notifyLoadingChange(workspacePath, false);
    }

    // If this was the active workspace, clear it (triggers callbacks via setActiveWorkspace)
    if (this.activeWorkspacePath === workspacePath) {
      this.setActiveWorkspace(null);
    }

    // If this was the attached workspace, clear the tracker
    if (this.attachedWorkspacePath === workspacePath) {
      this.attachedWorkspacePath = null;
    }

    await this.destroyWorkspaceViewImpl(state);

    this.logger.debug("View destroyed", { workspace: basename(workspacePath) });
  }

  getWorkspaceView(workspacePath: string): ViewHandle | undefined {
    return this.workspaceStates.get(workspacePath)?.handle;
  }

  async captureWorkspaceView(workspacePath: string): Promise<Buffer | null> {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return null;
    return this.capturePNG(state.handle);
  }

  preloadWorkspaceUrl(workspacePath: string): void {
    this.logger.debug("Preloading URL", { workspace: basename(workspacePath) });
    this.loadViewUrl(workspacePath);
  }

  updateCodeServerPort(port: number): void {
    this.codeServerPort = port;
  }

  /**
   * Default implementation: iterate every workspace whose URL has been loaded
   * and is not currently in a loading state, and ask the subclass to reload
   * each one. Subclasses may override to add watchdog/recovery behavior.
   */
  reloadAllViews(): void {
    for (const [workspacePath, state] of this.workspaceStates) {
      if (!state.urlLoaded) continue;
      if (this.loadingWorkspaces.has(workspacePath)) continue;
      this.reloadWorkspaceView(state);
    }
  }

  // ---------------------------------------------------------------------------
  // Bounds
  // ---------------------------------------------------------------------------

  updateBounds(): void {
    if (!this.isWindowAlive()) return;

    const bounds = this.windowManager.getBounds();

    // UI layer: full window (so dialogs can overlay everything)
    this.applyBounds(this.uiViewHandle, computeUIRect(bounds));

    // Only update active workspace bounds (O(1) - inactive views are detached).
    // Loading workspaces are also updated: they are detached but setBounds keeps
    // the renderer viewport in sync so code-server re-layouts at the correct size.
    if (this.activeWorkspacePath !== null) {
      const state = this.workspaceStates.get(this.activeWorkspacePath);
      if (state) {
        this.applyBounds(state.handle, computeWorkspaceRect(bounds));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Active workspace
  // ---------------------------------------------------------------------------

  setActiveWorkspace(workspacePath: string | null, focus: boolean = true): void {
    if (this.isChangingWorkspace) return;

    // Same workspace is usually a no-op, except when the active path was kept
    // in place across a destroy + recreate cycle (e.g. hibernate → wake) and
    // the new view exists but isn't attached yet — in that case we must run
    // through loadViewUrl + attachView once to bring the view onscreen.
    if (this.activeWorkspacePath === workspacePath) {
      if (workspacePath === null) return;
      const state = this.workspaceStates.get(workspacePath);
      const needsAttach =
        state !== undefined &&
        this.attachedWorkspacePath !== workspacePath &&
        !this.loadingWorkspaces.has(workspacePath);
      if (!needsAttach) return;
      this.loadViewUrl(workspacePath);
      this.attachView(workspacePath);
      this.updateBounds();
      if (focus) this.focus();
      return;
    }

    try {
      this.isChangingWorkspace = true;
      const previousPath = this.activeWorkspacePath;

      this.activeWorkspacePath = workspacePath;

      // Load URL and attach new view FIRST (visual continuity - no gap)
      if (workspacePath !== null) {
        this.loadViewUrl(workspacePath);
        if (!this.loadingWorkspaces.has(workspacePath)) {
          this.attachView(workspacePath);
        }
        // Loading workspaces stay detached with full-size bounds (set at creation).
        // Alt+X works via the UI view's before-input-event (focus goes to UI).
      }

      // Then detach previous
      if (previousPath !== null && previousPath !== workspacePath) {
        this.detachView(previousPath);
      }

      // Maintain z-order: if we're in a mode where the UI should be on top
      // (dialog/shortcut/hover) we need to raise it back above the new
      // workspace view. In plain "workspace" mode we still re-attach the UI
      // at the bottom with the redraw flag set to force Windows to repaint
      // the transparent sidebar strip.
      if (this.mode === "dialog" || this.mode === "shortcut" || this.mode === "hover") {
        try {
          if (this.isWindowAlive()) {
            this.bringUIToTop();
            if (this.mode === "shortcut") {
              this.focus();
            } else {
              this.focusUIView();
            }
          }
        } catch {
          // Ignore errors during z-order change - window may be closing
        }
      } else {
        try {
          if (this.isWindowAlive()) {
            this.bringUIToBottom(true);
          }
        } catch {
          // window may be closing
        }
      }

      this.updateBounds();

      if (focus) {
        this.focus();
      }

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

  getActiveWorkspacePath(): string | null {
    return this.activeWorkspacePath;
  }

  onWorkspaceChange(callback: (path: string | null) => void): Unsubscribe {
    this.workspaceChangeCallbacks.add(callback);
    return () => {
      this.workspaceChangeCallbacks.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // Focus
  // ---------------------------------------------------------------------------

  focus(): void {
    if (this.destroying) return;

    switch (this.mode) {
      case "dialog":
      case "hover":
        // These modes manage their own focus via traps/handlers
        break;
      case "shortcut":
        this.logger.debug("focus", { target: "ui", mode: this.mode });
        this.focusUIView();
        break;
      case "workspace": {
        const topView = this.getTopView();
        this.logger.debug("focus", {
          target: topView === this.uiViewHandle ? "ui" : "workspace",
          mode: this.mode,
          attachedWorkspace: this.attachedWorkspacePath
            ? basename(this.attachedWorkspacePath)
            : null,
        });
        this.focusHandle(topView);
        break;
      }
    }
  }

  /**
   * Returns the topmost focusable view handle.
   * If an active workspace is attached (not loading), returns it.
   * Otherwise returns the UI view (loading workspaces are detached,
   * so focus goes to the UI view where Alt+X detection works).
   */
  protected getTopView(): ViewHandle {
    if (
      this.activeWorkspacePath !== null &&
      !this.loadingWorkspaces.has(this.activeWorkspacePath)
    ) {
      const state = this.workspaceStates.get(this.activeWorkspacePath);
      if (state) return state.handle;
    }
    return this.uiViewHandle;
  }

  protected focusUIView(): void {
    this.focusHandle(this.uiViewHandle);
  }

  // ---------------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------------

  setMode(newMode: UIMode): void {
    const previousMode = this.mode;
    if (newMode === previousMode) return;

    this.mode = newMode;

    try {
      if (this.isWindowAlive()) {
        switch (newMode) {
          case "workspace":
            this.bringUIToBottom(false);
            this.focus();
            break;
          case "shortcut":
            this.bringUIToTop();
            this.focus();
            break;
          case "hover":
          case "dialog":
            this.bringUIToTop();
            // Do NOT change focus - hover/dialog component manages its own focus
            break;
          default: {
            const _exhaustive: never = newMode;
            this.logger.warn("Unhandled UI mode", { mode: _exhaustive });
          }
        }
      }
    } catch {
      // Ignore errors during mode change - window may be closing
    }

    this.logger.debug("Mode changed", { mode: newMode, previous: previousMode });

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

  getMode(): UIMode {
    return this.mode;
  }

  onModeChange(callback: (event: UIModeChangedEvent) => void): Unsubscribe {
    this.modeChangeCallbacks.add(callback);
    return () => {
      this.modeChangeCallbacks.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  isWorkspaceLoading(workspacePath: string): boolean {
    return this.loadingWorkspaces.has(workspacePath);
  }

  setWorkspaceLoaded(workspacePath: string): void {
    if (!this.loadingWorkspaces.has(workspacePath)) return;

    const timeout = this.loadingWorkspaces.get(workspacePath);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    this.loadingWorkspaces.delete(workspacePath);

    this.notifyLoadingChange(workspacePath, false);

    if (this.activeWorkspacePath === workspacePath) {
      this.attachView(workspacePath);
      this.updateBounds();

      // Maintain z-order: UI must stay in correct position relative to workspace
      if (this.mode === "dialog" || this.mode === "shortcut" || this.mode === "hover") {
        try {
          if (this.isWindowAlive()) {
            this.bringUIToTop();
          }
        } catch {
          // Ignore errors - window may be closing
        }
      } else {
        try {
          if (this.isWindowAlive()) {
            this.bringUIToBottom(true);
          }
        } catch {
          // window may be closing
        }
      }

      // In dialog/hover mode, the view re-attachment above may have shifted
      // focus to the workspace view. Restore focus to the UI view so the
      // renderer's focus trap continues to work.
      if (this.mode === "dialog" || this.mode === "hover") {
        this.focusUIView();
      } else {
        this.focus();
      }
    }
    // Inactive: no-op (view stays detached, URL already loaded)

    this.logger.debug("Workspace loaded", { workspace: basename(workspacePath) });
  }

  onLoadingChange(callback: LoadingChangeCallback): Unsubscribe {
    this.loadingChangeCallbacks.add(callback);

    // Late-binding replay: catch workspaces whose loading=false events were
    // lost before this callback was wired (e.g., during startup).
    for (const workspacePath of this.workspaceStates.keys()) {
      if (!this.loadingWorkspaces.has(workspacePath)) {
        try {
          callback(workspacePath, false);
        } catch (error) {
          this.logger.error(
            "Error in loading change callback (initial emit)",
            { path: workspacePath, loading: false },
            error instanceof Error ? error : undefined
          );
        }
      }
    }

    return () => {
      this.loadingChangeCallbacks.delete(callback);
    };
  }

  protected notifyLoadingChange(path: string, loading: boolean): void {
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

  // ---------------------------------------------------------------------------
  // Attach / detach + URL load (shared bookkeeping, primitive does the work)
  // ---------------------------------------------------------------------------

  protected loadViewUrl(workspacePath: string): void {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;
    if (state.urlLoaded) return;
    state.urlLoaded = true;
    this.startLoadingUrl(state);
  }

  protected attachView(workspacePath: string): void {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;
    if (!this.isWindowAlive()) return;
    try {
      this.attachViewImpl(state);
      this.attachedWorkspacePath = workspacePath;
      this.logger.debug("View attached", { workspace: basename(workspacePath) });
    } catch {
      // Ignore errors during attach - window may be closing
    }
  }

  protected detachView(workspacePath: string): void {
    const state = this.workspaceStates.get(workspacePath);
    if (!state) return;
    try {
      this.detachViewImpl(state);
      this.logger.debug("View detached", { workspace: basename(workspacePath) });
    } catch {
      // Ignore errors during detach - window may be closing
    }
    if (this.attachedWorkspacePath === workspacePath) {
      this.attachedWorkspacePath = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Abstract primitives (implementation-specific I/O)
  // ---------------------------------------------------------------------------

  /**
   * Create the UI view fully wired (created, security configured, attached
   * to the window, background colored). Returns the handle that the base
   * will hold onto for the rest of its lifetime.
   */
  protected abstract createUIView(): ViewHandle;

  /** Destroy the UI view. May throw; the base wraps it in try/catch. */
  protected abstract destroyUIView(): void;

  protected abstract isUIViewAvailable(): boolean;

  protected abstract sendToUIView(channel: string, args: unknown[]): void;

  protected abstract capturePNG(handle: ViewHandle): Promise<Buffer | null>;

  /** True if the underlying window is alive and operations are safe. */
  protected abstract isWindowAlive(): boolean;

  /**
   * Create a fresh per-workspace view, wire its handlers, set initial bounds.
   * Does NOT attach to the window and does NOT load the URL.
   */
  protected abstract createWorkspaceViewImpl(
    workspacePath: string,
    url: string,
    projectPath: string
  ): CreatedWorkspaceView;

  /**
   * Best-effort teardown of a workspace view: clear impl-private timers,
   * detach if attached, navigate to about:blank if needed, destroy.
   */
  protected abstract destroyWorkspaceViewImpl(state: WorkspaceState): Promise<void>;

  /** Start loading the URL on the underlying view (fire-and-forget). */
  protected abstract startLoadingUrl(state: WorkspaceState): void;

  /**
   * Attach the workspace view to the window. Implementations are free to
   * also perform impl-private cleanup (e.g. reload-on-attach for crashed
   * renderers).
   */
  protected abstract attachViewImpl(state: WorkspaceState): void;

  protected abstract detachViewImpl(state: WorkspaceState): void;

  protected abstract applyBounds(handle: ViewHandle, rect: Rect): void;

  protected abstract focusHandle(handle: ViewHandle): void;

  /** Raise the UI view to the top of the stack. */
  protected abstract bringUIToTop(): void;

  /**
   * Lower the UI view to the bottom of the stack. `forceRedraw` is a hint
   * to force a re-composite (used after active-workspace switches to work
   * around the Windows DirectComposition transparent-sidebar bug).
   */
  protected abstract bringUIToBottom(forceRedraw: boolean): void;

  /**
   * Reload one workspace view as part of `reloadAllViews`. Default
   * `reloadAllViews` iterates and calls this per workspace; subclasses may
   * use this hook to add watchdog/recovery behavior.
   */
  protected abstract reloadWorkspaceView(state: WorkspaceState): void;
}
