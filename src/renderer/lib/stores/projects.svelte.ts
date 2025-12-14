/**
 * Projects store using Svelte 5 runes.
 * Manages the state of open projects and workspaces.
 */

import type { Project, ProjectPath, Workspace } from "@shared/ipc";

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

const _activeProject = $derived<Project | undefined>(
  _sortedProjects.find((p) => p.workspaces.some((w) => w.path === _activeWorkspacePath))
);

const _flatWorkspaceList = $derived(
  _sortedProjects.flatMap((p) =>
    p.workspaces.map((w) => ({
      projectPath: p.path,
      workspace: w,
    }))
  )
);

// ============ Getters (for reactive access) ============

export const projects = {
  get value() {
    return _sortedProjects;
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

export const flatWorkspaceList = {
  get value() {
    return _flatWorkspaceList;
  },
};

// ============ Actions ============

export function setProjects(newProjects: Project[]): void {
  _projects = newProjects;
}

export function addProject(project: Project): void {
  _projects = [..._projects, project];
}

export function removeProject(path: ProjectPath): void {
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
  projectPath: ProjectPath,
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

export function removeWorkspace(projectPath: ProjectPath, workspacePath: string): void {
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
 * Get workspace by global index (0-based).
 * @returns Workspace at index, or undefined if out of range.
 */
export function getWorkspaceByIndex(index: number): Workspace | undefined {
  return getAllWorkspaces()[index];
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
