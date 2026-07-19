/**
 * Integration tests for CloseProjectOperation.
 *
 * Tests the full project:close pipeline through dispatcher.dispatch():
 * - Operation dispatches workspace:delete per workspace, then runs "close" hook
 * - workspace:delete uses removeWorktree=false (runtime teardown only)
 * - skipSwitch prevents intermediate workspace switches during sequential teardown
 * - Hook modules unregister from global provider, remove state + store
 *
 * Test plan items covered:
 * #9: Closes project and tears down workspaces
 * #10: Close with removeLocalRepo deletes cloned dir
 * #11: Close with removeLocalRepo skips for local projects
 * #12: project:closed event emitted after close
 * #13: Close with unknown projectPath throws
 * #14: skipSwitch prevents intermediate switches during close
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "./lib/dispatcher";

import type { IntentModule } from "./lib/module";
import type { HookContext, HookOutput } from "./lib/operation";
import type { DomainEvent } from "./lib/types";
import {
  CloseProjectOperation,
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  EVENT_PROJECT_CLOSED,
  EVENT_PROJECT_CLOSE_FAILED,
} from "./close-project";
import type {
  CloseProjectIntent,
  CloseResolveHookResult,
  CloseConfirmHookInput,
  CloseConfirmHookResult,
  CloseHookInput,
  CloseHookResult,
  ProjectClosedEvent,
  ProjectCloseFailedEvent,
} from "./close-project";
import {
  DeleteWorkspaceOperation,
  DELETE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_DELETED,
} from "./delete-workspace";
import type {
  DeleteWorkspaceIntent,
  WorkspaceDeletedEvent,
  ShutdownHookResult,
  DeletePipelineHookInput,
} from "./delete-workspace";
import {
  createTestViewManager,
  registerTestInfrastructure,
  workspacesFromProjects,
} from "./operations.test-utils";
import type { TestViewManager } from "./operations.test-utils";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "./switch-workspace";
import type { ProjectId, WorkspaceName, Project } from "../shared/api/types";
import { Path } from "../utils/path/path";

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
const WORKSPACE_A_PATH = "/test/project/workspaces/feature-a";
const WORKSPACE_A_NAME = "feature-a" as WorkspaceName;
const WORKSPACE_B_PATH = "/test/project/workspaces/feature-b";
const WORKSPACE_B_NAME = "feature-b" as WorkspaceName;

// =============================================================================
// Mock Factories
// =============================================================================

interface TestState {
  serversStoppedForWorkspaces: string[];
  destroyedViews: string[];
  deregisteredProjects: string[];
  removedProjectsFromStore: string[];
  deletedProjectDirectories: string[];
  unregisteredProjects: string[];
  setActiveWorkspaceCalls: Array<{ path: string | null; focus?: boolean }>;
}

interface TestHarness {
  dispatcher: Dispatcher;
  state: TestState;
  viewManager: TestViewManager;
}

function createTestHarness(options?: {
  withRemoteUrl?: boolean;
  emptyProject?: boolean;
  projectNotFound?: boolean;
  noRemoteUrl?: boolean;
}): TestHarness {
  const dispatcher = createMockDispatcher();

  const vmHarness = createTestViewManager(WORKSPACE_A_PATH);
  const viewManager = vmHarness.viewManager;

  const state: TestState = {
    serversStoppedForWorkspaces: [],
    destroyedViews: vmHarness.destroyedViews,
    deregisteredProjects: [],
    removedProjectsFromStore: [],
    deletedProjectDirectories: [],
    unregisteredProjects: [],
    setActiveWorkspaceCalls: vmHarness.setActiveWorkspaceCalls,
  };

  const workspaces = options?.emptyProject
    ? []
    : [
        {
          projectId: PROJECT_ID,
          name: WORKSPACE_A_NAME,
          path: WORKSPACE_A_PATH,
          branch: "feature-a",
          metadata: { base: "main" },
        },
        {
          projectId: PROJECT_ID,
          name: WORKSPACE_B_NAME,
          path: WORKSPACE_B_PATH,
          branch: "feature-b",
          metadata: { base: "main" },
        },
      ];

  const project: Project | undefined = options?.projectNotFound
    ? undefined
    : {
        id: PROJECT_ID,
        path: PROJECT_PATH,
        name: "test-project",
        workspaces,
        ...(options?.withRemoteUrl && { remoteUrl: "https://github.com/org/repo.git" }),
      };

  const remoteUrl = options?.withRemoteUrl
    ? "https://github.com/org/repo.git"
    : options?.noRemoteUrl
      ? undefined
      : undefined;

  const gitWorktreeProvider = {
    unregisterProject: (projectPath: Path) => {
      state.unregisteredProjects.push(projectPath.toString());
    },
  };

  const appState = {
    getAllProjects: vi.fn().mockImplementation(async () => (project ? [project] : [])),
    getProject: vi.fn().mockReturnValue(project),
    isProjectOpen: vi.fn().mockReturnValue(!options?.projectNotFound),
    deregisterProject: vi.fn().mockImplementation((path: string) => {
      state.deregisteredProjects.push(path);
    }),
    getProjectStore: vi.fn().mockReturnValue({
      getProjectConfig: vi.fn().mockImplementation(async () => {
        if (remoteUrl) {
          return { remoteUrl };
        }
        return undefined;
      }),
      removeProject: vi.fn().mockImplementation(async (path: string) => {
        state.removedProjectsFromStore.push(path);
      }),
      deleteProjectDirectory: vi.fn().mockImplementation(async (path: string) => {
        state.deletedProjectDirectories.push(path);
      }),
    }),
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockImplementation(async (path: string) => {
        state.serversStoppedForWorkspaces.push(path);
        return { success: true };
      }),
    }),
    unregisterWorkspace: vi.fn(),
  };

  // Register operations
  dispatcher.registerOperation(new CloseProjectOperation());
  dispatcher.registerOperation(new DeleteWorkspaceOperation());

  // Shared workspace:resolve (reverse lookup over the project) and project:resolve
  registerTestInfrastructure(dispatcher, {
    workspaces: workspacesFromProjects(() => (project ? [project] : [])),
    projects: (projectPath) => ({ projectId: testProjectId(projectPath) }),
    viewManager,
  });

  // Delete-workspace hook modules (simplified for close-project testing)
  const deleteViewModule: IntentModule = {
    name: "test",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            // Track that skipSwitch is set
            if (!payload.skipSwitch) {
              // Not expected for project:close -- would indicate a bug
              viewManager.setActiveWorkspace(null);
            }
            await viewManager.destroyWorkspaceView(workspacePath);
            return { result: {} };
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
          handler: async (ctx: HookContext): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const serverManager = appState.getServerManager();
            if (serverManager) {
              await serverManager.stopServer(workspacePath);
            }
            return { result: {} };
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

  // ProjectResolveModule: "resolve" hook -- resolves projectPath to config/workspaces
  const projectResolveModule: IntentModule = {
    name: "test",
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseResolveHookResult>> => {
            const intent = ctx.intent as CloseProjectIntent;
            const { projectPath: payloadPath } = intent.payload;

            // Resolve using appState (mirrors bootstrap pattern)
            const allProjects: Project[] = await appState.getAllProjects();
            const found = allProjects.find((p) => p.path === payloadPath);
            if (!found) {
              throw new Error(`Project not found for path: ${payloadPath}`);
            }

            const store = appState.getProjectStore();
            const config = await store.getProjectConfig(found.path);

            return {
              result: {
                workspaces: found.workspaces ?? [],
                ...(config?.remoteUrl !== undefined && { remoteUrl: config.remoteUrl }),
              },
            };
          },
        },
      },
    },
  };

  // ProjectCloseViewModule: "close" hook -- returns otherProjectsExist, clears active workspace if no other projects
  // Note: workspace:switched(null) is emitted by CloseProjectOperation, not here
  const projectCloseViewModule: IntentModule = {
    name: "test",
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath } = ctx as CloseHookInput;
            const allProjects: Project[] = await appState.getAllProjects();
            const otherProjectsExist = allProjects.some((p) => p.path !== projectPath);
            if (!otherProjectsExist) {
              viewManager.setActiveWorkspace(null);
            }
            return { result: { otherProjectsExist } };
          },
        },
      },
    },
  };

  // ProjectLocalCloseModule: "close" hook -- deregister + remove store for local projects
  const projectLocalCloseModule: IntentModule = {
    name: "test",
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath, remoteUrl } = ctx as CloseHookInput;

            // Self-select: only handle local projects (no remoteUrl)
            if (remoteUrl !== undefined) {
              return { result: {} };
            }

            appState.deregisterProject(projectPath);

            const store = appState.getProjectStore();
            try {
              await store.removeProject(projectPath);
            } catch {
              // Fail silently
            }

            return { result: {} };
          },
        },
      },
    },
  };

  // ProjectRemoteCloseModule: "close" hook -- deregister + remove store for remote projects, optionally delete dir
  const projectRemoteCloseModule: IntentModule = {
    name: "test",
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath, remoteUrl, removeLocalRepo } = ctx as CloseHookInput;

            // Self-select: only handle remote projects (has remoteUrl)
            if (!remoteUrl) {
              return { result: {} };
            }

            appState.deregisterProject(projectPath);

            const store = appState.getProjectStore();
            try {
              await store.removeProject(projectPath);
            } catch {
              // Fail silently
            }

            if (removeLocalRepo) {
              await store.deleteProjectDirectory(projectPath, {
                isClonedProject: true,
              });
            }

            return { result: {} };
          },
        },
      },
    },
  };

  // ProjectWorktreeCloseModule: "close" hook -- unregister project from global git provider
  const projectWorktreeCloseModule: IntentModule = {
    name: "test",
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath } = ctx as CloseHookInput;
            gitWorktreeProvider.unregisterProject(new Path(projectPath));
            return { result: {} };
          },
        },
      },
    },
  };

  for (const m of [
    deleteViewModule,
    deleteAgentModule,
    deleteStateModule,
    projectResolveModule,
    projectCloseViewModule,
    projectLocalCloseModule,
    projectRemoteCloseModule,
    projectWorktreeCloseModule,
  ])
    dispatcher.registerModule(m);

  return { dispatcher, state, viewManager };
}

function buildCloseIntent(overrides?: Partial<CloseProjectIntent["payload"]>): CloseProjectIntent {
  return {
    type: INTENT_CLOSE_PROJECT,
    payload: {
      projectPath: PROJECT_PATH,
      ...overrides,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("CloseProjectOperation", () => {
  it("test 9: closes project and tears down workspaces", async () => {
    const harness = createTestHarness();
    const intent = buildCloseIntent();

    await harness.dispatcher.dispatch(intent);

    // All workspace views destroyed
    expect(harness.state.destroyedViews).toContain(WORKSPACE_A_PATH);
    expect(harness.state.destroyedViews).toContain(WORKSPACE_B_PATH);

    // All workspace servers stopped
    expect(harness.state.serversStoppedForWorkspaces).toContain(WORKSPACE_A_PATH);
    expect(harness.state.serversStoppedForWorkspaces).toContain(WORKSPACE_B_PATH);

    // Project deregistered from state
    expect(harness.state.deregisteredProjects).toContain(PROJECT_PATH);

    // Project removed from store
    expect(harness.state.removedProjectsFromStore).toContain(PROJECT_PATH);

    // Project unregistered from global git provider
    expect(harness.state.unregisteredProjects).toContain(PROJECT_PATH);
  });

  it("test 10: close with removeLocalRepo deletes cloned dir", async () => {
    const harness = createTestHarness({ withRemoteUrl: true });
    const intent = buildCloseIntent({ removeLocalRepo: true });

    await harness.dispatcher.dispatch(intent);

    // Directory deleted
    expect(harness.state.deletedProjectDirectories).toContain(PROJECT_PATH);
  });

  it("test 11: close with removeLocalRepo skips for local projects", async () => {
    const harness = createTestHarness({ noRemoteUrl: true });
    const intent = buildCloseIntent({ removeLocalRepo: true });

    await harness.dispatcher.dispatch(intent);

    // Directory NOT deleted (no remoteUrl)
    expect(harness.state.deletedProjectDirectories).toHaveLength(0);
  });

  it("test 12: project:closed event emitted after close", async () => {
    const harness = createTestHarness();

    const receivedEvents: DomainEvent[] = [];
    harness.dispatcher.subscribe(EVENT_PROJECT_CLOSED, (event) => {
      receivedEvents.push(event);
    });

    await harness.dispatcher.dispatch(buildCloseIntent());

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as ProjectClosedEvent;
    expect(event.type).toBe(EVENT_PROJECT_CLOSED);
    expect(event.payload.projectId).toBe(PROJECT_ID);
    // Regression: project:closed must carry projectPath so the per-projectPath
    // idempotency guard resets on success (not only on project:close-failed).
    // Without it the guard leaks and a reopened project can never be closed again.
    expect(event.payload.projectPath).toBe(PROJECT_PATH);
  });

  it("test 13: close with unknown projectPath throws", async () => {
    const harness = createTestHarness({ projectNotFound: true });
    const intent = buildCloseIntent({
      projectPath: "/nonexistent/project",
    });

    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow("Project not found");
  });

  it("test 14: skipSwitch prevents intermediate switches during close", async () => {
    const harness = createTestHarness();
    const intent = buildCloseIntent();

    await harness.dispatcher.dispatch(intent);

    // The deleteViewModule checks skipSwitch -- no setActiveWorkspace calls from
    // individual workspace deletes (only from the project close operation itself)
    // The operation sets active to null since no other projects exist
    const nullCalls = harness.state.setActiveWorkspaceCalls.filter((c) => c.path === null);
    expect(nullCalls.length).toBe(1);

    // No intermediate workspace switches (no calls with workspace paths)
    const workspaceSwitchCalls = harness.state.setActiveWorkspaceCalls.filter(
      (c) => c.path !== null
    );
    expect(workspaceSwitchCalls).toHaveLength(0);
  });

  it("test 15: emits workspace:switched(null) when no other projects remain", async () => {
    const harness = createTestHarness();

    const switchedEvents: DomainEvent[] = [];
    harness.dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
      switchedEvents.push(event);
    });

    await harness.dispatcher.dispatch(buildCloseIntent());

    // Should emit workspace:switched(null) since no other projects exist
    expect(switchedEvents).toHaveLength(1);
    const event = switchedEvents[0] as WorkspaceSwitchedEvent;
    expect(event.type).toBe(EVENT_WORKSPACE_SWITCHED);
    expect(event.payload).toBeNull();
  });
});

// =============================================================================
// Interactive confirm hook
// =============================================================================

describe("CloseProjectOperation.interactiveConfirm", () => {
  /** Register an extra confirm-hook module on the harness dispatcher. */
  function registerConfirm(
    harness: TestHarness,
    impl: (ctx: CloseConfirmHookInput) => Promise<CloseConfirmHookResult> | CloseConfirmHookResult
  ): ReturnType<typeof vi.fn> {
    const spy = vi.fn(impl);
    const module: IntentModule = {
      name: "test",
      hooks: {
        [CLOSE_PROJECT_OPERATION_ID]: {
          confirm: {
            handler: async (ctx: HookContext): Promise<HookOutput<CloseConfirmHookResult>> => ({
              result: await spy(ctx as CloseConfirmHookInput),
            }),
          },
        },
      },
    };
    harness.dispatcher.registerModule(module);
    return spy;
  }

  /** Record the payloads of full-pipeline deletes (the "delete" hook only
   *  runs when removeWorktree is true). */
  function recordFullDeletes(harness: TestHarness): DeleteWorkspaceIntent["payload"][] {
    const payloads: DeleteWorkspaceIntent["payload"][] = [];
    const module: IntentModule = {
      name: "test",
      hooks: {
        [DELETE_WORKSPACE_OPERATION_ID]: {
          delete: {
            handler: async (ctx: HookContext) => {
              payloads.push((ctx.intent as DeleteWorkspaceIntent).payload);
              return { result: {} };
            },
          },
        },
      },
    };
    harness.dispatcher.registerModule(module);
    return payloads;
  }

  it("confirm receives the resolved workspaces and remoteUrl", async () => {
    const harness = createTestHarness({ withRemoteUrl: true });
    const confirm = registerConfirm(harness, () => ({}));

    await harness.dispatcher.dispatch(buildCloseIntent({ interactive: true }));

    expect(confirm).toHaveBeenCalledTimes(1);
    const input = confirm.mock.calls[0]![0] as CloseConfirmHookInput;
    expect(input.projectPath).toBe(PROJECT_PATH);
    expect(input.remoteUrl).toBe("https://github.com/org/repo.git");
    expect(input.workspaces.map((w) => w.path)).toEqual([WORKSPACE_A_PATH, WORKSPACE_B_PATH]);
  });

  it("a canceled confirm aborts cleanly and emits project:close-failed", async () => {
    const harness = createTestHarness();
    registerConfirm(harness, () => ({ canceled: true }));

    const closeFailed: DomainEvent[] = [];
    const closed: DomainEvent[] = [];
    harness.dispatcher.subscribe(EVENT_PROJECT_CLOSE_FAILED, (e) => closeFailed.push(e));
    harness.dispatcher.subscribe(EVENT_PROJECT_CLOSED, (e) => closed.push(e));

    await harness.dispatcher.dispatch(buildCloseIntent({ interactive: true }));

    // Nothing closed, nothing torn down.
    expect(harness.state.deregisteredProjects).toHaveLength(0);
    expect(harness.state.destroyedViews).toHaveLength(0);
    expect(closed).toHaveLength(0);
    // close-failed resets the per-projectPath idempotency guard.
    expect(closeFailed).toHaveLength(1);
    expect((closeFailed[0] as ProjectCloseFailedEvent).payload).toEqual({
      projectPath: PROJECT_PATH,
    });
  });

  it("a confirmed removeAll upgrades teardown to full deletion (branches + warnings included)", async () => {
    const harness = createTestHarness();
    registerConfirm(harness, () => ({ removeAll: true }));
    const fullDeletes = recordFullDeletes(harness);

    await harness.dispatcher.dispatch(buildCloseIntent({ interactive: true }));

    expect(fullDeletes.map((p) => p.workspacePath)).toEqual([WORKSPACE_A_PATH, WORKSPACE_B_PATH]);
    for (const payload of fullDeletes) {
      expect(payload).toMatchObject({
        removeWorktree: true,
        keepBranch: false,
        ignoreWarnings: true,
        skipSwitch: true,
      });
    }
    // The close still completes.
    expect(harness.state.deregisteredProjects).toContain(PROJECT_PATH);
  });

  it("a confirmed close without removeAll keeps the runtime-teardown deletes", async () => {
    const harness = createTestHarness();
    registerConfirm(harness, () => ({}));
    const fullDeletes = recordFullDeletes(harness);

    await harness.dispatcher.dispatch(buildCloseIntent({ interactive: true }));

    // No full-pipeline deletes ran; workspaces were torn down runtime-only.
    expect(fullDeletes).toHaveLength(0);
    expect(harness.state.destroyedViews).toContain(WORKSPACE_A_PATH);
    expect(harness.state.deregisteredProjects).toContain(PROJECT_PATH);
  });

  it("a confirmed removeLocalRepo overrides the payload", async () => {
    const harness = createTestHarness({ withRemoteUrl: true });
    registerConfirm(harness, () => ({ removeLocalRepo: true }));

    // Payload carries no removeLocalRepo; the dialog answer provides it.
    await harness.dispatcher.dispatch(buildCloseIntent({ interactive: true }));

    expect(harness.state.deletedProjectDirectories).toContain(PROJECT_PATH);
  });

  it("emits project:close-failed before rethrowing on errors", async () => {
    const harness = createTestHarness({ projectNotFound: true });

    const closeFailed: DomainEvent[] = [];
    harness.dispatcher.subscribe(EVENT_PROJECT_CLOSE_FAILED, (e) => closeFailed.push(e));

    await expect(
      harness.dispatcher.dispatch(buildCloseIntent({ projectPath: "/nonexistent/project" }))
    ).rejects.toThrow("Project not found");

    expect(closeFailed).toHaveLength(1);
    expect((closeFailed[0] as ProjectCloseFailedEvent).payload).toEqual({
      projectPath: "/nonexistent/project",
    });
  });

  it("non-interactive dispatches never run the confirm hook", async () => {
    const harness = createTestHarness();
    const confirm = registerConfirm(harness, () => ({ canceled: true }));

    await harness.dispatcher.dispatch(buildCloseIntent());

    expect(confirm).not.toHaveBeenCalled();
    expect(harness.state.deregisteredProjects).toContain(PROJECT_PATH);
  });
});
