/**
 * Tests for the renderer API layer.
 *
 * Setup operations use lifecycle API:
 * - lifecycle.getState() returns "ready" | "setup"
 * - lifecycle.setup() runs setup and returns success/failure
 * - lifecycle.quit() quits the app
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

    it("exports domain API namespaces delegating to window.api", async () => {
      const api = await import("$lib/api");

      await api.projects.close("/test/project");
      await api.workspaces.getStatus("/test/ws");
      await api.ui.setMode("workspace");

      expect(mockApi.projects.close).toHaveBeenCalledWith("/test/project", undefined);
      expect(mockApi.workspaces.getStatus).toHaveBeenCalledWith("/test/ws", undefined);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      expect(api.lifecycle).toBe(mockApi.lifecycle);
      expect(api.on).toBe(mockApi.on);
      expect(api.onModeChange).toBe(mockApi.onModeChange);
      expect(api.onShortcut).toBe(mockApi.onShortcut);
    });
  });

  // =============================================================================
  // Phase A dual-fire: wrappers emit observational UiEvents
  // =============================================================================

  describe("UI event dual-fire", () => {
    let mockApi: Api;

    beforeEach(() => {
      mockApi = createMockApi();
      window.api = mockApi;
    });

    it("emits matching events alongside the invokes", async () => {
      const api = await import("$lib/api");

      await api.projects.open("/test");
      await api.workspaces.remove("/test/ws");
      await api.workspaces.hibernate("/test/ws");
      await api.workspaces.wake("/test/ws");
      await api.ui.switchWorkspace("/test/ws");

      expect(vi.mocked(mockApi.emitEvent).mock.calls.map(([event]) => event)).toEqual([
        { kind: "open-project" },
        { kind: "remove-workspace" },
        { kind: "hibernate-workspace" },
        { kind: "wake-workspace" },
        { kind: "switch-workspace" },
      ]);
    });

    it("does not emit events for request/response invokes", async () => {
      const api = await import("$lib/api");

      await api.workspaces.getStatus("/test/ws");
      await api.workspaces.getScreenshot("p-1", "ws");
      await api.ui.setMode("workspace");
      await api.projects.close("/test/project");

      expect(mockApi.emitEvent).not.toHaveBeenCalled();
    });

    it("emitEvent failures never break the invoke", async () => {
      mockApi.emitEvent = vi.fn(() => {
        throw new Error("channel broke");
      });
      const api = await import("$lib/api");

      await expect(api.workspaces.wake("/test/ws")).resolves.toBeDefined();
      expect(mockApi.workspaces.wake).toHaveBeenCalledWith("/test/ws");
    });

    it("exports emitEvent for invoke-less signals", async () => {
      const api = await import("$lib/api");

      api.emitEvent({ kind: "panel-visibility", open: true });

      expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "panel-visibility", open: true });
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
  // Normal API Tests
  // =============================================================================

  describe("normal API operations", () => {
    let mockApi: Api;

    beforeEach(() => {
      // Use shared createMockApi instead of inline definition
      mockApi = createMockApi();
      window.api = mockApi;
    });

    it("projects.open returns Project with id", async () => {
      const api = await import("$lib/api");
      const result = await api.projects.open("/test");

      expect(mockApi.projects.open).toHaveBeenCalledWith("/test");
      expect(result).toHaveProperty("id");
    });

    // Note: lifecycle.getState removed in app:setup migration
    it("lifecycle.quit calls quit", async () => {
      const api = await import("$lib/api");
      await api.lifecycle.quit();

      expect(mockApi.lifecycle.quit).toHaveBeenCalled();
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
    it("lifecycle API methods have correct types", async () => {
      const mockApi = createMockApi();
      window.api = mockApi;

      const api = await import("$lib/api");

      // Verify lifecycle namespace exists - only quit remains after app:setup migration
      expect(api.lifecycle).toBeDefined();
      expect(typeof api.lifecycle.quit).toBe("function");
    });

    it("API has all namespaces", async () => {
      const mockApi = createMockApi();
      window.api = mockApi;

      const api = await import("$lib/api");

      expect(api).toHaveProperty("projects");
      expect(api).toHaveProperty("workspaces");
      expect(api).toHaveProperty("ui");
      expect(api).toHaveProperty("lifecycle");
      expect(api).toHaveProperty("on");
    });
  });
});
