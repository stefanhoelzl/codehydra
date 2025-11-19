import { openDirectory, startCodeServer, stopCodeServer } from '$lib/api/tauri';
import { addProject, removeProject, setActiveProject } from '$lib/stores/projects';
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
    
    const name = path.split('/').pop() || 'Project';
    const id = crypto.randomUUID();
    
    console.log('Starting code-server for:', path);
    
    // Start code-server (may take a few seconds)
    const info = await startCodeServer(path);
    
    console.log('Code-server started:', info);
    
    const project: Project = {
      id,
      name,
      path,
      port: info.port,
      url: info.url
    };
    
    addProject(project);
    setActiveProject(id);
    
    console.log('Project added to store:', project);
  } catch (error) {
    console.error('Failed to open project:', error);
    alert(`Failed to open project: ${error}`);
  }
}

export async function closeProject(project: Project): Promise<void> {
  try {
    await stopCodeServer(project.port);
    removeProject(project.id);
  } catch (error) {
    console.error('Failed to close project:', error);
    // Remove from UI anyway
    removeProject(project.id);
  }
}
