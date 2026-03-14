/**
 * OpenCode integration services.
 * Public API for the opencode module.
 */

export { OpenCodeClient, type SessionEventCallback } from "./client";
export { OpenCodeServerManager } from "./server-manager";

// Re-export types
export type { Result, SessionStatus, IDisposable, Unsubscribe } from "./types";
