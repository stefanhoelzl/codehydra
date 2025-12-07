/**
 * Test fixtures for renderer tests.
 * Provides factory functions for creating mock domain objects.
 */

import type { Project, Workspace, BaseInfo, ProjectPath } from "@shared/ipc";

/**
 * Creates a mock Workspace with sensible defaults.
 * @param overrides - Optional properties to override defaults
 */
export function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    path: "/test/project/.worktrees/feature-1",
    name: "feature-1",
    branch: "feature-1",
    ...overrides,
  };
}

/**
 * Creates a mock Project with sensible defaults.
 * Includes one default workspace unless overridden.
 * @param overrides - Optional properties to override defaults
 */
export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    path: "/test/project" as ProjectPath,
    name: "test-project",
    workspaces: [createMockWorkspace()],
    ...overrides,
  };
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
