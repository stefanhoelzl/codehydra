/**
 * Test utilities for the UI view manager.
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
    getUIViewHandle: vi.fn().mockReturnValue({ id: "ui-view", __brand: "ViewHandle" }),
    getUIDevtoolsTarget: vi.fn(),
    getUIKeyboardTarget: vi.fn(),
    isUIAvailable: vi.fn().mockReturnValue(true),
    loadUIContent: vi.fn().mockResolvedValue(undefined),
    sendToUI: vi.fn(),
    focus: vi.fn(),
    setMode: vi.fn((mode: UIMode) => {
      currentMode = mode;
    }),
    getMode: vi.fn(() => currentMode),
    captureActiveWorkspaceView: vi.fn().mockResolvedValue(null),
    destroy: vi.fn(),
  } as IViewManager;

  return { ...base, ...(options?.overrides ?? {}) };
}
