/**
 * Tests for registry test utilities.
 * Verifies that mock registry matches real registry behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { ApiRegistry } from "./registry";
import {
  createMockRegistry,
  createMockProject,
  createMockWorkspace,
  registerAllMethodsWithStubs,
} from "./registry.test-utils";
import type { MethodHandler } from "./registry-types";

// Mock electron for real registry tests
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

describe("mock-registry.behavior", () => {
  describe("register", () => {
    it("tracks registered method paths", () => {
      const mockRegistry = createMockRegistry();

      mockRegistry.register("lifecycle.getState", async () => "ready");

      expect(mockRegistry.getRegisteredPaths()).toContain("lifecycle.getState");
      expect(mockRegistry.register).toHaveBeenCalledWith(
        "lifecycle.getState",
        expect.any(Function)
      );
    });

    it("throws on duplicate registration like real registry", () => {
      const realRegistry = new ApiRegistry();
      const mockRegistry = createMockRegistry();

      const handler: MethodHandler<"lifecycle.getState"> = async () => "ready";

      // Register once
      realRegistry.register("lifecycle.getState", handler);
      mockRegistry.register("lifecycle.getState", handler);

      // Second registration should throw in both
      expect(() => realRegistry.register("lifecycle.getState", handler)).toThrow(
        "Method already registered: lifecycle.getState"
      );
      expect(() => mockRegistry.register("lifecycle.getState", handler)).toThrow(
        "Method already registered: lifecycle.getState"
      );
    });

    it("throws on disposed registry like real registry", async () => {
      const realRegistry = new ApiRegistry();
      const mockRegistry = createMockRegistry();

      await realRegistry.dispose();
      await mockRegistry.dispose();

      expect(() => realRegistry.register("lifecycle.getState", async () => "ready")).toThrow(
        "Cannot register on disposed registry"
      );
      expect(() => mockRegistry.register("lifecycle.getState", async () => "ready")).toThrow(
        "Cannot register on disposed registry"
      );
    });
  });

  describe("emit", () => {
    it("records emitted events", () => {
      const mockRegistry = createMockRegistry();
      const project = createMockProject();

      mockRegistry.emit("project:opened", { project });

      const events = mockRegistry.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event: "project:opened",
        payload: { project },
      });
    });

    it("calls subscribed handlers", () => {
      const mockRegistry = createMockRegistry();
      const handler = vi.fn();

      mockRegistry.on("project:opened", handler);
      mockRegistry.emit("project:opened", { project: createMockProject() });

      expect(handler).toHaveBeenCalledWith({ project: expect.any(Object) });
    });
  });

  describe("on", () => {
    it("returns unsubscribe function", () => {
      const mockRegistry = createMockRegistry();
      const handler = vi.fn();

      const unsubscribe = mockRegistry.on("project:opened", handler);

      // Emit should call handler
      mockRegistry.emit("project:opened", { project: createMockProject() });
      expect(handler).toHaveBeenCalledTimes(1);

      // After unsubscribe, handler should not be called
      unsubscribe();
      mockRegistry.emit("project:opened", { project: createMockProject() });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("tracks subscriptions", () => {
      const mockRegistry = createMockRegistry();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      mockRegistry.on("project:opened", handler1);
      mockRegistry.on("project:closed", handler2);

      const subs = mockRegistry.getSubscriptions();
      expect(subs.get("project:opened")?.has(handler1)).toBe(true);
      expect(subs.get("project:closed")?.has(handler2)).toBe(true);
    });
  });

  describe("getInterface", () => {
    it("validates completeness like real registry", () => {
      const realRegistry = new ApiRegistry();
      const mockRegistry = createMockRegistry();

      // Only register one method
      realRegistry.register("lifecycle.getState", async () => "ready");
      mockRegistry.register("lifecycle.getState", async () => "ready");

      // Should throw in both
      expect(() => realRegistry.getInterface()).toThrow("Missing method registrations:");
      expect(() => mockRegistry.getInterface()).toThrow("Missing method registrations:");
    });

    it("returns interface when complete", () => {
      const mockRegistry = createMockRegistry();
      registerAllMethodsWithStubs(mockRegistry);

      const api = mockRegistry.getInterface();

      expect(api.projects).toBeDefined();
      expect(api.workspaces).toBeDefined();
      expect(api.ui).toBeDefined();
      expect(api.lifecycle).toBeDefined();
    });

    it("interface delegates to registered handlers", async () => {
      const mockRegistry = createMockRegistry();
      const customProject = createMockProject({ name: "custom-project" });

      registerAllMethodsWithStubs(mockRegistry, {
        "projects.list": async () => [customProject],
      });

      const api = mockRegistry.getInterface();
      const result = await api.projects.list();

      expect(result).toEqual([customProject]);
    });
  });

  describe("dispose", () => {
    it("clears registered methods", async () => {
      const mockRegistry = createMockRegistry();
      mockRegistry.register("lifecycle.getState", async () => "ready");

      expect(mockRegistry.getRegisteredPaths()).toHaveLength(1);

      await mockRegistry.dispose();

      expect(mockRegistry.getRegisteredPaths()).toHaveLength(0);
    });
  });
});

describe("createMockProject", () => {
  it("creates project with default values", () => {
    const project = createMockProject();

    expect(project.id).toBe("test-project-12345678");
    expect(project.name).toBe("test-project");
    expect(project.path).toBe("/test/project");
    expect(project.workspaces).toHaveLength(1); // Includes default workspace
  });

  it("creates project without workspaces when option set", () => {
    const project = createMockProject({}, { includeDefaultWorkspace: false });

    expect(project.workspaces).toEqual([]);
  });

  it("allows overriding values", () => {
    const project = createMockProject({
      name: "custom-name",
      path: "/custom/path",
    });

    expect(project.name).toBe("custom-name");
    expect(project.path).toBe("/custom/path");
    expect(project.id).toBe("test-project-12345678"); // Default preserved
  });
});

describe("createMockWorkspace", () => {
  it("creates workspace with default values", () => {
    const workspace = createMockWorkspace();

    expect(workspace.projectId).toBe("test-project-12345678");
    expect(workspace.name).toBe("feature-1");
    expect(workspace.branch).toBe("feature-1"); // Branch matches name by default
    expect(workspace.metadata).toEqual({ base: "feature-1" });
    expect(workspace.path).toBe("/test/project/.worktrees/feature-1");
  });

  it("allows overriding values", () => {
    const workspace = createMockWorkspace({
      branch: "feature-branch",
    });

    expect(workspace.branch).toBe("feature-branch");
    expect(workspace.name).toBe("feature-1"); // Default preserved
  });
});

describe("registerAllMethodsWithStubs", () => {
  it("registers all required methods", () => {
    const mockRegistry = createMockRegistry();
    registerAllMethodsWithStubs(mockRegistry);

    // Should be able to get interface (means all methods registered)
    expect(() => mockRegistry.getInterface()).not.toThrow();
  });

  it("allows overriding specific methods", async () => {
    const mockRegistry = createMockRegistry();
    const customProject = createMockProject({ name: "override-project" });

    registerAllMethodsWithStubs(mockRegistry, {
      "projects.open": async () => customProject,
    });

    const api = mockRegistry.getInterface();
    const result = await api.projects.open("/test/path");

    expect(result.name).toBe("override-project");
  });
});
