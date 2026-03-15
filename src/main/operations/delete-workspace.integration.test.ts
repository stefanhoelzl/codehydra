/**
 * Integration tests for DeleteWorkspaceOperation.
 *
 * Tests the full delete-workspace pipeline through dispatcher.dispatch():
 * - Operation orchestrates hooks (shutdown -> release -> [flush] -> delete)
 * - On delete failure: detect -> emit delete-failed -> return
 * - On retry: blockingPids in payload -> flush -> delete
 * - Interceptor enforces idempotency (per-workspace), reset by deleted/delete-failed events
 * - Event subscribers update state and emit IPC events
 * - Progress callback captures DeletionProgress objects
 *
 * All tests use behavioral mocks -- state changes and outcomes are verified,
 * not call tracking. Windows behavior is tested via behavioral mocks on all platforms.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import type { IntentModule } from "../intents/infrastructure/module";
import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import {
  DeleteWorkspaceOperation,
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
} from "./delete-workspace";
import type {
  WorkspaceDeletedEvent,
  WorkspaceDeleteFailedEvent,
  WorkspaceDeletionProgressEvent,
} from "./delete-workspace";
import type {
  DeleteWorkspaceIntent,
  PreflightHookResult,
  ShutdownHookResult,
  ReleaseHookResult,
  DeleteHookResult,
  DetectHookResult,
  FlushHookResult,
  FlushHookInput,
  DeletePipelineHookInput,
} from "./delete-workspace";
import type { HookContext, OperationContext } from "../intents/infrastructure/operation";
import type {
  BlockingProcess,
  DeletionProgress,
  ProjectId,
  WorkspaceName,
} from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../services/platform/path";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_SWITCHED,
  selectNextWorkspace,
} from "./switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  WorkspaceSwitchedEvent,
  ActivateHookInput,
  FindCandidatesHookResult,
  SelectNextHookInput,
  SelectNextHookResult,
} from "./switch-workspace";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./get-active-workspace";
import type { GetActiveWorkspaceHookResult } from "./get-active-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "./resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "./resolve-project";

// =============================================================================
// Test Helpers
// =============================================================================

function testProjectId(path: string): ProjectId {
  return Buffer.from(path).toString("base64url") as ProjectId;
}

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/project";
const PROJECT_ID = testProjectId(PROJECT_PATH);
const WORKSPACE_PATH = "/test/project/workspaces/feature-a";
const WORKSPACE_NAME = "feature-a" as WorkspaceName;

const WORKSPACE_PATH_B = "/test/project/workspaces/feature-b";

// =============================================================================
// Helper: Build Intent
// =============================================================================

function buildDeleteIntent(
  overrides?: Partial<DeleteWorkspaceIntent["payload"]>
): DeleteWorkspaceIntent {
  return {
    type: INTENT_DELETE_WORKSPACE,
    payload: {
      workspacePath: WORKSPACE_PATH,
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
  removedWorkspaces: Array<{ projectPath: string; workspacePath: string }>;
  worktreeRemoved: boolean;
}

/**
 * Mock interface for test hooks that simulate agent and state interactions.
 * Provides getServerManager (from AgentModule) plus
 * test-only methods for project/workspace state simulation.
 */
interface MockAppState {
  getServerManager: () => {
    stopServer: (path: string) => Promise<{ success: boolean; error?: string }>;
  } | null;
  getAllProjects: () => Promise<TestProject[]>;
  getProject: (path: string) => TestProject | undefined;
  unregisterWorkspace: (projectPath: string, workspacePath: string) => void;
  findProjectForWorkspace: (wsPath: string) => TestProject | undefined;
}

function createMockGitWorktreeProvider(opts?: { removeError?: string }): {
  gitWorktreeProvider: {
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
    gitWorktreeProvider: {
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

interface TestViewManager {
  getActiveWorkspacePath(): string | null;
  setActiveWorkspace(path: string | null, focus?: boolean): void;
  destroyWorkspaceView(path: string): Promise<void>;
}

function createTestViewManager(activeWorkspacePath: string | null = WORKSPACE_PATH): {
  viewManager: TestViewManager;
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
    focus: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn().mockReturnValue(() => {}),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
  } as TestViewManager;

  return { viewManager, activeWorkspace, destroyedViews };
}

function createTestSendToUI(): {
  sendToUI: (channel: string, payload: unknown) => void;
  emittedEvents: Array<{ event: string; payload: unknown }>;
} {
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const sendToUI = vi.fn((channel: string, payload: unknown) => {
    emittedEvents.push({ event: channel, payload });
  });
  return { sendToUI, emittedEvents };
}

function createTestWorkspaceFileService() {
  return {
    deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// Test Harness: Wires all modules with real Dispatcher
// =============================================================================

interface TestHarness {
  dispatcher: Dispatcher;
  progressCaptures: DeletionProgress[];
  appState: MockAppState;
  testState: TestAppState;
  viewManager: TestViewManager;
  activeWorkspace: { path: string | null };
  destroyedViews: string[];
  emittedEvents: Array<{ event: string; payload: unknown }>;
  inProgressDeletions: Set<string>;
  gitWorktreeProviderState: { removed: boolean };
  gitWorktreeProviderMock: {
    gitWorktreeProvider: { removeWorkspace: ReturnType<typeof vi.fn> };
  };
}

function createTestHarness(options?: {
  activeWorkspacePath?: string | null;
  workspaceLockHandler?: {
    detect: (...args: unknown[]) => Promise<BlockingProcess[]>;
    detectCwd: (...args: unknown[]) => Promise<BlockingProcess[]>;
    killProcesses: (...args: unknown[]) => Promise<void>;
    closeHandles: (...args: unknown[]) => Promise<void>;
  };
  killTerminalsCallback?: (workspacePath: string) => Promise<void>;
  serverStopError?: string;
  worktreeRemoveError?: string;
  initialProjects?: TestAppState["projects"];
  isDirty?: boolean;
  unmergedCommits?: number;
}): TestHarness {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const progressCaptures: DeletionProgress[] = [];

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
  const gitWorktreeProviderMock = createMockGitWorktreeProvider(
    options?.worktreeRemoveError ? { removeError: options.worktreeRemoveError } : undefined
  );

  const { viewManager, activeWorkspace, destroyedViews } = createTestViewManager(
    options?.activeWorkspacePath ?? WORKSPACE_PATH
  );
  const { sendToUI, emittedEvents } = createTestSendToUI();
  const noop: (...args: unknown[]) => void = () => {};
  const logger = { silly: noop, debug: noop, info: noop, warn: noop, error: noop };
  const workspaceFileService = createTestWorkspaceFileService();

  // Register operations
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new DeleteWorkspaceOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());

  // Add interceptor via module (inline, matching bootstrap pattern)
  const inProgressDeletions = new Set<string>();
  const idempotencyModule: IntentModule = {
    name: "test",
    interceptors: [
      {
        id: "idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_DELETE_WORKSPACE) {
            return intent;
          }
          const deleteIntent = intent as DeleteWorkspaceIntent;
          const key = deleteIntent.payload.workspacePath;

          if (deleteIntent.payload.force) {
            inProgressDeletions.add(key);
            return intent;
          }

          if (inProgressDeletions.has(key)) {
            return null;
          }

          inProgressDeletions.add(key);
          return intent;
        },
      },
    ],
    events: {
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceDeletedEvent).payload;
          inProgressDeletions.delete(payload.workspacePath);
        },
      },
      [EVENT_WORKSPACE_DELETE_FAILED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceDeleteFailedEvent).payload;
          inProgressDeletions.delete(payload.workspacePath);
        },
      },
    },
  };

  // Create and wire all modules (inline, following create-workspace test pattern)
  const killTerminalsCallback = options?.killTerminalsCallback ?? undefined;
  const workspaceLockHandler = options?.workspaceLockHandler ?? undefined;

  const resolveWorkspaceModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { workspacePath: wsPath } = ctx as { workspacePath: string } & HookContext;
            // Reverse lookup: find which project owns this workspace path
            const project = appState.findProjectForWorkspace(wsPath);
            if (!project) return {};
            const workspaceName = extractWorkspaceName(wsPath);
            return { projectPath: project.path, workspaceName: workspaceName as WorkspaceName };
          },
        },
      },
    },
  };

  const resolveProjectModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { projectPath } = ctx as { projectPath: string } & HookContext;
            const allProjects = await appState.getAllProjects();
            const project = allProjects.find((p) => p.path === projectPath);
            return project
              ? { projectId: testProjectId(project.path), projectName: project.name }
              : {};
          },
        },
      },
    },
  };

  const deleteViewModule: IntentModule = {
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            const isActive = viewManager.getActiveWorkspacePath() === workspacePath;

            try {
              await viewManager.destroyWorkspaceView(workspacePath);
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
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              if (killTerminalsCallback) {
                try {
                  await killTerminalsCallback(workspacePath);
                } catch (error) {
                  logger.warn("Kill terminals failed", {
                    workspacePath,
                    error: getErrorMessage(error),
                  });
                }
              }

              let serverError: string | undefined;
              const serverManager = appState.getServerManager();
              if (serverManager) {
                const stopResult = await serverManager.stopServer(workspacePath);
                if (!stopResult.success) {
                  serverError = stopResult.error ?? "Failed to stop server";
                  if (!payload.force) {
                    throw new Error(serverError);
                  }
                }
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
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force || !workspaceLockHandler) {
              return {};
            }

            // CWD-only scan: find and kill processes whose CWD is under workspace
            try {
              const cwdProcesses = await workspaceLockHandler.detectCwd(new Path(workspacePath));
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
            const { workspacePath } = ctx as DeletePipelineHookInput;

            try {
              const detected = await workspaceLockHandler.detect(new Path(workspacePath));
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
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { projectPath, workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              await gitWorktreeProviderMock.gitWorktreeProvider.removeWorkspace(
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
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const workspacePath = new Path(wsPath);
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
    name: "test",
    events: {
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceDeletedEvent).payload;
          appState.unregisterWorkspace(payload.projectPath, payload.workspacePath);
        },
      },
    },
  };

  const deleteIpcBridge: IntentModule = {
    name: "test",
    events: {
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceDeletedEvent).payload;
          sendToUI("api:workspace:removed", {
            projectId: payload.projectId,
            workspaceName: payload.workspaceName,
            path: payload.workspacePath,
          });
        },
      },
    },
  };

  // Switch modules: activate (resolve is handled by shared resolve operations)
  const switchViewModule: IntentModule = {
    name: "test",
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
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceSwitchedEvent).payload;
          if (payload === null) {
            viewManager.setActiveWorkspace(null);
          }
        },
      },
    },
  };

  // find-candidates module: returns all workspaces from appState for auto-select
  const switchFindCandidatesModule: IntentModule = {
    name: "test",
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

  const getActiveWorkspaceModule: IntentModule = {
    name: "test",
    hooks: {
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<GetActiveWorkspaceHookResult> => {
            const path = activeWorkspace.path;
            if (!path) return { workspaceRef: null };
            return {
              workspaceRef: {
                projectId: PROJECT_ID,
                workspaceName: extractWorkspaceName(path) as WorkspaceName,
                path,
              },
            };
          },
        },
      },
    },
  };

  const progressCaptureModule: IntentModule = {
    name: "test",
    events: {
      [EVENT_WORKSPACE_DELETION_PROGRESS]: {
        handler: async (event: DomainEvent): Promise<void> => {
          progressCaptures.push((event as WorkspaceDeletionProgressEvent).payload);
        },
      },
    },
  };

  // select-next module: uses selectNextWorkspace with agent status scoring
  const switchSelectNextModule: IntentModule = {
    name: "test",
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "select-next": {
          handler: async (ctx: HookContext): Promise<SelectNextHookResult> => {
            const { currentPath, candidates } = ctx as unknown as SelectNextHookInput;
            // In production, scoring uses an internal status cache.
            // For these tests, all workspaces are treated as idle (score 0).
            const scorer = (): number => 0;
            const result = selectNextWorkspace(
              currentPath,
              candidates,
              extractWorkspaceName,
              scorer
            );
            return result ? { selected: result } : {};
          },
        },
      },
    },
  };

  const deletePreflightModule: IntentModule = {
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        preflight: {
          handler: async (): Promise<PreflightHookResult> => {
            return {
              isDirty: options?.isDirty ?? false,
              unmergedCommits: options?.unmergedCommits ?? 0,
            };
          },
        },
      },
    },
  };

  for (const m of [
    idempotencyModule,
    progressCaptureModule,
    resolveWorkspaceModule,
    resolveProjectModule,
    getActiveWorkspaceModule,
    deletePreflightModule,
    deleteViewModule,
    deleteAgentModule,
    deleteWindowsLockModule,
    deleteWorktreeModule,
    deleteCodeServerModule,
    deleteStateModule,
    deleteIpcBridge,
    switchViewModule,
    switchFindCandidatesModule,
    switchSelectNextModule,
  ])
    dispatcher.registerModule(m);

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
    gitWorktreeProviderState: gitWorktreeProviderMock,
    gitWorktreeProviderMock:
      gitWorktreeProviderMock as unknown as TestHarness["gitWorktreeProviderMock"],
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

    // Shutdown: server stopped
    expect(harness.testState.serverStopped).toBe(true);

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
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "api:workspace:removed");
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
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "api:workspace:removed");
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

    const workspaceLockHandler = {
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

  it("test 22: delete fails → detect finds blockers → progress shows blockers → returns failure → retry with blockingPids → flush → delete succeeds", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 5678, name: "node.exe", commandLine: "node server.js", files: ["file.txt"], cwd: "." },
    ];

    let deleteAttempts = 0;
    const workspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    // Make first delete fail, second succeed
    const gitWorktreeProvider = {
      removeWorkspace: vi.fn().mockImplementation(async () => {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error("Permission denied");
        }
      }),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    harness.gitWorktreeProviderMock.gitWorktreeProvider.removeWorkspace =
      gitWorktreeProvider.removeWorkspace;

    // First attempt: fails, detects blockers, returns
    const intent = buildDeleteIntent();
    const result1 = await harness.dispatcher.dispatch(intent);
    expect(result1).toEqual({ started: true });

    // Verify progress shows blocking processes
    const progressWithBlockers = harness.progressCaptures.find(
      (p) => p.blockingProcesses && p.blockingProcesses.length > 0
    );
    expect(progressWithBlockers).toBeDefined();
    expect(progressWithBlockers!.blockingProcesses![0]!.pid).toBe(5678);
    expect(progressWithBlockers!.completed).toBe(true);
    expect(progressWithBlockers!.hasErrors).toBe(true);

    // Verify detecting-blockers operation
    const detectOp = progressWithBlockers!.operations.find((op) => op.id === "detecting-blockers");
    expect(detectOp).toBeDefined();
    expect(detectOp!.status).toBe("error");

    // Idempotency reset by workspace:delete-failed event
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // Retry with blockingPids
    const retryIntent = buildDeleteIntent({ blockingPids: [5678] });
    const result2 = await harness.dispatcher.dispatch(retryIntent);
    expect(result2).toEqual({ started: true });

    // Flush killed the PIDs
    expect(workspaceLockHandler.killProcesses).toHaveBeenCalledWith([5678]);

    // Second delete succeeded
    expect(deleteAttempts).toBe(2);

    // Final progress: success
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });

  it("test 23: delete fails → detect finds blockers → pipeline exits with hasErrors, no workspace:deleted emitted", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 9999, name: "code.exe", commandLine: "code .", files: ["file.txt"], cwd: null },
    ];

    const workspaceLockHandler = {
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

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Workspace should NOT be removed from state (no workspace:deleted event)
    expect(harness.testState.removedWorkspaces).toHaveLength(0);

    // No IPC workspace:removed event
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "api:workspace:removed");
    expect(ipcEvent).toBeUndefined();

    // Idempotency was reset by delete-failed event (allows retry)
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // Progress shows blockers
    const progressWithBlockers = harness.progressCaptures.find(
      (p) => p.blockingProcesses && p.blockingProcesses.length > 0
    );
    expect(progressWithBlockers).toBeDefined();
    expect(progressWithBlockers!.blockingProcesses![0]!.pid).toBe(9999);
  });

  it("test 24: multiple retry dispatches: first fails → retry with PIDs fails → retry again → succeeds", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 1111, name: "node.exe", commandLine: "node", files: ["a.js"], cwd: null },
    ];

    let deleteAttempts = 0;
    const workspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const gitWorktreeProvider = {
      removeWorkspace: vi.fn().mockImplementation(async () => {
        deleteAttempts++;
        // First two fail, third succeeds
        if (deleteAttempts <= 2) {
          throw new Error("Permission denied");
        }
      }),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    harness.gitWorktreeProviderMock.gitWorktreeProvider.removeWorkspace =
      gitWorktreeProvider.removeWorkspace;

    // First attempt: fails
    const result1 = await harness.dispatcher.dispatch(buildDeleteIntent());
    expect(result1).toEqual({ started: true });
    expect(deleteAttempts).toBe(1);
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // Second attempt (retry with PIDs): also fails
    const result2 = await harness.dispatcher.dispatch(buildDeleteIntent({ blockingPids: [1111] }));
    expect(result2).toEqual({ started: true });
    expect(deleteAttempts).toBe(2);
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // Third attempt: succeeds
    const result3 = await harness.dispatcher.dispatch(buildDeleteIntent({ blockingPids: [1111] }));
    expect(result3).toEqual({ started: true });
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

    // Post-release: cleanup-workspace still in-progress (delete hook about to run)
    const postRelease = harness.progressCaptures[2]!;
    expect(postRelease.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe(
      "in-progress"
    );
  });

  it("test 26: first attempt emits detecting-blockers in-progress; retry with blockingPids emits killing-blockers in-progress", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 4444, name: "node.exe", commandLine: "node", files: ["f.js"], cwd: null },
    ];

    let deleteAttempts = 0;
    const workspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const gitWorktreeProvider = {
      removeWorkspace: vi.fn().mockImplementation(async () => {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error("Permission denied");
        }
      }),
    };

    const harness = createTestHarness({ workspaceLockHandler });
    harness.gitWorktreeProviderMock.gitWorktreeProvider.removeWorkspace =
      gitWorktreeProvider.removeWorkspace;

    // First attempt: fails, detect runs
    await harness.dispatcher.dispatch(buildDeleteIntent());

    // Should have emitted detecting-blockers as in-progress
    const detectInProgress = harness.progressCaptures.find(
      (p) => p.operations.find((op) => op.id === "detecting-blockers")?.status === "in-progress"
    );
    expect(detectInProgress).toBeDefined();

    // Clear captures for retry
    harness.progressCaptures.length = 0;

    // Retry with blockingPids
    await harness.dispatcher.dispatch(buildDeleteIntent({ blockingPids: [4444] }));

    // Should have emitted killing-blockers as in-progress
    const flushInProgress = harness.progressCaptures.find(
      (p) => p.operations.find((op) => op.id === "killing-blockers")?.status === "in-progress"
    );
    expect(flushInProgress).toBeDefined();
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

  it("auto-switches when user navigates to workspace being deleted", async () => {
    // Active workspace is B, deleting A — user is NOT on the deleted workspace initially
    const harness = createTestHarness({
      activeWorkspacePath: WORKSPACE_PATH_B,
    });

    // Simulate user navigating to workspace A during the delete hook
    // (after the initial shutdown switch-away already ran, finding wasActive=false)
    harness.gitWorktreeProviderMock.gitWorktreeProvider.removeWorkspace = vi
      .fn()
      .mockImplementation(async () => {
        // User navigates to workspace A mid-deletion
        harness.activeWorkspace.path = WORKSPACE_PATH;
      });

    const intent = buildDeleteIntent(); // deleting WORKSPACE_PATH (A)
    await harness.dispatcher.dispatch(intent);

    // autoSwitchIfBecameActive should have detected the change and switched back to B
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

    const ipcEvent = harness.emittedEvents.find((e) => e.event === "api:workspace:removed");
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
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "api:workspace:removed");
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
    const ipcEvent = harness.emittedEvents.find((e) => e.event === "api:workspace:removed");
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

  it("test 21: throws when resolve hook cannot find workspace", async () => {
    // Create harness with no projects (resolve hooks return empty)
    const harness = createTestHarness({
      initialProjects: [],
    });

    const intent = buildDeleteIntent();

    // Resolve hook returns empty -> shared resolve operation throws
    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow(
      "Workspace not found: /test/project/workspaces/feature-a"
    );
  });

  it("test 27: deletion succeeds with only workspacePath in payload (resolve hooks provide identity)", async () => {
    const harness = createTestHarness();

    // Build intent with only workspacePath (the new payload format)
    const intent: DeleteWorkspaceIntent = {
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: WORKSPACE_PATH,
        keepBranch: true,
        force: false,
        removeWorktree: true,
      },
    };

    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Resolve hooks populated identity from appState, pipeline ran successfully
    expect(harness.testState.worktreeRemoved).toBe(true);
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    // Progress used resolved paths
    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.workspacePath).toBe(WORKSPACE_PATH);
  });

  it("test 28: throws when resolve hooks return nothing for unknown workspace path", async () => {
    // No projects to resolve from
    const harness = createTestHarness({
      initialProjects: [],
    });

    const intent: DeleteWorkspaceIntent = {
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: "/unknown/workspace",
        keepBranch: true,
        force: false,
        removeWorktree: true,
      },
    };

    // Normal mode: shared resolve operation should throw when workspace not found
    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow(
      "Workspace not found: /unknown/workspace"
    );
  });
});

describe("DeleteWorkspaceOperation.safetyNet", () => {
  it("emits completed error progress when pipeline encounters unexpected error after identity resolution", async () => {
    // Directly test the safety net by constructing the operation with a mock context
    // where hooks.collect throws on "release" (simulating an infrastructure-level failure).
    const operation = new DeleteWorkspaceOperation();
    const intent = buildDeleteIntent();

    const emittedEvents: DomainEvent[] = [];

    const ctx = {
      intent,
      causation: [],
      emit: async (event: DomainEvent): Promise<void> => {
        emittedEvents.push(event);
      },
      dispatch: async (dispatchedIntent: Intent) => {
        if (dispatchedIntent.type === INTENT_RESOLVE_WORKSPACE) {
          return { projectPath: PROJECT_PATH, workspaceName: WORKSPACE_NAME };
        }
        if (dispatchedIntent.type === INTENT_RESOLVE_PROJECT) {
          return { projectId: PROJECT_ID, projectName: "test-project" };
        }
        if (dispatchedIntent.type === INTENT_GET_ACTIVE_WORKSPACE) {
          return { workspaceRef: null };
        }
        return undefined;
      },
      hooks: {
        async collect(hookPointId: string) {
          if (hookPointId === "shutdown") {
            return { results: [{ wasActive: false }], errors: [] };
          }
          if (hookPointId === "release") {
            // Simulate unexpected infrastructure-level failure
            throw new Error("Unexpected collect failure");
          }
          return { results: [], errors: [] };
        },
      },
    } as unknown as OperationContext<DeleteWorkspaceIntent>;

    const result = await operation.execute(ctx);
    expect(result).toEqual({ started: true });

    // Safety net should have emitted a terminal progress event
    const progressEvents = emittedEvents.filter(
      (e) => e.type === EVENT_WORKSPACE_DELETION_PROGRESS
    ) as WorkspaceDeletionProgressEvent[];
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const finalProgress = progressEvents[progressEvents.length - 1]!;
    expect(finalProgress.payload.completed).toBe(true);
    expect(finalProgress.payload.hasErrors).toBe(true);

    // workspace:delete-failed should have been emitted (resets idempotency)
    const failedEvents = emittedEvents.filter((e) => e.type === EVENT_WORKSPACE_DELETE_FAILED);
    expect(failedEvents).toHaveLength(1);

    // workspace:deleted should NOT have been emitted
    const deletedEvents = emittedEvents.filter((e) => e.type === EVENT_WORKSPACE_DELETED);
    expect(deletedEvents).toHaveLength(0);
  });

  it("delete handler returns error in non-force mode instead of throwing", async () => {
    // With the fix, removeWorkspace failure returns { error } instead of throwing.
    // The pipeline should reach the detect phase (proving collect() got a structured
    // error result, not a thrown exception that escaped).
    const blockingProcesses: BlockingProcess[] = [
      { pid: 7777, name: "node.exe", commandLine: "node", files: ["x.js"], cwd: null },
    ];

    const workspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    const harness = createTestHarness({
      workspaceLockHandler,
      worktreeRemoveError: "EBUSY: resource busy",
    });

    const intent = buildDeleteIntent();
    const result = await harness.dispatcher.dispatch(intent);
    expect(result).toEqual({ started: true });

    // Pipeline reached the detect phase (detect hook was called)
    expect(workspaceLockHandler.detect).toHaveBeenCalled();

    // Progress shows blockers from detect phase
    const progressWithBlockers = harness.progressCaptures.find(
      (p) => p.blockingProcesses && p.blockingProcesses.length > 0
    );
    expect(progressWithBlockers).toBeDefined();
    expect(progressWithBlockers!.blockingProcesses![0]!.pid).toBe(7777);
    expect(progressWithBlockers!.completed).toBe(true);
    expect(progressWithBlockers!.hasErrors).toBe(true);

    // delete-failed emitted (resets idempotency for retry)
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // workspace:deleted NOT emitted (workspace still exists)
    expect(harness.testState.removedWorkspaces).toHaveLength(0);
  });
});

describe("DeleteWorkspaceOperation.preflight", () => {
  it("throws when workspace is dirty", async () => {
    const harness = createTestHarness({ isDirty: true });
    const intent = buildDeleteIntent();

    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow(
      "Preflight check failed: Workspace has uncommitted changes"
    );

    // Shutdown hook should NOT have been called (server not stopped)
    expect(harness.testState.serverStopped).toBe(false);

    // Worktree should NOT be removed
    expect(harness.testState.worktreeRemoved).toBe(false);

    // workspace:deleted NOT emitted
    expect(harness.testState.removedWorkspaces).toHaveLength(0);

    // delete-failed emitted (resets idempotency)
    expect(harness.inProgressDeletions.has(WORKSPACE_PATH)).toBe(false);

    // No progress events emitted (preflight throws before any progress)
    expect(harness.progressCaptures).toHaveLength(0);
  });

  it("throws when workspace has unmerged commits", async () => {
    const harness = createTestHarness({ unmergedCommits: 3 });
    const intent = buildDeleteIntent();

    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow(
      "Preflight check failed: Workspace has 3 unmerged commits"
    );

    expect(harness.testState.serverStopped).toBe(false);
    expect(harness.testState.worktreeRemoved).toBe(false);
    expect(harness.testState.removedWorkspaces).toHaveLength(0);
    expect(harness.progressCaptures).toHaveLength(0);
  });

  it("proceeds when workspace is clean", async () => {
    const harness = createTestHarness({ isDirty: false, unmergedCommits: 0 });
    const intent = buildDeleteIntent();

    await harness.dispatcher.dispatch(intent);

    // Deletion should have completed normally
    expect(harness.testState.worktreeRemoved).toBe(true);
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });

  it("skips preflight when ignoreWarnings is true", async () => {
    const harness = createTestHarness({ isDirty: true, unmergedCommits: 5 });
    const intent = buildDeleteIntent({ ignoreWarnings: true });

    await harness.dispatcher.dispatch(intent);

    // Deletion should proceed despite dirty state
    expect(harness.testState.worktreeRemoved).toBe(true);
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });

    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });

  it("skips preflight when force is true", async () => {
    const harness = createTestHarness({ isDirty: true });
    const intent = buildDeleteIntent({ force: true });

    await harness.dispatcher.dispatch(intent);

    // Force deletion proceeds
    expect(harness.testState.removedWorkspaces).toContainEqual({
      projectPath: PROJECT_PATH,
      workspacePath: WORKSPACE_PATH,
    });
  });

  it("skips preflight when removeWorktree is false", async () => {
    const harness = createTestHarness({ isDirty: true });
    const intent = buildDeleteIntent({ removeWorktree: false });

    await harness.dispatcher.dispatch(intent);

    // Runtime teardown only — no preflight, no worktree removal
    expect(harness.testState.serverStopped).toBe(true);

    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });

  it("retry with ignoreWarnings and blockingPids skips preflight and proceeds to flush → delete", async () => {
    const blockingProcesses: BlockingProcess[] = [
      { pid: 7777, name: "node.exe", commandLine: "node server.js", files: ["file.txt"], cwd: "." },
    ];

    const workspaceLockHandler = {
      detect: vi.fn().mockResolvedValue(blockingProcesses),
      detectCwd: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn().mockResolvedValue(undefined),
      closeHandles: vi.fn().mockResolvedValue(undefined),
    };

    // Dirty workspace — preflight would throw without ignoreWarnings
    const harness = createTestHarness({ isDirty: true, workspaceLockHandler });

    // First attempt (without ignoreWarnings): fails at preflight
    const intent1 = buildDeleteIntent();
    await expect(harness.dispatcher.dispatch(intent1)).rejects.toThrow("Preflight check failed");
    expect(harness.progressCaptures).toHaveLength(0);

    // Retry with ignoreWarnings + blockingPids (simulates Kill & Retry)
    const retryIntent = buildDeleteIntent({ ignoreWarnings: true, blockingPids: [7777] });
    const result = await harness.dispatcher.dispatch(retryIntent);
    expect(result).toEqual({ started: true });

    // Flush killed the PIDs
    expect(workspaceLockHandler.killProcesses).toHaveBeenCalledWith([7777]);

    // Delete succeeded
    expect(harness.testState.worktreeRemoved).toBe(true);

    const finalProgress = harness.progressCaptures[harness.progressCaptures.length - 1]!;
    expect(finalProgress.completed).toBe(true);
    expect(finalProgress.hasErrors).toBe(false);
  });

  it("throws with both dirty and unmerged messages when both are true", async () => {
    const harness = createTestHarness({ isDirty: true, unmergedCommits: 2 });
    const intent = buildDeleteIntent();

    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow(
      "Preflight check failed: Workspace has uncommitted changes; Workspace has 2 unmerged commits"
    );

    expect(harness.progressCaptures).toHaveLength(0);
  });
});
