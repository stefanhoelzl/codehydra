/**
 * Test utilities for CodeHydra API mocking.
 *
 * Provides mock factory for ICodeHydraApi to enable easy unit testing of consumers.
 */

import * as nodePath from "node:path";
import type {
  ICodeHydraApi,
  IProjectApi,
  IWorkspaceApi,
  IUiApi,
  ILifecycleApi,
  ApiEvents,
  Unsubscribe,
} from "../../shared/api/interfaces";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  WorkspaceRemovalResult,
  SetupResult,
  AppState,
} from "../../shared/api/types";

// ============================================================================
// Types for Mock Configuration
// ============================================================================

type EventHandler<T = unknown> = (event: T) => void;

/**
 * Options for mock project API methods.
 */
export interface MockProjectApiOptions {
  /** Return value for list() */
  readonly projects?: readonly Project[];
  /** Function to resolve get() by ID */
  readonly getProject?: (id: ProjectId) => Project | undefined;
  /** Bases to return from fetchBases() */
  readonly bases?: readonly BaseInfo[];
  /** Error to throw from open() */
  readonly openError?: Error;
  /** Error to throw from close() */
  readonly closeError?: Error;
}

/**
 * Options for mock workspace API methods.
 */
export interface MockWorkspaceApiOptions {
  /** Function to resolve get() by project ID and name */
  readonly getWorkspace?: (projectId: ProjectId, name: WorkspaceName) => Workspace | undefined;
  /** Default status to return from getStatus() */
  readonly status?: WorkspaceStatus;
  /** Error to throw from create() */
  readonly createError?: Error;
  /** Error to throw from remove() */
  readonly removeError?: Error;
  /** Default removal result */
  readonly removalResult?: WorkspaceRemovalResult;
}

/**
 * Options for mock UI API methods.
 */
export interface MockUiApiOptions {
  /** Return value for selectFolder() */
  readonly selectedFolder?: string | null;
  /** Return value for getActiveWorkspace() */
  readonly activeWorkspace?: WorkspaceRef | null;
  /** Error to throw from switchWorkspace() */
  readonly switchError?: Error;
}

/**
 * Options for mock lifecycle API methods.
 */
export interface MockLifecycleApiOptions {
  /** Return value for getState() */
  readonly state?: AppState;
  /** Return value for setup() */
  readonly setupResult?: SetupResult;
}

/**
 * Options for creating a mock CodeHydra API.
 */
export interface MockCodeHydraApiOptions {
  /** Mock project API options */
  readonly projects?: MockProjectApiOptions;
  /** Mock workspace API options */
  readonly workspaces?: MockWorkspaceApiOptions;
  /** Mock UI API options */
  readonly ui?: MockUiApiOptions;
  /** Mock lifecycle API options */
  readonly lifecycle?: MockLifecycleApiOptions;
}

// ============================================================================
// Mock API Factory
// ============================================================================

/**
 * Create a mock CodeHydra API for testing.
 *
 * Returns a controllable mock that:
 * - Implements all ICodeHydraApi methods with configurable return values
 * - Provides emit() to trigger events for testing event handlers
 * - Tracks subscriptions for verification
 *
 * @example Basic usage
 * const { api, emit } = createMockCodeHydraApi();
 *
 * @example With custom project list
 * const { api } = createMockCodeHydraApi({
 *   projects: {
 *     projects: [{ id: 'my-app-12345678' as ProjectId, ... }]
 *   }
 * });
 *
 * @example Emit events for testing
 * const { api, emit } = createMockCodeHydraApi();
 * const handler = vi.fn();
 * api.on('project:opened', handler);
 * emit('project:opened', { project: testProject });
 * expect(handler).toHaveBeenCalled();
 */
export function createMockCodeHydraApi(options?: MockCodeHydraApiOptions): {
  api: ICodeHydraApi;
  emit: <E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]) => void;
} {
  const listeners = new Map<string, Set<EventHandler>>();

  // Event system
  const on = <E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(handler as EventHandler);
    return () => {
      listeners.get(event)?.delete(handler as EventHandler);
    };
  };

  const emit = <E extends keyof ApiEvents>(
    event: E,
    payload: Parameters<ApiEvents[E]>[0]
  ): void => {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        (handler as ApiEvents[E])(payload as never);
      } catch {
        // Ignore handler errors in mock
      }
    }
  };

  const dispose = (): void => {
    listeners.clear();
  };

  // Create mock domain APIs
  const projects = createMockProjectApi(options?.projects);
  const workspaces = createMockWorkspaceApi(options?.workspaces);
  const ui = createMockUiApi(options?.ui);
  const lifecycle = createMockLifecycleApi(options?.lifecycle);

  const api: ICodeHydraApi = {
    projects,
    workspaces,
    ui,
    lifecycle,
    on,
    dispose,
  };

  return { api, emit };
}

// ============================================================================
// Domain API Mock Factories
// ============================================================================

function createMockProjectApi(options?: MockProjectApiOptions): IProjectApi {
  const defaultProject: Project = {
    id: "test-project-12345678" as ProjectId,
    name: "test-project",
    path: "/test/project",
    workspaces: [],
  };

  return {
    async open(path: string): Promise<Project> {
      if (options?.openError) {
        throw options.openError;
      }
      return {
        ...defaultProject,
        path,
        name: nodePath.basename(path) || "project",
      };
    },

    async close(projectId: ProjectId): Promise<void> {
      if (options?.closeError) {
        throw options.closeError;
      }
      // Verify project exists if getProject is configured
      if (options?.getProject && !options.getProject(projectId)) {
        throw new Error(`Project not found: ${projectId}`);
      }
    },

    async list(): Promise<readonly Project[]> {
      return options?.projects ?? [];
    },

    async get(projectId: ProjectId): Promise<Project | undefined> {
      if (options?.getProject) {
        return options.getProject(projectId);
      }
      // Fall back to searching the projects list
      return options?.projects?.find((p) => p.id === projectId);
    },

    async fetchBases(): Promise<{ readonly bases: readonly BaseInfo[] }> {
      return { bases: options?.bases ?? [] };
    },
  };
}

function createMockWorkspaceApi(options?: MockWorkspaceApiOptions): IWorkspaceApi {
  const defaultWorkspace: Workspace = {
    projectId: "test-project-12345678" as ProjectId,
    name: "test-workspace" as WorkspaceName,
    branch: "main",
    metadata: { base: "main" },
    path: "/test/workspace",
  };

  const defaultStatus: WorkspaceStatus = {
    isDirty: false,
    agent: { type: "none" },
  };

  const defaultRemovalResult: WorkspaceRemovalResult = {
    branchDeleted: false,
  };

  return {
    async create(projectId: ProjectId, name: string, base: string): Promise<Workspace> {
      if (options?.createError) {
        throw options.createError;
      }
      return {
        projectId,
        name: name as WorkspaceName,
        branch: base,
        metadata: { base },
        path: `/workspaces/${name}`,
      };
    },

    async remove(): Promise<WorkspaceRemovalResult> {
      if (options?.removeError) {
        throw options.removeError;
      }
      return options?.removalResult ?? defaultRemovalResult;
    },

    async get(projectId: ProjectId, workspaceName: WorkspaceName): Promise<Workspace | undefined> {
      if (options?.getWorkspace) {
        return options.getWorkspace(projectId, workspaceName);
      }
      return {
        ...defaultWorkspace,
        projectId,
        name: workspaceName,
        metadata: { base: "main" },
      };
    },

    async getStatus(): Promise<WorkspaceStatus> {
      return options?.status ?? defaultStatus;
    },

    async setMetadata(): Promise<void> {},

    async getMetadata(): Promise<Readonly<Record<string, string>>> {
      return { base: "main" };
    },
  };
}

function createMockUiApi(options?: MockUiApiOptions): IUiApi {
  return {
    async selectFolder(): Promise<string | null> {
      return options?.selectedFolder ?? null;
    },

    async getActiveWorkspace(): Promise<WorkspaceRef | null> {
      return options?.activeWorkspace ?? null;
    },

    async switchWorkspace(): Promise<void> {
      if (options?.switchError) {
        throw options.switchError;
      }
    },

    async setMode(): Promise<void> {
      // No-op in mock
    },
  };
}

function createMockLifecycleApi(options?: MockLifecycleApiOptions): ILifecycleApi {
  return {
    async getState(): Promise<AppState> {
      return options?.state ?? "ready";
    },

    async setup(): Promise<SetupResult> {
      return options?.setupResult ?? { success: true };
    },

    async quit(): Promise<void> {
      // No-op in mock
    },
  };
}

// ============================================================================
// Test Data Factories
// ============================================================================

/**
 * Create a test Project for use in tests.
 *
 * @example
 * const project = createTestProject({ name: 'my-app' });
 */
export function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: "test-project-12345678" as ProjectId,
    name: "test-project",
    path: "/test/project",
    workspaces: [],
    ...overrides,
  };
}

/**
 * Create a test Workspace for use in tests.
 *
 * @example
 * const workspace = createTestWorkspace({ name: 'feature-branch' as WorkspaceName });
 */
export function createTestWorkspace(overrides?: Partial<Workspace>): Workspace {
  return {
    projectId: "test-project-12345678" as ProjectId,
    name: "test-workspace" as WorkspaceName,
    branch: "main",
    metadata: { base: "main" },
    path: "/test/workspace",
    ...overrides,
  };
}

/**
 * Create a test WorkspaceRef for use in tests.
 *
 * @example
 * const ref = createTestWorkspaceRef({ workspaceName: 'feature' as WorkspaceName });
 */
export function createTestWorkspaceRef(overrides?: Partial<WorkspaceRef>): WorkspaceRef {
  return {
    projectId: "test-project-12345678" as ProjectId,
    workspaceName: "test-workspace" as WorkspaceName,
    path: "/test/workspace",
    ...overrides,
  };
}

/**
 * Create a test WorkspaceStatus for use in tests.
 *
 * @example
 * const status = createTestWorkspaceStatus({ isDirty: true });
 */
export function createTestWorkspaceStatus(overrides?: Partial<WorkspaceStatus>): WorkspaceStatus {
  return {
    isDirty: false,
    agent: { type: "none" },
    ...overrides,
  };
}

/**
 * Create a test BaseInfo for use in tests.
 *
 * @example
 * const base = createTestBaseInfo({ name: 'main', isRemote: false });
 */
export function createTestBaseInfo(overrides?: Partial<BaseInfo>): BaseInfo {
  return {
    name: "main",
    isRemote: false,
    ...overrides,
  };
}
