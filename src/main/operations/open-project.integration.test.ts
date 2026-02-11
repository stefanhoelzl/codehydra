/**
 * Integration tests for OpenProjectOperation.
 *
 * Tests the full project:open pipeline through dispatcher.dispatch():
 * - Operation orchestrates resolve → discover → register hooks via collect()
 * - Idempotency interceptor prevents duplicate opens
 * - Best-effort handling when individual workspace:create fails
 * - URL detection and clone handling
 *
 * Test plan items covered:
 * #1: Opens local project and activates workspaces
 * #2: Clones remote project then opens
 * #3: Returns existing project if already open (interceptor cancels)
 * #4: Returns existing project if URL already cloned
 * #5: project:opened event emitted after open
 * #6: Continues best-effort when workspace:create fails
 * #7: Rejects invalid git path
 * #8: Rejects invalid clone URL
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import {
  OpenProjectOperation,
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
} from "./open-project";
import type {
  OpenProjectIntent,
  ResolveHookResult,
  DiscoverHookResult,
  RegisterHookInput,
  RegisterHookResult,
  ProjectOpenedEvent,
} from "./open-project";
import type { Intent } from "../intents/infrastructure/types";
import {
  CreateWorkspaceOperation,
  CREATE_WORKSPACE_OPERATION_ID,
  INTENT_CREATE_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
} from "./create-workspace";
import type {
  CreateWorkspaceHookContext,
  CreateWorkspaceIntent,
  WorkspaceCreatedEvent,
} from "./create-workspace";
import type { IViewManager } from "../managers/view-manager.interface";
import type { Project, ProjectId } from "../../shared/api/types";
import { generateProjectId } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";
import { expandGitUrl } from "../../services/project/url-utils";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
} from "./switch-workspace";
import type { SwitchWorkspaceIntent, SwitchWorkspaceHookContext } from "./switch-workspace";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/project";
const PROJECT_ID = generateProjectId(PROJECT_PATH);
const WORKSPACE_A_PATH = "/test/project/workspaces/feature-a";
const WORKSPACE_B_PATH = "/test/project/workspaces/feature-b";
const WORKSPACE_URL = "http://127.0.0.1:8080/?folder=test";

// =============================================================================
// Mock Factories
// =============================================================================

function createTestViewManager(): {
  viewManager: IViewManager;
  activeWorkspace: { path: string | null };
  createdViews: Array<{ path: string; url: string }>;
  preloadedPaths: string[];
} {
  const activeWorkspace = { path: null as string | null };
  const createdViews: Array<{ path: string; url: string }> = [];
  const preloadedPaths: string[] = [];

  const viewManager = {
    getActiveWorkspacePath: vi.fn().mockImplementation(() => activeWorkspace.path),
    setActiveWorkspace: vi.fn().mockImplementation((path: string | null) => {
      activeWorkspace.path = path;
    }),
    destroyWorkspaceView: vi.fn().mockResolvedValue(undefined),
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn().mockImplementation((path: string, url: string) => {
      createdViews.push({ path, url });
    }),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn().mockReturnValue(() => {}),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
    preloadWorkspaceUrl: vi.fn().mockImplementation((path: string) => {
      preloadedPaths.push(path);
    }),
  } as unknown as IViewManager;

  return { viewManager, activeWorkspace, createdViews, preloadedPaths };
}

interface TestProjectState {
  /** Projects registered via registerProject */
  registeredProjects: Array<{
    id: ProjectId;
    name: string;
    path: string;
    workspaces: Array<{ path: string; branch: string | null; metadata: Record<string, string> }>;
    remoteUrl?: string;
  }>;
  /** Workspaces registered via stateModule event handler */
  registeredWorkspaces: Array<{ projectPath: string; workspacePath: string }>;
  /** Whether the project is considered "open" */
  openProjectPaths: Set<string>;
  /** Last base branch cache */
  lastBaseBranches: Map<string, string>;
}

interface TestHarness {
  dispatcher: Dispatcher;
  viewManager: IViewManager;
  activeWorkspace: { path: string | null };
  createdViews: Array<{ path: string; url: string }>;
  preloadedPaths: string[];
  projectState: TestProjectState;
  inProgressOpens: Set<string>;
  /** Mock for provider.discover() */
  discoverResult: Array<{
    name: string;
    path: Path;
    branch: string | null;
    metadata: Readonly<Record<string, string>>;
  }>;
  /** Whether validateRepository should throw */
  validateThrows: boolean;
  /** Mock projectStore state */
  projectStoreState: {
    configs: Map<string, { remoteUrl?: string }>;
    savedProjects: string[];
    findByRemoteUrlResult: string | undefined;
  };
  /** Clone call tracking */
  cloneCalls: Array<{ url: string; path: string }>;
}

function createTestHarness(options?: {
  discoverResult?: TestHarness["discoverResult"];
  validateThrows?: boolean;
  cloneThrows?: boolean;
  findByRemoteUrlResult?: string;
  existingConfig?: { path: string; remoteUrl?: string };
  workspaceCreateThrowsForPath?: string;
}): TestHarness {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const { viewManager, activeWorkspace, createdViews, preloadedPaths } = createTestViewManager();

  const discoverResult: TestHarness["discoverResult"] = options?.discoverResult ?? [
    {
      name: "feature-a",
      path: new Path(WORKSPACE_A_PATH),
      branch: "feature-a",
      metadata: { base: "main" },
    },
    {
      name: "feature-b",
      path: new Path(WORKSPACE_B_PATH),
      branch: "feature-b",
      metadata: { base: "main" },
    },
  ];

  const validateThrows = options?.validateThrows ?? false;

  const projectState: TestProjectState = {
    registeredProjects: [],
    registeredWorkspaces: [],
    openProjectPaths: new Set(),
    lastBaseBranches: new Map(),
  };

  const projectStoreState: TestHarness["projectStoreState"] = {
    configs: new Map(),
    savedProjects: [],
    findByRemoteUrlResult: options?.findByRemoteUrlResult,
  };

  if (options?.existingConfig) {
    projectStoreState.configs.set(options.existingConfig.path, {
      ...(options.existingConfig.remoteUrl !== undefined && {
        remoteUrl: options.existingConfig.remoteUrl,
      }),
    });
  }

  const cloneCalls: Array<{ url: string; path: string }> = [];

  // Mock AppState methods used by hooks
  const appState = {
    isProjectOpen: vi.fn().mockImplementation((path: string) => {
      try {
        return projectState.openProjectPaths.has(new Path(path).toString());
      } catch {
        return false;
      }
    }),
    registerProject: vi.fn().mockImplementation(
      (project: {
        id: ProjectId;
        name: string;
        path: Path;
        workspaces: readonly {
          name: string;
          path: Path;
          branch: string | null;
          metadata: Record<string, string>;
        }[];
        provider: unknown;
        remoteUrl?: string;
      }) => {
        projectState.openProjectPaths.add(project.path.toString());
        projectState.registeredProjects.push({
          id: project.id,
          name: project.name,
          path: project.path.toString(),
          workspaces: project.workspaces.map((w) => ({
            path: w.path.toString(),
            branch: w.branch,
            metadata: w.metadata,
          })),
          ...(project.remoteUrl !== undefined && { remoteUrl: project.remoteUrl }),
        });
      }
    ),
    registerWorkspace: vi.fn().mockImplementation(
      (
        projectPath: string,
        workspace: {
          path: Path;
          branch: string | null;
          metadata: Record<string, string>;
        }
      ) => {
        projectState.registeredWorkspaces.push({
          projectPath,
          workspacePath: workspace.path.toString(),
        });
        // Also add to the project's workspaces (matches real AppState behavior)
        const project = projectState.registeredProjects.find(
          (p) => p.path === new Path(projectPath).toString()
        );
        if (project) {
          project.workspaces.push({
            path: workspace.path.toString(),
            branch: workspace.branch,
            metadata: workspace.metadata,
          });
        }
      }
    ),
    setLastBaseBranch: vi.fn().mockImplementation((path: string, branch: string) => {
      projectState.lastBaseBranches.set(new Path(path).toString(), branch);
    }),
    getDefaultBaseBranch: vi.fn().mockResolvedValue("main"),
    getWorkspaceUrl: vi.fn().mockResolvedValue(WORKSPACE_URL),
    getServerManager: vi.fn().mockReturnValue({
      startServer: vi.fn().mockResolvedValue(9090),
    }),
    getAgentStatusManager: vi.fn().mockReturnValue({
      getProvider: vi.fn().mockReturnValue({
        getEnvironmentVariables: () => ({}),
      }),
    }),
    getAllProjects: vi.fn().mockImplementation(async () => []),
    getProject: vi.fn().mockReturnValue(undefined),
  };

  // Mock projectStore
  const projectStore = {
    getProjectConfig: vi.fn().mockImplementation(async (path: string) => {
      return projectStoreState.configs.get(new Path(path).toString()) ?? undefined;
    }),
    saveProject: vi.fn().mockImplementation(async (path: string) => {
      projectStoreState.savedProjects.push(path);
    }),
    findByRemoteUrl: vi
      .fn()
      .mockImplementation(async () => projectStoreState.findByRemoteUrlResult),
    removeProject: vi.fn().mockResolvedValue(undefined),
    deleteProjectDirectory: vi.fn().mockResolvedValue(undefined),
  };

  const cloneThrows = options?.cloneThrows ?? false;

  // Mock gitClient
  const gitClient = {
    clone: vi.fn().mockImplementation(async (url: string, path: Path) => {
      if (cloneThrows) {
        throw new Error(`Failed to clone: ${url}`);
      }
      cloneCalls.push({ url, path: path.toString() });
    }),
  };

  // Mock globalProvider
  const globalProvider = {
    validateRepository: vi.fn().mockImplementation(async () => {
      if (validateThrows) {
        throw new Error("Not a valid git repository");
      }
    }),
  };

  // Register operations
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
  dispatcher.registerOperation(INTENT_CREATE_WORKSPACE, new CreateWorkspaceOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());

  // Interceptor (inline, matching bootstrap pattern)
  const inProgressOpens = new Set<string>();

  const openIdempotencyModule: IntentModule = {
    interceptors: [
      {
        id: "project-open-idempotency",
        order: 0,
        async before(intent: Intent): Promise<Intent | null> {
          if (intent.type !== INTENT_OPEN_PROJECT) {
            return intent;
          }
          const { path, git } = (intent as OpenProjectIntent).payload;

          // Use expanded URL as key for git (so it matches remoteUrl in cleanup)
          const key = path ? path.toString() : expandGitUrl(git!);

          if (path && projectState.openProjectPaths.has(path.toString())) {
            return null;
          }

          if (inProgressOpens.has(key)) {
            return null;
          }

          inProgressOpens.add(key);
          return intent;
        },
      },
    ],
    events: {
      [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
        const { project } = (event as ProjectOpenedEvent).payload;
        inProgressOpens.delete(project.path);
        if (project.remoteUrl) {
          inProgressOpens.delete(project.remoteUrl);
        }
      },
    },
  };

  // ProjectResolverModule (simplified for tests)
  const projectResolverModule: IntentModule = {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git } = intent.payload;

            let projectPath: Path;
            let remoteUrl: string | undefined;

            if (git) {
              const expanded = expandGitUrl(git);
              const existing = await projectStore.findByRemoteUrl(expanded);
              if (existing) {
                projectPath = new Path(existing);
              } else {
                const gitPath = new Path("/test/cloned", "repo");
                await gitClient.clone(expanded, gitPath);
                await projectStore.saveProject(gitPath.toString(), {
                  remoteUrl: expanded,
                });
                projectStoreState.configs.set(gitPath.toString(), { remoteUrl: expanded });
                projectPath = gitPath;
              }
              remoteUrl = expanded;
            } else {
              projectPath = path!;
            }

            await globalProvider.validateRepository(projectPath);

            return {
              projectPath: projectPath.toString(),
              ...(remoteUrl !== undefined && { remoteUrl }),
            };
          },
        },
      },
    },
  };

  // ProjectDiscoveryModule
  const projectDiscoveryModule: IntentModule = {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        discover: {
          handler: async (): Promise<DiscoverHookResult> => {
            return { workspaces: discoverResult };
          },
        },
      },
    },
  };

  // ProjectRegistryModule
  const projectRegistryModule: IntentModule = {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        register: {
          handler: async (ctx: HookContext): Promise<RegisterHookResult> => {
            const { projectPath: projectPathStr, remoteUrl: resolvedRemoteUrl } =
              ctx as RegisterHookInput;
            const projectPath = new Path(projectPathStr);

            const projectId = generateProjectId(projectPathStr);

            const config = await projectStore.getProjectConfig(projectPathStr);
            let remoteUrl = resolvedRemoteUrl;
            if (config?.remoteUrl) {
              remoteUrl = config.remoteUrl;
            }

            // Create mock provider for AppState registration
            const mockProvider = {
              projectRoot: projectPath,
              discover: vi.fn(),
              listBases: vi.fn(),
              updateBases: vi.fn(),
              createWorkspace: vi.fn(),
              removeWorkspace: vi.fn(),
              isDirty: vi.fn(),
              defaultBase: vi.fn(),
              cleanupOrphanedWorkspaces: vi
                .fn()
                .mockResolvedValue({ removedCount: 0, failedPaths: [] }),
            } as unknown as import("../../services/git/workspace-provider").IWorkspaceProvider;

            appState.registerProject({
              id: projectId,
              name: projectPath.basename,
              path: projectPath,
              workspaces: [],
              provider: mockProvider,
              ...(remoteUrl !== undefined && { remoteUrl }),
            });

            let defaultBaseBranch: string | undefined;
            const baseBranch = await appState.getDefaultBaseBranch(projectPathStr);
            if (baseBranch) {
              appState.setLastBaseBranch(projectPathStr, baseBranch);
              defaultBaseBranch = baseBranch;
            }

            if (!config) {
              await projectStore.saveProject(projectPathStr);
            }

            return {
              projectId,
              ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
              ...(remoteUrl !== undefined && { remoteUrl }),
            };
          },
        },
      },
    },
  };

  // WorktreeModule for workspace:create (handles existingWorkspace)
  const worktreeModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as CreateWorkspaceHookContext;
            const intent = ctx.intent as CreateWorkspaceIntent;

            if (intent.payload.existingWorkspace) {
              const existing = intent.payload.existingWorkspace;

              // Simulate failure for specific workspace
              if (options?.workspaceCreateThrowsForPath === existing.path) {
                throw new Error("Workspace activation failed");
              }

              hookCtx.workspacePath = existing.path;
              hookCtx.branch = existing.branch ?? existing.name;
              hookCtx.metadata = existing.metadata;
              hookCtx.projectPath = intent.payload.projectPath!;
              return;
            }

            throw new Error("Expected existingWorkspace in project:open context");
          },
        },
      },
    },
  };

  // CodeServerModule for workspace:create
  const codeServerModule: IntentModule = {
    hooks: {
      [CREATE_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as CreateWorkspaceHookContext;
            hookCtx.workspaceUrl = WORKSPACE_URL;
          },
        },
      },
    },
  };

  // StateModule for workspace:created
  const stateModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        appState.registerWorkspace(payload.projectPath, {
          path: new Path(payload.workspacePath),
          name: payload.workspaceName,
          branch: payload.branch,
          metadata: payload.metadata,
        });
      },
    },
  };

  // ViewModule for workspace:created
  const viewModule: IntentModule = {
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceCreatedEvent).payload;
        viewManager.createWorkspaceView(
          payload.workspacePath,
          payload.workspaceUrl,
          payload.projectPath,
          true
        );
      },
    },
  };

  // ProjectViewModule for project:opened (preloads non-first workspaces)
  // Note: first workspace activation is now done by OpenProjectOperation dispatching workspace:switch
  const projectViewModule: IntentModule = {
    events: {
      [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
        const payload = (event as ProjectOpenedEvent).payload;
        const workspaces = payload.project.workspaces;
        for (let i = 1; i < workspaces.length; i++) {
          viewManager.preloadWorkspaceUrl(workspaces[i]!.path);
        }
      },
    },
  };

  // SwitchViewModule for workspace:switch (sets active workspace in viewManager)
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext) => {
            const hookCtx = ctx as SwitchWorkspaceHookContext;
            const intent = ctx.intent as SwitchWorkspaceIntent;

            // Simple resolve: find workspace path from registered projects
            const project = projectState.registeredProjects.find(
              (p) => generateProjectId(p.path) === intent.payload.projectId
            );
            if (!project) return;
            const workspace = project.workspaces.find((w) =>
              w.path.endsWith(`/${intent.payload.workspaceName}`)
            );
            if (!workspace) return;

            if (viewManager.getActiveWorkspacePath() === workspace.path) {
              return; // no-op
            }

            const focus = intent.payload.focus ?? true;
            viewManager.setActiveWorkspace(workspace.path, focus);
            hookCtx.resolvedPath = workspace.path;
            hookCtx.projectPath = project.path;
          },
        },
      },
    },
  };

  wireModules(
    [
      openIdempotencyModule,
      projectResolverModule,
      projectDiscoveryModule,
      projectRegistryModule,
      worktreeModule,
      codeServerModule,
      stateModule,
      viewModule,
      projectViewModule,
      switchViewModule,
    ],
    hookRegistry,
    dispatcher
  );

  return {
    dispatcher,
    viewManager,
    activeWorkspace,
    createdViews,
    preloadedPaths,
    projectState,
    inProgressOpens,
    discoverResult,
    validateThrows,
    projectStoreState,
    cloneCalls,
  };
}

function buildOpenIntent(input: { path: Path } | { git: string }): OpenProjectIntent {
  return {
    type: INTENT_OPEN_PROJECT,
    payload: "path" in input ? { path: input.path } : { git: input.git },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenProjectOperation", () => {
  it("test 1: opens local project and activates workspaces", async () => {
    const harness = createTestHarness();
    const intent = buildOpenIntent({ path: new Path(PROJECT_PATH) });

    const result = await harness.dispatcher.dispatch(intent);

    // Returns Project with correct fields
    expect(result).toBeDefined();
    const project = result as Project;
    expect(project.id).toBe(PROJECT_ID);
    expect(project.path).toBe(PROJECT_PATH);
    expect(project.workspaces).toHaveLength(2);

    // Project registered in state
    expect(harness.projectState.registeredProjects).toHaveLength(1);
    expect(harness.projectState.registeredProjects[0]!.id).toBe(PROJECT_ID);

    // Views created for workspaces
    expect(harness.createdViews).toHaveLength(2);

    // First workspace set as active
    expect(harness.activeWorkspace.path).toBe(WORKSPACE_A_PATH);

    // Second workspace preloaded
    expect(harness.preloadedPaths).toContain(WORKSPACE_B_PATH);
  });

  it("test 2: clones remote project then opens", async () => {
    const harness = createTestHarness();
    const intent = buildOpenIntent({ git: "https://github.com/org/repo.git" });

    const result = await harness.dispatcher.dispatch(intent);

    expect(result).toBeDefined();
    const project = result as Project;
    expect(project).toBeDefined();

    // Clone was called
    expect(harness.cloneCalls).toHaveLength(1);
    expect(harness.cloneCalls[0]!.url).toBe("https://github.com/org/repo.git");

    // Project registered
    expect(harness.projectState.registeredProjects).toHaveLength(1);
    expect(harness.projectState.registeredProjects[0]!.remoteUrl).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("test 3: returns undefined if project already open (interceptor cancels)", async () => {
    const harness = createTestHarness();

    // Pre-populate project as open
    harness.projectState.openProjectPaths.add(new Path(PROJECT_PATH).toString());

    const intent = buildOpenIntent({ path: new Path(PROJECT_PATH) });
    const result = await harness.dispatcher.dispatch(intent);

    // Interceptor cancelled
    expect(result).toBeUndefined();

    // No project registered (state unchanged)
    expect(harness.projectState.registeredProjects).toHaveLength(0);
  });

  it("test 4: returns existing project if URL already cloned", async () => {
    const harness = createTestHarness({
      findByRemoteUrlResult: PROJECT_PATH,
    });

    const intent = buildOpenIntent({ git: "https://github.com/org/repo.git" });
    const result = await harness.dispatcher.dispatch(intent);

    expect(result).toBeDefined();

    // No clone call (used existing path)
    expect(harness.cloneCalls).toHaveLength(0);

    // Project opened at existing path
    expect(harness.projectState.registeredProjects).toHaveLength(1);
    expect(harness.projectState.registeredProjects[0]!.path).toBe(PROJECT_PATH);
  });

  it("test 5: project:opened event emitted after open", async () => {
    const harness = createTestHarness();

    const receivedEvents: DomainEvent[] = [];
    harness.dispatcher.subscribe(EVENT_PROJECT_OPENED, (event) => {
      receivedEvents.push(event);
    });

    await harness.dispatcher.dispatch(buildOpenIntent({ path: new Path(PROJECT_PATH) }));

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as ProjectOpenedEvent;
    expect(event.type).toBe(EVENT_PROJECT_OPENED);
    expect(event.payload.project.id).toBe(PROJECT_ID);
    expect(event.payload.project.path).toBe(PROJECT_PATH);
  });

  it("test 6: continues best-effort when workspace:create fails", async () => {
    const harness = createTestHarness({
      workspaceCreateThrowsForPath: WORKSPACE_A_PATH,
    });

    const intent = buildOpenIntent({ path: new Path(PROJECT_PATH) });
    const result = await harness.dispatcher.dispatch(intent);

    // Operation succeeds despite one workspace failure
    expect(result).toBeDefined();
    const project = result as Project;
    expect(project.workspaces).toHaveLength(2); // All discovered, even if creation failed

    // Only one view created (the successful one)
    expect(harness.createdViews).toHaveLength(1);
    expect(harness.createdViews[0]!.path).toBe(WORKSPACE_B_PATH);
  });

  it("test 7: rejects invalid git path", async () => {
    const harness = createTestHarness({ validateThrows: true });

    const intent = buildOpenIntent({ path: new Path("/invalid/path") });

    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow("Not a valid git repository");
  });

  it("test 8: rejects invalid clone URL", async () => {
    const harness = createTestHarness({ cloneThrows: true });
    const intent = buildOpenIntent({ git: "https://invalid-host.example/bad/repo.git" });

    await expect(harness.dispatcher.dispatch(intent)).rejects.toThrow("Failed to clone");
  });
});
