import {
  openDirectory,
  openProject as openProjectBackend,
  discoverWorkspaces,
  closeProject as closeProjectBackend,
  loadPersistedProjects,
} from '$lib/api/tauri';
import {
  addProject,
  removeProject,
  setActiveProject,
  activeWorkspace,
  projects,
} from '$lib/stores/projects';
import type { Project, ProjectHandle } from '$lib/types/project';
import { get } from 'svelte/store';

export async function openNewProject(): Promise<void> {
  try {
    console.log('Opening directory picker...');
    const path = await openDirectory();
    console.log('Selected path:', path);

    if (!path) {
      console.log('User cancelled directory selection');
      return; // User cancelled
    }

    console.log('Opening project:', path);

    // Open the project and get handle
    const handle = await openProjectBackend(path);

    console.log('Project opened with handle:', handle);

    // Discover workspaces (now includes code-server URLs)
    const workspaces = await discoverWorkspaces(handle);

    console.log('Discovered workspaces with code-servers:', workspaces);

    const project: Project = {
      handle,
      path,
      workspaces,
    };

    addProject(project);
    setActiveProject(handle);

    // Auto-select first workspace (main workspace)
    if (workspaces.length > 0) {
      activeWorkspace.set({
        projectHandle: handle,
        workspacePath: workspaces[0].path,
      });
    }

    console.log('Project added to store:', project);
  } catch (error) {
    console.error('Failed to open project:', error);
    alert(`Failed to open project: ${error}`);
  }
}

export async function closeProject(project: Project): Promise<void> {
  try {
    await closeProjectBackend(project.handle);
    removeProject(project.handle);
  } catch (error) {
    console.error('Failed to close project:', error);
    // Remove from UI anyway
    removeProject(project.handle);
  }
}

/**
 * Open a project by path (used for restoring persisted projects)
 */
async function openProjectByPath(path: string): Promise<ProjectHandle> {
  const handle = await openProjectBackend(path);
  const workspaces = await discoverWorkspaces(handle);

  const project: Project = { handle, path, workspaces };
  addProject(project);

  return handle;
}

/**
 * Restore all persisted projects from disk.
 * Called on app startup to restore previously opened projects.
 */
export async function restorePersistedProjects(): Promise<void> {
  try {
    const paths = await loadPersistedProjects();

    let firstHandle: ProjectHandle | null = null;

    for (const path of paths) {
      try {
        const handle = await openProjectByPath(path);
        if (!firstHandle) {
          firstHandle = handle;
        }
      } catch (error) {
        console.warn(`Failed to restore project at ${path}:`, error);
      }
    }

    // Auto-select first project and its first workspace
    if (firstHandle) {
      setActiveProject(firstHandle);

      const allProjects = get(projects);
      const firstProject = allProjects.find((p) => p.handle === firstHandle);
      if (firstProject && firstProject.workspaces.length > 0) {
        activeWorkspace.set({
          projectHandle: firstHandle,
          workspacePath: firstProject.workspaces[0].path,
        });
      }
    }
  } catch (error) {
    console.error('Failed to load persisted projects:', error);
  }
}
