/**
 * Test utilities for ViewManager.
 *
 * Provides a stateful mock implementing `IViewManager` with sensible no-op
 * defaults for every method. Tests override only the slices they care about
 * via the `overrides` argument.
 */
import { vi } from "vitest";
import type { IViewManager } from "./view-manager.interface";
import type { UIMode } from "../../shared/ipc";

export interface CreateMockViewManagerOptions {
  /** Initial mode. Default: "workspace". */
  initialMode?: UIMode;
  /** Override any subset of the IViewManager API. */
  overrides?: Partial<IViewManager>;
}

/**
 * Create a mock ViewManager. State is held in closures; mode mutates in
 * place when setMode is called.
 *
 * The returned object satisfies IViewManager. Pass `overrides` to plug in
 * specific behavior for methods your test exercises.
 */
export function createMockViewManager(options?: CreateMockViewManagerOptions): IViewManager {
  let currentMode: UIMode = options?.initialMode ?? "workspace";

  const base: IViewManager = {
    create: vi.fn(),
    getUIDevtoolsTarget: vi.fn(),
    getActiveWorkspaceDevtoolsTarget: vi.fn(),
    getUIKeyboardTarget: vi.fn(),
    getWorkspaceKeyboardTarget: vi.fn(),
    isUIAvailable: vi.fn().mockReturnValue(true),
    loadUIContent: vi.fn().mockResolvedValue(undefined),
    sendToUI: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn().mockResolvedValue(undefined),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn().mockReturnValue(null),
    focus: vi.fn(),
    setMode: vi.fn((mode: UIMode) => {
      currentMode = mode;
    }),
    getMode: vi.fn(() => currentMode),
    onModeChange: vi.fn(() => () => {}),
    onWorkspaceChange: vi.fn(() => () => {}),
    updateCodeServerPort: vi.fn(),
    isWorkspaceLoading: vi.fn().mockReturnValue(false),
    setWorkspaceLoaded: vi.fn(),
    onLoadingChange: vi.fn(() => () => {}),
    reloadAllViews: vi.fn(),
    preloadWorkspaceUrl: vi.fn(),
    destroy: vi.fn(),
    captureWorkspaceView: vi.fn().mockResolvedValue(null),
  } as IViewManager;

  return { ...base, ...(options?.overrides ?? {}) };
}
