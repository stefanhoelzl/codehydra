import { writable, derived, get } from 'svelte/store';
import type { Project, ProjectHandle, Workspace } from '$lib/types/project';

export interface ActiveWorkspaceId {
  projectHandle: ProjectHandle;
  workspacePath: string;
}

export const projects = writable<Project[]>([]);
export const activeProjectHandle = writable<ProjectHandle | null>(null);
export const activeWorkspace = writable<ActiveWorkspaceId | null>(null);

export const activeProject = derived(
  [projects, activeProjectHandle],
  ([$projects, $activeProjectHandle]) => $projects.find((p) => p.handle === $activeProjectHandle)
);

export function addProject(project: Project): void {
  projects.update((p) => [...p, project]);
}

export function removeProject(handle: ProjectHandle): void {
  projects.update((p) => p.filter((proj) => proj.handle !== handle));

  const currentActive = get(activeProjectHandle);
  if (currentActive === handle) {
    const remaining = get(projects);
    activeProjectHandle.set(remaining.length > 0 ? remaining[0].handle : null);
  }
}

export function setActiveProject(handle: ProjectHandle): void {
  activeProjectHandle.set(handle);
}

export function setActiveWorkspace(projectHandle: ProjectHandle, workspacePath: string): void {
  activeWorkspace.set({ projectHandle, workspacePath });
}

export function addWorkspaceToProject(handle: ProjectHandle, workspace: Workspace): void {
  projects.update((p) =>
    p.map((proj) =>
      proj.handle === handle ? { ...proj, workspaces: [...proj.workspaces, workspace] } : proj
    )
  );
}
