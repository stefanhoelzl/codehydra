/**
 * Types for Claude Code integration.
 * Defines hook payloads and status mapping for the Claude Code agent.
 */

import type { AgentStatus } from "../types";

/**
 * All Claude Code hook names.
 * These are the lifecycle events that Claude Code emits.
 */
export type ClaudeCodeHookName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Stop"
  | "SubagentStop"
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "PreCompact";

/**
 * Base hook payload that all hooks include.
 * Claude Code sends this via stdin to the hook command.
 */
export interface ClaudeCodeHookPayload {
  /** Session ID for the current conversation */
  readonly session_id?: string;
  /** Transcript of the conversation (may be present in some hooks) */
  readonly transcript?: unknown;
  /** Tool name for PreToolUse/PostToolUse hooks */
  readonly tool_name?: string;
  /** Tool input for PreToolUse hook */
  readonly tool_input?: unknown;
  /** Tool result for PostToolUse hook */
  readonly tool_result?: unknown;
}

/**
 * Extended payload with workspace path added by hook-handler.
 * This is what the bridge server receives.
 */
export interface ClaudeCodeBridgePayload extends ClaudeCodeHookPayload {
  /** Workspace path (added by hook-handler from environment) */
  readonly workspacePath: string;
}

/**
 * Status change resulting from a hook.
 * null means no status change should occur.
 */
export type HookStatusChange = AgentStatus | null;

/**
 * Mapping from hook name to the status change it causes.
 *
 * Status reflects when user intervention is needed:
 * - none: No session active
 * - idle: Waiting for user (submit prompt, answer permission, etc.)
 * - busy: Agent is working, no action needed
 *
 * Note: PreToolUse is handled specially in server-manager.ts
 * to only transition to busy after a PermissionRequest (flag-based).
 */
export const HOOK_STATUS_MAP: Readonly<Record<ClaudeCodeHookName, HookStatusChange>> = {
  // Session started, waiting for user prompt
  SessionStart: "idle",
  // Session ended
  SessionEnd: "none",
  // User submitted prompt, agent working
  UserPromptSubmit: "busy",
  // Waiting for user to answer permission
  PermissionRequest: "idle",
  // Agent finished working, waiting for next prompt
  Stop: "idle",
  // Subagent done, main agent continues (no change)
  SubagentStop: null,
  // Tool starting - handled specially with flag (see server-manager.ts)
  PreToolUse: null,
  // Tool done, back to busy (handles return from PermissionRequest idle state)
  PostToolUse: "busy",
  // Informational only (no change)
  Notification: null,
  // Informational only (no change)
  PreCompact: null,
};

/**
 * Get the status change for a given hook name.
 * Returns null if the hook doesn't cause a status change.
 */
export function getStatusChangeForHook(hookName: ClaudeCodeHookName): HookStatusChange {
  return HOOK_STATUS_MAP[hookName];
}

/**
 * Check if a string is a valid Claude Code hook name.
 */
export function isValidHookName(name: string): name is ClaudeCodeHookName {
  return name in HOOK_STATUS_MAP;
}
