/**
 * Test utilities for WindowManager.
 * Provides mock factory for consistent WindowManager mocking across test files.
 */

import { vi, type Mock } from "vitest";
import type { WindowManager, ContentBounds, Unsubscribe } from "./window-manager";
import type { WindowHandle } from "../../services/shell/types";
import { createWindowHandle } from "../../services/shell/types";
import type { ImageHandle } from "../../services/platform/types";

/**
 * Mock WindowManager with vitest spy methods.
 * All method calls are recorded for assertion.
 */
export interface MockWindowManager {
  create: Mock<WindowManager["create"]>;
  getWindowHandle: Mock<WindowManager["getWindowHandle"]>;
  getBounds: Mock<WindowManager["getBounds"]>;
  onResize: Mock<WindowManager["onResize"]>;
  maximizeAsync: Mock<WindowManager["maximizeAsync"]>;
  focus: Mock<WindowManager["focus"]>;
  setTitle: Mock<WindowManager["setTitle"]>;
  setOverlayIcon: Mock<WindowManager["setOverlayIcon"]>;
  close: Mock<WindowManager["close"]>;

  /**
   * Get all calls to setOverlayIcon with their arguments.
   * Useful for badge-manager tests that need to inspect overlay icon state.
   */
  getOverlayIconCalls(): Array<{ image: ImageHandle | null; description: string }>;
}

/**
 * Options for customizing the mock WindowManager.
 */
export interface MockWindowManagerOptions {
  /** WindowHandle returned by getWindowHandle(). Defaults to createWindowHandle("test-window-1"). */
  readonly windowHandle?: WindowHandle;
  /** Bounds returned by getBounds(). Defaults to { width: 1200, height: 800 }. */
  readonly bounds?: ContentBounds;
}

/**
 * Create a mock WindowManager for testing.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const windowManager = createMockWindowManager();
 * const badgeManager = new BadgeManager(..., windowManager as unknown as WindowManager, ...);
 *
 * // Custom window handle
 * const windowManager = createMockWindowManager({ windowHandle: myHandle });
 *
 * // Assert overlay icon calls
 * const calls = windowManager.getOverlayIconCalls();
 * expect(calls[0]?.description).toBe("All workspaces working");
 * ```
 */
export function createMockWindowManager(options?: MockWindowManagerOptions): MockWindowManager {
  const windowHandle = options?.windowHandle ?? createWindowHandle("test-window-1");
  const bounds = options?.bounds ?? { width: 1200, height: 800 };
  const overlayIconCalls: Array<{ image: ImageHandle | null; description: string }> = [];

  return {
    create: vi.fn(),
    getWindowHandle: vi.fn(() => windowHandle),
    getBounds: vi.fn(() => bounds),
    onResize: vi.fn((): Unsubscribe => vi.fn()),
    maximizeAsync: vi.fn(async () => {}),
    focus: vi.fn(),
    setTitle: vi.fn(),
    setOverlayIcon: vi.fn((image: ImageHandle | null, description: string) => {
      overlayIconCalls.push({ image, description });
    }),
    close: vi.fn(),

    getOverlayIconCalls(): Array<{ image: ImageHandle | null; description: string }> {
      return overlayIconCalls;
    },
  };
}
