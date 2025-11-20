import {
  openDirectory,
  openProject as openProjectBackend,
  discoverWorkspaces,
  closeProject as closeProjectBackend,
} from '$lib/api/tauri';
import { addProject, removeProject, setActiveProject, activeWorkspace } from '$lib/stores/projects';
import type { Project } from '$lib/types/project';

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
