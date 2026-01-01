/**
 * Integration tests for AppLayer behavioral mock.
 *
 * Tests verify the behavioral mock provides correct contract behavior
 * that matches the real DefaultAppLayer implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createBehavioralAppLayer, type BehavioralAppLayer } from "./app.test-utils";

describe("AppLayer (behavioral mock)", () => {
  describe("with macOS platform", () => {
    let appLayer: BehavioralAppLayer;

    beforeEach(() => {
      appLayer = createBehavioralAppLayer({ platform: "darwin" });
    });

    describe("dock", () => {
      it("is available on macOS", () => {
        expect(appLayer.dock).toBeDefined();
      });

      it("setBadge updates state", () => {
        appLayer.dock!.setBadge("test");
        expect(appLayer._getState().dockBadge).toBe("test");
      });

      it("setBadge records all calls", () => {
        appLayer.dock!.setBadge("a");
        appLayer.dock!.setBadge("b");
        appLayer.dock!.setBadge("");
        expect(appLayer._getState().dockSetBadgeCalls).toEqual(["a", "b", ""]);
      });

      it("empty string clears badge", () => {
        appLayer.dock!.setBadge("test");
        appLayer.dock!.setBadge("");
        expect(appLayer._getState().dockBadge).toBe("");
      });
    });
  });

  describe("with Windows platform", () => {
    let appLayer: BehavioralAppLayer;

    beforeEach(() => {
      appLayer = createBehavioralAppLayer({ platform: "win32" });
    });

    it("dock is undefined", () => {
      expect(appLayer.dock).toBeUndefined();
    });
  });

  describe("with Linux platform", () => {
    let appLayer: BehavioralAppLayer;

    beforeEach(() => {
      appLayer = createBehavioralAppLayer({ platform: "linux" });
    });

    it("dock is undefined", () => {
      expect(appLayer.dock).toBeUndefined();
    });
  });

  describe("setBadgeCount", () => {
    let appLayer: BehavioralAppLayer;

    beforeEach(() => {
      appLayer = createBehavioralAppLayer();
    });

    it("updates badge count state", () => {
      appLayer.setBadgeCount(5);
      expect(appLayer._getState().badgeCount).toBe(5);
    });

    it("returns true", () => {
      expect(appLayer.setBadgeCount(1)).toBe(true);
    });

    it("records all calls", () => {
      appLayer.setBadgeCount(1);
      appLayer.setBadgeCount(0);
      appLayer.setBadgeCount(10);
      expect(appLayer._getState().setBadgeCountCalls).toEqual([1, 0, 10]);
    });

    it("setting 0 clears badge", () => {
      appLayer.setBadgeCount(5);
      appLayer.setBadgeCount(0);
      expect(appLayer._getState().badgeCount).toBe(0);
    });
  });

  describe("getPath", () => {
    it("returns default paths", () => {
      const appLayer = createBehavioralAppLayer();
      expect(appLayer.getPath("home")).toBe("/mock/home");
      expect(appLayer.getPath("userData")).toBe("/mock/userData");
      expect(appLayer.getPath("temp")).toBe("/mock/temp");
    });

    it("uses custom paths when provided", () => {
      const appLayer = createBehavioralAppLayer({
        paths: {
          home: "/custom/home",
          userData: "/custom/userData",
        },
      });
      expect(appLayer.getPath("home")).toBe("/custom/home");
      expect(appLayer.getPath("userData")).toBe("/custom/userData");
      // Unmapped paths still return defaults
      expect(appLayer.getPath("temp")).toBe("/mock/temp");
    });
  });

  describe("commandLineAppendSwitch", () => {
    let appLayer: BehavioralAppLayer;

    beforeEach(() => {
      appLayer = createBehavioralAppLayer();
    });

    it("records switch without value", () => {
      appLayer.commandLineAppendSwitch("disable-gpu");
      expect(appLayer._getState().commandLineSwitches).toEqual([
        { key: "disable-gpu", value: undefined },
      ]);
    });

    it("records switch with value", () => {
      appLayer.commandLineAppendSwitch("use-gl", "swiftshader");
      expect(appLayer._getState().commandLineSwitches).toEqual([
        { key: "use-gl", value: "swiftshader" },
      ]);
    });

    it("records multiple switches", () => {
      appLayer.commandLineAppendSwitch("disable-gpu");
      appLayer.commandLineAppendSwitch("use-gl", "swiftshader");
      expect(appLayer._getState().commandLineSwitches).toHaveLength(2);
    });
  });
});
