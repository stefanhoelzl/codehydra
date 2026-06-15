/**
 * Tests for the renderer API layer.
 *
 * All renderer→main gestures are fire-and-forget ui:events (emitEvent); there
 * are no command invokes. The layer mostly re-exports window.api for
 * mockability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Api } from "@shared/electron-api";
import { createMockApi } from "../test-utils";

describe("renderer API layer", () => {
  // Store original window.api
  const originalApi = window.api;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original window.api
    if (originalApi) {
      window.api = originalApi;
    }
  });

  describe("when window.api is available", () => {
    let mockApi: Api;

    beforeEach(() => {
      mockApi = createMockApi();
      window.api = mockApi;
    });

    it("re-exports window.api functions for mockability", async () => {
      const api = await import("$lib/api");

      expect(api.on).toBe(mockApi.on);
      expect(api.onState).toBe(mockApi.onState);
    });
  });

  // =============================================================================
  // ui:event emission
  // =============================================================================

  describe("emitEvent", () => {
    let mockApi: Api;

    beforeEach(() => {
      mockApi = createMockApi();
      window.api = mockApi;
    });

    it("forwards events to window.api", async () => {
      const api = await import("$lib/api");

      api.emitEvent({ kind: "switch-workspace", key: "p/ws" });
      api.emitEvent({ kind: "hover", region: "sidebar" });

      expect(vi.mocked(mockApi.emitEvent).mock.calls.map(([event]) => event)).toEqual([
        { kind: "switch-workspace", key: "p/ws" },
        { kind: "hover", region: "sidebar" },
      ]);
    });

    it("never throws when the underlying channel breaks", async () => {
      mockApi.emitEvent = vi.fn(() => {
        throw new Error("channel broke");
      });
      const api = await import("$lib/api");

      expect(() => api.emitEvent({ kind: "wake-workspace", key: "p/ws" })).not.toThrow();
    });
  });

  describe("when window.api is undefined", () => {
    beforeEach(() => {
      // Remove window.api
      // @ts-expect-error - Intentionally removing api for testing
      delete window.api;
    });

    it("throws descriptive error if window.api is undefined", async () => {
      await expect(import("$lib/api")).rejects.toThrow(
        "window.api is not available. Ensure the preload script is loaded correctly."
      );
    });
  });

  // =============================================================================
  // Remaining command invoke + event subscription
  // =============================================================================

  describe("normal API operations", () => {
    let mockApi: Api;

    beforeEach(() => {
      mockApi = createMockApi();
      window.api = mockApi;
    });

    it("on subscribes to events and returns unsubscribe", async () => {
      const api = await import("$lib/api");
      const handler = vi.fn();
      const unsubscribe = api.on("workspace:switched", handler);

      expect(mockApi.on).toHaveBeenCalledWith("workspace:switched", handler);
      expect(typeof unsubscribe).toBe("function");
    });
  });

  // =============================================================================
  // Type-level Tests
  // =============================================================================

  describe("type-level tests", () => {
    it("exposes emitEvent and event subscriptions", async () => {
      const mockApi = createMockApi();
      window.api = mockApi;

      const api = await import("$lib/api");

      expect(api).toHaveProperty("emitEvent");
      expect(api).toHaveProperty("on");
      expect(api).toHaveProperty("onState");
    });
  });
});
