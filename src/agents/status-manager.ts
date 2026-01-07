/**
 * Agent Status Manager - aggregates agent status across all workspaces.
 *
 * Currently delegates to OpenCode implementation. When additional agent types
 * are added, this module can provide a generic implementation or factory.
 */

// Re-export from OpenCode implementation
export { AgentStatusManager, type StatusChangedCallback } from "./opencode/status-manager";

// Re-export session types
export type { AgentSessionInfo } from "./types";
