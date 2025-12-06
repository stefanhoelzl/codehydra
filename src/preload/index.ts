import { contextBridge } from "electron";

// TODO: Phase 3 - Add webview-preload.ts for code-server views

contextBridge.exposeInMainWorld("electronAPI", {
  // Phase 3 will add IPC methods here
});
