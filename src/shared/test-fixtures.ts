/**
 * Shared test fixtures for creating mock domain objects.
 * Used by both main process and renderer test utilities.
 *
 * Uses v2 API types (Project with id, Workspace with projectId).
 */

import type {
  Project,
  Workspace,
  BaseInfo,
  ProjectId,
  WorkspaceName,
  WorkspaceRef,
  WorkspaceStatus,
} from "./api/types";
import type { ProjectPath } from "./ipc";

/**
 * Default project ID used in test fixtures.
 */
export const DEFAULT_PROJECT_ID = "test-project-12345678" as ProjectId;

// =============================================================================
// Type Cast Helpers
// =============================================================================

/**
 * Cast a string to ProjectId.
 * Use in tests when you need to create a typed project ID from a plain string.
 */
export function asProjectId(id: string): ProjectId {
  return id as ProjectId;
}

/**
 * Cast a string to WorkspaceName.
 * Use in tests when you need to create a typed workspace name from a plain string.
 */
export function asWorkspaceName(name: string): WorkspaceName {
  return name as WorkspaceName;
}

/**
 * Cast a string to ProjectPath.
 * Use in tests when you need to create a typed project path from a plain string.
 */
export function asProjectPath(path: string): ProjectPath {
  return path as ProjectPath;
}

/**
 * Create a WorkspaceRef from plain strings.
 * Use in tests when you need a typed workspace reference.
 */
export function asWorkspaceRef(
  projectId: string,
  workspaceName: string,
  path: string
): WorkspaceRef {
  return {
    projectId: asProjectId(projectId),
    workspaceName: asWorkspaceName(workspaceName),
    path,
  };
}

// =============================================================================
// Workspace Mock Factory
// =============================================================================

/**
 * Partial workspace override that accepts plain strings for convenience in tests.
 * branch can be explicitly set to null (detached HEAD state).
 */
export type WorkspaceOverrides = Partial<
  Omit<Workspace, "name" | "projectId" | "branch" | "metadata">
> & {
  name?: string;
  projectId?: ProjectId;
  branch?: string | null;
  metadata?: Record<string, string>;
};

/**
 * Creates a mock Workspace with sensible defaults.
 * Uses v2 API types (includes projectId).
 *
 * Default workspace simulates a git worktree at /test/project/.worktrees/feature-1
 *
 * @param overrides - Optional properties to override defaults (accepts plain strings for name)
 */
export function createMockWorkspace(overrides: WorkspaceOverrides = {}): Workspace {
  const name = overrides.name ?? "feature-1";
  // Use "in" check to allow explicit null for branch (detached HEAD)
  const branch = "branch" in overrides ? overrides.branch : name;

  return {
    projectId: overrides.projectId ?? DEFAULT_PROJECT_ID,
    name: name as WorkspaceName,
    branch,
    metadata: { base: branch ?? "main", ...overrides.metadata },
    path: overrides.path ?? `/test/project/.worktrees/${name}`,
  };
}

// =============================================================================
// Project Mock Factory
// =============================================================================

/**
 * Options for creating a mock project.
 */
export interface MockProjectOptions {
  /**
   * If true, include a default workspace in the project.
   * Defaults to false for backward compatibility with main process tests.
   */
  includeDefaultWorkspace?: boolean;
}

/**
 * Partial project override that accepts looser types for convenience in tests.
 */
export type ProjectOverrides = Partial<Omit<Project, "workspaces">> & {
  workspaces?: WorkspaceOverrides[] | readonly Workspace[];
};

/**
 * Creates a mock Project with sensible defaults.
 * Uses v2 API types (Project with id).
 *
 * Default project simulates a git repository at /test/project with one workspace.
 * Set `options.includeDefaultWorkspace = false` (or pass `workspaces: []`) to exclude workspaces.
 *
 * @param overrides - Optional properties to override defaults
 * @param options - Options for project creation
 */
export function createMockProject(
  overrides: ProjectOverrides = {},
  options: MockProjectOptions = {}
): Project {
  const projectId = overrides.id ?? DEFAULT_PROJECT_ID;
  // Default to including a workspace (matches renderer test expectations)
  const { includeDefaultWorkspace = true } = options;

  // Convert workspace overrides to Workspace objects
  let workspaces: readonly Workspace[];
  if (overrides.workspaces) {
    workspaces = overrides.workspaces.map((w) => {
      // Check if it's already a Workspace (has projectId as branded type)
      if ("projectId" in w && typeof w.projectId === "string" && w.projectId.includes("-")) {
        return w as Workspace;
      }
      // Otherwise treat as WorkspaceOverrides
      return createMockWorkspace({ ...w, projectId });
    });
  } else if (includeDefaultWorkspace) {
    workspaces = [createMockWorkspace({ projectId })];
  } else {
    workspaces = [];
  }

  return {
    id: projectId,
    name: overrides.name ?? "test-project",
    path: overrides.path ?? "/test/project",
    workspaces,
    ...(overrides.defaultBaseBranch !== undefined
      ? { defaultBaseBranch: overrides.defaultBaseBranch }
      : {}),
  };
}

// =============================================================================
// Other Mock Factories
// =============================================================================

/**
 * Creates a mock BaseInfo with sensible defaults.
 * @param overrides - Optional properties to override defaults
 */
export function createMockBaseInfo(overrides: Partial<BaseInfo> = {}): BaseInfo {
  return {
    name: "main",
    isRemote: false,
    ...overrides,
  };
}

// =============================================================================
// API Mock Factory Defaults
// Note: These are used by test-utils files that create mock APIs.
// =============================================================================

/**
 * Default values for mock workspace API responses.
 * Use these when creating mock workspace APIs in test files.
 */
export const MOCK_WORKSPACE_API_DEFAULTS = {
  workspace: {
    name: "test" as WorkspaceName,
    path: "/path",
    branch: "main",
    metadata: { base: "main" },
    projectId: DEFAULT_PROJECT_ID,
  } as Workspace,

  status: {
    isDirty: false,
    agent: { type: "none" },
  } as WorkspaceStatus,

  removeResult: { started: true } as const,

  metadata: { base: "main" } as Readonly<Record<string, string>>,
};
