/**
 * Integration tests for CoreModule.
 *
 * Tests workspace removal operations including killTerminalsCallback behavior
 * and WorkspaceLockHandler integration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoreModule, type CoreModuleDeps } from "./index";
import { createMockRegistry } from "../../api/registry.test-utils";
import type { MockApiRegistry } from "../../api/registry.test-utils";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import { createMockLogger } from "../../../services/logging";
import { generateProjectId } from "../../api/id-utils";
import { createMockWorkspaceLockHandler } from "../../../services/platform/workspace-lock-handler.test-utils";
import type { DeletionProgress } from "../../../shared/api/types";
import { GitError } from "../../../services/errors";

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

// =============================================================================
// Workspace Create Tests
// =============================================================================

describe("core.workspaces.create", () => {
  let registry: MockApiRegistry;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("normalizes string initialPrompt to { prompt, agent: undefined }", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const addWorkspace = vi.fn();

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [],
      }),
      addWorkspace,
      getWorkspaceProvider: vi.fn().mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue({
          path: { toString: () => workspacePath },
          branch: "feature",
          metadata: { base: "main" },
        }),
      }),
    });

    const viewManager = createMockViewManager();
    const deps = createMockDeps({ appState, viewManager });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.create");
    await handler!({
      projectId: TEST_PROJECT_ID,
      name: "feature",
      base: "main",
      initialPrompt: "Implement the login feature",
    });

    // Verify addWorkspace was called with normalized prompt (agent undefined)
    expect(addWorkspace).toHaveBeenCalledWith(
      TEST_PROJECT_PATH,
      expect.objectContaining({
        branch: "feature",
      }),
      { initialPrompt: { prompt: "Implement the login feature" } }
    );

    // Verify agent is NOT in the normalized prompt
    const callArgs = addWorkspace.mock.calls[0];
    expect(callArgs![2]?.initialPrompt?.agent).toBeUndefined();
  });

  it("passes through object initialPrompt with agent", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const addWorkspace = vi.fn();

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [],
      }),
      addWorkspace,
      getWorkspaceProvider: vi.fn().mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue({
          path: { toString: () => workspacePath },
          branch: "feature",
          metadata: { base: "main" },
        }),
      }),
    });

    const viewManager = createMockViewManager();
    const deps = createMockDeps({ appState, viewManager });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.create");
    await handler!({
      projectId: TEST_PROJECT_ID,
      name: "feature",
      base: "main",
      initialPrompt: { prompt: "Implement the login feature", agent: "build" },
    });

    // Verify addWorkspace was called with full prompt object including agent
    expect(addWorkspace).toHaveBeenCalledWith(
      TEST_PROJECT_PATH,
      expect.objectContaining({
        branch: "feature",
      }),
      { initialPrompt: { prompt: "Implement the login feature", agent: "build" } }
    );
  });

  it("switches to new workspace when keepInBackground is false", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [],
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue({
          path: { toString: () => workspacePath },
          branch: "feature",
          metadata: { base: "main" },
        }),
      }),
    });

    const setActiveWorkspace = vi.fn();
    const viewManager = createMockViewManager();
    (
      viewManager as unknown as { setActiveWorkspace: typeof setActiveWorkspace }
    ).setActiveWorkspace = setActiveWorkspace;

    const deps = createMockDeps({ appState, viewManager });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.create");
    await handler!({
      projectId: TEST_PROJECT_ID,
      name: "feature",
      base: "main",
      keepInBackground: false,
    });

    // Verify setActiveWorkspace was called with the new workspace path
    expect(setActiveWorkspace).toHaveBeenCalledWith(workspacePath, true);
  });

  it("does not switch workspace when keepInBackground is true", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [],
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue({
          path: { toString: () => workspacePath },
          branch: "feature",
          metadata: { base: "main" },
        }),
      }),
    });

    const setActiveWorkspace = vi.fn();
    const viewManager = createMockViewManager();
    (
      viewManager as unknown as { setActiveWorkspace: typeof setActiveWorkspace }
    ).setActiveWorkspace = setActiveWorkspace;

    const deps = createMockDeps({ appState, viewManager });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.create");
    await handler!({
      projectId: TEST_PROJECT_ID,
      name: "feature",
      base: "main",
      keepInBackground: true,
    });

    // Verify setActiveWorkspace was NOT called
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });

  it("defaults keepInBackground to false (switches workspace)", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [],
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue({
          path: { toString: () => workspacePath },
          branch: "feature",
          metadata: { base: "main" },
        }),
      }),
    });

    const setActiveWorkspace = vi.fn();
    const viewManager = createMockViewManager();
    (
      viewManager as unknown as { setActiveWorkspace: typeof setActiveWorkspace }
    ).setActiveWorkspace = setActiveWorkspace;

    const deps = createMockDeps({ appState, viewManager });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.create");
    await handler!({
      projectId: TEST_PROJECT_ID,
      name: "feature",
      base: "main",
      // keepInBackground not specified - should default to false
    });

    // Verify setActiveWorkspace was called (default behavior = switch)
    expect(setActiveWorkspace).toHaveBeenCalledWith(workspacePath, true);
  });

  it("does not pass initialPrompt options when no initialPrompt provided", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const addWorkspace = vi.fn();

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [],
      }),
      addWorkspace,
      getWorkspaceProvider: vi.fn().mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue({
          path: { toString: () => workspacePath },
          branch: "feature",
          metadata: { base: "main" },
        }),
      }),
    });

    const viewManager = createMockViewManager();
    const deps = createMockDeps({ appState, viewManager });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.create");
    await handler!({
      projectId: TEST_PROJECT_ID,
      name: "feature",
      base: "main",
      // No initialPrompt
    });

    // Verify addWorkspace was called with undefined options (no initialPrompt)
    expect(addWorkspace).toHaveBeenCalledWith(
      TEST_PROJECT_PATH,
      expect.objectContaining({
        branch: "feature",
      }),
      undefined
    );
  });
});

// =============================================================================
// restartAgentServer Tests
// =============================================================================

describe("core.workspaces.restartAgentServer", () => {
  let registry: MockApiRegistry;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("returns port for valid workspace with running server", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;

    const restartServer = vi.fn().mockResolvedValue({ success: true, port: 14001 });

    const projectData = {
      path: TEST_PROJECT_PATH,
      name: "test-project",
      workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
    };

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([projectData]),
      getProject: vi.fn().mockReturnValue(projectData),
      getServerManager: vi.fn().mockReturnValue({
        restartServer,
        getPort: vi.fn().mockReturnValue(14001),
      }),
    });

    const deps = createMockDeps({ appState });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.restartAgentServer");
    const port = await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
    });

    expect(port).toBe(14001);
    expect(restartServer).toHaveBeenCalledWith(workspacePath);
  });

  it("throws error when server manager not available", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;

    const projectData = {
      path: TEST_PROJECT_PATH,
      name: "test-project",
      workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
    };

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([projectData]),
      getProject: vi.fn().mockReturnValue(projectData),
      getServerManager: vi.fn().mockReturnValue(null),
    });

    const deps = createMockDeps({ appState });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.restartAgentServer");
    await expect(
      handler!({
        projectId: TEST_PROJECT_ID,
        workspaceName,
      })
    ).rejects.toThrow("Agent server manager not available");
  });

  it("throws error when restart fails", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;

    const restartServer = vi
      .fn()
      .mockResolvedValue({ success: false, error: "Server not running", serverStopped: false });

    const projectData = {
      path: TEST_PROJECT_PATH,
      name: "test-project",
      workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
    };

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([projectData]),
      getProject: vi.fn().mockReturnValue(projectData),
      getServerManager: vi.fn().mockReturnValue({
        restartServer,
        getPort: vi.fn().mockReturnValue(null),
      }),
    });

    const deps = createMockDeps({ appState });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.restartAgentServer");
    await expect(
      handler!({
        projectId: TEST_PROJECT_ID,
        workspaceName,
      })
    ).rejects.toThrow("Server not running");
  });
});

// =============================================================================
// WorkspaceLockHandler Integration Tests
// =============================================================================

describe("core.workspaces.remove.workspaceLockHandler", () => {
  let registry: MockApiRegistry;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("calls killProcesses before deletion when unblock is 'kill'", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler({
      processes: [{ pid: 1234, name: "node.exe", commandLine: "node", files: [], cwd: null }],
    });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      unblock: "kill",
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify detect was called TWICE:
    // 1. First to get PIDs for killProcesses
    // 2. Then proactive detection after cleanup to verify
    expect(mockBlockingService.detectCalls).toBe(2);
    expect(mockBlockingService.killProcessesCalls).toBe(1);
    expect(mockBlockingService.lastKillPids).toEqual([1234]);
  });

  it("emits killing-blockers step before and after kill operation", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler({
      processes: [{ pid: 1234, name: "node.exe", commandLine: "node", files: [], cwd: null }],
    });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      unblock: "kill",
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Find the first progress event - should include killing-blockers as in-progress
    const firstCall = emitDeletionProgress.mock.calls[0];
    const firstProgress = firstCall![0] as DeletionProgress;
    const killingOp = firstProgress.operations.find((op) => op.id === "killing-blockers");
    expect(killingOp).toBeDefined();
    expect(killingOp!.label).toBe("Killing blocking tasks...");
    expect(killingOp!.status).toBe("in-progress");

    // Find final progress - killing-blockers should be done
    const finalCall = emitDeletionProgress.mock.calls[emitDeletionProgress.mock.calls.length - 1];
    const finalProgress = finalCall![0] as DeletionProgress;
    const finalKillingOp = finalProgress.operations.find((op) => op.id === "killing-blockers");
    expect(finalKillingOp).toBeDefined();
    expect(finalKillingOp!.status).toBe("done");
  });

  it("calls closeHandles before deletion when unblock is 'close'", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler({
      processes: [
        { pid: 1234, name: "node.exe", commandLine: "node", files: ["file.txt"], cwd: null },
      ],
    });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      unblock: "close",
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify closeHandles was called (not killProcesses)
    expect(mockBlockingService.closeHandlesCalls).toBe(1);
    expect(mockBlockingService.killProcessesCalls).toBe(0);
  });

  it("emits closing-handles step before and after close operation", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler({
      processes: [
        { pid: 1234, name: "node.exe", commandLine: "node", files: ["file.txt"], cwd: null },
      ],
    });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      unblock: "close",
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Find the first progress event - should include closing-handles as in-progress
    const firstCall = emitDeletionProgress.mock.calls[0];
    const firstProgress = firstCall![0] as DeletionProgress;
    const closingOp = firstProgress.operations.find((op) => op.id === "closing-handles");
    expect(closingOp).toBeDefined();
    expect(closingOp!.label).toBe("Closing blocking handles...");
    expect(closingOp!.status).toBe("in-progress");

    // Find final progress - closing-handles should be done
    const finalCall = emitDeletionProgress.mock.calls[emitDeletionProgress.mock.calls.length - 1];
    const finalProgress = finalCall![0] as DeletionProgress;
    const finalClosingOp = finalProgress.operations.find((op) => op.id === "closing-handles");
    expect(finalClosingOp).toBeDefined();
    expect(finalClosingOp!.status).toBe("done");
  });

  it("does not call killProcesses when unblock is false", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler();

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      // unblock omitted - no unblock action
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify killProcesses was NOT called (no pre-detection either for unblock)
    expect(mockBlockingService.killProcessesCalls).toBe(0);
  });

  it("does not include unblock steps when unblock is omitted", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler();

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      // unblock omitted - no unblock action
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify no unblock steps (killing-blockers/closing-handles) are present in any progress event
    for (const call of emitDeletionProgress.mock.calls) {
      const progress = call[0] as DeletionProgress;
      const hasClosingHandles = progress.operations.some((op) => op.id === "closing-handles");
      const hasKillingBlockers = progress.operations.some((op) => op.id === "killing-blockers");
      expect(hasClosingHandles).toBe(false);
      expect(hasKillingBlockers).toBe(false);
    }
  });

  it("includes blocking processes in DeletionProgress when proactive detection finds blockers", async () => {
    // With proactive detection, blockers are found BEFORE cleanup-workspace runs.
    // This stops deletion early with detecting-blockers in error state.
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const blockingProcesses = [
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: [], cwd: null },
      {
        pid: 5678,
        name: "Code.exe",
        commandLine: "C:\\Program Files\\Code\\Code.exe",
        files: [],
        cwd: null,
      },
    ];
    const mockBlockingService = createMockWorkspaceLockHandler({ processes: blockingProcesses });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
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
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify proactive detect was called once
    expect(mockBlockingService.detectCalls).toBe(1);
    expect(mockBlockingService.lastDetectPath?.toString()).toBe(workspacePath);

    // Verify blocking processes are included in the final progress event
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0] as DeletionProgress;
    expect(progress.hasErrors).toBe(true);
    expect(progress.blockingProcesses).toEqual(blockingProcesses);

    // Verify detecting-blockers operation shows error (proactive detection found blockers)
    const detectOp = progress.operations.find((op) => op.id === "detecting-blockers");
    expect(detectOp?.status).toBe("error");

    // Verify cleanup-workspace stays pending (never runs when proactive detection finds blockers)
    const cleanupOp = progress.operations.find((op) => op.id === "cleanup-workspace");
    expect(cleanupOp?.status).toBe("pending");
  });

  it("detects blocking processes on EACCES error", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const blockingProcesses = [
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: [], cwd: null },
    ];
    const mockBlockingService = createMockWorkspaceLockHandler({ processes: blockingProcesses });

    // Create EACCES error for workspace removal
    const eaccesError = new Error("Permission denied") as NodeJS.ErrnoException;
    eaccesError.code = "EACCES";

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
        removeWorkspace: vi.fn().mockRejectedValue(eaccesError),
      }),
    });

    const viewManager = createMockViewManager();

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
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
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify blocking processes detection was triggered
    expect(mockBlockingService.detectCalls).toBe(1);
  });

  it("detects blocking processes when GitError has no error code", async () => {
    // This tests the fix for the issue where git errors (GitError) don't have
    // an error code, so we couldn't detect blocking processes using error codes alone.
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const blockingProcesses = [
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: [], cwd: null },
    ];
    const mockBlockingService = createMockWorkspaceLockHandler({ processes: blockingProcesses });

    // Create GitError (has no .code property - this is the actual issue we're fixing)
    const gitError = new GitError("Failed to remove worktree: Permission denied");

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
        removeWorkspace: vi.fn().mockRejectedValue(gitError),
      }),
    });

    const viewManager = createMockViewManager();

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
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
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify detect was called even though GitError has no error code
    expect(mockBlockingService.detectCalls).toBe(1);

    // Verify blocking processes ARE included in the final progress event
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0] as DeletionProgress;
    expect(progress.hasErrors).toBe(true);
    expect(progress.blockingProcesses).toEqual(blockingProcesses);
  });

  it("calls getBlockingProcesses for any cleanup error (not just file lock codes)", async () => {
    // Detection is called twice:
    // 1. Proactively before cleanup-workspace (finds nothing, continues)
    // 2. Reactively after cleanup error (catches any lingering blockers)
    // This ensures we detect blockers even for git errors (GitError) that
    // don't preserve filesystem error codes.
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler();

    // Create ENOENT error - not a typical file lock error but we still check
    const enoentError = new Error("File not found") as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";

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
        removeWorkspace: vi.fn().mockRejectedValue(enoentError),
      }),
    });

    const viewManager = createMockViewManager();

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
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
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify detect was called TWICE: proactive + reactive after error
    expect(mockBlockingService.detectCalls).toBe(2);

    // But no blocking processes found (mock returns empty array by default)
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0] as DeletionProgress;
    expect(progress.blockingProcesses).toBeUndefined();
  });

  it("blockingProcesses is undefined when no WorkspaceLockHandler is provided (non-Windows)", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    // Create EBUSY error for workspace removal
    const ebusyError = new Error("Directory in use") as NodeJS.ErrnoException;
    ebusyError.code = "EBUSY";

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
        removeWorkspace: vi.fn().mockRejectedValue(ebusyError),
      }),
    });

    const viewManager = createMockViewManager();

    // No workspaceLockHandler provided (simulating non-Windows)
    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      // No workspaceLockHandler
    });
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
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify blockingProcesses is undefined in all progress events
    const calls = emitDeletionProgress.mock.calls;
    for (const call of calls) {
      const progress = call[0] as DeletionProgress;
      expect(progress.blockingProcesses).toBeUndefined();
    }
  });

  it("retry skips proactive detection (isRetry: true)", async () => {
    // Test case #12: workspace.remove({ isRetry: true }) skips proactive detection
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler({
      processes: [{ pid: 1234, name: "node.exe", commandLine: "node", files: [], cwd: null }],
    });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      isRetry: true, // User clicked Retry button
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify detect was NOT called (retry skips proactive detection)
    expect(mockBlockingService.detectCalls).toBe(0);

    // Verify detecting-blockers is NOT in operations
    for (const call of emitDeletionProgress.mock.calls) {
      const progress = call[0] as DeletionProgress;
      const hasDetecting = progress.operations.some((op) => op.id === "detecting-blockers");
      expect(hasDetecting).toBe(false);
    }

    // Verify deletion completed successfully
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0] as DeletionProgress;
    expect(progress.completed).toBe(true);
    expect(progress.hasErrors).toBe(false);

    // Verify cleanup-workspace completed
    const cleanupOp = progress.operations.find((op) => op.id === "cleanup-workspace");
    expect(cleanupOp?.status).toBe("done");
  });

  it("ignore skips detection entirely (unblock: 'ignore')", async () => {
    // Test case #14: workspace.remove({ unblock: "ignore" }) skips detection entirely
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();
    const mockBlockingService = createMockWorkspaceLockHandler({
      processes: [{ pid: 1234, name: "node.exe", commandLine: "node", files: [], cwd: null }],
    });

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

    const deps = createMockDeps({
      appState,
      viewManager,
      emitDeletionProgress,
      workspaceLockHandler: mockBlockingService,
    });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
      unblock: "ignore", // Power user escape hatch
    });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0] as DeletionProgress;
      expect(progress.completed).toBe(true);
    });

    // Verify detect was NOT called (ignore skips detection entirely)
    expect(mockBlockingService.detectCalls).toBe(0);

    // Verify detecting-blockers is NOT in operations
    for (const call of emitDeletionProgress.mock.calls) {
      const progress = call[0] as DeletionProgress;
      const hasDetecting = progress.operations.some((op) => op.id === "detecting-blockers");
      expect(hasDetecting).toBe(false);
    }

    // Verify no unblock steps (killing-blockers/closing-handles) are present either
    for (const call of emitDeletionProgress.mock.calls) {
      const progress = call[0] as DeletionProgress;
      const hasKilling = progress.operations.some((op) => op.id === "killing-blockers");
      const hasClosing = progress.operations.some((op) => op.id === "closing-handles");
      expect(hasKilling).toBe(false);
      expect(hasClosing).toBe(false);
    }

    // Verify deletion completed successfully
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0] as DeletionProgress;
    expect(progress.completed).toBe(true);
    expect(progress.hasErrors).toBe(false);

    // Verify cleanup-workspace completed
    const cleanupOp = progress.operations.find((op) => op.id === "cleanup-workspace");
    expect(cleanupOp?.status).toBe("done");
  });
});
