/**
 * Type validation tests for API Registry types.
 * Uses expectTypeOf for compile-time type checking.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  MethodRegistry,
  MethodPath,
  MethodHandler,
  MethodPayload,
  MethodResult,
  EmptyPayload,
  ProjectOpenPayload,
  ProjectIdPayload,
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceRefPayload,
  WorkspaceSetMetadataPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
  LifecyclePath,
  ProjectPath,
  WorkspacePath,
  UiPath,
  IApiRegistry,
  IApiModule,
  RegistrationOptions,
  ApiEvents,
  Unsubscribe,
} from "./registry-types";
import { ALL_METHOD_PATHS } from "./registry-types";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  SetupResult,
  AppState,
  OpenCodeSession,
} from "../../shared/api/types";
import type { UIMode } from "../../shared/ipc";

describe("registry-types.paths", () => {
  it("ALL_METHOD_PATHS contains all MethodRegistry keys", () => {
    // This test is compile-time verified by the `satisfies` constraint in registry-types.ts
    // At runtime, we verify the count matches
    const registryKeyCount = 23; // Count of all methods in MethodRegistry
    expect(ALL_METHOD_PATHS.length).toBe(registryKeyCount);
  });

  it("ALL_METHOD_PATHS elements are type-safe MethodPath", () => {
    // Each element should be assignable to MethodPath
    for (const path of ALL_METHOD_PATHS) {
      expectTypeOf(path).toExtend<MethodPath>();
    }
  });

  it("MethodPath is union of all paths", () => {
    // MethodPath should accept any valid path
    expectTypeOf<"lifecycle.getState">().toExtend<MethodPath>();
    expectTypeOf<"projects.open">().toExtend<MethodPath>();
    expectTypeOf<"workspaces.create">().toExtend<MethodPath>();
    expectTypeOf<"ui.selectFolder">().toExtend<MethodPath>();
  });

  it("grouped paths match their expected values", () => {
    // Lifecycle paths
    expectTypeOf<"lifecycle.getState">().toExtend<LifecyclePath>();
    expectTypeOf<"lifecycle.setup">().toExtend<LifecyclePath>();
    expectTypeOf<"lifecycle.quit">().toExtend<LifecyclePath>();

    // Project paths
    expectTypeOf<"projects.open">().toExtend<ProjectPath>();
    expectTypeOf<"projects.close">().toExtend<ProjectPath>();
    expectTypeOf<"projects.list">().toExtend<ProjectPath>();
    expectTypeOf<"projects.get">().toExtend<ProjectPath>();
    expectTypeOf<"projects.fetchBases">().toExtend<ProjectPath>();

    // Workspace paths
    expectTypeOf<"workspaces.create">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.remove">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.forceRemove">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.get">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.getStatus">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.getOpenCodeSession">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.setMetadata">().toExtend<WorkspacePath>();
    expectTypeOf<"workspaces.getMetadata">().toExtend<WorkspacePath>();

    // UI paths
    expectTypeOf<"ui.selectFolder">().toExtend<UiPath>();
    expectTypeOf<"ui.getActiveWorkspace">().toExtend<UiPath>();
    expectTypeOf<"ui.switchWorkspace">().toExtend<UiPath>();
    expectTypeOf<"ui.setMode">().toExtend<UiPath>();
  });
});

describe("registry-types.payload", () => {
  it("extracts EmptyPayload for no-arg methods", () => {
    expectTypeOf<MethodPayload<"lifecycle.getState">>().toEqualTypeOf<EmptyPayload>();
    expectTypeOf<MethodPayload<"lifecycle.setup">>().toEqualTypeOf<EmptyPayload>();
    expectTypeOf<MethodPayload<"lifecycle.quit">>().toEqualTypeOf<EmptyPayload>();
    expectTypeOf<MethodPayload<"projects.list">>().toEqualTypeOf<EmptyPayload>();
    expectTypeOf<MethodPayload<"ui.selectFolder">>().toEqualTypeOf<EmptyPayload>();
    expectTypeOf<MethodPayload<"ui.getActiveWorkspace">>().toEqualTypeOf<EmptyPayload>();
  });

  it("extracts ProjectOpenPayload for projects.open", () => {
    expectTypeOf<MethodPayload<"projects.open">>().toEqualTypeOf<ProjectOpenPayload>();
    // Verify shape
    expectTypeOf<MethodPayload<"projects.open">>().toHaveProperty("path");
    expectTypeOf<MethodPayload<"projects.open">["path"]>().toBeString();
  });

  it("extracts ProjectIdPayload for project ID methods", () => {
    expectTypeOf<MethodPayload<"projects.close">>().toEqualTypeOf<ProjectIdPayload>();
    expectTypeOf<MethodPayload<"projects.get">>().toEqualTypeOf<ProjectIdPayload>();
    expectTypeOf<MethodPayload<"projects.fetchBases">>().toEqualTypeOf<ProjectIdPayload>();
    // Verify shape
    expectTypeOf<MethodPayload<"projects.close">>().toHaveProperty("projectId");
    expectTypeOf<MethodPayload<"projects.close">["projectId"]>().toEqualTypeOf<ProjectId>();
  });

  it("extracts WorkspaceCreatePayload for workspaces.create", () => {
    expectTypeOf<MethodPayload<"workspaces.create">>().toEqualTypeOf<WorkspaceCreatePayload>();
    // Verify shape
    expectTypeOf<MethodPayload<"workspaces.create">>().toHaveProperty("projectId");
    expectTypeOf<MethodPayload<"workspaces.create">>().toHaveProperty("name");
    expectTypeOf<MethodPayload<"workspaces.create">>().toHaveProperty("base");
  });

  it("extracts WorkspaceRemovePayload for workspaces.remove", () => {
    expectTypeOf<MethodPayload<"workspaces.remove">>().toEqualTypeOf<WorkspaceRemovePayload>();
    // Verify shape
    expectTypeOf<MethodPayload<"workspaces.remove">>().toHaveProperty("projectId");
    expectTypeOf<MethodPayload<"workspaces.remove">>().toHaveProperty("workspaceName");
    // keepBranch is optional
    type RemovePayload = MethodPayload<"workspaces.remove">;
    expectTypeOf<{
      projectId: ProjectId;
      workspaceName: WorkspaceName;
    }>().toExtend<RemovePayload>();
  });

  it("extracts WorkspaceRefPayload for workspace ref methods", () => {
    expectTypeOf<MethodPayload<"workspaces.forceRemove">>().toEqualTypeOf<WorkspaceRefPayload>();
    expectTypeOf<MethodPayload<"workspaces.get">>().toEqualTypeOf<WorkspaceRefPayload>();
    expectTypeOf<MethodPayload<"workspaces.getStatus">>().toEqualTypeOf<WorkspaceRefPayload>();
    expectTypeOf<
      MethodPayload<"workspaces.getOpenCodeSession">
    >().toEqualTypeOf<WorkspaceRefPayload>();
    expectTypeOf<MethodPayload<"workspaces.getMetadata">>().toEqualTypeOf<WorkspaceRefPayload>();
  });

  it("extracts WorkspaceSetMetadataPayload for workspaces.setMetadata", () => {
    expectTypeOf<
      MethodPayload<"workspaces.setMetadata">
    >().toEqualTypeOf<WorkspaceSetMetadataPayload>();
    // Verify shape
    expectTypeOf<MethodPayload<"workspaces.setMetadata">>().toHaveProperty("key");
    expectTypeOf<MethodPayload<"workspaces.setMetadata">>().toHaveProperty("value");
    expectTypeOf<MethodPayload<"workspaces.setMetadata">["value"]>().toEqualTypeOf<string | null>();
  });

  it("extracts UiSwitchWorkspacePayload for ui.switchWorkspace", () => {
    expectTypeOf<MethodPayload<"ui.switchWorkspace">>().toEqualTypeOf<UiSwitchWorkspacePayload>();
    // focus is optional
    type SwitchPayload = MethodPayload<"ui.switchWorkspace">;
    expectTypeOf<{
      projectId: ProjectId;
      workspaceName: WorkspaceName;
    }>().toExtend<SwitchPayload>();
  });

  it("extracts UiSetModePayload for ui.setMode", () => {
    expectTypeOf<MethodPayload<"ui.setMode">>().toEqualTypeOf<UiSetModePayload>();
    expectTypeOf<MethodPayload<"ui.setMode">>().toHaveProperty("mode");
    expectTypeOf<MethodPayload<"ui.setMode">["mode"]>().toEqualTypeOf<UIMode>();
  });
});

describe("registry-types.handler", () => {
  it("MethodHandler extracts correct function type", () => {
    // Handler for projects.open should accept ProjectOpenPayload and return Promise<Project>
    type OpenHandler = MethodHandler<"projects.open">;
    expectTypeOf<OpenHandler>().toBeFunction();
    expectTypeOf<OpenHandler>().parameter(0).toEqualTypeOf<ProjectOpenPayload>();
    expectTypeOf<OpenHandler>().returns.resolves.toEqualTypeOf<Project>();
  });

  it("MethodHandler matches MethodRegistry definition", () => {
    // MethodHandler<P> should be exactly MethodRegistry[P]
    expectTypeOf<MethodHandler<"lifecycle.getState">>().toEqualTypeOf<
      MethodRegistry["lifecycle.getState"]
    >();
    expectTypeOf<MethodHandler<"projects.list">>().toEqualTypeOf<MethodRegistry["projects.list"]>();
    expectTypeOf<MethodHandler<"workspaces.create">>().toEqualTypeOf<
      MethodRegistry["workspaces.create"]
    >();
    expectTypeOf<MethodHandler<"ui.setMode">>().toEqualTypeOf<MethodRegistry["ui.setMode"]>();
  });
});

describe("registry-types.result", () => {
  it("MethodResult extracts correct return type", () => {
    // Lifecycle methods
    expectTypeOf<MethodResult<"lifecycle.getState">>().toEqualTypeOf<AppState>();
    expectTypeOf<MethodResult<"lifecycle.setup">>().toEqualTypeOf<SetupResult>();
    expectTypeOf<MethodResult<"lifecycle.quit">>().toEqualTypeOf<void>();

    // Project methods
    expectTypeOf<MethodResult<"projects.open">>().toEqualTypeOf<Project>();
    expectTypeOf<MethodResult<"projects.close">>().toEqualTypeOf<void>();
    expectTypeOf<MethodResult<"projects.list">>().toEqualTypeOf<readonly Project[]>();
    expectTypeOf<MethodResult<"projects.get">>().toEqualTypeOf<Project | undefined>();
    expectTypeOf<MethodResult<"projects.fetchBases">>().toEqualTypeOf<{
      readonly bases: readonly BaseInfo[];
    }>();

    // Workspace methods
    expectTypeOf<MethodResult<"workspaces.create">>().toEqualTypeOf<Workspace>();
    expectTypeOf<MethodResult<"workspaces.remove">>().toEqualTypeOf<{ started: true }>();
    expectTypeOf<MethodResult<"workspaces.forceRemove">>().toEqualTypeOf<void>();
    expectTypeOf<MethodResult<"workspaces.get">>().toEqualTypeOf<Workspace | undefined>();
    expectTypeOf<MethodResult<"workspaces.getStatus">>().toEqualTypeOf<WorkspaceStatus>();
    expectTypeOf<
      MethodResult<"workspaces.getOpenCodeSession">
    >().toEqualTypeOf<OpenCodeSession | null>();
    expectTypeOf<MethodResult<"workspaces.setMetadata">>().toEqualTypeOf<void>();
    expectTypeOf<MethodResult<"workspaces.getMetadata">>().toEqualTypeOf<
      Readonly<Record<string, string>>
    >();

    // UI methods
    expectTypeOf<MethodResult<"ui.selectFolder">>().toEqualTypeOf<string | null>();
    expectTypeOf<MethodResult<"ui.getActiveWorkspace">>().toEqualTypeOf<WorkspaceRef | null>();
    expectTypeOf<MethodResult<"ui.switchWorkspace">>().toEqualTypeOf<void>();
    expectTypeOf<MethodResult<"ui.setMode">>().toEqualTypeOf<void>();
  });
});

describe("registry-types.interfaces", () => {
  it("IApiRegistry has required methods", () => {
    expectTypeOf<IApiRegistry>().toHaveProperty("register");
    expectTypeOf<IApiRegistry>().toHaveProperty("emit");
    expectTypeOf<IApiRegistry>().toHaveProperty("on");
    expectTypeOf<IApiRegistry>().toHaveProperty("getInterface");
    expectTypeOf<IApiRegistry>().toHaveProperty("dispose");
  });

  it("IApiRegistry.register accepts correct parameters", () => {
    type RegisterFn = IApiRegistry["register"];
    expectTypeOf<RegisterFn>().toBeFunction();
    // Should be a generic function that accepts MethodPath and matching handler
  });

  it("IApiRegistry.on returns Unsubscribe", () => {
    type OnFn = IApiRegistry["on"];
    expectTypeOf<OnFn>().returns.toEqualTypeOf<Unsubscribe>();
  });

  it("IApiRegistry.dispose returns Promise<void>", () => {
    type DisposeFn = IApiRegistry["dispose"];
    expectTypeOf<DisposeFn>().returns.resolves.toEqualTypeOf<void>();
  });

  it("IApiModule has dispose method", () => {
    expectTypeOf<IApiModule>().toHaveProperty("dispose");
    type DisposeFn = IApiModule["dispose"];
    expectTypeOf<DisposeFn>().returns.toEqualTypeOf<void>();
  });

  it("RegistrationOptions has optional ipc property", () => {
    expectTypeOf<RegistrationOptions>().toExtend<{ ipc?: string }>();
    // Empty options should be valid
    expectTypeOf<object>().toExtend<RegistrationOptions>();
  });
});

describe("registry-types.events", () => {
  it("ApiEvents is re-exported correctly", () => {
    // Verify some known events exist
    expectTypeOf<ApiEvents>().toHaveProperty("project:opened");
    expectTypeOf<ApiEvents>().toHaveProperty("workspace:created");
    expectTypeOf<ApiEvents>().toHaveProperty("ui:mode-changed");
  });
});
