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

const _activeProject = $derived<Project | undefined>(
  _projects.find((p) => p.workspaces.some((w) => w.path === _activeWorkspacePath))
);

const _flatWorkspaceList = $derived(
  _projects.flatMap((p) =>
    p.workspaces.map((w) => ({
      projectPath: p.path,
      workspace: w,
    }))
  )
);

// ============ Getters (for reactive access) ============

export const projects = {
  get value() {
    return _projects;
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

export function addWorkspace(projectPath: ProjectPath, workspace: Workspace): void {
  _projects = _projects.map((p) =>
    p.path === projectPath ? { ...p, workspaces: [...p.workspaces, workspace] } : p
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
