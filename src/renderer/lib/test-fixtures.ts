/**
 * Test fixtures for renderer tests.
 * Re-exports from shared test-fixtures for consistency.
 *
 * Renderer tests can import directly from @shared/test-fixtures or from here.
 */

// Re-export all shared test fixtures
export {
  DEFAULT_PROJECT_ID,
  asProjectId,
  asWorkspaceName,
  asProjectPath,
  asWorkspaceRef,
  createMockWorkspace,
  createMockProject,
  createMockBaseInfo,
  type WorkspaceOverrides,
  type ProjectOverrides,
  type MockProjectOptions,
} from "@shared/test-fixtures";

// Re-export types that renderer tests commonly need
export type { Project, Workspace, BaseInfo, ProjectId, WorkspaceName } from "@shared/api/types";

/**
 * Convenience function to create a project with one default workspace.
 * Equivalent to: createMockProject(overrides, { includeDefaultWorkspace: true })
 *
 * @deprecated Use createMockProject(overrides, { includeDefaultWorkspace: true }) instead.
 */
export { createMockProject as createMockProjectWithId } from "@shared/test-fixtures";
