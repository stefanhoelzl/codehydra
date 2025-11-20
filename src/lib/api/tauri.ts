import { invoke } from '@tauri-apps/api/core';
import type { CodeServerInfo, ProjectHandle, Workspace } from '$lib/types/project';

export async function openDirectory(): Promise<string | null> {
  return await invoke<string | null>('open_directory');
}

export async function startCodeServer(projectPath: string): Promise<CodeServerInfo> {
  return await invoke<CodeServerInfo>('start_code_server', { projectPath });
}

export async function stopCodeServer(port: number): Promise<void> {
  return await invoke('stop_code_server', { port });
}

export async function cleanupAllServers(): Promise<void> {
  return await invoke('cleanup_all_servers');
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
