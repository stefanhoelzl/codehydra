/**
 * MenuBoundary - Abstraction over Electron's Menu module.
 *
 * Provides an injectable interface for application menu control without
 * direct Electron dependency.
 */

import type { Logger } from "../platform/logging";

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's Menu module.
 */
export interface MenuBoundary {
  /**
   * Set the application menu.
   *
   * @param menu - null to remove the menu
   */
  setApplicationMenu(menu: null): void;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { Menu } from "electron";

/**
 * Default implementation of MenuBoundary using Electron's Menu module.
 */
export class DefaultMenuBoundary implements MenuBoundary {
  constructor(private readonly logger: Logger) {}

  setApplicationMenu(menu: null): void {
    Menu.setApplicationMenu(menu);
    this.logger.debug("Application menu cleared");
  }
}
