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
 * #13: Close with unknown projectId throws
 * #14: skipSwitch prevents intermediate switches during close
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import {
  CloseProjectOperation,
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  EVENT_PROJECT_CLOSED,
} from "./close-project";
import type {
  CloseProjectIntent,
  CloseResolveHookResult,
  CloseHookInput,
  CloseHookResult,
  ProjectClosedEvent,
} from "./close-project";
import {
  DeleteWorkspaceOperation,
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
} from "./delete-workspace";
import type {
  DeleteWorkspaceIntent,
  WorkspaceDeletedEvent,
  DeletionProgressCallback,
  ShutdownHookResult,
  ResolveProjectHookResult,
  ResolveWorkspaceHookResult,
  ResolveWorkspaceHookInput,
} from "./delete-workspace";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "./switch-workspace";
import type { IViewManager } from "../managers/view-manager.interface";
import type { AppState } from "../app-state";
import type { ProjectId, WorkspaceName, Project } from "../../shared/api/types";
import { generateProjectId } from "../../shared/api/id-utils";
import { extractWorkspaceName, resolveProjectPath } from "../api/id-utils";
import { Path } from "../../services/platform/path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/project";
const PROJECT_ID = generateProjectId(PROJECT_PATH);
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
  viewManager: IViewManager;
}

function createTestHarness(options?: {
  withRemoteUrl?: boolean;
  emptyProject?: boolean;
  projectNotFound?: boolean;
  noRemoteUrl?: boolean;
}): TestHarness {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const state: TestState = {
    serversStoppedForWorkspaces: [],
    destroyedViews: [],
    deregisteredProjects: [],
    removedProjectsFromStore: [],
    deletedProjectDirectories: [],
    unregisteredProjects: [],
    setActiveWorkspaceCalls: [],
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

  const viewManager = {
    getActiveWorkspacePath: vi.fn().mockReturnValue(WORKSPACE_A_PATH),
    setActiveWorkspace: vi.fn().mockImplementation((path: string | null, focus?: boolean) => {
      state.setActiveWorkspaceCalls.push({
        path,
        ...(focus !== undefined && { focus }),
      });
    }),
    destroyWorkspaceView: vi.fn().mockImplementation(async (path: string) => {
      state.destroyedViews.push(path);
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
    preloadWorkspaceUrl: vi.fn(),
  } as unknown as IViewManager;

  const remoteUrl = options?.withRemoteUrl
    ? "https://github.com/org/repo.git"
    : options?.noRemoteUrl
      ? undefined
      : undefined;

  const globalProvider = {
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
    getMcpServerManager: vi.fn().mockReturnValue({
      clearWorkspace: vi.fn(),
    }),
    getAgentStatusManager: vi.fn().mockReturnValue({
      clearTuiTracking: vi.fn(),
    }),
    unregisterWorkspace: vi.fn(),
  } as unknown as AppState;

  // Register operations
  const emitProgress: DeletionProgressCallback = () => {};
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new DeleteWorkspaceOperation(emitProgress));

  // Delete-workspace resolve modules
  const deleteResolveProjectModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            const projectPath = await resolveProjectPath(payload.projectId, appState);
            return projectPath ? { projectPath } : {};
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
            const found = appState.getProject(projectPath);
            if (!found) return {};
            const workspace = found.workspaces?.find(
              (w: { path: string }) => extractWorkspaceName(w.path) === payload.workspaceName
            );
            return workspace ? { workspacePath: workspace.path } : {};
          },
        },
      },
    },
  };

  // Delete-workspace hook modules (simplified for close-project testing)
  const deleteViewModule: IntentModule = {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<ShutdownHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;
            // Track that skipSwitch is set
            if (!payload.skipSwitch) {
              // Not expected for project:close -- would indicate a bug
              viewManager.setActiveWorkspace(null, false);
            }
            await viewManager.destroyWorkspaceView(payload.workspacePath);
            return {};
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
            const serverManager = appState.getServerManager();
            if (serverManager) {
              await serverManager.stopServer(payload.workspacePath);
            }
            return {};
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

  // ProjectResolveModule: "resolve-project" hook -- resolves projectId to path/config/workspaces
  const projectResolveModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<CloseResolveHookResult> => {
            const intent = ctx.intent as CloseProjectIntent;

            // Resolve using appState (mirrors bootstrap pattern)
            const allProjects = await appState.getAllProjects();
            const found = allProjects.find((p) => p.id === intent.payload.projectId);
            if (!found) {
              throw new Error(`Project not found: ${intent.payload.projectId}`);
            }

            const store = appState.getProjectStore();
            const config = await store.getProjectConfig(found.path);

            return {
              projectPath: found.path,
              workspaces: found.workspaces ?? [],
              ...(config?.remoteUrl !== undefined && { remoteUrl: config.remoteUrl }),
            };
          },
        },
      },
    },
  };

  // ProjectCloseViewModule: "close" hook -- returns otherProjectsExist, clears active workspace if no other projects
  // Note: workspace:switched(null) is emitted by CloseProjectOperation, not here
  const projectCloseViewModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath } = ctx as CloseHookInput;
            const allProjects = await appState.getAllProjects();
            const otherProjectsExist = allProjects.some((p) => p.path !== projectPath);
            if (!otherProjectsExist) {
              viewManager.setActiveWorkspace(null, false);
            }
            return { otherProjectsExist };
          },
        },
      },
    },
  };

  // ProjectLocalCloseModule: "close" hook -- deregister + remove store for local projects
  const projectLocalCloseModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, remoteUrl } = ctx as CloseHookInput;

            // Self-select: only handle local projects (no remoteUrl)
            if (remoteUrl !== undefined) {
              return {};
            }

            appState.deregisterProject(projectPath);

            const store = appState.getProjectStore();
            try {
              await store.removeProject(projectPath);
            } catch {
              // Fail silently
            }

            return {};
          },
        },
      },
    },
  };

  // ProjectRemoteCloseModule: "close" hook -- deregister + remove store for remote projects, optionally delete dir
  const projectRemoteCloseModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, remoteUrl, removeLocalRepo } = ctx as CloseHookInput;

            // Self-select: only handle remote projects (has remoteUrl)
            if (!remoteUrl) {
              return {};
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

            return {};
          },
        },
      },
    },
  };

  // ProjectWorktreeCloseModule: "close" hook -- unregister project from global git provider
  const projectWorktreeCloseModule: IntentModule = {
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath } = ctx as CloseHookInput;
            globalProvider.unregisterProject(new Path(projectPath));
            return {};
          },
        },
      },
    },
  };

  wireModules(
    [
      deleteResolveProjectModule,
      deleteResolveWorkspaceModule,
      deleteViewModule,
      deleteAgentModule,
      deleteStateModule,
      projectResolveModule,
      projectCloseViewModule,
      projectLocalCloseModule,
      projectRemoteCloseModule,
      projectWorktreeCloseModule,
    ],
    hookRegistry,
    dispatcher
  );

  return { dispatcher, state, viewManager };
}

function buildCloseIntent(overrides?: Partial<CloseProjectIntent["payload"]>): CloseProjectIntent {
  return {
    type: INTENT_CLOSE_PROJECT,
    payload: {
      projectId: PROJECT_ID,
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
  });

  it("test 13: close with unknown projectId throws", async () => {
    const harness = createTestHarness({ projectNotFound: true });
    const intent = buildCloseIntent({
      projectId: "nonexistent-12345678" as ProjectId,
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
