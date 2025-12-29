/**
 * Integration tests for CoreModule.
 *
 * Tests workspace removal operations including killTerminalsCallback behavior.
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
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
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
    emitDeletionProgress: vi.fn(),
    logger: createMockLogger(),
  };
  return { ...defaults, ...overrides };
}

// =============================================================================
// Tests
// =============================================================================

describe("core.workspaces.remove.killTerminalsCallback", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("invokes killTerminalsCallback with workspace path when PluginServer is available", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const killTerminalsCallback = vi.fn().mockResolvedValue(undefined);

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = createMockViewManager();

    deps = createMockDeps({ appState, viewManager, emitDeletionProgress, killTerminalsCallback });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    // Wait for async deletion to complete by checking for the final progress event
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0];
      expect(progress.completed).toBe(true);
    });

    // Verify killTerminalsCallback was called with the correct workspace path
    expect(killTerminalsCallback).toHaveBeenCalledWith(workspacePath);
    expect(killTerminalsCallback).toHaveBeenCalledTimes(1);

    // Verify deletion completed successfully
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0];

    // Verify kill-terminals operation shows as done
    const killTerminalsOp = progress.operations.find(
      (op: { id: string }) => op.id === "kill-terminals"
    );
    expect(killTerminalsOp?.status).toBe("done");
  });

  it("continues deletion when killTerminalsCallback throws an error", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const killTerminalsCallback = vi.fn().mockRejectedValue(new Error("Kill terminals failed"));

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = createMockViewManager();

    deps = createMockDeps({ appState, viewManager, emitDeletionProgress, killTerminalsCallback });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0];
      expect(progress.completed).toBe(true);
    });

    // Verify killTerminalsCallback was called
    expect(killTerminalsCallback).toHaveBeenCalledWith(workspacePath);

    // Verify deletion still completed (error handling is graceful)
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0];
    expect(progress.completed).toBe(true);

    // kill-terminals operation should still show as "done" (errors are logged but not propagated)
    const killTerminalsOp = progress.operations.find(
      (op: { id: string }) => op.id === "kill-terminals"
    );
    expect(killTerminalsOp?.status).toBe("done");
  });

  it("proceeds with deletion when no killTerminalsCallback is provided", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = createMockViewManager();

    // No killTerminalsCallback provided
    deps = createMockDeps({ appState, viewManager, emitDeletionProgress });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0];
      expect(progress.completed).toBe(true);
    });

    // Verify deletion completed successfully
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0];
    expect(progress.completed).toBe(true);
    expect(progress.hasErrors).toBe(false);

    // kill-terminals operation should be done (skipped gracefully)
    const killTerminalsOp = progress.operations.find(
      (op: { id: string }) => op.id === "kill-terminals"
    );
    expect(killTerminalsOp?.status).toBe("done");
  });
});
