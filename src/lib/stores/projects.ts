import { writable, derived, get } from 'svelte/store';
import type { Project } from '$lib/types/project';

export const projects = writable<Project[]>([]);
export const activeProjectId = writable<string | null>(null);

export const activeProject = derived([projects, activeProjectId], ([$projects, $activeProjectId]) =>
  $projects.find((p) => p.id === $activeProjectId)
);

export function addProject(project: Project): void {
  projects.update((p) => [...p, project]);
}

export function removeProject(id: string): void {
  projects.update((p) => p.filter((proj) => proj.id !== id));

  const currentActive = get(activeProjectId);
  if (currentActive === id) {
    const remaining = get(projects);
    activeProjectId.set(remaining.length > 0 ? remaining[0].id : null);
  }
}

export function setActiveProject(id: string): void {
  activeProjectId.set(id);
}
