/**
 * Test utilities for BadgeManager.
 * Provides mock factories for ElectronAppApi and WindowManager.
 */

import type { NativeImage } from "electron";
import type { ElectronAppApi } from "./electron-app-api";
import type { WindowManager } from "./window-manager";

/**
 * Mock ElectronAppApi with call tracking.
 */
export interface MockElectronAppApi extends ElectronAppApi {
  /** All calls to dock.setBadge */
  dockSetBadgeCalls: string[];
  /** All calls to setBadgeCount */
  setBadgeCountCalls: number[];
}

/**
 * Creates a mock ElectronAppApi for testing.
 * Tracks all calls to dock.setBadge and setBadgeCount.
 *
 * @returns Mock ElectronAppApi with call tracking
 */
export function createMockElectronAppApi(): MockElectronAppApi {
  const dockSetBadgeCalls: string[] = [];
  const setBadgeCountCalls: number[] = [];

  return {
    dock: {
      setBadge: (badge: string) => {
        dockSetBadgeCalls.push(badge);
      },
    },
    setBadgeCount: (count: number) => {
      setBadgeCountCalls.push(count);
      return true;
    },
    dockSetBadgeCalls,
    setBadgeCountCalls,
  };
}

/**
 * Mock WindowManager subset for BadgeManager testing.
 */
export interface MockWindowManagerForBadge extends Pick<WindowManager, "setOverlayIcon"> {
  /** All calls to setOverlayIcon */
  setOverlayIconCalls: Array<{ image: NativeImage | null; description: string }>;
}

/**
 * Creates a mock WindowManager for BadgeManager testing.
 * Only implements setOverlayIcon with call tracking.
 *
 * @returns Mock WindowManager subset with call tracking
 */
export function createMockWindowManagerForBadge(): MockWindowManagerForBadge {
  const setOverlayIconCalls: Array<{ image: NativeImage | null; description: string }> = [];

  return {
    setOverlayIcon: (image: NativeImage | null, description: string) => {
      setOverlayIconCalls.push({ image, description });
    },
    setOverlayIconCalls,
  };
}
