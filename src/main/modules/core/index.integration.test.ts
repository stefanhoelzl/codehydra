/**
 * Integration tests for CoreModule.
 *
 * Note: Workspace deletion tests are in
 * src/main/operations/delete-workspace.integration.test.ts
 * Project open/close/clone tests are in
 * src/main/operations/open-project.integration.test.ts and
 * src/main/operations/close-project.integration.test.ts
 *
 * This file tests CoreModule-specific behavior
 * (e.g., workspace execute command, project queries).
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
    getProject: vi.fn(),
    getAllProjects: vi.fn().mockResolvedValue([]),
    findProjectForWorkspace: vi.fn(),
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn().mockResolvedValue("main"),
    setLastBaseBranch: vi.fn(),
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
      remotesDir: "/test/remotes",
    } as unknown as import("../../../services").PathProvider,
    projectStore: {
      findByRemoteUrl: vi.fn().mockResolvedValue(undefined),
      saveProject: vi.fn().mockResolvedValue(undefined),
      getProjectConfig: vi.fn().mockResolvedValue(undefined),
      deleteProjectDirectory: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../../services").ProjectStore,
    globalProvider: {
      listBases: vi.fn().mockResolvedValue([]),
      updateBases: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../../services/git/git-worktree-provider").GitWorktreeProvider,
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
    expect(registeredPaths).toContain("projects.list");
    expect(registeredPaths).toContain("projects.get");
    expect(registeredPaths).toContain("workspaces.get");
    expect(registeredPaths).toContain("workspaces.executeCommand");
    expect(registeredPaths).toContain("ui.selectFolder");

    // Verify ui.switchWorkspace NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("ui.switchWorkspace");

    // Verify workspace create/remove NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("workspaces.create");
    expect(registeredPaths).not.toContain("workspaces.remove");

    // Verify projects.fetchBases NOT registered (handled by intent dispatcher in bootstrap.ts)
    expect(registeredPaths).not.toContain("projects.fetchBases");

    // Verify project open/close/clone NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("projects.open");
    expect(registeredPaths).not.toContain("projects.close");
    expect(registeredPaths).not.toContain("projects.clone");
  });
});
