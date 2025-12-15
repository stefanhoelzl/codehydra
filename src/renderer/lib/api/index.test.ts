/**
 * Tests for the renderer API layer.
 *
 * The API has two layers:
 * 1. Setup API - registered early, available during setup
 * 2. Normal API (projects, workspaces, ui, lifecycle, on) - primary API for normal operation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Api, Unsubscribe } from "@shared/electron-api";
import { createMockApi } from "../test-utils";
import type { WorkspaceRef, ProjectId, WorkspaceName } from "@shared/api/types";

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

    it("exports setup API functions from window.api", async () => {
      const api = await import("$lib/api");

      expect(api.setupReady).toBe(mockApi.setupReady);
      expect(api.setupRetry).toBe(mockApi.setupRetry);
      expect(api.setupQuit).toBe(mockApi.setupQuit);
      expect(api.onSetupProgress).toBe(mockApi.onSetupProgress);
      expect(api.onSetupComplete).toBe(mockApi.onSetupComplete);
      expect(api.onSetupError).toBe(mockApi.onSetupError);
    });

    it("exports normal API functions from window.api", async () => {
      const api = await import("$lib/api");

      expect(api.projects).toBe(mockApi.projects);
      expect(api.workspaces).toBe(mockApi.workspaces);
      expect(api.ui).toBe(mockApi.ui);
      expect(api.lifecycle).toBe(mockApi.lifecycle);
      expect(api.on).toBe(mockApi.on);
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
      mockApi = {
        setupReady: vi.fn().mockResolvedValue({ ready: true }),
        setupRetry: vi.fn().mockResolvedValue(undefined),
        setupQuit: vi.fn().mockResolvedValue(undefined),
        onSetupProgress: vi.fn(() => vi.fn()),
        onSetupComplete: vi.fn(() => vi.fn()),
        onSetupError: vi.fn(() => vi.fn()),
        projects: {
          open: vi.fn().mockResolvedValue({
            id: "test-12345678",
            name: "test",
            path: "/test",
            workspaces: [],
          }),
          close: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue([]),
          get: vi.fn().mockResolvedValue(undefined),
          fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
        },
        workspaces: {
          create: vi.fn().mockResolvedValue({
            projectId: "test-12345678",
            name: "ws",
            branch: "ws",
            path: "/ws",
          }),
          remove: vi.fn().mockResolvedValue({ branchDeleted: false }),
          get: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
        },
        ui: {
          selectFolder: vi.fn().mockResolvedValue(null),
          getActiveWorkspace: vi.fn().mockResolvedValue(null),
          switchWorkspace: vi.fn().mockResolvedValue(undefined),
          setDialogMode: vi.fn().mockResolvedValue(undefined),
          focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),
          setMode: vi.fn().mockResolvedValue(undefined),
        },
        lifecycle: {
          getState: vi.fn().mockResolvedValue("ready"),
          setup: vi.fn().mockResolvedValue({ success: true }),
          quit: vi.fn().mockResolvedValue(undefined),
        },
        on: vi.fn(() => vi.fn()),
        onModeChange: vi.fn(() => vi.fn()),
      };
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
      expect(result).toBe("ready");
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
    it("setup API methods have correct types", async () => {
      const mockApi = createMockApi();
      window.api = mockApi;

      const api = await import("$lib/api");

      // Verify setup methods exist and are functions
      expect(typeof api.setupReady).toBe("function");
      expect(typeof api.setupRetry).toBe("function");
      expect(typeof api.setupQuit).toBe("function");
      expect(typeof api.onSetupProgress).toBe("function");
      expect(typeof api.onSetupComplete).toBe("function");
      expect(typeof api.onSetupError).toBe("function");
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

    it("onSetupProgress returns Unsubscribe function", async () => {
      const mockApi = createMockApi();
      window.api = mockApi;

      const api = await import("$lib/api");
      const unsubscribe: Unsubscribe = api.onSetupProgress(() => {});

      expect(typeof unsubscribe).toBe("function");
    });
  });

  // =============================================================================
  // Utility Functions
  // =============================================================================

  describe("utility functions", () => {
    let mockApi: Api;

    beforeEach(() => {
      mockApi = createMockApi();
      window.api = mockApi;
    });

    describe("createWorkspaceRef", () => {
      it("creates WorkspaceRef from projectId and workspaceName", async () => {
        const api = await import("$lib/api");

        const ref = api.createWorkspaceRef("my-app-12345678", "feature-branch");

        expect(ref.projectId).toBe("my-app-12345678");
        expect(ref.workspaceName).toBe("feature-branch");
      });
    });

    describe("workspaceRefEquals", () => {
      it("returns true for matching refs", async () => {
        const api = await import("$lib/api");

        const ref1 = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws1",
        } as WorkspaceRef;
        const ref2 = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws2",
        } as WorkspaceRef;

        expect(api.workspaceRefEquals(ref1, ref2)).toBe(true);
      });

      it("returns false for different projectId", async () => {
        const api = await import("$lib/api");

        const ref1 = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws",
        } as WorkspaceRef;
        const ref2 = {
          projectId: "other-app-87654321" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws",
        } as WorkspaceRef;

        expect(api.workspaceRefEquals(ref1, ref2)).toBe(false);
      });

      it("returns false for different workspaceName", async () => {
        const api = await import("$lib/api");

        const ref1 = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws",
        } as WorkspaceRef;
        const ref2 = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "bugfix" as WorkspaceName,
          path: "/ws",
        } as WorkspaceRef;

        expect(api.workspaceRefEquals(ref1, ref2)).toBe(false);
      });

      it("returns true when both are null", async () => {
        const api = await import("$lib/api");

        expect(api.workspaceRefEquals(null, null)).toBe(true);
      });

      it("returns false when one is null", async () => {
        const api = await import("$lib/api");

        const ref = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws",
        } as WorkspaceRef;

        expect(api.workspaceRefEquals(ref, null)).toBe(false);
        expect(api.workspaceRefEquals(null, ref)).toBe(false);
      });
    });

    describe("workspaceRefKey", () => {
      it("creates composite key from WorkspaceRef", async () => {
        const api = await import("$lib/api");

        const ref = {
          projectId: "my-app-12345678" as ProjectId,
          workspaceName: "feature" as WorkspaceName,
          path: "/ws",
        } as WorkspaceRef;
        const key = api.workspaceRefKey(ref);

        expect(key).toBe("my-app-12345678/feature");
      });
    });
  });
});
