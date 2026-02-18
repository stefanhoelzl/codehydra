/**
 * Integration tests for DeleteWorkspaceOperation.
 *
 * Tests the full delete-workspace pipeline through dispatcher.dispatch():
 * - Operation orchestrates hooks (shutdown -> release -> delete)
 * - On delete failure: detect -> emit -> wait -> flush -> delete (retry loop)
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
import type { WorkspaceDeletedEvent } from "./delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletionProgressCallback,
  ShutdownHookResult,
  ReleaseHookResult,
  DeleteHookResult,
  DetectHookResult,
  FlushHookResult,
  FlushHookInput,
  ResolveProjectHookResult,
  ResolveWorkspaceHookResult,
  ResolveWorkspaceHookInput,
  DeletePipelineHookInput,
} from "./delete-workspace";
import type { HookContext } from "../intents/infrastructure/operation";
import type { IViewManager } from "../managers/view-manager.interface";
import type { AppState } from "../app-state";
import type { IApiRegistry } from "../api/registry-types";
import type { WorkspaceLockHandler } from "../../services/platform/workspace-lock-handler";
import type { IWorkspaceFileService } from "../../services";
import type { WorkspacePath } from "../../shared/ipc";
import type { BlockingProcess, DeletionProgress, WorkspaceName } from "../../shared/api/types";
import { createBehavioralLogger } from "../../services/logging/logging.test-utils";
import { generateProjectId } from "../../shared/api/id-utils";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../services/platform/path";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_SWITCHED,
  isAutoSwitch,
} from "./switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  WorkspaceSwitchedEvent,
  ResolveProjectHookResult as SwitchResolveProjectHookResult,
  ResolveWorkspaceHookInput as SwitchResolveWorkspaceHookInput,
  ResolveWorkspaceHookResult as SwitchResolveWorkspaceHookResult,
  ActivateHookInput,
  FindCandidatesHookResult,
} from "./switch-workspace";

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

interface TestProject {
  path: string;
  name: string;
  workspaces: Array<{ path: string; branch: string; metadata: Record<string, string> }>;
}

interface TestAppState {
  projects: TestProject[];
  serverStopped: boolean;
  tuiCleared: boolean;
  removedWorkspaces: Array<{ projectPath: string; workspacePath: string }>;
  worktreeRemoved: boolean;
}

/**
 * Mock AppState interface used in tests. Extends real AppState methods with
 * test-only methods that simulate removed production methods (getAllProjects,
 * getProject, unregisterWorkspace, findProjectForWorkspace). These are used
 * by inline hook modules that simulate the behavior of extracted production modules.
 */
interface MockAppState extends AppState {
  getAllProjects: () => Promise<TestProject[]>;
  getProject: (path: string) => TestProject | undefined;
  unregisterWorkspace: (projectPath: string, workspacePath: string) => void;
  findProjectForWorkspace: (wsPath: string) => TestProject | undefined;
}

function createMockGlobalProvider(opts?: { removeError?: string }): {
  globalProvider: {
    removeWorkspace: (
      projectPath: Path,
      workspacePath: Path,
      deleteBranch: boolean
    ) => Promise<void>;
  };
  removed: boolean;
} {
  const result = { removed: false };
  return {
    globalProvider: {
      removeWorkspace: async () => {
        if (opts?.removeError) {
          throw new Error(opts.removeError);
        }
        result.removed = true;
      },
    },
    get removed() {
      return result.removed;
    },
  };
}

function createTestAppState(initial?: Partial<TestAppState>): {
  appState: MockAppState;
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
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockImplementation(async () => {
        state.serverStopped = true;
        return { success: true };
      }),
    }),
    getMcpServerManager: vi.fn().mockReturnValue({}),
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
  } as unknown as MockAppState;

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

interface TestHarness {
  dispatcher: Dispatcher;
  deleteOp: DeleteWorkspaceOperation;
  progressCaptures: DeletionProgress[];
  appState: MockAppState;
  testState: TestAppState;
  viewManager: IViewManager;
  activeWorkspace: { path: string | null };
  destroyedViews: string[];
  emittedEvents: Array<{ event: string; payload: unknown }>;
  inProgressDeletions: Set<string>;
  globalProviderState: { removed: boolean };
  globalProviderMock: {
    globalProvider: { removeWorkspace: ReturnType<typeof vi.fn> };
  };
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

  // Create global provider (with optional remove error)
  const globalProviderMock = createMockGlobalProvider(
    options?.worktreeRemoveError ? { removeError: options.worktreeRemoveError } : undefined
  );

  const { viewManager, activeWorkspace, destroyedViews } = createTestViewManager(
    options?.activeWorkspacePath ?? WORKSPACE_PATH
  );
  const { registry, emittedEvents } = createTestApiRegistry();
  const logger = createBehavioralLogger();
  const workspaceFileService = createTestWorkspaceFileService();

  // Register operations
  const deleteOp = new DeleteWorkspaceOperation(emitProgress);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteOp);
  dispatcher.registerOperation(
    INTENT_SWITCH_WORKSPACE,
    new SwitchWorkspaceOperation(
      extractWorkspaceName,
      (path: string) => generateProjectId(path),
      // Agent status scorer: returns score from mock appState
      (workspacePath) => {
        const agentStatusManager = appState.getAgentStatusManager();
        const status = agentStatusManager?.getStatus(workspacePath);
        if (!status || status.status === "none") return 2;
        if (status.status === "busy") return 1;
        return 0;
      }
    )
  );

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

  const deleteResolveProjectModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            const projects = await appState.getAllProjects();
            const match = projects.find(
              (p: { path: string }) => generateProjectId(p.path) === payload.projectId
            );
            return match ? { projectPath: match.path } : {};
          },
        },
      },
    },
  };

  const deleteResolveWorkspaceModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { projectPath } = ctx as ResolveWorkspaceHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            const project = appState.getProject(projectPath);
            if (!project) return {};
            const workspace = project.workspaces.find(
              (w) => extractWorkspaceName(w.path) === payload.workspaceName
            );
            return workspace ? { workspacePath: workspace.path } : {};
          },
        },
      },
    },
  };

  const deleteViewModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            const isActive = viewManager.getActiveWorkspacePath() === payload.workspacePath;

            try {
              await viewManager.destroyWorkspaceView(payload.workspacePath);
              return { ...(isActive && { wasActive: true }) };
            } catch (error) {
              if (payload.force) {
                logger.warn("ViewModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {
                  ...(isActive && { wasActive: true }),
                  error: getErrorMessage(error),
                };
              }
              throw error;
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
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              if (killTerminalsCallback) {
                try {
                  await killTerminalsCallback(payload.workspacePath);
                } catch (error) {
                  logger.warn("Kill terminals failed", {
                    workspacePath: payload.workspacePath,
                    error: getErrorMessage(error),
                  });
                }
              }

              let serverError: string | undefined;
              const serverManager = appState.getServerManager();
              if (serverManager) {
                const stopResult = await serverManager.stopServer(payload.workspacePath);
                if (!stopResult.success) {
                  serverError = stopResult.error ?? "Failed to stop server";
                  if (!payload.force) {
                    throw new Error(serverError);
                  }
                }
              }

              const agentStatusManager = appState.getAgentStatusManager();
              if (agentStatusManager) {
                agentStatusManager.clearTuiTracking(payload.workspacePath as WorkspacePath);
              }

              return serverError ? { error: serverError } : {};
            } catch (error) {
              if (payload.force) {
                logger.warn("AgentModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { error: getErrorMessage(error) };
              }
              throw error;
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
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force || !workspaceLockHandler) {
              return {};
            }

            // CWD-only scan: find and kill processes whose CWD is under workspace
            try {
              const cwdProcesses = await workspaceLockHandler.detectCwd(
                new Path(payload.workspacePath)
              );
              if (cwdProcesses.length > 0) {
                await workspaceLockHandler.killProcesses(cwdProcesses.map((p) => p.pid));
              }
            } catch {
              // Non-fatal
            }
            return {};
          },
        },
        detect: {
          handler: async (ctx: HookContext): Promise<DetectHookResult> => {
            if (!workspaceLockHandler) return {};
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const detected = await workspaceLockHandler.detect(new Path(payload.workspacePath));
              return { blockingProcesses: detected };
            } catch {
              return { blockingProcesses: [] };
            }
          },
        },
        flush: {
          handler: async (ctx: HookContext): Promise<FlushHookResult> => {
            if (!workspaceLockHandler) return {};
            const { blockingPids } = ctx as FlushHookInput;
            if (blockingPids.length > 0) {
              try {
                await workspaceLockHandler.killProcesses([...blockingPids]);
              } catch (error) {
                return { error: getErrorMessage(error) };
              }
            }
            return {};
          },
        },
      },
    },
  };

  const deleteWorktreeModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { projectPath, workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              await globalProviderMock.globalProvider.removeWorkspace(
                new Path(projectPath),
                new Path(workspacePath),
                !payload.keepBranch
              );
              testState.worktreeRemoved = true;
              return {};
            } catch (error) {
              if (payload.force) {
                logger.warn("WorktreeModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return { error: getErrorMessage(error) };
              }
              throw error;
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
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const workspacePath = new Path(payload.workspacePath);
              const workspaceName = workspacePath.basename;
              const projectWorkspacesDir = workspacePath.dirname;
              await workspaceFileService.deleteWorkspaceFile(workspaceName, projectWorkspacesDir);
              return {};
            } catch (error) {
              if (payload.force) {
                logger.warn("CodeServerModule: error in force mode (ignored)", {
                  error: getErrorMessage(error),
                });
                return {};
              }
              throw error;
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

  // Switch modules: resolve-project, resolve-workspace, activate
  const switchResolveProjectModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<SwitchResolveProjectHookResult> => {
            const { payload } = ctx.intent as SwitchWorkspaceIntent;
            if (isAutoSwitch(payload)) return {};
            const allProjects = await appState.getAllProjects();
            const project = allProjects.find(
              (p) => generateProjectId(p.path) === payload.projectId
            );
            return project ? { projectPath: project.path, projectName: project.name } : {};
          },
        },
      },
    },
  };
  const switchResolveWorkspaceModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<SwitchResolveWorkspaceHookResult> => {
            const { projectPath, workspaceName } = ctx as SwitchResolveWorkspaceHookInput;
            const project = appState.getProject(projectPath);
            if (!project) return {};
            const ws = project.workspaces.find(
              (w) => extractWorkspaceName(w.path) === workspaceName
            );
            return ws ? { workspacePath: ws.path } : {};
          },
        },
      },
    },
  };
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath } = ctx as ActivateHookInput;
            const intent = ctx.intent as SwitchWorkspaceIntent;

            if (viewManager.getActiveWorkspacePath() === workspacePath) {
              return {};
            }
            const focus = intent.payload.focus ?? true;
            viewManager.setActiveWorkspace(workspacePath, focus);
            return { resolvedPath: workspacePath };
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        if (payload === null) {
          viewManager.setActiveWorkspace(null, false);
        }
      },
    },
  };

  // find-candidates module: returns all workspaces from appState for auto-select
  const switchFindCandidatesModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "find-candidates": {
          handler: async (): Promise<FindCandidatesHookResult> => {
            const allProjects = await appState.getAllProjects();
            const candidates: Array<{
              projectPath: string;
              projectName: string;
              workspacePath: string;
            }> = [];
            for (const project of allProjects) {
              for (const ws of project.workspaces) {
                candidates.push({
                  projectPath: project.path,
                  projectName: project.name,
                  workspacePath: ws.path,
                });
              }
            }
            return { candidates };
          },
        },
      },
    },
  };

  wireModules(
    [
      idempotencyModule,
      deleteResolveProjectModule,
      deleteResolveWorkspaceModule,
      deleteViewModule,
      deleteAgentModule,
      deleteWindowsLockModule,
      deleteWorktreeModule,
      deleteCodeServerModule,
      deleteStateModule,
      deleteIpcBridge,
      switchResolveProjectModule,
      switchResolveWorkspaceModule,
      switchViewModule,
      switchFindCandidatesModule,
    ],
    hookRegistry,
    dispatcher
  );

  return {
    dispatcher,
    deleteOp,
    progressCaptures,
    appState,
    testState,
    viewManager,
    activeWorkspace,
    destroyedViews,
    emittedEvents,
    inProgressDeletions,
    globalProviderState: globalProviderMock,
    globalProviderMock: globalProviderMock as unknown as TestHarness["globalProviderMock"],
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

    // Shutdown: server stopped, TUI cleared (MCP cleared via domain event, not in agent hook)
    expect(harness.testState.serverStopped).toBe(true);
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
  it("test 6: CWD processes found in release → auto-killed → deletion succeeds", async () => {
    const cwdProcesses: BlockingProcess[] = [
      { pid: 1234, name: "bash.exe", commandLine: "bash", files: [], cwd: "." },
    ];
    let detectCwdCalls = 0;

    const workspaceLockHandler: WorkspaceLockHandler = {
      detect: vi.fn().mockResolvedValue([]),
      detectCwd: vi.fn().mockImplementation(async () => {
        detectCwdCalls++;
        return cwdProcesses;
      }),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    const intent = buildDeleteIntent();

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // CWD processes were detected and killed in release
    expect(detectCwdCalls).toBe(1);
    expect(workspaceLockHandler.killProcesses).toHaveBeenCalledWith([1234]);

    // Worktree removed (deletion succeeded)
    expect(harness.testState.worktreeRemoved).toBe(true);

    // No blocking processes in final progress (CWD kill was transparent)
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
    expect(finalProgress.blockingProcesses).toBeUndefined();
  });

  it("test 22: delete fails → detect finds blockers → progress shows process list → signal retry → flush kills PIDs → delete succeeds", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 5678, name: "node.exe", commandLine: "node server.js", files: ["file.txt"], cwd: "." },
    ];

    let deleteAttempts = 0;
    const workspaceLockHandler: WorkspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    // Make first delete fail, second succeed
    const globalProvider = {
      removeWorkspace: vi.fn().mockImplementation(async () => {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error("Permission denied");
        }
      }),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    // Override the worktree module's provider
    harness.globalProviderMock.globalProvider.removeWorkspace = globalProvider.removeWorkspace;

    const intent = buildDeleteIntent();

    // Start deletion (will block at waitForRetryChoice)
    const dispatchPromise = harness.dispatcher.dispatch(intent);

    // Wait for the pipeline to reach the retry wait
    await vi.waitFor(() => {
      expect(harness.deleteOp.hasPendingRetry(WORKSPACE_PATH)).toBe(true);
    });

    // Verify progress shows blocking processes
    const progressWithBlockers = harness.progressCaptures.find(
      (p) => p.blockingProcesses && p.blockingProcesses.length > 0
    );
    expect(progressWithBlockers).toBeDefined();
    expect(progressWithBlockers!.blockingProcesses![0]!.pid).toBe(5678);
    expect(progressWithBlockers!.completed).toBe(true);
    expect(progressWithBlockers!.hasErrors).toBe(true);

    // Verify detecting-blockers operation in progress
    const detectOp = progressWithBlockers!.operations.find((op) => op.id === "detecting-blockers");
    expect(detectOp).toBeDefined();
    expect(detectOp!.status).toBe("error");

    // Signal retry
    harness.deleteOp.signalRetry(WORKSPACE_PATH);

    // Wait for completion
    const result = await dispatchPromise;
    expect(result).toEqual({ started: true });

    // Flush killed the PIDs
    expect(workspaceLockHandler.killProcesses).toHaveBeenCalledWith([5678]);

    // Second delete succeeded
    expect(deleteAttempts).toBe(2);

    // Final progress: success
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });

  it("test 23: delete fails → detect → signal dismiss → pipeline exits with hasErrors", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 9999, name: "code.exe", commandLine: "code .", files: ["file.txt"], cwd: null },
    ];

    const workspaceLockHandler: WorkspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const harness = createTestHarness({
      workspaceLockHandler,
      worktreeRemoveError: "Permission denied",
    });
    const intent = buildDeleteIntent();

    // Start deletion
    const dispatchPromise = harness.dispatcher.dispatch(intent);

    // Wait for retry prompt
    await vi.waitFor(() => {
      expect(harness.deleteOp.hasPendingRetry(WORKSPACE_PATH)).toBe(true);
    });

    // Signal dismiss
    harness.deleteOp.signalDismiss(WORKSPACE_PATH);

    const result = await dispatchPromise;
    expect(result).toEqual({ started: true });

    // Workspace should NOT be removed from state (no workspace:deleted event)
    expect(harness.testState.removedWorkspaces).toHaveLength(0);

    // No IPC workspace:removed event
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeUndefined();
  });

  it("test 24: multiple retry loop: detect → retry → flush → delete(fails) → detect → retry → flush → delete(succeeds)", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 1111, name: "node.exe", commandLine: "node", files: ["a.js"], cwd: null },
    ];

    let deleteAttempts = 0;
    const workspaceLockHandler: WorkspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const globalProvider = {
      removeWorkspace: vi.fn().mockImplementation(async () => {
        deleteAttempts++;
        // First two fail, third succeeds
        if (deleteAttempts <= 2) {
          throw new Error("Permission denied");
        }
      }),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    harness.globalProviderMock.globalProvider.removeWorkspace = globalProvider.removeWorkspace;

    const intent = buildDeleteIntent();
    const dispatchPromise = harness.dispatcher.dispatch(intent);

    // First retry cycle
    await vi.waitFor(() => {
      expect(harness.deleteOp.hasPendingRetry(WORKSPACE_PATH)).toBe(true);
    });
    harness.deleteOp.signalRetry(WORKSPACE_PATH);

    // Second retry cycle (second delete also fails)
    await vi.waitFor(() => {
      expect(harness.deleteOp.hasPendingRetry(WORKSPACE_PATH)).toBe(true);
    });
    harness.deleteOp.signalRetry(WORKSPACE_PATH);

    // Third delete succeeds
    const result = await dispatchPromise;
    expect(result).toEqual({ started: true });
    expect(deleteAttempts).toBe(3);

    // Final progress: success
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);

    // Workspace was deleted
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });
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

    // At least 4 progress emissions: pre-shutdown, post-shutdown, post-release, final
    expect(harness.progressCaptures.length).toBeGreaterThanOrEqual(4);

    // First progress (pre-shutdown): kill-terminals should be in-progress
    const firstProgress = harness.progressCaptures[0]!;
    expect(firstProgress.completed).toBe(false);
    const killTerminals = firstProgress.operations.find((op) => op.id === "kill-terminals");
    expect(killTerminals?.status).toBe("in-progress");
    const cleanupWorkspace = firstProgress.operations.find((op) => op.id === "cleanup-workspace");
    expect(cleanupWorkspace?.status).toBe("pending");

    // Second progress (post-shutdown): shutdown ops done, cleanup-workspace in-progress
    const secondProgress = harness.progressCaptures[1]!;
    expect(secondProgress.completed).toBe(false);
    const killTerminals2 = secondProgress.operations.find((op) => op.id === "kill-terminals");
    expect(killTerminals2?.status).toBe("done");
    const cleanupWorkspace2 = secondProgress.operations.find((op) => op.id === "cleanup-workspace");
    expect(cleanupWorkspace2?.status).toBe("in-progress");

    // Last progress: all done, completed
    const lastProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(lastProgress.completed).toBe(true);
  });
});

describe("DeleteWorkspaceOperation.inProgressSpinner", () => {
  it("test 25: normal deletion emits in-progress before each hook point", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Pre-shutdown: kill-terminals in-progress, cleanup-workspace pending
    const preShutdown = harness.progressCaptures[0]!;
    expect(preShutdown.operations.find((op) => op.id === "kill-terminals")?.status).toBe(
      "in-progress"
    );
    expect(preShutdown.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe(
      "pending"
    );

    // Post-shutdown: cleanup-workspace in-progress immediately, shutdown ops done
    const postShutdown = harness.progressCaptures[1]!;
    expect(postShutdown.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe(
      "in-progress"
    );
    expect(postShutdown.operations.find((op) => op.id === "kill-terminals")?.status).toBe("done");
  });

  it("test 26: retry loop emits in-progress for detecting-blockers, killing-blockers, and cleanup-workspace", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 4444, name: "node.exe", commandLine: "node", files: ["f.js"], cwd: null },
    ];

    let deleteAttempts = 0;
    const workspaceLockHandler: WorkspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const globalProvider = {
      removeWorkspace: vi.fn().mockImplementation(async () => {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error("Permission denied");
        }
      }),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    harness.globalProviderMock.globalProvider.removeWorkspace = globalProvider.removeWorkspace;

    const intent = buildDeleteIntent();
    const dispatchPromise = harness.dispatcher.dispatch(intent);

    await vi.waitFor(() => {
      expect(harness.deleteOp.hasPendingRetry(WORKSPACE_PATH)).toBe(true);
    });

    // Before user choice: should have emitted detecting-blockers as in-progress
    const detectInProgress = harness.progressCaptures.find(
      (p) => p.operations.find((op) => op.id === "detecting-blockers")?.status === "in-progress"
    );
    expect(detectInProgress).toBeDefined();

    harness.deleteOp.signalRetry(WORKSPACE_PATH);
    await dispatchPromise;

    // After retry: should have emitted killing-blockers as in-progress
    const flushInProgress = harness.progressCaptures.find(
      (p) => p.operations.find((op) => op.id === "killing-blockers")?.status === "in-progress"
    );
    expect(flushInProgress).toBeDefined();

    // After retry: should have emitted cleanup-workspace as in-progress (retry delete)
    const retryDeleteInProgress = harness.progressCaptures.find(
      (p) =>
        p.operations.some((op) => op.id === "killing-blockers") &&
        p.operations.find((op) => op.id === "cleanup-workspace")?.status === "in-progress"
    );
    expect(retryDeleteInProgress).toBeDefined();
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

    // TUI tracking cleared (MCP cleared via domain event, not in agent hook)
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

describe("DeleteWorkspaceOperation.resolveHooks", () => {
  it("test 19: resolve-project populates enriched context from projectId", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Workspace deleted event should use the resolved project path
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "workspace:removed");
    expect(ipcEvent).toBeDefined();
    expect((ipcEvent!.payload as { projectId: string }).projectId).toBe(PROJECT_ID);

    // The deleted event payload should carry the resolved projectPath
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });
  });

  it("test 20: resolve-workspace populates enriched context from workspaceName", async () => {
    const harness = createTestHarness();
    const intent = buildDeleteIntent();

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Worktree was removed — proves enriched context reached the delete hook
    expect(harness.testState.worktreeRemoved).toBe(true);

    // Progress uses the resolved workspace path
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.workspacePath).toBe(WORKSPACE_PATH);
  });

  it("test 21: resolve hooks fall back to payload when project not found", async () => {
    // Create harness with no projects (resolve hooks return empty)
    const harness = createTestHarness({
      initialProjects: [],
    });

    // Provide explicit paths in payload (the fallback path)
    const intent = buildDeleteIntent();

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Pipeline still runs with payload values as fallback
    // Server stopped (shutdown hook runs)
    expect(harness.testState.serverStopped).toBe(true);
  });
});
