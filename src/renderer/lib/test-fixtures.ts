/**
 * Test fixtures for renderer tests.
 * Provides factory functions for creating mock domain objects.
 *
 * Uses v2 API types (Project with id, Workspace with projectId).
 */

import type {
  Project,
  Workspace,
  BaseInfo,
  ProjectId,
  WorkspaceName,
  SetupProgress,
} from "@shared/api/types";

/**
 * Default project ID used in test fixtures.
 */
const DEFAULT_PROJECT_ID = "test-project-12345678" as ProjectId;

/**
 * Partial workspace override that accepts plain strings for convenience in tests.
 * branch can be explicitly set to null (detached HEAD state).
 */
type WorkspaceOverrides = Partial<Omit<Workspace, "name" | "projectId" | "branch">> & {
  name?: string;
  projectId?: ProjectId;
  branch?: string | null;
};

/**
 * Creates a mock Workspace with sensible defaults.
 * Uses v2 API types (includes projectId).
 * @param overrides - Optional properties to override defaults (accepts plain strings for name)
 */
export function createMockWorkspace(overrides: WorkspaceOverrides = {}): Workspace {
  const branch = "branch" in overrides ? overrides.branch : "feature-1";
  return {
    projectId: overrides.projectId ?? DEFAULT_PROJECT_ID,
    path: overrides.path ?? "/test/project/.worktrees/feature-1",
    name: (overrides.name ?? "feature-1") as WorkspaceName,
    // Use "in" check to allow explicit null for branch (detached HEAD)
    branch,
    baseBranch: overrides.baseBranch ?? branch ?? "main",
  };
}

/**
 * Partial project override that accepts looser types for convenience in tests.
 */
type ProjectOverrides = Partial<Omit<Project, "workspaces">> & {
  workspaces?: WorkspaceOverrides[] | readonly Workspace[];
};

/**
 * Creates a mock Project with sensible defaults (v2 API format with ID).
 * Includes one default workspace unless overridden.
 * @param overrides - Optional properties to override defaults
 */
export function createMockProject(overrides: ProjectOverrides = {}): Project {
  const projectId = overrides.id ?? DEFAULT_PROJECT_ID;

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
  } else {
    workspaces = [createMockWorkspace({ projectId })];
  }

  return {
    id: projectId,
    path: overrides.path ?? "/test/project",
    name: overrides.name ?? "test-project",
    workspaces,
    ...(overrides.defaultBaseBranch !== undefined
      ? { defaultBaseBranch: overrides.defaultBaseBranch }
      : {}),
  };
}

/**
 * Creates a mock ProjectWithId (alias for createMockProject).
 * @deprecated Use createMockProject instead - v2 Projects always have IDs.
 * @param overrides - Optional properties to override defaults
 */
export function createMockProjectWithId(overrides: Partial<Project> = {}): Project {
  return createMockProject(overrides);
}

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

/**
 * Creates a mock SetupProgress event.
 * @param step - The setup step name
 * @param message - The progress message
 */
export function createMockSetupProgress(
  step: SetupProgress["step"],
  message: string
): SetupProgress {
  return { step, message };
}
