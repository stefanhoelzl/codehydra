/**
 * Shared test utilities for operation integration tests.
 *
 * Provides a configurable mock IntentModule that handles the common hooks
 * duplicated across operation tests: workspace resolution, project resolution,
 * active workspace queries, and workspace switching.
 *
 * Usage:
 * ```ts
 * const { dispatcher } = createTestSetup();
 * registerTestInfrastructure(dispatcher, {
 *   workspaces: { "/workspaces/feature-x": { projectPath: "/project", workspaceName: "feature-x" as WorkspaceName } },
 *   projects: { "/project": { projectId: "abc" as ProjectId } },
 * });
 * ```
 */

import type { Dispatcher } from "./lib/dispatcher";
import type { IntentModule } from "./lib/module";
import type { HookOutput } from "./lib/operation";
import { defineHooks, type HooksOf, type OperationSchemaMap } from "./declarations";
import type { ProjectId, WorkspaceName, WorkspaceLocator } from "../shared/api/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import { INTENT_UPDATE_AGENT_STATUS } from "./update-agent-status";
import type { UpdateAgentStatusIntent } from "./update-agent-status";
import { ResolveWorkspaceOperation, RESOLVE_WORKSPACE_OPERATION_ID } from "./resolve-workspace";
import type {
  ResolveHookResult as ResolveWorkspaceHookResult,
  ResolveWorkspaceIntent,
  StateHookResult,
} from "./resolve-workspace";
import { ResolveProjectOperation, RESOLVE_PROJECT_OPERATION_ID } from "./resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "./resolve-project";
import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
} from "./get-active-workspace";
import type { GetActiveWorkspaceHookResult } from "./get-active-workspace";
import { SwitchWorkspaceOperation, SWITCH_WORKSPACE_OPERATION_ID } from "./switch-workspace";
import type { SwitchWorkspaceHookResult } from "./switch-workspace";
import type { WorkspacePath, ProjectPath } from "./contract";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";
import type { ProjectRef, WorkspaceRef } from "./contract";
import { workspacePathSchema } from "./contract";
import { parseProjectRef } from "../utils/ref";
import { projectPathSchema } from "./contract";
import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./set-metadata";
import type { SetMetadataIntent } from "./set-metadata";
import { GetMetadataOperation, GET_METADATA_OPERATION_ID } from "./get-metadata";
import type { GetMetadataHookResult } from "./get-metadata";
import { isValidMetadataKey } from "../shared/api/types";
import { Path } from "../utils/path/path";
import { projPath, testPath, workspaceRefIn, wsPath } from "../shared/test-fixtures";

// =============================================================================
// Configuration Types
// =============================================================================

export interface MockWorkspaceEntry {
  readonly projectPath: ProjectPath;
  /** The project's ref; defaults to the checkout ref of `projectPath`. */
  readonly projectRef?: ProjectRef;
  readonly workspaceName: WorkspaceName;
  readonly branch?: string | null;
  /** Explicit active flag; when omitted, derived from the viewManager (if any). */
  readonly active?: boolean;
  /** Raw domain metadata; when omitted, resolve defaults it to empty. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface MockProjectEntry {
  readonly projectId: ProjectId;
  readonly projectName?: string;
  readonly projectRef?: ProjectRef;
}

export interface MockViewManager {
  getActiveWorkspacePath(): string | null;
  setActiveWorkspace(path: string | null, focus?: boolean): void;
}

/**
 * Static map or dynamic lookup function for workspace resolution. A function
 * answers refs too when it can list the paths it knows (`paths`).
 */
export type MockWorkspaceLookup =
  | Readonly<Record<string, MockWorkspaceEntry>>
  | (((workspacePath: WorkspacePath) => MockWorkspaceEntry | undefined) & {
      readonly paths?: () => Iterable<WorkspacePath>;
    });

/**
 * Static map or dynamic lookup function for project resolution. A checkout's
 * ref names its path; a managed project's is found through `paths` and the
 * entry's `projectRef`.
 */
export type MockProjectLookup =
  | Readonly<Record<string, MockProjectEntry>>
  | (((projectPath: ProjectPath) => MockProjectEntry | undefined) & {
      readonly paths?: () => Iterable<ProjectPath>;
    });

export interface TestMockConfig {
  /** Maps workspacePath → resolution data (or dynamic lookup). */
  readonly workspaces?: MockWorkspaceLookup;
  /** Maps projectPath → resolution data (or dynamic lookup). */
  readonly projects?: MockProjectLookup;
  /** Active workspace ref for get-active-workspace. Default: null. */
  readonly activeWorkspaceRef?: WorkspaceLocator | null;
  /** View manager for switch-workspace activate hook. Only wired if provided. */
  readonly viewManager?: MockViewManager;
}

/** Minimal project shape for {@link workspacesFromProjects}. */
export interface ProjectWithWorkspaces {
  readonly path: ProjectPath;
  /** Origin of a managed project, which its ref is named by. */
  readonly remoteUrl?: string;
  readonly workspaces?: ReadonlyArray<{
    readonly path: WorkspacePath;
    readonly metadata?: Readonly<Record<string, string>>;
  }>;
}

/**
 * Workspace lookup that reverse-looks-up the owning project from a live
 * project list. The workspaceName derives from the path basename, matching
 * production resolution.
 */
export function workspacesFromProjects(
  getProjects: () => readonly ProjectWithWorkspaces[]
): MockWorkspaceLookup {
  const lookup = (workspacePath: WorkspacePath): MockWorkspaceEntry | undefined => {
    for (const project of getProjects()) {
      const workspace = project.workspaces?.find((w) => w.path === workspacePath);
      if (workspace) {
        return {
          projectPath: project.path,
          projectRef: projectRefFor(project.path, project.remoteUrl),
          workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
          ...(workspace.metadata !== undefined && { metadata: workspace.metadata }),
        };
      }
    }
    return undefined;
  };
  return Object.assign(lookup, {
    paths: () => getProjects().flatMap((project) => (project.workspaces ?? []).map((w) => w.path)),
  });
}

// =============================================================================
// Intent Builders
// =============================================================================

/** Build an agent:update-status intent. */
export function updateStatusIntent(
  workspaceRef: WorkspaceRef,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: { workspaceRef, status },
  };
}

// =============================================================================
// View Manager Mock
// =============================================================================

/** ViewManager surface used by operation tests, with capture-friendly extras. */
export interface TestViewManager extends MockViewManager {
  destroyWorkspaceView(path: string): Promise<void>;
  createWorkspaceView(path: string, url: string, projectPath: ProjectPath, visible: boolean): void;
  preloadWorkspaceUrl(path: string): void;
}

export interface TestViewManagerHarness {
  readonly viewManager: TestViewManager;
  /** Live active-workspace state; mutate `path` to simulate external changes. */
  readonly activeWorkspace: { path: string | null };
  readonly destroyedViews: string[];
  readonly createdViews: Array<{ path: string; url: string }>;
  readonly preloadedPaths: string[];
  readonly setActiveWorkspaceCalls: Array<{ path: string | null; focus?: boolean }>;
}

/**
 * Stateful ViewManager mock: setActiveWorkspace updates the active path and
 * records the call; destroy/create/preload record their arguments.
 */
export function createTestViewManager(initialActive: string | null = null): TestViewManagerHarness {
  const activeWorkspace = { path: initialActive };
  const destroyedViews: string[] = [];
  const createdViews: Array<{ path: string; url: string }> = [];
  const preloadedPaths: string[] = [];
  const setActiveWorkspaceCalls: Array<{ path: string | null; focus?: boolean }> = [];

  const viewManager: TestViewManager = {
    getActiveWorkspacePath: () => activeWorkspace.path,
    setActiveWorkspace: (path, focus) => {
      activeWorkspace.path = path;
      setActiveWorkspaceCalls.push({ path, ...(focus !== undefined && { focus }) });
    },
    destroyWorkspaceView: async (path) => {
      destroyedViews.push(path);
    },
    createWorkspaceView: (path, url) => {
      createdViews.push({ path, url });
    },
    preloadWorkspaceUrl: (path) => {
      preloadedPaths.push(path);
    },
  };

  return {
    viewManager,
    activeWorkspace,
    destroyedViews,
    createdViews,
    preloadedPaths,
    setActiveWorkspaceCalls,
  };
}

// =============================================================================
// Mock Module Factory
// =============================================================================

/**
 * Creates a single IntentModule with hooks for common infrastructure operations:
 * - resolve-workspace: looks up config.workspaces[workspacePath]
 * - resolve-project: looks up config.projects[projectPath]
 * - get-active-workspace: returns config.activeWorkspaceRef
 * - switch-workspace activate: calls config.viewManager.setActiveWorkspace() (if provided)
 */
export function createTestMockModule(config: TestMockConfig): IntentModule {
  const hooks: { -readonly [Id in keyof OperationSchemaMap]?: HooksOf<Id> } = {};

  // -- resolve-workspace --
  if (config.workspaces) {
    const workspaces = config.workspaces;
    const lookupWorkspace =
      typeof workspaces === "function" ? workspaces : (path: string) => workspaces[path];
    const vm = config.viewManager;
    // A workspace named by its ref is found among the entries by the ref its
    // project and name give. A lookup function answers refs when it lists its paths.
    const projectRefOfEntry = (entry: MockWorkspaceEntry): ProjectRef =>
      entry.projectRef ?? projectRefFor(entry.projectPath);
    const refOf = (entry: MockWorkspaceEntry): WorkspaceRef =>
      makeWorkspaceRef(projectRefOfEntry(entry), entry.workspaceName);
    const knownPaths = (): Iterable<WorkspacePath> =>
      typeof workspaces === "function"
        ? (workspaces.paths?.() ?? [])
        : Object.keys(workspaces).map((path) => workspacePathSchema.parse(path));
    const find = (payload: ResolveWorkspaceIntent["payload"]) => {
      if (payload.workspacePath !== undefined) {
        const entry = lookupWorkspace(payload.workspacePath);
        return entry ? { entry, path: payload.workspacePath } : undefined;
      }
      for (const path of knownPaths()) {
        const entry = lookupWorkspace(path);
        if (entry !== undefined && refOf(entry) === payload.workspaceRef) return { entry, path };
      }
      return undefined;
    };
    hooks[RESOLVE_WORKSPACE_OPERATION_ID] = {
      resolve: {
        handler: async (ctx): Promise<HookOutput<ResolveWorkspaceHookResult>> => {
          const found = find(ctx.intent.payload);
          if (!found) return { result: {} };
          const { entry, path } = found;
          return {
            result: {
              workspaceRef: refOf(entry),
              workspacePath: path,
              projectRef: projectRefOfEntry(entry),
              projectPath: entry.projectPath,
              workspaceName: entry.workspaceName,
              branch: entry.branch ?? null,
              metadata: entry.metadata ?? {},
            },
          };
        },
      },
      state: {
        handler: async (ctx): Promise<HookOutput<StateHookResult>> => {
          const { workspacePath } = ctx;
          const entry = lookupWorkspace(workspacePath);
          return {
            result: {
              active: entry?.active ?? (vm ? vm.getActiveWorkspacePath() === workspacePath : false),
            },
          };
        },
      },
    };
  }

  // -- resolve-project --
  if (config.projects) {
    const projects = config.projects;
    const lookupProject =
      typeof projects === "function" ? projects : (path: string) => projects[path];
    const knownProjectPaths = (): Iterable<ProjectPath> =>
      typeof projects === "function"
        ? (projects.paths?.() ?? [])
        : Object.keys(projects).map((path) => projectPathSchema.parse(path));
    const findProject = (
      projectRef: ProjectRef
    ): { entry: MockProjectEntry; projectPath: ProjectPath } | undefined => {
      // A checkout's ref names its path; anything else is looked for by ref.
      const parts = parseProjectRef(projectRef);
      if (parts?.kind === "checkout") {
        const projectPath = projectPathSchema.parse(parts.project);
        const entry = lookupProject(projectPath);
        if (entry !== undefined && (entry.projectRef ?? projectRef) === projectRef) {
          return { entry, projectPath };
        }
      }
      for (const projectPath of knownProjectPaths()) {
        const entry = lookupProject(projectPath);
        if (entry?.projectRef === projectRef) return { entry, projectPath };
      }
      return undefined;
    };
    hooks[RESOLVE_PROJECT_OPERATION_ID] = {
      resolve: {
        handler: async (ctx): Promise<HookOutput<ResolveProjectHookResult>> => {
          // Test projects are checkouts, so a ref's project part is the path an entry is under.
          const { projectRef } = ctx;
          const found = findProject(projectRef);
          if (found === undefined) return { result: {} };
          const { entry, projectPath } = found;
          const result: ResolveProjectHookResult = { projectId: entry.projectId, projectPath };
          if (entry.projectName !== undefined) {
            return { result: { ...result, projectName: entry.projectName } };
          }
          return { result };
        },
      },
    };
  }

  // -- get-active-workspace --
  // Only wired when explicitly configured, so tests can provide their own
  // dynamic get hook without competing handlers.
  if (config.activeWorkspaceRef !== undefined) {
    const activeRef = config.activeWorkspaceRef;
    hooks[GET_ACTIVE_WORKSPACE_OPERATION_ID] = {
      get: {
        handler: async (): Promise<HookOutput<GetActiveWorkspaceHookResult>> => {
          return { result: { workspaceRef: activeRef } };
        },
      },
    };
  }

  // -- switch-workspace activate --
  if (config.viewManager) {
    const vm = config.viewManager;
    hooks[SWITCH_WORKSPACE_OPERATION_ID] = {
      activate: {
        handler: async (ctx): Promise<HookOutput<SwitchWorkspaceHookResult>> => {
          const { workspaceRef, workspacePath, active } = ctx;
          const intent = ctx.intent;
          // Deselect: mirrors the production view-module null branch.
          if (workspaceRef === null || workspacePath === null) {
            vm.setActiveWorkspace(null);
            return { result: {} };
          }
          if (active) {
            return { result: {} };
          }
          const focus = intent.payload.focus ?? true;
          vm.setActiveWorkspace(workspacePath, focus);
          return { result: { resolvedRef: workspaceRef } };
        },
      },
    };
  }

  return { name: "test-mock", hooks: defineHooks(hooks) };
}

// =============================================================================
// Convenience: Register operations + mock module
// =============================================================================

/**
 * Registers the four shared infrastructure operations on the dispatcher,
 * creates the mock module from config, and registers it.
 *
 * Returns `{ dispatcher, mockModule }` for further customization.
 */
export function registerTestInfrastructure(
  dispatcher: Dispatcher,
  config: TestMockConfig
): { mockModule: IntentModule } {
  dispatcher.registerOperation(new ResolveWorkspaceOperation());
  dispatcher.registerOperation(new ResolveProjectOperation());
  dispatcher.registerOperation(new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(new SwitchWorkspaceOperation());

  const mockModule = createTestMockModule(config);
  dispatcher.registerModule(mockModule);

  return { mockModule };
}

// =============================================================================
// Metadata operations (set-metadata / get-metadata)
// =============================================================================

const METADATA_PROJECT_ROOT = testPath("/project");
const METADATA_WORKSPACES_DIR = testPath("/workspaces");

export interface MetadataTestSetup {
  readonly dispatcher: Dispatcher;
  /** Simple Map-based metadata store: workspacePath → Record<string, string>. */
  readonly metadataStore: Map<string, Record<string, string>>;
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: WorkspacePath;
}

/**
 * A dispatcher with the set-metadata and get-metadata operations, one workspace
 * (`feature-x` of the project at `/project`), and a module serving both
 * operations' hooks from a Map-based metadata store.
 */
export function createMetadataTestSetup(): MetadataTestSetup {
  const workspacePath = new Path(METADATA_WORKSPACES_DIR, "feature-x");
  const projectId = "project-ea0135bc" as ProjectId;
  const workspaceName = "feature-x" as WorkspaceName;

  const metadataStore = new Map<string, Record<string, string>>();

  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new SetMetadataOperation());
  dispatcher.registerOperation(new GetMetadataOperation());

  // Infrastructure operations (resolve-workspace, resolve-project, etc.)
  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [workspacePath.toString()]: {
        projectPath: projPath(METADATA_PROJECT_ROOT.toString()),
        workspaceName,
      },
    },
    projects: {
      [METADATA_PROJECT_ROOT.toString()]: { projectId },
    },
  });

  // set/get module: performs metadata operations using the Map store
  const metadataModule: IntentModule = {
    name: "test-metadata",
    hooks: defineHooks({
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx) => {
            const { workspacePath: wp, intent } = ctx;
            if (!isValidMetadataKey(intent.payload.key)) {
              throw new Error(
                `Invalid metadata key '${intent.payload.key}': must start with a letter, contain only letters, digits, and hyphens, and not end with a hyphen`
              );
            }
            const record = metadataStore.get(wp) ?? {};
            if (intent.payload.value === null) {
              delete record[intent.payload.key];
            } else {
              record[intent.payload.key] = intent.payload.value;
            }
            metadataStore.set(wp, record);
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        get: {
          handler: async (ctx): Promise<HookOutput<GetMetadataHookResult>> => {
            const metadata = metadataStore.get(ctx.workspacePath) ?? {};
            return { result: { metadata } };
          },
        },
      },
    }),
  };
  dispatcher.registerModule(metadataModule);

  return {
    dispatcher,
    metadataStore,
    projectId,
    workspaceName,
    workspacePath: wsPath(workspacePath.toString()),
  };
}

/** The ref of a workspace of the {@link createMetadataTestSetup} project, by its path. */
export function metadataWorkspaceRef(workspacePath: WorkspacePath): WorkspaceRef {
  return workspaceRefIn(
    projPath(METADATA_PROJECT_ROOT.toString()),
    new Path(workspacePath).basename
  );
}

export function setMetadataIntent(
  workspacePath: WorkspacePath,
  key: string,
  value: string | null
): SetMetadataIntent {
  return {
    type: INTENT_SET_METADATA,
    payload: { workspaceRef: metadataWorkspaceRef(workspacePath), key, value },
  };
}
