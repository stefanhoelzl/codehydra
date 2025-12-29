/**
 * Projects store using Svelte 5 runes.
 * Manages the state of open projects and workspaces.
 *
 * Uses v2 API types where projects and workspaces include IDs from the main process.
 * IDs are NOT generated client-side - they come from API responses.
 *
 * ## Path Handling
 *
 * All paths in this store are **normalized strings** from the main process:
 * - POSIX separators (forward slashes) on all platforms
 * - Lowercase on Windows (case-insensitive filesystem)
 * - No trailing slashes
 *
 * Path comparison in the renderer is safe using `===` since paths are pre-normalized.
 * The Path class is NOT used in the renderer - all normalization happens in main process.
 *
 * Example: `workspace.path === _activeWorkspacePath` works correctly on all platforms.
 */

import type { Project, Workspace, ProjectId, WorkspaceName, WorkspaceRef } from "@shared/api/types";

// ============ State ============

let _projects = $state<Project[]>([]);
let _activeWorkspacePath = $state<string | null>(null);
let _loadingState = $state<"loading" | "loaded" | "error">("loading");
let _loadingError = $state<string | null>(null);

// ============ Derived ============

/**
 * Projects sorted alphabetically (AaBbCc ordering) with their workspaces also sorted.
 * This is the canonical order used for display and navigation.
 */
const _sortedProjects = $derived(
  [...(_projects ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { caseFirst: "upper" }))
    .map((p) => ({
      ...p,
      workspaces: [...p.workspaces].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { caseFirst: "upper" })
      ),
    }))
);

/**
 * Projects with IDs (v2 API projects already include IDs).
 * This is an alias for sorted projects since they already have IDs from the API.
 */
const _projectsWithIds = $derived(_sortedProjects);

/**
 * Active project with ID.
 */
const _activeProject = $derived<ProjectWithId | undefined>(
  _projectsWithIds.find((p) => p.workspaces.some((w) => w.path === _activeWorkspacePath))
);

/**
 * Active workspace as WorkspaceRef (includes projectId).
 * Returns null if no active workspace.
 */
const _activeWorkspace = $derived.by((): WorkspaceRef | null => {
  if (!_activeWorkspacePath) return null;

  // Find the project and workspace
  for (const project of _projectsWithIds) {
    const workspace = project.workspaces.find((w) => w.path === _activeWorkspacePath);
    if (workspace) {
      return {
        projectId: project.id,
        workspaceName: workspace.name as WorkspaceName,
        path: workspace.path,
      };
    }
  }
  return null;
});

// ============ Getters (for reactive access) ============

export const projects = {
  get value() {
    return _projectsWithIds;
  },
};

export const activeWorkspacePath = {
  get value() {
    return _activeWorkspacePath;
  },
};

export const loadingState = {
  get value() {
    return _loadingState;
  },
};

export const loadingError = {
  get value() {
    return _loadingError;
  },
};

export const activeProject = {
  get value() {
    return _activeProject;
  },
};

/**
 * Active workspace as WorkspaceRef (v2 API).
 */
export const activeWorkspace = {
  get value() {
    return _activeWorkspace;
  },
};

// ============ Actions ============

export function setProjects(newProjects: Project[]): void {
  _projects = newProjects;
}

export function addProject(project: Project): void {
  _projects = [..._projects, project];
}

export function removeProject(path: string): void {
  const removedProject = _projects.find((p) => p.path === path);
  _projects = _projects.filter((p) => p.path !== path);

  // Update active if removed project contained active workspace
  if (removedProject?.workspaces.some((w) => w.path === _activeWorkspacePath)) {
    _activeWorkspacePath = _projects[0]?.workspaces[0]?.path ?? null;
  }
}

export function setActiveWorkspace(path: string | null): void {
  _activeWorkspacePath = path;
}

export function setLoaded(): void {
  _loadingState = "loaded";
}

export function setError(message: string): void {
  _loadingState = "error";
  _loadingError = message;
}

export function addWorkspace(
  projectPath: string,
  workspace: Workspace,
  defaultBaseBranch?: string
): void {
  _projects = _projects.map((p) =>
    p.path === projectPath
      ? {
          ...p,
          workspaces: [...p.workspaces, workspace],
          // Update defaultBaseBranch if provided (remembers last-used branch for next workspace creation)
          ...(defaultBaseBranch !== undefined ? { defaultBaseBranch } : {}),
        }
      : p
  );
}

export function removeWorkspace(projectPath: string, workspacePath: string): void {
  _projects = _projects.map((p) =>
    p.path === projectPath
      ? { ...p, workspaces: p.workspaces.filter((w) => w.path !== workspacePath) }
      : p
  );
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _projects = [];
  _activeWorkspacePath = null;
  _loadingState = "loading";
  _loadingError = null;
}

// ============ Helper Functions ============

/**
 * Get flat array of all workspaces across all projects.
 * Order: alphabetical by project name, then alphabetical by workspace name.
 */
export function getAllWorkspaces(): Workspace[] {
  return projects.value.flatMap((p) => p.workspaces);
}

/**
 * Get WorkspaceRef by global index (0-based).
 * Includes projectId and workspaceName for v2 API calls.
 * @returns WorkspaceRef at index, or undefined if out of range.
 */
export function getWorkspaceRefByIndex(index: number): WorkspaceRef | undefined {
  let currentIndex = 0;
  for (const project of projects.value) {
    for (const workspace of project.workspaces) {
      if (currentIndex === index) {
        return {
          projectId: project.id,
          workspaceName: workspace.name as WorkspaceName,
          path: workspace.path,
        };
      }
      currentIndex++;
    }
  }
  return undefined;
}

/**
 * Find the index of a workspace by its path.
 * @returns 0-based index, or -1 if not found.
 */
export function findWorkspaceIndex(path: string | null): number {
  if (!path) return -1;
  return getAllWorkspaces().findIndex((w) => w.path === path);
}

/**
 * Wrap an index to stay within bounds (for circular navigation).
 */
export function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

// =============================================================================
// v2 API Functions
// =============================================================================

/**
 * Project type alias for compatibility.
 * v2 API projects already include IDs, so this is just an alias.
 */
export type ProjectWithId = Project;

/**
 * Get a project by its ID.
 * @param id - The project ID to look up
 * @returns The project if found, undefined otherwise
 */
export function getProjectById(id: ProjectId): ProjectWithId | undefined {
  return _projectsWithIds.find((p) => p.id === id);
}
