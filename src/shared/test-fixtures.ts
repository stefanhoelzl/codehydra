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
// Simple Mock Factories (backward-compatible with main process tests)
// =============================================================================

/**
 * Creates a mock Project with simple defaults.
 * For main process tests - empty workspaces array by default.
 * @param overrides - Optional properties to override defaults
 */
export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: DEFAULT_PROJECT_ID,
    name: "test-project",
    path: "/test/path",
    workspaces: [],
    ...overrides,
  };
}

/**
 * Creates a mock Workspace with simple defaults.
 * For main process tests - simple default values.
 * @param overrides - Optional properties to override defaults
 */
export function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    projectId: DEFAULT_PROJECT_ID,
    name: "test-workspace" as WorkspaceName,
    branch: "main",
    metadata: { base: "main" },
    path: "/test/path/test-workspace",
    ...overrides,
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
