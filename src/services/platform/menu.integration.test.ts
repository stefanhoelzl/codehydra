/**
 * Integration tests for MenuLayer behavioral mock.
 *
 * Tests verify the behavioral mock provides correct contract behavior
 * that matches the real DefaultMenuLayer implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createBehavioralMenuLayer, type BehavioralMenuLayer } from "./menu.test-utils";
import type { MenuTemplate } from "./menu";

describe("MenuLayer (behavioral mock)", () => {
  let menuLayer: BehavioralMenuLayer;

  beforeEach(() => {
    menuLayer = createBehavioralMenuLayer();
  });

  describe("buildFromTemplate", () => {
    it("returns a menu handle", () => {
      const template: MenuTemplate = [{ label: "File" }];
      const handle = menuLayer.buildFromTemplate(template);

      expect(handle.id).toBeDefined();
      expect(handle.__brand).toBe("MenuHandle");
    });

    it("stores the template for inspection", () => {
      const template: MenuTemplate = [
        { label: "File", submenu: [{ label: "Quit", role: "quit" }] },
      ];
      const handle = menuLayer.buildFromTemplate(template);

      const state = menuLayer._getState();
      const menuInfo = state.menus.get(handle.id);
      expect(menuInfo?.template).toEqual(template);
    });

    it("increments build count", () => {
      menuLayer.buildFromTemplate([{ label: "Menu1" }]);
      menuLayer.buildFromTemplate([{ label: "Menu2" }]);

      const state = menuLayer._getState();
      expect(state.buildFromTemplateCount).toBe(2);
    });

    it("generates unique IDs for each menu", () => {
      const handle1 = menuLayer.buildFromTemplate([{ label: "A" }]);
      const handle2 = menuLayer.buildFromTemplate([{ label: "B" }]);

      expect(handle1.id).not.toBe(handle2.id);
    });
  });

  describe("setApplicationMenu", () => {
    it("sets menu to null", () => {
      menuLayer.setApplicationMenu(null);

      const state = menuLayer._getState();
      expect(state.applicationMenuId).toBeNull();
      expect(state.setApplicationMenuCount).toBe(1);
    });

    it("sets menu from handle", () => {
      const handle = menuLayer.buildFromTemplate([{ label: "File" }]);
      menuLayer.setApplicationMenu(handle);

      const state = menuLayer._getState();
      expect(state.applicationMenuId).toBe(handle.id);
    });

    it("increments set count on each call", () => {
      menuLayer.setApplicationMenu(null);
      const handle = menuLayer.buildFromTemplate([{ label: "Test" }]);
      menuLayer.setApplicationMenu(handle);
      menuLayer.setApplicationMenu(null);

      const state = menuLayer._getState();
      expect(state.setApplicationMenuCount).toBe(3);
    });

    it("ignores invalid menu handle silently", () => {
      // Set a valid menu first
      const validHandle = menuLayer.buildFromTemplate([{ label: "Valid" }]);
      menuLayer.setApplicationMenu(validHandle);

      // Try to set an invalid handle
      const invalidHandle = { id: "nonexistent", __brand: "MenuHandle" as const };
      menuLayer.setApplicationMenu(invalidHandle);

      // Should still have the valid menu set
      const state = menuLayer._getState();
      expect(state.applicationMenuId).toBe(validHandle.id);
    });
  });

  describe("getApplicationMenu", () => {
    it("returns null when no menu set", () => {
      const result = menuLayer.getApplicationMenu();
      expect(result).toBeNull();
    });

    it("returns null after setting null", () => {
      const handle = menuLayer.buildFromTemplate([{ label: "File" }]);
      menuLayer.setApplicationMenu(handle);
      menuLayer.setApplicationMenu(null);

      const result = menuLayer.getApplicationMenu();
      expect(result).toBeNull();
    });

    it("returns handle for current menu", () => {
      const handle = menuLayer.buildFromTemplate([{ label: "File" }]);
      menuLayer.setApplicationMenu(handle);

      const result = menuLayer.getApplicationMenu();
      expect(result?.id).toBe(handle.id);
      expect(result?.__brand).toBe("MenuHandle");
    });

    it("returns handle matching the last set menu", () => {
      const handle1 = menuLayer.buildFromTemplate([{ label: "A" }]);
      const handle2 = menuLayer.buildFromTemplate([{ label: "B" }]);

      menuLayer.setApplicationMenu(handle1);
      menuLayer.setApplicationMenu(handle2);

      const result = menuLayer.getApplicationMenu();
      expect(result?.id).toBe(handle2.id);
    });
  });

  describe("_getState", () => {
    it("returns copy of menus map", () => {
      const handle = menuLayer.buildFromTemplate([{ label: "Test" }]);

      const state1 = menuLayer._getState();
      menuLayer.buildFromTemplate([{ label: "Another" }]);
      const state2 = menuLayer._getState();

      // state1 should not have been modified
      expect(state1.menus.size).toBe(1);
      expect(state1.menus.has(handle.id)).toBe(true);
      expect(state2.menus.size).toBe(2);
    });
  });

  describe("_reset", () => {
    it("clears all state", () => {
      menuLayer.buildFromTemplate([{ label: "Menu" }]);
      menuLayer.setApplicationMenu(menuLayer.buildFromTemplate([{ label: "App" }]));

      menuLayer._reset();

      const state = menuLayer._getState();
      expect(state.menus.size).toBe(0);
      expect(state.applicationMenuId).toBeNull();
      expect(state.setApplicationMenuCount).toBe(0);
      expect(state.buildFromTemplateCount).toBe(0);
    });

    it("resets menu ID counter", () => {
      menuLayer.buildFromTemplate([{ label: "A" }]);
      menuLayer.buildFromTemplate([{ label: "B" }]);

      menuLayer._reset();

      const handle = menuLayer.buildFromTemplate([{ label: "C" }]);
      expect(handle.id).toBe("menu-1");
    });
  });

  describe("complex menu structures", () => {
    it("handles nested submenus", () => {
      const template: MenuTemplate = [
        {
          label: "File",
          submenu: [
            { label: "New", accelerator: "CmdOrCtrl+N" },
            { type: "separator" },
            {
              label: "Recent",
              submenu: [{ label: "file1.txt" }, { label: "file2.txt" }],
            },
          ],
        },
      ];

      const handle = menuLayer.buildFromTemplate(template);
      const state = menuLayer._getState();
      const menuInfo = state.menus.get(handle.id);

      expect(menuInfo?.template).toEqual(template);
    });

    it("handles role-based menu items", () => {
      const template: MenuTemplate = [
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
          ],
        },
      ];

      const handle = menuLayer.buildFromTemplate(template);
      const state = menuLayer._getState();

      expect(state.menus.has(handle.id)).toBe(true);
    });
  });
});
