import {
  openDirectory,
  openProject as openProjectBackend,
  discoverWorkspaces,
  closeProject as closeProjectBackend,
  loadPersistedProjects,
  listBranches as listBranchesApi,
  createWorkspace as createWorkspaceApi,
  fetchBranches as fetchBranchesApi,
} from '$lib/api/tauri';
import {
  addProject,
  removeProject,
  setActiveProject,
  activeWorkspace,
  projects,
  addWorkspaceToProject,
} from '$lib/stores/projects';
import type { BranchInfo, Project, ProjectHandle, Workspace } from '$lib/types/project';
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
 * Preserves existing activeWorkspace if one is already set.
 */
export async function restorePersistedProjects(): Promise<void> {
  try {
    // Check if there's already an active workspace before restoration
    const existingActiveWorkspace = get(activeWorkspace);

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

    // Only auto-select if no workspace was active before restoration
    // This preserves the user's selection during hot reloads
    if (existingActiveWorkspace) {
      // Verify the active workspace still exists in the restored projects
      const allProjects = get(projects);
      const activeProject = allProjects.find((p) =>
        p.workspaces.some((w) => w.path === existingActiveWorkspace.workspacePath)
      );

      if (activeProject) {
        // Update the handle in case it changed during re-open
        activeWorkspace.set({
          projectHandle: activeProject.handle,
          workspacePath: existingActiveWorkspace.workspacePath,
        });
        setActiveProject(activeProject.handle);
        return;
      }
      // If the active workspace no longer exists, fall through to default selection
    }

    // Auto-select first project and its first workspace (only when no active workspace)
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

/**
 * List all branches (local and remote) for a project.
 */
export async function listBranches(handle: ProjectHandle): Promise<BranchInfo[]> {
  return await listBranchesApi(handle);
}

/**
 * Fetch branches from all remotes for a project.
 */
export async function fetchBranches(handle: ProjectHandle): Promise<void> {
  return await fetchBranchesApi(handle);
}

/**
 * Create a new workspace (git worktree) for a project.
 * Also adds the workspace to the store and sets it as active.
 */
export async function createNewWorkspace(
  handle: ProjectHandle,
  name: string,
  baseBranch: string
): Promise<Workspace> {
  try {
    const workspace = await createWorkspaceApi(handle, name, baseBranch);

    // Add to store
    addWorkspaceToProject(handle, workspace);

    // Set as active
    activeWorkspace.set({
      projectHandle: handle,
      workspacePath: workspace.path,
    });

    return workspace;
  } catch (error) {
    console.error('Failed to create workspace:', error);
    throw error;
  }
}
