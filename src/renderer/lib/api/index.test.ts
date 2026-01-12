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

    it("exports domain API namespaces from window.api", async () => {
      const api = await import("$lib/api");

      expect(api.projects).toBe(mockApi.projects);
      expect(api.workspaces).toBe(mockApi.workspaces);
      expect(api.ui).toBe(mockApi.ui);
      expect(api.lifecycle).toBe(mockApi.lifecycle);
      expect(api.on).toBe(mockApi.on);
      expect(api.onModeChange).toBe(mockApi.onModeChange);
      expect(api.onShortcut).toBe(mockApi.onShortcut);
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

    it("projects.list returns array of projects", async () => {
      const api = await import("$lib/api");
      const result = await api.projects.list();

      expect(mockApi.projects.list).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });

    it("workspaces.create returns Workspace", async () => {
      const api = await import("$lib/api");
      const result = await api.workspaces.create("test-12345678", "feature", "main");

      expect(mockApi.workspaces.create).toHaveBeenCalledWith("test-12345678", "feature", "main");
      expect(result).toHaveProperty("projectId");
      expect(result).toHaveProperty("name");
    });

    it("ui.selectFolder returns path or null", async () => {
      const api = await import("$lib/api");
      const result = await api.ui.selectFolder();

      expect(mockApi.ui.selectFolder).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("lifecycle.getState returns app state", async () => {
      const api = await import("$lib/api");
      const result = await api.lifecycle.getState();

      expect(mockApi.lifecycle.getState).toHaveBeenCalled();
      expect(result).toEqual({ state: "loading", agent: "opencode" });
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

      // Verify lifecycle namespace exists with v2 API methods
      expect(api.lifecycle).toBeDefined();
      expect(typeof api.lifecycle.getState).toBe("function");
      expect(typeof api.lifecycle.setup).toBe("function");
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
