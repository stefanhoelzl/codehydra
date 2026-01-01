/**
 * Boundary tests for DefaultMenuLayer against real Electron Menu.
 *
 * These tests verify that DefaultMenuLayer correctly wraps Electron's Menu module.
 * Run with: npm run test:boundary
 */

// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DefaultMenuLayer } from "./menu";
import { SILENT_LOGGER } from "../logging";

/**
 * Check if we're running in an Electron environment.
 * Boundary tests run within Electron, regular tests don't.
 */
const isElectronEnvironment = typeof process !== "undefined" && !!process.versions?.electron;

describe.skipIf(!isElectronEnvironment)("DefaultMenuLayer (boundary)", () => {
  let menuLayer: DefaultMenuLayer;

  beforeEach(() => {
    menuLayer = new DefaultMenuLayer(SILENT_LOGGER);
  });

  afterEach(() => {
    // Clean up by clearing the application menu
    menuLayer.setApplicationMenu(null);
  });

  describe("setApplicationMenu", () => {
    it("accepts null to clear the menu", () => {
      expect(() => menuLayer.setApplicationMenu(null)).not.toThrow();
    });

    it("returns null from getApplicationMenu after clearing", () => {
      menuLayer.setApplicationMenu(null);
      const result = menuLayer.getApplicationMenu();
      expect(result).toBeNull();
    });
  });

  describe("buildFromTemplate", () => {
    it("creates a menu handle from empty template", () => {
      const handle = menuLayer.buildFromTemplate([]);

      expect(handle).toBeDefined();
      expect(handle).toHaveProperty("id");
      expect(typeof handle.id).toBe("string");
      expect(handle).toHaveProperty("__brand", "MenuHandle");
    });

    it("creates a menu handle from simple template", () => {
      const handle = menuLayer.buildFromTemplate([
        { label: "File", submenu: [{ label: "Exit", role: "quit" }] },
      ]);

      expect(handle).toBeDefined();
      expect(handle.id).toMatch(/^menu-\d+$/);
    });

    it("creates a menu handle with multiple items", () => {
      const handle = menuLayer.buildFromTemplate([
        {
          label: "File",
          submenu: [
            { label: "New", accelerator: "CmdOrCtrl+N" },
            { type: "separator" },
            { label: "Exit", role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { label: "Undo", role: "undo" },
            { label: "Redo", role: "redo" },
            { type: "separator" },
            { label: "Cut", role: "cut" },
            { label: "Copy", role: "copy" },
            { label: "Paste", role: "paste" },
          ],
        },
      ]);

      expect(handle).toBeDefined();
      expect(handle.id).toMatch(/^menu-\d+$/);
    });
  });

  describe("setApplicationMenu with handle", () => {
    it("sets the application menu from a handle", () => {
      const handle = menuLayer.buildFromTemplate([{ label: "Test" }]);

      expect(() => menuLayer.setApplicationMenu(handle)).not.toThrow();
    });

    it("returns the handle from getApplicationMenu after setting", () => {
      const handle = menuLayer.buildFromTemplate([{ label: "Test" }]);
      menuLayer.setApplicationMenu(handle);

      const result = menuLayer.getApplicationMenu();
      expect(result).not.toBeNull();
      expect(result?.id).toBe(handle.id);
    });

    it("updates when setting a different menu", () => {
      const handle1 = menuLayer.buildFromTemplate([{ label: "Menu 1" }]);
      const handle2 = menuLayer.buildFromTemplate([{ label: "Menu 2" }]);

      menuLayer.setApplicationMenu(handle1);
      expect(menuLayer.getApplicationMenu()?.id).toBe(handle1.id);

      menuLayer.setApplicationMenu(handle2);
      expect(menuLayer.getApplicationMenu()?.id).toBe(handle2.id);
    });
  });

  describe("menu with click handlers", () => {
    it("creates menu with click handler without throwing", () => {
      const handle = menuLayer.buildFromTemplate([
        {
          label: "Test",
          click: () => {
            // Click handler - can't be triggered in boundary tests
          },
        },
      ]);

      expect(handle).toBeDefined();
      // Note: We can't programmatically trigger the click in boundary tests
      // We just verify the menu is created successfully
    });
  });
});
