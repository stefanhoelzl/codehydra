/**
 * Tests for the renderer API layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expectTypeOf } from "vitest";
import type { Api, Unsubscribe } from "@shared/electron-api";
import type { Project } from "@shared/ipc";

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
      // Create a mock API
      mockApi = {
        selectFolder: vi.fn().mockResolvedValue(null),
        openProject: vi.fn().mockResolvedValue(undefined),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listProjects: vi.fn().mockResolvedValue([]),
        createWorkspace: vi.fn().mockResolvedValue(undefined),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
        listBases: vi.fn().mockResolvedValue([]),
        updateBases: vi.fn().mockResolvedValue(undefined),
        isWorkspaceDirty: vi.fn().mockResolvedValue(false),
        setDialogMode: vi.fn().mockResolvedValue(undefined),
        onProjectOpened: vi.fn(() => vi.fn()),
        onProjectClosed: vi.fn(() => vi.fn()),
        onWorkspaceCreated: vi.fn(() => vi.fn()),
        onWorkspaceRemoved: vi.fn(() => vi.fn()),
        onWorkspaceSwitched: vi.fn(() => vi.fn()),
      };
      window.api = mockApi;
    });

    it("exports all API functions from window.api", async () => {
      const api = await import("$lib/api");

      expect(api.selectFolder).toBe(mockApi.selectFolder);
      expect(api.openProject).toBe(mockApi.openProject);
      expect(api.closeProject).toBe(mockApi.closeProject);
      expect(api.listProjects).toBe(mockApi.listProjects);
      expect(api.createWorkspace).toBe(mockApi.createWorkspace);
      expect(api.removeWorkspace).toBe(mockApi.removeWorkspace);
      expect(api.switchWorkspace).toBe(mockApi.switchWorkspace);
      expect(api.listBases).toBe(mockApi.listBases);
      expect(api.updateBases).toBe(mockApi.updateBases);
      expect(api.isWorkspaceDirty).toBe(mockApi.isWorkspaceDirty);
      expect(api.onProjectOpened).toBe(mockApi.onProjectOpened);
      expect(api.onProjectClosed).toBe(mockApi.onProjectClosed);
      expect(api.onWorkspaceCreated).toBe(mockApi.onWorkspaceCreated);
      expect(api.onWorkspaceRemoved).toBe(mockApi.onWorkspaceRemoved);
      expect(api.onWorkspaceSwitched).toBe(mockApi.onWorkspaceSwitched);
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

  describe("type-level tests", () => {
    it("openProject accepts string parameter", async () => {
      const mockApi: Api = {
        selectFolder: vi.fn().mockResolvedValue(null),
        openProject: vi.fn().mockResolvedValue(undefined),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listProjects: vi.fn().mockResolvedValue([]),
        createWorkspace: vi.fn().mockResolvedValue(undefined),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
        listBases: vi.fn().mockResolvedValue([]),
        updateBases: vi.fn().mockResolvedValue(undefined),
        isWorkspaceDirty: vi.fn().mockResolvedValue(false),
        setDialogMode: vi.fn().mockResolvedValue(undefined),
        onProjectOpened: vi.fn(() => vi.fn()),
        onProjectClosed: vi.fn(() => vi.fn()),
        onWorkspaceCreated: vi.fn(() => vi.fn()),
        onWorkspaceRemoved: vi.fn(() => vi.fn()),
        onWorkspaceSwitched: vi.fn(() => vi.fn()),
      };
      window.api = mockApi;

      const api = await import("$lib/api");

      // Type-level tests using expectTypeOf
      expectTypeOf(api.openProject).parameter(0).toMatchTypeOf<string>();
      expectTypeOf(api.onProjectOpened).returns.toMatchTypeOf<Unsubscribe>();
      expectTypeOf<typeof api.listProjects>().returns.resolves.toMatchTypeOf<Project[]>();
    });
  });
});
