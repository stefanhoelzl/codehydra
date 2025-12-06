/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */
export type ElectronAPI = Record<string, never>; // Phase 3 will define IPC methods here

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
