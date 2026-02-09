/**
 * Integration tests for DeleteWorkspaceOperation.
 *
 * Tests the full delete-workspace pipeline through dispatcher.dispatch():
 * - Operation orchestrates hooks (shutdown -> release -> delete)
 * - Interceptor enforces idempotency (per-workspace)
 * - Event subscribers update state and emit IPC events
 * - Progress callback captures DeletionProgress objects
 *
 * All tests use behavioral mocks -- state changes and outcomes are verified,
 * not call tracking. Windows behavior is tested via behavioral mocks on all platforms.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { IntentModule } from "../intents/infrastructure/module";
import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import {
  DeleteWorkspaceOperation,
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
} from "./delete-workspace";
import type { WorkspaceDeletedEvent, DeleteWorkspaceHookContext } from "./delete-workspace";
import type { DeleteWorkspaceIntent, DeletionProgressCallback } from "./delete-workspace";
import type { HookContext } from "../intents/infrastructure/operation";
import type { IViewManager } from "../managers/view-manager.interface";
import type { AppState } from "../app-state";
import type { IApiRegistry } from "../api/registry-types";
import type { WorkspaceLockHandler } from "../../services/platform/workspace-lock-handler";
import type { IWorkspaceFileService } from "../../services";
import type { WorkspacePath } from "../../shared/ipc";
import type { DeletionProgress, WorkspaceName } from "../../shared/api/types";
import { createBehavioralLogger } from "../../services/logging/logging.test-utils";
import { generateProjectId } from "../../shared/api/id-utils";
import { extractWorkspaceName } from "../api/id-utils";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../services/platform/path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/project";
const PROJECT_ID = generateProjectId(PROJECT_PATH);
const WORKSPACE_PATH = "/test/project/workspaces/feature-a";
const WORKSPACE_NAME = "feature-a" as WorkspaceName;

const WORKSPACE_PATH_B = "/test/project/workspaces/feature-b";
const WORKSPACE_NAME_B = "feature-b" as WorkspaceName;

// =============================================================================
// Helper: Build Intent
// =============================================================================

function buildDeleteIntent(
  overrides?: Partial<DeleteWorkspaceIntent["payload"]>
): DeleteWorkspaceIntent {
  return {
    type: INTENT_DELETE_WORKSPACE,
    payload: {
      projectId: PROJECT_ID,
      workspaceName: WORKSPACE_NAME,
      workspacePath: WORKSPACE_PATH,
      projectPath: PROJECT_PATH,
      keepBranch: true,
      force: false,
      removeWorktree: true,
      ...overrides,
    },
  };
}

// =============================================================================
// Mock Factories
// =============================================================================

interface TestAppState {
  projects: Array<{
    path: string;
    name: string;
    workspaces: Array<{ path: string; branch: string; metadata: Record<string, string> }>;
  }>;
  serverStopped: boolean;
  mcpCleared: boolean;
  tuiCleared: boolean;
  removedWorkspaces: Array<{ projectPath: string; workspacePath: string }>;
  worktreeRemoved: boolean;
}

function createTestAppState(initial?: Partial<TestAppState>): {
  appState: AppState;
  state: TestAppState;
} {
  const state: TestAppState = {
    projects: [
      {
        path: PROJECT_PATH,
        name: "test-project",
        workspaces: [
          { path: WORKSPACE_PATH, branch: "feature-a", metadata: { base: "main" } },
          { path: WORKSPACE_PATH_B, branch: "feature-b", metadata: { base: "main" } },
        ],
      },
    ],
    serverStopped: false,
    mcpCleared: false,
    tuiCleared: false,
    removedWorkspaces: [],
    worktreeRemoved: false,
    ...initial,
  };

  const appState = {
    getAllProjects: vi.fn().mockImplementation(async () =>
      state.projects.map((p) => ({
        ...p,
        workspaces: p.workspaces.map((w) => ({ ...w })),
      }))
    ),
    getProject: vi.fn().mockImplementation((path: string) => {
      const p = state.projects.find((proj) => proj.path === path);
      return p ? { ...p, workspaces: p.workspaces.map((w) => ({ ...w })) } : undefined;
    }),
    findProjectForWorkspace: vi.fn().mockImplementation((wsPath: string) => {
      for (const p of state.projects) {
        if (p.workspaces.some((w) => w.path === wsPath)) {
          return { ...p };
        }
      }
      return undefined;
    }),
    getWorkspaceProvider: vi.fn().mockImplementation(() => ({
      removeWorkspace: vi.fn().mockImplementation(async () => {
        state.worktreeRemoved = true;
      }),
    })),
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockImplementation(async () => {
        state.serverStopped = true;
        return { success: true };
      }),
    }),
    getMcpServerManager: vi.fn().mockReturnValue({
      clearWorkspace: vi.fn().mockImplementation(() => {
        state.mcpCleared = true;
      }),
    }),
    getAgentStatusManager: vi.fn().mockReturnValue({
      clearTuiTracking: vi.fn().mockImplementation(() => {
        state.tuiCleared = true;
      }),
      getStatus: vi.fn().mockReturnValue({ status: "idle" }),
    }),
    unregisterWorkspace: vi
      .fn()
      .mockImplementation((projectPath: string, workspacePath: string) => {
        state.removedWorkspaces.push({ projectPath, workspacePath });
        // Actually remove from state
        const project = state.projects.find((p) => p.path === projectPath);
        if (project) {
          const idx = project.workspaces.findIndex((w) => w.path === workspacePath);
          if (idx >= 0) {
            project.workspaces.splice(idx, 1);
          }
        }
      }),
  } as unknown as AppState;

  return { appState, state };
}

function createTestViewManager(activeWorkspacePath: string | null = WORKSPACE_PATH): {
  viewManager: IViewManager;
  activeWorkspace: { path: string | null };
  destroyedViews: string[];
} {
  const activeWorkspace = { path: activeWorkspacePath };
  const destroyedViews: string[] = [];

  const viewManager = {
    getActiveWorkspacePath: vi.fn().mockImplementation(() => activeWorkspace.path),
    setActiveWorkspace: vi.fn().mockImplementation((path: string | null) => {
      activeWorkspace.path = path;
    }),
    destroyWorkspaceView: vi.fn().mockImplementation(async (path: string) => {
      destroyedViews.push(path);
    }),
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn().mockReturnValue(() => {}),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
  } as unknown as IViewManager;

  return { viewManager, activeWorkspace, destroyedViews };
}

function createTestApiRegistry(): {
  registry: IApiRegistry;
  emittedEvents: Array<{ event: string; payload: unknown }>;
} {
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const registry = {
    emit: vi.fn().mockImplementation((event: string, payload: unknown) => {
      emittedEvents.push({ event, payload });
    }),
    on: vi.fn().mockReturnValue(() => {}),
  } as unknown as IApiRegistry;
  return { registry, emittedEvents };
}

function createTestWorkspaceFileService(): IWorkspaceFileService {
  return {
    deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as IWorkspaceFileService;
}

// =============================================================================
// Test Harness: Wires all modules with real Dispatcher + HookRegistry
// =============================================================================

/**
 * Prioritized workspace selection algorithm (test copy).
 * Uses test mock references for appState and viewManager.
 */
async function switchToNextWorkspaceIfAvailable(
  currentWorkspacePath: string,
  viewManager: IViewManager,
  appState: AppState
): Promise<boolean> {
  const allProjects = await appState.getAllProjects();

  const sortedProjects = [...allProjects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { caseFirst: "upper" })
  );

  const workspaces: Array<{ path: string }> = [];
  for (const project of sortedProjects) {
    const sortedWs = [...project.workspaces].sort((a, b) => {
      const nameA = extractWorkspaceName(a.path);
      const nameB = extractWorkspaceName(b.path);
      return nameA.localeCompare(nameB, undefined, { caseFirst: "upper" });
    });
    for (const ws of sortedWs) {
      workspaces.push({ path: ws.path });
    }
  }

  if (workspaces.length === 0) {
    return false;
  }

  const currentIndex = workspaces.findIndex((w) => w.path === currentWorkspacePath);
  if (currentIndex === -1) {
    return false;
  }

  const agentStatusManager = appState.getAgentStatusManager();
  const getKey = (ws: { path: string }, index: number): number => {
    let statusKey: number;
    const status = agentStatusManager?.getStatus(ws.path as WorkspacePath);
    if (!status || status.status === "none") {
      statusKey = 2;
    } else if (status.status === "busy") {
      statusKey = 1;
    } else {
      statusKey = 0;
    }

    const positionKey = (index - currentIndex + workspaces.length) % workspaces.length;
    return statusKey * workspaces.length + positionKey;
  };

  let bestWorkspace: { path: string } | undefined;
  let bestKey = Infinity;

  for (let i = 0; i < workspaces.length; i++) {
    if (i === currentIndex) continue;
    const key = getKey(workspaces[i]!, i);
    if (key < bestKey) {
      bestKey = key;
      bestWorkspace = workspaces[i];
    }
  }

  if (!bestWorkspace) {
    return false;
  }

  viewManager.setActiveWorkspace(bestWorkspace.path, true);
  return true;
}

// =============================================================================

interface TestHarness {
  dispatcher: Dispatcher;
  progressCaptures: DeletionProgress[];
  appState: AppState;
  testState: TestAppState;
  viewManager: IViewManager;
  activeWorkspace: { path: string | null };
  destroyedViews: string[];
  emittedEvents: Array<{ event: string; payload: unknown }>;
  inProgressDeletions: Set<string>;
}

function createTestHarness(options?: {
  activeWorkspacePath?: string | null;
  workspaceLockHandler?: WorkspaceLockHandler;
  killTerminalsCallback?: (workspacePath: string) => Promise<void>;
  serverStopError?: string;
  worktreeRemoveError?: string;
  initialProjects?: TestAppState["projects"];
}): TestHarness {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const progressCaptures: DeletionProgress[] = [];
  const emitProgress: DeletionProgressCallback = (progress) => {
    progressCaptures.push(progress);
  };

  const { appState, state: testState } = createTestAppState(
    options?.initialProjects ? { projects: options.initialProjects } : undefined
  );

  // Override server manager if error requested
  if (options?.serverStopError) {
    (appState.getServerManager as ReturnType<typeof vi.fn>).mockReturnValue({
      stopServer: vi.fn().mockResolvedValue({
        success: false,
        error: options.serverStopError,
      }),
    });
  }

  // Override worktree provider if error requested
  if (options?.worktreeRemoveError) {
    (appState.getWorkspaceProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      removeWorkspace: vi.fn().mockRejectedValue(new Error(options.worktreeRemoveError)),
    });
  }

  const { viewManager, activeWorkspace, destroyedViews } = createTestViewManager(
    options?.activeWorkspacePath ?? WORKSPACE_PATH
  );
  const { registry, emittedEvents } = createTestApiRegistry();
  const logger = createBehavioralLogger();
  const workspaceFileService = createTestWorkspaceFileService();

  // Register the operation
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new DeleteWorkspaceOperation(emitProgress));

  // Add interceptor via module (inline, matching bootstrap pattern)
  const inProgressDeletions = new Set<string>();
  const idempotencyModule: IntentModule = {
    interceptors: [
      {
        id: "idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_DELETE_WORKSPACE) {
            return intent;
          }
          const deleteIntent = intent as DeleteWorkspaceIntent;
          const workspacePath = deleteIntent.payload.workspacePath;

          if (deleteIntent.payload.force) {
            inProgressDeletions.add(workspacePath);
            return intent;
          }

          if (inProgressDeletions.has(workspacePath)) {
            return null;
          }

          inProgressDeletions.add(workspacePath);
          return intent;
        },
      },
    ],
    events: {
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        inProgressDeletions.delete(payload.workspacePath);
      },
    },
  };

  // Create and wire all modules (inline, following create-workspace test pattern)
  const killTerminalsCallback = options?.killTerminalsCallback ?? undefined;
  const workspaceLockHandler = options?.workspaceLockHandler ?? undefined;

  const deleteViewModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as DeleteWorkspaceHookContext;
            if (!hookCtx.shutdownResults) {
              hookCtx.shutdownResults = {};
            }

            try {
              const isActive = viewManager.getActiveWorkspacePath() === hookCtx.workspacePath;
              if (isActive && !hookCtx.skipSwitch) {
                const switched = await switchToNextWorkspaceIfAvailable(
                  hookCtx.workspacePath,
                  viewManager,
                  appState
                );
                hookCtx.shutdownResults.switchedWorkspace = switched;
                if (!switched) {
                  viewManager.setActiveWorkspace(null, false);
                }
              }

              await viewManager.destroyWorkspaceView(hookCtx.workspacePath);
              hookCtx.shutdownResults.viewDestroyed = true;
            } catch (error) {
              if (hookCtx.force) {
                logger.warn("ViewModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                hookCtx.shutdownResults.viewDestroyed = true;
                hookCtx.shutdownResults.viewError = getErrorMessage(error);
              } else {
                throw error;
              }
            }
          },
        },
      },
    },
  };

  const deleteAgentModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as DeleteWorkspaceHookContext;
            if (!hookCtx.shutdownResults) {
              hookCtx.shutdownResults = {};
            }

            try {
              if (killTerminalsCallback) {
                try {
                  await killTerminalsCallback(hookCtx.workspacePath);
                  hookCtx.shutdownResults.terminalsClosed = true;
                } catch (error) {
                  logger.warn("Kill terminals failed", {
                    workspacePath: hookCtx.workspacePath,
                    error: getErrorMessage(error),
                  });
                  hookCtx.shutdownResults.terminalsClosed = true;
                }
              } else {
                hookCtx.shutdownResults.terminalsClosed = true;
              }

              const serverManager = appState.getServerManager();
              if (serverManager) {
                const stopResult = await serverManager.stopServer(hookCtx.workspacePath);
                if (stopResult.success) {
                  hookCtx.shutdownResults.serverStopped = true;
                } else {
                  hookCtx.shutdownResults.serverStopped = true;
                  hookCtx.shutdownResults.serverError = stopResult.error ?? "Failed to stop server";
                  if (!hookCtx.force) {
                    throw new Error(hookCtx.shutdownResults.serverError);
                  }
                }
              } else {
                hookCtx.shutdownResults.serverStopped = true;
              }

              const mcpServerManager = appState.getMcpServerManager();
              if (mcpServerManager) {
                mcpServerManager.clearWorkspace(hookCtx.workspacePath);
              }

              const agentStatusManager = appState.getAgentStatusManager();
              if (agentStatusManager) {
                agentStatusManager.clearTuiTracking(hookCtx.workspacePath as WorkspacePath);
              }
            } catch (error) {
              if (hookCtx.force) {
                logger.warn("AgentModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                hookCtx.shutdownResults.serverStopped = true;
                hookCtx.shutdownResults.serverError = getErrorMessage(error);
              } else {
                throw error;
              }
            }
          },
        },
      },
    },
  };

  const deleteWindowsLockModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as DeleteWorkspaceHookContext;
            if (!hookCtx.releaseResults) {
              hookCtx.releaseResults = {};
            }

            if (hookCtx.force) {
              return;
            }

            if (!workspaceLockHandler) {
              return;
            }

            if (hookCtx.unblock === "kill" || hookCtx.unblock === "close") {
              try {
                if (hookCtx.unblock === "kill") {
                  const detected = await workspaceLockHandler.detect(
                    new Path(hookCtx.workspacePath)
                  );
                  if (detected.length > 0) {
                    logger.info("Killing blocking processes before deletion", {
                      workspacePath: hookCtx.workspacePath,
                      pids: detected.map((p) => p.pid).join(","),
                    });
                    await workspaceLockHandler.killProcesses(detected.map((p) => p.pid));
                  }
                  hookCtx.releaseResults.unblockPerformed = true;
                } else {
                  logger.info("Closing handles before deletion", {
                    workspacePath: hookCtx.workspacePath,
                  });
                  await workspaceLockHandler.closeHandles(new Path(hookCtx.workspacePath));
                  hookCtx.releaseResults.unblockPerformed = true;
                }
              } catch (error) {
                hookCtx.releaseResults.unblockPerformed = false;
                hookCtx.releaseResults.unblockError = getErrorMessage(error);
                throw error;
              }
              return;
            }

            if (!hookCtx.isRetry && hookCtx.unblock !== "ignore") {
              try {
                const detected = await workspaceLockHandler.detect(new Path(hookCtx.workspacePath));
                hookCtx.releaseResults.blockersDetected = true;

                if (detected.length > 0) {
                  hookCtx.releaseResults.blockingProcesses = detected;
                  throw new Error(`Blocked by ${detected.length} process(es)`);
                }
              } catch (error) {
                if (
                  hookCtx.releaseResults.blockingProcesses &&
                  hookCtx.releaseResults.blockingProcesses.length > 0
                ) {
                  throw error;
                }
                logger.warn("Detection failed, continuing with deletion", {
                  error: getErrorMessage(error),
                });
                hookCtx.releaseResults.blockersDetected = true;
              }
            }
          },
        },
      },
    },
  };

  const deleteWorktreeModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as DeleteWorkspaceHookContext;
            if (!hookCtx.deleteResults) {
              hookCtx.deleteResults = {};
            }

            try {
              const provider = appState.getWorkspaceProvider(hookCtx.projectPath);
              if (provider) {
                await provider.removeWorkspace(
                  new Path(hookCtx.workspacePath),
                  !hookCtx.keepBranch
                );
              }
              hookCtx.deleteResults.worktreeRemoved = true;
            } catch (error) {
              if (hookCtx.force) {
                logger.warn("WorktreeModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                hookCtx.deleteResults.worktreeRemoved = true;
                hookCtx.deleteResults.worktreeError = getErrorMessage(error);
              } else {
                if (workspaceLockHandler) {
                  try {
                    const detected = await workspaceLockHandler.detect(
                      new Path(hookCtx.workspacePath)
                    );
                    if (detected.length > 0) {
                      if (!hookCtx.releaseResults) {
                        hookCtx.releaseResults = {};
                      }
                      hookCtx.releaseResults.blockingProcesses = detected;
                      logger.info("Detected blocking processes", {
                        workspacePath: hookCtx.workspacePath,
                        count: detected.length,
                      });
                    }
                  } catch (detectError) {
                    logger.warn("Failed to detect blocking processes", {
                      workspacePath: hookCtx.workspacePath,
                      error: getErrorMessage(detectError),
                    });
                  }
                }
                hookCtx.deleteResults.worktreeError = getErrorMessage(error);
                throw error;
              }
            }
          },
        },
      },
    },
  };

  const deleteCodeServerModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as DeleteWorkspaceHookContext;
            if (!hookCtx.deleteResults) {
              hookCtx.deleteResults = {};
            }

            try {
              const workspacePath = new Path(hookCtx.workspacePath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await workspaceFileService.deleteWorkspaceFile(workspaceName, projectWorkspacesDir);
              hookCtx.deleteResults.workspaceFileDeleted = true;
            } catch (error) {
              if (hookCtx.force) {
                logger.warn("CodeServerModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                hookCtx.deleteResults.workspaceFileDeleted = true;
              } else {
                throw error;
              }
            }
          },
        },
      },
    },
  };

  const deleteStateModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        appState.unregisterWorkspace(payload.projectPath, payload.workspacePath);
      },
    },
  };

  const deleteIpcBridge: IntentModule = {
    events: {
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        registry.emit("workspace:removed", {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.workspacePath,
        });
      },
    },
  };

  wireModules(
    [
      idempotencyModule,
      deleteViewModule,
      deleteAgentModule,
      deleteWindowsLockModule,
      deleteWorktreeModule,
      deleteCodeServerModule,
      deleteStateModule,
      deleteIpcBridge,
    ],
    hookRegistry,
    dispatcher
  );

  return {
    dispatcher,
    progressCaptures,
    appState,
    testState,
    viewManager,
    activeWorkspace,
    destroyedViews,
    emittedEvents,
    inProgressDeletions,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("DeleteWorkspaceOperation.normalDeletion", () => {
  it("test 1: normal deletion completes all hooks", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    const result = await harness.dispatcher.dispatch(intent);

    // Operation returns { started: true }
    expect(result).toEqual({ started: true });

    // Shutdown: server stopped, MCP cleared, TUI cleared
    expect(harness.testState.serverStopped).toBe(true);
    expect(harness.testState.mcpCleared).toBe(true);
    expect(harness.testState.tuiCleared).toBe(true);

    // Shutdown: view destroyed
    expect(harness.destroyedViews).toContain(WORKSPACE_PATH);

    // Delete: worktree removed
    expect(harness.testState.worktreeRemoved).toBe(true);

    // Event subscriber: workspace removed from state
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    // Event subscriber: IPC event emitted
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeDefined();
    expect(ipcEvent!.payload).toEqual({
      projectId: PROJECT_ID,
      workspaceName: WORKSPACE_NAME,
      path: WORKSPACE_PATH,
    });

    // Progress emitted after each hook (shutdown, release, delete + final)
    expect(harness.progressCaptures.length).toBeGreaterThanOrEqual(3);

    // Final progress should be completed
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });
});

describe("DeleteWorkspaceOperation.forceDeletion", () => {
  it("test 2: force deletion ignores errors and emits event via finally", async () => {
    const harness = createTestHarness({
      serverStopError: "Server stop failed",
      worktreeRemoveError: "Worktree removal failed",
    });

    const intent = buildDeleteIntent({ force: true });

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // State cleanup still happened (workspace:deleted emitted in finally block)
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    // IPC event still emitted
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeDefined();

    // Final progress should report errors
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
  });
});

describe("DeleteWorkspaceOperation.idempotency", () => {
  it("test 3: second deletion of same workspace returns undefined (interceptor blocks)", async () => {
    const harness = createTestHarness();

    // Manually mark workspace as in-progress (simulate concurrent dispatch)
    harness.inProgressDeletions.add(WORKSPACE_PATH);

    const intent = buildDeleteIntent();
    const result = await harness.dispatcher.dispatch(intent);

    // Interceptor returned null -> dispatcher returns undefined
    expect(result).toBeUndefined();

    // No state changes should have occurred
    expect(harness.testState.removedWorkspaces).toHaveLength(0);
    expect(harness.progressCaptures).toHaveLength(0);
  });

  it("test 4: force deletion proceeds when normal deletion in-progress", async () => {
    const harness = createTestHarness();

    // Mark workspace as in-progress
    harness.inProgressDeletions.add(WORKSPACE_PATH);

    const forceIntent = buildDeleteIntent({ force: true });
    const result = await harness.dispatcher.dispatch(forceIntent);

    // Force bypasses interceptor
    expect(result).toEqual({ started: true });

    // State cleanup happened
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });
  });

  it("test 5: in-progress flag cleared after completion", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // After completion, the in-progress flag should be cleared
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // Should be able to dispatch again (e.g., for a new workspace with same path)
    // Reset state for second dispatch
    harness.testState.projects.push({
      path: PROJECT_PATH,
      name: "test-project",
      workspaces: [{ path: WORKSPACE_PATH, branch: "feature-a", metadata: { base: "main" } }],
    });

    const result2 = await harness.dispatcher.dispatch(intent);
    expect(result2).toEqual({ started: true });
  });

  it("test 12: deleting workspace A does not block workspace B", async () => {
    const harness = createTestHarness();

    // Mark workspace A as in-progress
    harness.inProgressDeletions.add(WORKSPACE_PATH);

    // Dispatch delete for workspace B -- should NOT be blocked
    const intentB = buildDeleteIntent({
      workspaceName: WORKSPACE_NAME_B,
      workspacePath: WORKSPACE_PATH_B,
    });

    const result = await harness.dispatcher.dispatch(intentB);
    expect(result).toEqual({ started: true });

    // Workspace B was removed
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH_B,
    });
  });
});

describe("DeleteWorkspaceOperation.windowsBlockerDetection", () => {
  it("test 6: Windows blocker detection stops deletion", async () => {
    const blockingProcesses = [
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: ["file.txt"], cwd: "." },
    ];

    const workspaceLockHandler: WorkspaceLockHandler = {
      detect: vi.fn().mockImplementation(async (path: Path) => {
        if (path.toString() === new Path(WORKSPACE_PATH).toString()) {
          return blockingProcesses;
        }
        return [];
      }),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    const intent = buildDeleteIntent();

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Workspace should NOT be removed from state (no workspace:deleted event)
    expect(harness.testState.removedWorkspaces).toHaveLength(0);

    // No IPC workspace:removed event
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeUndefined();

    // Progress should show detecting-blockers as error
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(true);

    const detectOp = finalProgress.operations.find((op) => op.id === "detecting-blockers");
    expect(detectOp).toBeDefined();
    expect(detectOp!.status).toBe("error");

    // Blocking processes included in progress
    expect(finalProgress.blockingProcesses).toBeDefined();
    expect(finalProgress.blockingProcesses!.length).toBe(1);
    expect(finalProgress.blockingProcesses![0]!.pid).toBe(1234);
  });
});

describe("DeleteWorkspaceOperation.progressFormat", () => {
  it("test 7: progress format matches DeletionProgress", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Every progress emission should have the correct shape
    for (const progress of harness.progressCaptures) {
      expect(progress.workspacePath).toBe(WORKSPACE_PATH);
      expect(progress.workspaceName).toBe(WORKSPACE_NAME);
      expect(progress.projectId).toBe(PROJECT_ID);
      expect(progress.keepBranch).toBe(true);
      expect(Array.isArray(progress.operations)).toBe(true);
      expect(typeof progress.completed).toBe("boolean");
      expect(typeof progress.hasErrors).toBe("boolean");

      // Each operation should have required fields
      for (const op of progress.operations) {
        expect(typeof op.id).toBe("string");
        expect(typeof op.label).toBe("string");
        expect(["pending", "in-progress", "done", "error"]).toContain(op.status);
      }
    }

    // Final progress should have all standard operations
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    const opIds = finalProgress.operations.map((op) => op.id);
    expect(opIds).toContain("kill-terminals");
    expect(opIds).toContain("stop-server");
    expect(opIds).toContain("cleanup-vscode");
    expect(opIds).toContain("cleanup-workspace");

    // All standard ops should be "done"
    for (const op of finalProgress.operations) {
      if (
        ["kill-terminals", "stop-server", "cleanup-vscode", "cleanup-workspace"].includes(op.id)
      ) {
        expect(op.status).toBe("done");
      }
    }
  });

  it("test 16: progress callback captures correct format throughout lifecycle", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // At least 3 progress emissions: after shutdown, after release, final (after delete)
    expect(harness.progressCaptures.length).toBeGreaterThanOrEqual(3);

    // First progress (after shutdown): shutdown ops should be done, delete should be pending
    const firstProgress = harness.progressCaptures[0]!;
    expect(firstProgress.completed).toBe(false);
    const killTerminals = firstProgress.operations.find((op) => op.id === "kill-terminals");
    expect(killTerminals?.status).toBe("done");
    const cleanupWorkspace = firstProgress.operations.find((op) => op.id === "cleanup-workspace");
    expect(cleanupWorkspace?.status).toBe("pending");

    // Last progress: all done, completed
    const lastProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(lastProgress.completed).toBe(true);
  });
});

describe("DeleteWorkspaceOperation.workspaceSwitching", () => {
  it("test 8: active workspace switches to best candidate on delete", async () => {
    const harness = createTestHarness({
      activeWorkspacePath: WORKSPACE_PATH,
    });
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Should have switched away from deleted workspace
    // The best candidate is feature-b (the only remaining workspace)
    expect(harness.activeWorkspace.path).toBe(WORKSPACE_PATH_B);
  });

  it("test 13: deleting inactive workspace skips switch", async () => {
    // Active workspace is B, deleting A
    const harness = createTestHarness({
      activeWorkspacePath: WORKSPACE_PATH_B,
    });
    const intent = buildDeleteIntent(); // deleting WORKSPACE_PATH (A)

    await harness.dispatcher.dispatch(intent);

    // Active workspace unchanged (still B)
    expect(harness.activeWorkspace.path).toBe(WORKSPACE_PATH_B);
  });

  it("test 14: deleting last workspace sets active to null", async () => {
    const harness = createTestHarness({
      activeWorkspacePath: WORKSPACE_PATH,
      initialProjects: [
        {
          path: PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: WORKSPACE_PATH, branch: "feature-a", metadata: { base: "main" } }],
        },
      ],
    });
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Last workspace -- should set active to null
    expect(harness.activeWorkspace.path).toBe(null);
  });
});

describe("DeleteWorkspaceOperation.agentCleanup", () => {
  it("test 9: agent resources cleaned up after deletion", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Server stopped
    expect(harness.testState.serverStopped).toBe(true);

    // MCP tracking cleared
    expect(harness.testState.mcpCleared).toBe(true);

    // TUI tracking cleared
    expect(harness.testState.tuiCleared).toBe(true);
  });
});

describe("DeleteWorkspaceOperation.stateCleanup", () => {
  it("test 10: workspace removed from project state after deletion", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Workspace removed from state
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    // The workspace should no longer be in the project's workspaces array
    const project = harness.testState.projects.find((p) => p.path === PROJECT_PATH);
    expect(project).toBeDefined();
    const ws = project!.workspaces.find((w) => w.path === WORKSPACE_PATH);
    expect(ws).toBeUndefined();
  });
});

describe("DeleteWorkspaceOperation.ipcEvents", () => {
  it("test 11: IPC workspace:removed event emitted with correct payload", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeDefined();
    expect(ipcEvent!.payload).toEqual({
      projectId: PROJECT_ID,
      workspaceName: WORKSPACE_NAME,
      path: WORKSPACE_PATH,
    });
  });
});

describe("DeleteWorkspaceOperation.ipcHandler", () => {
  it("test 15: returns started false when interceptor blocks", async () => {
    // This test verifies the IPC handler pattern: result ?? { started: false }
    const harness = createTestHarness();

    // Simulate interceptor blocking by pre-adding to in-progress
    harness.inProgressDeletions.add(WORKSPACE_PATH);

    const intent = buildDeleteIntent();
    const result = await harness.dispatcher.dispatch(intent);

    // Dispatcher returns undefined when interceptor cancels
    expect(result).toBeUndefined();

    // IPC handler would do: result ?? { started: false }
    const ipcResult = result ?? { started: false };
    expect(ipcResult).toEqual({ started: false });
  });
});

describe("DeleteWorkspaceOperation.removeWorktree", () => {
  it("test 17: removeWorktree=false skips release and delete hooks", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent({ removeWorktree: false });

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Shutdown still runs: server stopped, view destroyed
    expect(harness.testState.serverStopped).toBe(true);
    expect(harness.destroyedViews).toContain(WORKSPACE_PATH);

    // Delete hooks skipped: worktree NOT removed
    expect(harness.testState.worktreeRemoved).toBe(false);

    // Event still emitted (needed for state cleanup)
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    // IPC event emitted
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeDefined();
  });

  it("test 18: removeWorktree=true runs full pipeline", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent({ removeWorktree: true });

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Shutdown runs
    expect(harness.testState.serverStopped).toBe(true);
    expect(harness.destroyedViews).toContain(WORKSPACE_PATH);

    // Delete hooks run: worktree removed
    expect(harness.testState.worktreeRemoved).toBe(true);

    // Event emitted
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });
  });
});
