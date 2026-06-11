/**
 * Test utilities for WindowManager.
 * Provides mock factory for consistent WindowManager mocking across test files.
 */

import { vi, type Mock } from "vitest";
import type { WindowManager, ContentBounds, Unsubscribe, Theme } from "./window-manager";
import type { WindowHandle } from "./types";
import { createWindowHandle } from "./types";
import type { ImageHandle } from "./image-types";

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
  getTheme: Mock<WindowManager["getTheme"]>;
  onThemeChange: Mock<WindowManager["onThemeChange"]>;
  /**
   * Trigger a theme change for tests subscribed via onThemeChange().
   */
  triggerThemeChange(theme: Theme): void;

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
  /** Theme returned by getTheme(). Defaults to "dark". */
  readonly theme?: Theme;
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
  let currentTheme: Theme = options?.theme ?? "dark";
  const overlayIconCalls: Array<{ image: ImageHandle | null; description: string }> = [];
  const themeCallbacks = new Set<(theme: Theme) => void>();

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
    getTheme: vi.fn(() => currentTheme),
    onThemeChange: vi.fn((cb: (theme: Theme) => void): Unsubscribe => {
      themeCallbacks.add(cb);
      return () => themeCallbacks.delete(cb);
    }),

    triggerThemeChange(theme: Theme): void {
      currentTheme = theme;
      for (const cb of themeCallbacks) cb(theme);
    },

    getOverlayIconCalls(): Array<{ image: ImageHandle | null; description: string }> {
      return overlayIconCalls;
    },
  };
}
