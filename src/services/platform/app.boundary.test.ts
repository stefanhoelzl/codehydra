/**
 * Boundary tests for DefaultAppLayer.
 *
 * These tests verify the real Electron app behavior.
 * Run with: npm run test:boundary
 *
 * Note: Badge-related tests are limited since they're visual-only
 * and may not work on all Linux desktop environments.
 */

// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { platform } from "node:os";
import { DefaultAppLayer } from "./app";
import { SILENT_LOGGER } from "../logging";

describe("DefaultAppLayer (boundary)", () => {
  let appLayer: DefaultAppLayer;

  beforeEach(() => {
    appLayer = new DefaultAppLayer(SILENT_LOGGER);
  });

  describe("dock", () => {
    it.skipIf(platform() !== "darwin")("is available on macOS", () => {
      expect(appLayer.dock).toBeDefined();
    });

    it.skipIf(platform() === "darwin")("is undefined on non-macOS", () => {
      expect(appLayer.dock).toBeUndefined();
    });

    // Note: Actually setting the dock badge would be visual only and can't be verified
    // We just verify the API is callable on macOS
    it.skipIf(platform() !== "darwin")("setBadge is callable", () => {
      expect(() => appLayer.dock?.setBadge("test")).not.toThrow();
      // Clear the badge
      expect(() => appLayer.dock?.setBadge("")).not.toThrow();
    });
  });

  describe("setBadgeCount", () => {
    // Badge count may not work on all systems (e.g., Linux without Unity)
    // We just verify the API is callable
    it("is callable and returns boolean", () => {
      const result = appLayer.setBadgeCount(0);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("getPath", () => {
    it("returns valid path for home", () => {
      const homePath = appLayer.getPath("home");
      expect(typeof homePath).toBe("string");
      expect(homePath.length).toBeGreaterThan(0);
    });

    it("returns valid path for userData", () => {
      const userDataPath = appLayer.getPath("userData");
      expect(typeof userDataPath).toBe("string");
      expect(userDataPath.length).toBeGreaterThan(0);
    });

    it("returns valid path for temp", () => {
      const tempPath = appLayer.getPath("temp");
      expect(typeof tempPath).toBe("string");
      expect(tempPath.length).toBeGreaterThan(0);
    });

    it("returns valid path for logs", () => {
      const logsPath = appLayer.getPath("logs");
      expect(typeof logsPath).toBe("string");
      expect(logsPath.length).toBeGreaterThan(0);
    });
  });

  describe("commandLineAppendSwitch", () => {
    // Note: Command line switches take effect before app.whenReady()
    // In boundary tests, the app is already ready, so we can only verify
    // the API is callable without throwing
    it("is callable without value", () => {
      // Use a harmless switch that won't affect anything
      expect(() => appLayer.commandLineAppendSwitch("test-switch-no-effect")).not.toThrow();
    });

    it("is callable with value", () => {
      expect(() =>
        appLayer.commandLineAppendSwitch("test-switch-no-effect-2", "value")
      ).not.toThrow();
    });
  });
});
