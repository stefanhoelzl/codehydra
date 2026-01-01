/**
 * MenuLayer - Abstraction over Electron's Menu module.
 *
 * Provides an injectable interface for menu management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron Menu
 * - Application menu control without direct Electron dependency
 */

import type { Logger } from "../logging";

// ============================================================================
// Types
// ============================================================================

/**
 * Role for menu items with predefined behavior.
 */
export type MenuItemRole =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "pasteAndMatchStyle"
  | "delete"
  | "selectAll"
  | "reload"
  | "forceReload"
  | "toggleDevTools"
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
  | "togglefullscreen"
  | "window"
  | "minimize"
  | "close"
  | "help"
  | "about"
  | "services"
  | "hide"
  | "hideOthers"
  | "unhide"
  | "quit"
  | "startSpeaking"
  | "stopSpeaking"
  | "zoom"
  | "front"
  | "appMenu"
  | "fileMenu"
  | "editMenu"
  | "viewMenu"
  | "windowMenu";

/**
 * Type of menu item.
 */
export type MenuItemType = "normal" | "separator" | "submenu" | "checkbox" | "radio";

/**
 * Keyboard accelerator definition.
 */
export type MenuAccelerator = string;

/**
 * Options for creating a menu item.
 */
export interface MenuItemOptions {
  /** Click handler for the menu item */
  readonly click?: () => void;
  /** Role with predefined behavior (overrides click handler) */
  readonly role?: MenuItemRole;
  /** Type of menu item */
  readonly type?: MenuItemType;
  /** Label for the menu item */
  readonly label?: string;
  /** Submenu items */
  readonly submenu?: readonly MenuItemOptions[];
  /** Keyboard accelerator */
  readonly accelerator?: MenuAccelerator;
  /** Whether the item is enabled */
  readonly enabled?: boolean;
  /** Whether the item is visible */
  readonly visible?: boolean;
  /** Whether the item is checked (for checkbox/radio types) */
  readonly checked?: boolean;
}

/**
 * Template for building a menu from an array of menu item options.
 */
export type MenuTemplate = readonly MenuItemOptions[];

/**
 * Opaque handle to a menu instance.
 */
export interface MenuHandle {
  readonly id: string;
  readonly __brand: "MenuHandle";
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's Menu module.
 *
 * Provides application menu management without exposing Electron Menu objects directly.
 */
export interface MenuLayer {
  /**
   * Build a menu from a template.
   *
   * @param template - Array of menu item options
   * @returns Handle to the created menu
   */
  buildFromTemplate(template: MenuTemplate): MenuHandle;

  /**
   * Set the application menu.
   *
   * @param menu - Menu handle to set, or null to remove the menu
   */
  setApplicationMenu(menu: MenuHandle | null): void;

  /**
   * Get the current application menu.
   *
   * @returns Handle to the current menu, or null if no menu is set
   */
  getApplicationMenu(): MenuHandle | null;
}

// ============================================================================
// Handle Creation
// ============================================================================

let menuIdCounter = 0;

/**
 * Creates a MenuHandle with the given ID.
 */
export function createMenuHandle(id: string): MenuHandle {
  return { id, __brand: "MenuHandle" };
}

// ============================================================================
// Default Implementation
// ============================================================================

import { Menu } from "electron";

/**
 * Default implementation of MenuLayer using Electron's Menu module.
 */
export class DefaultMenuLayer implements MenuLayer {
  private readonly menus = new Map<string, Menu>();
  private currentApplicationMenuId: string | null = null;

  constructor(private readonly logger: Logger) {}

  buildFromTemplate(template: MenuTemplate): MenuHandle {
    const id = `menu-${++menuIdCounter}`;

    // Convert our readonly template to Electron's mutable format
    const electronTemplate = this.convertTemplate(template);
    const menu = Menu.buildFromTemplate(electronTemplate);

    this.menus.set(id, menu);
    this.logger.debug("Menu built from template", { id, itemCount: template.length });

    return createMenuHandle(id);
  }

  setApplicationMenu(menu: MenuHandle | null): void {
    if (menu === null) {
      Menu.setApplicationMenu(null);
      this.currentApplicationMenuId = null;
      this.logger.debug("Application menu cleared");
      return;
    }

    const electronMenu = this.menus.get(menu.id);
    if (!electronMenu) {
      this.logger.warn("Menu not found", { id: menu.id });
      return;
    }

    Menu.setApplicationMenu(electronMenu);
    this.currentApplicationMenuId = menu.id;
    this.logger.debug("Application menu set", { id: menu.id });
  }

  getApplicationMenu(): MenuHandle | null {
    if (this.currentApplicationMenuId === null) {
      return null;
    }
    return createMenuHandle(this.currentApplicationMenuId);
  }

  /**
   * Convert our readonly template to Electron's mutable format.
   */
  private convertTemplate(template: MenuTemplate): Electron.MenuItemConstructorOptions[] {
    return template.map((item) => this.convertMenuItem(item));
  }

  private convertMenuItem(item: MenuItemOptions): Electron.MenuItemConstructorOptions {
    const result: Electron.MenuItemConstructorOptions = {};

    if (item.click !== undefined) result.click = item.click;
    if (item.role !== undefined) result.role = item.role;
    if (item.type !== undefined) result.type = item.type;
    if (item.label !== undefined) result.label = item.label;
    if (item.accelerator !== undefined) result.accelerator = item.accelerator;
    if (item.enabled !== undefined) result.enabled = item.enabled;
    if (item.visible !== undefined) result.visible = item.visible;
    if (item.checked !== undefined) result.checked = item.checked;
    if (item.submenu !== undefined) {
      result.submenu = this.convertTemplate(item.submenu);
    }

    return result;
  }
}
