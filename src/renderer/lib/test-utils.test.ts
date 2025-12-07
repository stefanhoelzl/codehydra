/**
 * Tests for test utilities and fixtures.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "./test-utils";
import { createMockProject, createMockWorkspace, createMockBaseInfo } from "./test-fixtures";

describe("createMockApi", () => {
  it("returns object with all Api functions", () => {
    const api = createMockApi();

    // Commands
    expect(api.selectFolder).toBeInstanceOf(Function);
    expect(api.openProject).toBeInstanceOf(Function);
    expect(api.closeProject).toBeInstanceOf(Function);
    expect(api.listProjects).toBeInstanceOf(Function);
    expect(api.createWorkspace).toBeInstanceOf(Function);
    expect(api.removeWorkspace).toBeInstanceOf(Function);
    expect(api.switchWorkspace).toBeInstanceOf(Function);
    expect(api.listBases).toBeInstanceOf(Function);
    expect(api.updateBases).toBeInstanceOf(Function);
    expect(api.isWorkspaceDirty).toBeInstanceOf(Function);

    // Events
    expect(api.onProjectOpened).toBeInstanceOf(Function);
    expect(api.onProjectClosed).toBeInstanceOf(Function);
    expect(api.onWorkspaceCreated).toBeInstanceOf(Function);
    expect(api.onWorkspaceRemoved).toBeInstanceOf(Function);
    expect(api.onWorkspaceSwitched).toBeInstanceOf(Function);
  });

  it("event subscriptions return unsubscribe functions", () => {
    const api = createMockApi();

    const unsubProjectOpened = api.onProjectOpened(vi.fn());
    const unsubProjectClosed = api.onProjectClosed(vi.fn());
    const unsubWorkspaceCreated = api.onWorkspaceCreated(vi.fn());
    const unsubWorkspaceRemoved = api.onWorkspaceRemoved(vi.fn());
    const unsubWorkspaceSwitched = api.onWorkspaceSwitched(vi.fn());

    expect(unsubProjectOpened).toBeInstanceOf(Function);
    expect(unsubProjectClosed).toBeInstanceOf(Function);
    expect(unsubWorkspaceCreated).toBeInstanceOf(Function);
    expect(unsubWorkspaceRemoved).toBeInstanceOf(Function);
    expect(unsubWorkspaceSwitched).toBeInstanceOf(Function);
  });

  it("command mocks return expected default values", async () => {
    const api = createMockApi();

    expect(await api.selectFolder()).toBeNull();
    expect(await api.openProject("/path")).toBeUndefined();
    expect(await api.closeProject("/path")).toBeUndefined();
    expect(await api.listProjects()).toEqual([]);
    expect(await api.createWorkspace("/path", "name", "main")).toBeUndefined();
    expect(await api.removeWorkspace("/path", true)).toBeUndefined();
    expect(await api.switchWorkspace("/path")).toBeUndefined();
    expect(await api.listBases("/path")).toEqual([]);
    expect(await api.updateBases("/path")).toBeUndefined();
    expect(await api.isWorkspaceDirty("/path")).toBe(false);
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
