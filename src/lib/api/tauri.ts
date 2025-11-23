import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  BranchInfo,
  CodeServerInfo,
  ProjectHandle,
  RemovalResult,
  Workspace,
  WorkspaceStatus,
} from '$lib/types/project';
import type { SetupEvent } from '$lib/types/setup';

export async function openDirectory(): Promise<string | null> {
  return await invoke<string | null>('open_directory');
}

/**
 * Ensure the code-server is running and return its port.
 * This starts a single global code-server instance if not already running.
 */
export async function ensureCodeServerRunning(): Promise<number> {
  return await invoke<number>('ensure_code_server_running');
}

/**
 * Get the URL to open a folder in code-server.
 * Returns null if the code-server is not running.
 */
export async function getWorkspaceUrl(folderPath: string): Promise<string | null> {
  return await invoke<string | null>('get_workspace_url', { folderPath });
}

/**
 * Stop the code-server instance.
 */
export async function stopCodeServer(): Promise<void> {
  return await invoke('stop_code_server');
}

/**
 * Check if the code-server is currently running.
 */
export async function isCodeServerRunning(): Promise<boolean> {
  return await invoke<boolean>('is_code_server_running');
}

export async function openProject(path: string): Promise<ProjectHandle> {
  return await invoke<ProjectHandle>('open_project', { path });
}

export async function discoverWorkspaces(handle: ProjectHandle): Promise<Workspace[]> {
  return await invoke<Workspace[]>('discover_workspaces', { handle });
}

export async function closeProject(handle: ProjectHandle): Promise<void> {
  await invoke('close_project', { handle });
}

/**
 * List all branches (local and remote) for a project.
 */
export async function listBranches(handle: ProjectHandle): Promise<BranchInfo[]> {
  return await invoke<BranchInfo[]>('list_branches', { handle });
}

/**
 * Create a new workspace (git worktree) for a project.
 */
export async function createWorkspace(
  handle: ProjectHandle,
  name: string,
  baseBranch: string
): Promise<Workspace> {
  return await invoke<Workspace>('create_workspace', { handle, name, baseBranch });
}

/**
 * Fetch branches from all remotes for a project.
 */
export async function fetchBranches(handle: ProjectHandle): Promise<void> {
  return await invoke('fetch_branches', { handle });
}

/**
 * Check if the runtime (Bun, code-server, extensions) is ready.
 * @returns true if all components are installed, false otherwise
 */
export async function checkRuntimeReady(): Promise<boolean> {
  return invoke<boolean>('check_runtime_ready');
}

/**
 * Load all persisted project paths from disk.
 * Returns paths that still exist on disk.
 */
export async function loadPersistedProjects(): Promise<string[]> {
  return invoke<string[]>('load_persisted_projects');
}

/**
 * Start the runtime setup process.
 * This downloads Bun, installs code-server, and installs extensions.
 * Listen to 'setup-progress' events for progress updates.
 */
export async function setupRuntime(): Promise<void> {
  return invoke('setup_runtime');
}

/**
 * Listen for setup progress events.
 * @param callback Function to call when a setup event is received
 * @returns A function to stop listening
 */
export function listenSetupProgress(callback: (event: SetupEvent) => void): Promise<UnlistenFn> {
  return listen<SetupEvent>('setup-progress', (event) => {
    callback(event.payload);
  });
}

/**
 * Check workspace status (uncommitted changes, is main worktree).
 */
export async function checkWorkspaceStatus(
  handle: ProjectHandle,
  workspacePath: string
): Promise<WorkspaceStatus> {
  return await invoke<WorkspaceStatus>('check_workspace_status', { handle, workspacePath });
}

/**
 * Remove a workspace (git worktree).
 * @param handle - Project handle
 * @param workspacePath - Path to the workspace to remove
 * @param deleteBranch - If true, also deletes the associated branch
 */
export async function removeWorkspace(
  handle: ProjectHandle,
  workspacePath: string,
  deleteBranch: boolean
): Promise<RemovalResult> {
  return await invoke<RemovalResult>('remove_workspace', { handle, workspacePath, deleteBranch });
}

// --- Deprecated functions for backward compatibility ---
// These are kept for existing code but should be migrated to the new API

/**
 * @deprecated Use ensureCodeServerRunning() and getWorkspaceUrl() instead
 */
export async function startCodeServer(projectPath: string): Promise<CodeServerInfo> {
  const port = await ensureCodeServerRunning();
  const url = await getWorkspaceUrl(projectPath);
  return {
    port,
    url: url ?? `http://localhost:${port}/?folder=${encodeURIComponent(projectPath)}`,
  };
}

/**
 * @deprecated The code-server is now a single global instance.
 * Use stopCodeServer() to stop it completely.
 */
export async function cleanupAllServers(): Promise<void> {
  return await stopCodeServer();
}
