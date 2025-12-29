/**
 * Tests for test utilities and fixtures.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "./test-utils";
import { createMockProject, createMockWorkspace, createMockBaseInfo } from "./test-fixtures";

describe("createMockApi", () => {
  it("returns object with domain API namespaces", () => {
    const api = createMockApi();

    // Domain APIs
    expect(api.projects).toBeDefined();
    expect(api.workspaces).toBeDefined();
    expect(api.ui).toBeDefined();
    expect(api.lifecycle).toBeDefined();

    // Event subscription
    expect(api.on).toBeInstanceOf(Function);
    expect(api.onModeChange).toBeInstanceOf(Function);
    expect(api.onShortcut).toBeInstanceOf(Function);
  });

  it("on() returns unsubscribe function", () => {
    const api = createMockApi();

    const unsub = api.on("setup:progress", vi.fn());
    expect(unsub).toBeInstanceOf(Function);
  });

  it("projects methods return expected default values", async () => {
    const api = createMockApi();

    const project = await api.projects.open("/test");
    expect(project.id).toBe("test-12345678");

    expect(await api.projects.close("id")).toBeUndefined();
    expect(await api.projects.list()).toEqual([]);
    expect(await api.projects.get("id")).toBeUndefined();
    expect(await api.projects.fetchBases("id")).toEqual({ bases: [] });
  });

  it("workspaces methods return expected default values", async () => {
    const api = createMockApi();

    const workspace = await api.workspaces.create("id", "name", "main");
    expect(workspace.name).toBe("test"); // Uses MOCK_WORKSPACE_API_DEFAULTS.workspace

    const removeResult = await api.workspaces.remove("id", "name");
    expect(removeResult.started).toBe(true);

    expect(await api.workspaces.forceRemove("id", "name")).toBeUndefined();

    expect(await api.workspaces.get("id", "name")).toBeUndefined();

    const status = await api.workspaces.getStatus("id", "name");
    expect(status.isDirty).toBe(false);
    expect(status.agent.type).toBe("none");
  });

  it("ui methods return expected default values", async () => {
    const api = createMockApi();

    expect(await api.ui.selectFolder()).toBeNull();
    expect(await api.ui.getActiveWorkspace()).toBeNull();
    expect(await api.ui.switchWorkspace("id", "name")).toBeUndefined();
    expect(await api.ui.setMode("workspace")).toBeUndefined();
  });

  it("lifecycle methods return expected default values", async () => {
    const api = createMockApi();

    expect(await api.lifecycle.getState()).toBe("ready");
    expect(await api.lifecycle.setup()).toEqual({ success: true });
    expect(await api.lifecycle.quit()).toBeUndefined();
  });
});

describe("createMockProject", () => {
  it("returns valid Project with defaults", () => {
    const project = createMockProject();

    expect(project.path).toBe("/test/project");
    expect(project.name).toBe("test-project");
    expect(project.workspaces).toHaveLength(1);
    expect(project.workspaces[0]?.name).toBe("feature-1");
  });

  it("allows property overrides", () => {
    const project = createMockProject({
      path: "/custom/path" as import("@shared/ipc").ProjectPath,
      name: "custom-project",
      workspaces: [],
    });

    expect(project.path).toBe("/custom/path");
    expect(project.name).toBe("custom-project");
    expect(project.workspaces).toHaveLength(0);
  });
});

describe("createMockWorkspace", () => {
  it("returns valid Workspace with defaults", () => {
    const workspace = createMockWorkspace();

    expect(workspace.path).toBe("/test/project/.worktrees/feature-1");
    expect(workspace.name).toBe("feature-1");
    expect(workspace.branch).toBe("feature-1");
  });

  it("allows property overrides", () => {
    const workspace = createMockWorkspace({
      path: "/custom/worktree",
      name: "custom-ws",
      branch: null,
    });

    expect(workspace.path).toBe("/custom/worktree");
    expect(workspace.name).toBe("custom-ws");
    expect(workspace.branch).toBeNull();
  });
});

describe("createMockBaseInfo", () => {
  it("returns valid BaseInfo with defaults", () => {
    const baseInfo = createMockBaseInfo();

    expect(baseInfo.name).toBe("main");
    expect(baseInfo.isRemote).toBe(false);
  });

  it("allows property overrides", () => {
    const baseInfo = createMockBaseInfo({
      name: "origin/main",
      isRemote: true,
    });

    expect(baseInfo.name).toBe("origin/main");
    expect(baseInfo.isRemote).toBe(true);
  });
});
