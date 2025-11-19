import { invoke } from '@tauri-apps/api/core';
import type { CodeServerInfo } from '$lib/types/project';

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
