/**
 * ViewManager — composition-root facade that picks its backend at `create()`
 * time based on `experimental.iframes`.
 *
 * Construction is cheap (just captures deps). The backend choice happens in
 * `create()`, which is called from the `app-start/init` hook — AFTER
 * `configService.load()` has resolved CLI/env/file overrides. This lets the
 * flag flow through the normal config system without re-ordering the rest of
 * main.ts (modules can still register their own keys lazily in their
 * factories).
 *
 * The two concrete implementations (`WebContentsViewManager` and
 * `IframeViewManager`) remain as-is — both extend `BaseViewManager` and are
 * unit-tested directly via the conformance suite. This class is a thin
 * delegating wrapper; production code always constructs `ViewManager`, never
 * the concrete subclasses.
 */

import type { PersistedAccessor } from "../platform/store-definition";
import type { Logger } from "../platform/logging";
import type { AppBoundary } from "./app";
import type { SessionBoundary } from "./session";
import type { ViewBoundary } from "./view";
import type { ViewHandle } from "./types";
import type { WindowBoundaryInternal } from "./window";
import type { WindowManager } from "./window-manager";
import { IframeViewManager } from "./iframe-view-manager";
import { WebContentsViewManager } from "./webcontents-view-manager";
import type { IViewManager, LoadingChangeCallback, Unsubscribe } from "./view-manager.interface";
import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";
import type { DevtoolsTarget, KeyboardTarget } from "./view-manager-types";

export interface ViewManagerConfig {
  /** Path to the UI layer preload script */
  readonly uiPreloadPath: string;
  /** Code-server port number */
  readonly codeServerPort: number;
  /** Path to the workspace host HTML page (used in iframe mode) */
  readonly workspaceHostHtmlPath: string;
}

export interface ViewManagerDeps {
  readonly windowManager: WindowManager;
  readonly windowLayer: WindowBoundaryInternal;
  readonly viewLayer: ViewBoundary;
  readonly sessionLayer: SessionBoundary;
  readonly appLayer: Pick<AppBoundary, "openUrl">;
  /** Accessor for the iframe-rendering flag (registered in the composition root). */
  readonly iframesConfig: PersistedAccessor<boolean>;
  readonly config: ViewManagerConfig;
  readonly logger: Logger;
}

export class ViewManager implements IViewManager {
  private impl: IViewManager | null = null;

  constructor(private readonly deps: ViewManagerDeps) {}

  create(): void {
    if (this.impl) return; // idempotent
    const useIframes = this.deps.iframesConfig.get();
    this.impl = useIframes
      ? new IframeViewManager({
          windowManager: this.deps.windowManager,
          windowLayer: this.deps.windowLayer,
          viewLayer: this.deps.viewLayer,
          sessionLayer: this.deps.sessionLayer,
          appLayer: this.deps.appLayer,
          config: {
            uiPreloadPath: this.deps.config.uiPreloadPath,
            codeServerPort: this.deps.config.codeServerPort,
            workspaceHostHtmlPath: this.deps.config.workspaceHostHtmlPath,
          },
          logger: this.deps.logger,
        })
      : new WebContentsViewManager({
          windowManager: this.deps.windowManager,
          windowLayer: this.deps.windowLayer,
          viewLayer: this.deps.viewLayer,
          sessionLayer: this.deps.sessionLayer,
          appLayer: this.deps.appLayer,
          config: {
            uiPreloadPath: this.deps.config.uiPreloadPath,
            codeServerPort: this.deps.config.codeServerPort,
          },
          logger: this.deps.logger,
        });
    this.impl.create();
  }

  private get vm(): IViewManager {
    if (!this.impl) throw new Error("ViewManager.create() has not been called yet");
    return this.impl;
  }

  // ---------------------------------------------------------------------------
  // IViewManager — full delegation
  // ---------------------------------------------------------------------------

  getUIViewHandle(): ViewHandle {
    return this.vm.getUIViewHandle();
  }
  getUIDevtoolsTarget(): DevtoolsTarget {
    return this.vm.getUIDevtoolsTarget();
  }
  getActiveWorkspaceDevtoolsTarget(): DevtoolsTarget | undefined {
    return this.vm.getActiveWorkspaceDevtoolsTarget();
  }
  getUIKeyboardTarget(): KeyboardTarget {
    return this.vm.getUIKeyboardTarget();
  }
  getWorkspaceKeyboardTarget(path: string): KeyboardTarget | undefined {
    return this.vm.getWorkspaceKeyboardTarget(path);
  }
  isUIAvailable(): boolean {
    return this.impl?.isUIAvailable() ?? false;
  }
  loadUIContent(htmlPath: string): Promise<void> {
    return this.vm.loadUIContent(htmlPath);
  }
  sendToUI(channel: string, ...args: unknown[]): void {
    // Pre-create sends are dropped silently — UI doesn't exist yet.
    this.impl?.sendToUI(channel, ...args);
  }
  createWorkspaceView(path: string, url: string, projectPath: string, isNew?: boolean): ViewHandle {
    return this.vm.createWorkspaceView(path, url, projectPath, isNew);
  }
  destroyWorkspaceView(path: string): Promise<void> {
    return this.impl ? this.impl.destroyWorkspaceView(path) : Promise.resolve();
  }
  updateBounds(): void {
    this.impl?.updateBounds();
  }
  setActiveWorkspace(path: string | null, focus?: boolean): void {
    this.vm.setActiveWorkspace(path, focus);
  }
  getActiveWorkspacePath(): string | null {
    return this.impl?.getActiveWorkspacePath() ?? null;
  }
  focus(): void {
    this.impl?.focus();
  }
  setMode(mode: UIMode): void {
    this.vm.setMode(mode);
  }
  getMode(): UIMode {
    return this.impl?.getMode() ?? "workspace";
  }
  onModeChange(cb: (e: UIModeChangedEvent) => void): Unsubscribe {
    return this.vm.onModeChange(cb);
  }
  onWorkspaceChange(cb: (path: string | null) => void): Unsubscribe {
    return this.vm.onWorkspaceChange(cb);
  }
  updateCodeServerPort(port: number): void {
    this.impl?.updateCodeServerPort(port);
  }
  isWorkspaceLoading(path: string): boolean {
    return this.impl?.isWorkspaceLoading(path) ?? false;
  }
  setWorkspaceLoaded(path: string): void {
    this.impl?.setWorkspaceLoaded(path);
  }
  onLoadingChange(cb: LoadingChangeCallback): Unsubscribe {
    return this.vm.onLoadingChange(cb);
  }
  reloadAllViews(): void {
    this.impl?.reloadAllViews();
  }
  preloadWorkspaceUrl(path: string): void {
    this.impl?.preloadWorkspaceUrl(path);
  }
  destroy(): void {
    this.impl?.destroy();
  }
  captureWorkspaceView(path: string): Promise<Buffer | null> {
    return this.impl ? this.impl.captureWorkspaceView(path) : Promise.resolve(null);
  }
}
