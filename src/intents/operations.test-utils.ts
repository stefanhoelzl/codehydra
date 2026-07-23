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
import type { HookContext, HookOutput } from "./lib/operation";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "../shared/api/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import { INTENT_UPDATE_AGENT_STATUS } from "./update-agent-status";
import type { UpdateAgentStatusIntent } from "./update-agent-status";
import { ResolveWorkspaceOperation, RESOLVE_WORKSPACE_OPERATION_ID } from "./resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "./resolve-workspace";
import { ResolveProjectOperation, RESOLVE_PROJECT_OPERATION_ID } from "./resolve-project";
import type {
  ResolveHookResult as ResolveProjectHookResult,
  ResolveHookInput as ResolveProjectHookInput,
} from "./resolve-project";
import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
} from "./get-active-workspace";
import type { GetActiveWorkspaceHookResult } from "./get-active-workspace";
import { SwitchWorkspaceOperation, SWITCH_WORKSPACE_OPERATION_ID } from "./switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
} from "./switch-workspace";
import type { WorkspacePath, ProjectPath } from "./contract";

// =============================================================================
// Configuration Types
// =============================================================================

export interface MockWorkspaceEntry {
  readonly projectPath: ProjectPath;
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
}

export interface MockViewManager {
  getActiveWorkspacePath(): string | null;
  setActiveWorkspace(path: string | null, focus?: boolean): void;
}

/** Static map or dynamic lookup function for workspace resolution. */
export type MockWorkspaceLookup =
  | Readonly<Record<string, MockWorkspaceEntry>>
  | ((workspacePath: WorkspacePath) => MockWorkspaceEntry | undefined);

/** Static map or dynamic lookup function for project resolution. */
export type MockProjectLookup =
  | Readonly<Record<string, MockProjectEntry>>
  | ((projectPath: ProjectPath) => MockProjectEntry | undefined);

export interface TestMockConfig {
  /** Maps workspacePath → resolution data (or dynamic lookup). */
  readonly workspaces?: MockWorkspaceLookup;
  /** Maps projectPath → resolution data (or dynamic lookup). */
  readonly projects?: MockProjectLookup;
  /** Active workspace ref for get-active-workspace. Default: null. */
  readonly activeWorkspaceRef?: WorkspaceRef | null;
  /** View manager for switch-workspace activate hook. Only wired if provided. */
  readonly viewManager?: MockViewManager;
}

/** Minimal project shape for {@link workspacesFromProjects}. */
export interface ProjectWithWorkspaces {
  readonly path: ProjectPath;
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
): (workspacePath: WorkspacePath) => MockWorkspaceEntry | undefined {
  return (workspacePath) => {
    for (const project of getProjects()) {
      const workspace = project.workspaces?.find((w) => w.path === workspacePath);
      if (workspace) {
        return {
          projectPath: project.path,
          workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
          ...(workspace.metadata !== undefined && { metadata: workspace.metadata }),
        };
      }
    }
    return undefined;
  };
}

// =============================================================================
// Intent Builders
// =============================================================================

/** Build an agent:update-status intent. */
export function updateStatusIntent(
  workspacePath: WorkspacePath,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: {
      workspacePath: workspacePath as WorkspacePath,
      status,
    },
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
  const hooks: Record<
    string,
    Record<string, { handler: (ctx: HookContext) => Promise<HookOutput | void> }>
  > = {};

  // -- resolve-workspace --
  if (config.workspaces) {
    const workspaces = config.workspaces;
    const lookupWorkspace =
      typeof workspaces === "function" ? workspaces : (path: string) => workspaces[path];
    const vm = config.viewManager;
    hooks[RESOLVE_WORKSPACE_OPERATION_ID] = {
      resolve: {
        handler: async (ctx: HookContext): Promise<HookOutput<ResolveWorkspaceHookResult>> => {
          const intent = ctx.intent as { payload: { workspacePath: WorkspacePath } };
          const entry = lookupWorkspace(intent.payload.workspacePath);
          if (!entry) return { result: {} };
          return {
            result: {
              ...entry,
              active:
                entry.active ??
                (vm ? vm.getActiveWorkspacePath() === intent.payload.workspacePath : false),
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
    hooks[RESOLVE_PROJECT_OPERATION_ID] = {
      resolve: {
        handler: async (ctx: HookContext): Promise<HookOutput<ResolveProjectHookResult>> => {
          const { projectPath } = ctx as ResolveProjectHookInput;
          const entry = lookupProject(projectPath);
          if (!entry) return { result: {} };
          const result: ResolveProjectHookResult = { projectId: entry.projectId };
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
        handler: async (ctx: HookContext): Promise<HookOutput<SwitchWorkspaceHookResult>> => {
          const { workspacePath, active } = ctx as ActivateHookInput;
          const intent = ctx.intent as SwitchWorkspaceIntent;
          // Deselect: mirrors the production view-module null branch.
          if (workspacePath === null) {
            vm.setActiveWorkspace(null);
            return { result: {} };
          }
          if (active) {
            return { result: {} };
          }
          const focus = intent.payload.focus ?? true;
          vm.setActiveWorkspace(workspacePath, focus);
          return { result: { resolvedPath: workspacePath } };
        },
      },
    };
  }

  return { name: "test-mock", hooks };
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
