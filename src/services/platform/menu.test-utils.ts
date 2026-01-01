/**
 * Test utilities for MenuLayer.
 * Provides behavioral mock for testing menu operations without Electron.
 */

import type { MenuLayer, MenuTemplate, MenuHandle } from "./menu";
import { createMenuHandle } from "./menu";

// ============================================================================
// Types
// ============================================================================

/**
 * Information about a built menu.
 */
export interface BuiltMenuInfo {
  readonly id: string;
  readonly template: MenuTemplate;
}

/**
 * State of the MenuLayer behavioral mock.
 */
export interface MenuLayerState {
  /** All built menus */
  readonly menus: Map<string, BuiltMenuInfo>;
  /** Current application menu ID (null if no menu set) */
  readonly applicationMenuId: string | null;
  /** Number of times setApplicationMenu was called */
  readonly setApplicationMenuCount: number;
  /** Number of times buildFromTemplate was called */
  readonly buildFromTemplateCount: number;
}

/**
 * Extended MenuLayer interface with state inspection for testing.
 */
export interface BehavioralMenuLayer extends MenuLayer {
  /**
   * Get internal state for test assertions.
   */
  _getState(): MenuLayerState;

  /**
   * Reset all state.
   */
  _reset(): void;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a behavioral mock of MenuLayer for testing.
 *
 * The mock tracks all menu operations and provides state inspection
 * for testing menu management without Electron.
 *
 * @example Basic usage - set null menu
 * ```typescript
 * const menuLayer = createBehavioralMenuLayer();
 * menuLayer.setApplicationMenu(null);
 *
 * const state = menuLayer._getState();
 * expect(state.applicationMenuId).toBeNull();
 * expect(state.setApplicationMenuCount).toBe(1);
 * ```
 *
 * @example Build and set menu
 * ```typescript
 * const menuLayer = createBehavioralMenuLayer();
 * const menu = menuLayer.buildFromTemplate([
 *   { label: "File", submenu: [{ label: "Quit", role: "quit" }] },
 * ]);
 *
 * menuLayer.setApplicationMenu(menu);
 * expect(menuLayer.getApplicationMenu()?.id).toBe(menu.id);
 * ```
 */
export function createBehavioralMenuLayer(): BehavioralMenuLayer {
  // State tracking
  const menus = new Map<string, BuiltMenuInfo>();
  let applicationMenuId: string | null = null;
  let setApplicationMenuCount = 0;
  let buildFromTemplateCount = 0;
  let nextMenuId = 0;

  return {
    buildFromTemplate(template: MenuTemplate): MenuHandle {
      const id = `menu-${++nextMenuId}`;
      menus.set(id, { id, template });
      buildFromTemplateCount++;
      return createMenuHandle(id);
    },

    setApplicationMenu(menu: MenuHandle | null): void {
      setApplicationMenuCount++;
      if (menu === null) {
        applicationMenuId = null;
        return;
      }
      // Verify menu exists
      if (!menus.has(menu.id)) {
        // Match real behavior: silently ignore invalid menu
        return;
      }
      applicationMenuId = menu.id;
    },

    getApplicationMenu(): MenuHandle | null {
      if (applicationMenuId === null) {
        return null;
      }
      return createMenuHandle(applicationMenuId);
    },

    _getState(): MenuLayerState {
      return {
        menus: new Map(menus),
        applicationMenuId,
        setApplicationMenuCount,
        buildFromTemplateCount,
      };
    },

    _reset(): void {
      menus.clear();
      applicationMenuId = null;
      setApplicationMenuCount = 0;
      buildFromTemplateCount = 0;
      nextMenuId = 0;
    },
  };
}
