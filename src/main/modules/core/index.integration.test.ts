/**
 * Integration tests for CoreModule.
 *
 * Note: Workspace deletion tests have been moved to
 * src/main/operations/__tests__/delete-workspace.integration.test.ts
 * since deletion is now handled by the intent dispatcher, not CoreModule.
 *
 * This file is kept for future CoreModule-specific integration tests
 * (e.g., project clone, workspace execute command).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoreModule, type CoreModuleDeps } from "./index";
import { createMockRegistry } from "../../api/registry.test-utils";
import type { MockApiRegistry } from "../../api/registry.test-utils";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import { createMockLogger } from "../../../services/logging";

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

describe("core.registration", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("registers all expected methods", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("projects.open");
    expect(registeredPaths).toContain("projects.close");
    expect(registeredPaths).toContain("projects.list");
    expect(registeredPaths).toContain("projects.get");
    expect(registeredPaths).toContain("projects.fetchBases");
    expect(registeredPaths).toContain("workspaces.get");
    expect(registeredPaths).toContain("workspaces.executeCommand");
    expect(registeredPaths).toContain("ui.selectFolder");
    expect(registeredPaths).toContain("ui.switchWorkspace");

    // Verify workspace create/remove NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("workspaces.create");
    expect(registeredPaths).not.toContain("workspaces.remove");
  });
});
