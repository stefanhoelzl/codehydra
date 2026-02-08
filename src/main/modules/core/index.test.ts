/**
 * Unit tests for CoreModule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoreModule, type CoreModuleDeps } from "./index";
import { createMockRegistry } from "../../api/registry.test-utils";
import type { MockApiRegistry } from "../../api/registry.test-utils";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import { createMockLogger } from "../../../services/logging";
import { generateProjectId } from "../../api/id-utils";

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PROJECT_PATH = "/test/project";
const TEST_PROJECT_ID = generateProjectId(TEST_PROJECT_PATH);

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    openProject: vi.fn().mockResolvedValue({
      path: "/test/project",
      name: "test-project",
      workspaces: [],
    }),
    closeProject: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn(),
    getAllProjects: vi.fn().mockResolvedValue([]),
    getWorkspaceProvider: vi.fn().mockReturnValue({
      createWorkspace: vi.fn().mockResolvedValue({
        path: "/test/project/workspaces/feature",
        branch: "feature",
        metadata: { base: "main" },
      }),
      removeWorkspace: vi.fn().mockResolvedValue(undefined),
      listBases: vi.fn().mockResolvedValue([]),
      updateBases: vi.fn().mockResolvedValue(undefined),
      isDirty: vi.fn().mockResolvedValue(false),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    }),
    findProjectForWorkspace: vi.fn(),
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn().mockResolvedValue("main"),
    setLastBaseBranch: vi.fn(),
    loadPersistedProjects: vi.fn(),
    setDiscoveryService: vi.fn(),
    getDiscoveryService: vi.fn(),
    setAgentStatusManager: vi.fn(),
    getAgentStatusManager: vi.fn().mockReturnValue(null),
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockResolvedValue({ success: true }),
      getPort: vi.fn().mockReturnValue(null),
    }),
    ...overrides,
  } as unknown as AppState;
}

function createMockViewManager(): IViewManager {
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn().mockResolvedValue(undefined),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn().mockReturnValue(null),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn().mockReturnValue(() => {}),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
  } as unknown as IViewManager;
}

function createMockDeps(overrides: Partial<CoreModuleDeps> = {}): CoreModuleDeps {
  const defaults: CoreModuleDeps = {
    appState: createMockAppState(),
    viewManager: createMockViewManager(),
    gitClient: {
      clone: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../../services").IGitClient,
    pathProvider: {
      projectsDir: "/test/projects",
    } as unknown as import("../../../services").PathProvider,
    projectStore: {
      findByRemoteUrl: vi.fn().mockResolvedValue(undefined),
      saveProject: vi.fn().mockResolvedValue(undefined),
      getProjectConfig: vi.fn().mockResolvedValue(undefined),
      deleteProjectDirectory: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../../services").ProjectStore,
    logger: createMockLogger(),
  };
  return { ...defaults, ...overrides };
}

// =============================================================================
// Tests
// =============================================================================

describe("core.projects", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  describe("projects.open", () => {
    it("opens project and emits project:opened event", async () => {
      const appState = createMockAppState({
        openProject: vi.fn().mockResolvedValue({
          path: "/test/project",
          name: "test-project",
          workspaces: [],
        }),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.open");
      const result = await handler!({ path: "/test/project" });

      expect(result.name).toBe("test-project");
      expect(appState.openProject).toHaveBeenCalledWith("/test/project");

      const emittedEvents = registry.getEmittedEvents();
      expect(emittedEvents).toContainEqual({
        event: "project:opened",
        payload: { project: expect.any(Object) },
      });
    });

    it("includes defaultBaseBranch in project:opened event when present", async () => {
      const appState = createMockAppState({
        openProject: vi.fn().mockResolvedValue({
          path: "/test/project",
          name: "test-project",
          workspaces: [],
          defaultBaseBranch: "main",
        }),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.open");
      const result = await handler!({ path: "/test/project" });

      expect(result.defaultBaseBranch).toBe("main");

      const emittedEvents = registry.getEmittedEvents();
      expect(emittedEvents).toContainEqual({
        event: "project:opened",
        payload: {
          project: expect.objectContaining({
            defaultBaseBranch: "main",
          }),
        },
      });
    });
  });

  describe("projects.list", () => {
    it("returns list of projects", async () => {
      const appState = createMockAppState({
        getAllProjects: vi.fn().mockResolvedValue([
          { path: "/test/project1", name: "project1", workspaces: [] },
          { path: "/test/project2", name: "project2", workspaces: [] },
        ]),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.list");
      const result = await handler!({});

      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe("project1");
      expect(result[1]?.name).toBe("project2");
    });
  });

  describe("projects.close", () => {
    it("closes project and emits project:closed event", async () => {
      const appState = createMockAppState({
        getAllProjects: vi
          .fn()
          .mockResolvedValue([{ path: TEST_PROJECT_PATH, name: "test-project", workspaces: [] }]),
        closeProject: vi.fn().mockResolvedValue(undefined),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.close");
      await handler!({ projectId: TEST_PROJECT_ID });

      expect(appState.closeProject).toHaveBeenCalledWith(TEST_PROJECT_PATH);

      const emittedEvents = registry.getEmittedEvents();
      expect(emittedEvents).toContainEqual({
        event: "project:closed",
        payload: { projectId: TEST_PROJECT_ID },
      });
    });
  });
});

describe("core.registration", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("registers all projects.* paths with IPC", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("projects.open");
    expect(registeredPaths).toContain("projects.close");
    expect(registeredPaths).toContain("projects.list");
    expect(registeredPaths).toContain("projects.get");
    expect(registeredPaths).toContain("projects.fetchBases");
  });

  it("registers workspaces.get and workspaces.executeCommand (remove handled by intent dispatcher)", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).not.toContain("workspaces.create");
    expect(registeredPaths).not.toContain("workspaces.remove");
    expect(registeredPaths).toContain("workspaces.get");
  });

  it("registers methods with correct IPC channels", () => {
    new CoreModule(registry, deps);

    expect(registry.register).toHaveBeenCalledWith("projects.open", expect.any(Function), {
      ipc: "api:project:open",
    });
    expect(registry.register).toHaveBeenCalledWith("workspaces.get", expect.any(Function), {
      ipc: "api:workspace:get",
    });
  });
});

describe("CoreModule.dispose", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("dispose is a no-op", () => {
    const module = new CoreModule(registry, deps);
    expect(() => module.dispose()).not.toThrow();
  });
});
