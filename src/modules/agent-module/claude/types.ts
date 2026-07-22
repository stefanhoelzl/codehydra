/**
 * Types for Claude Code integration.
 * Defines hook payloads and status mapping for the Claude Code agent.
 */

import type { AgentStatus } from "../types";

/**
 * All Claude Code hook names.
 * These are the lifecycle events that Claude Code emits.
 *
 * WrapperStart/WrapperEnd are CodeHydra-specific hooks sent by the wrapper script
 * before/after spawning the Claude binary. They are not part of Claude's hook system.
 */
export type ClaudeCodeHookName =
  | "WrapperStart"
  | "WrapperEnd"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Stop"
  | "StopFailure"
  | "SubagentStop"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "PreCompact"
  | "SubagentStart"
  | "TeammateIdle"
  | "TaskCompleted";

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
  /** Notification type for Notification hook */
  readonly notification_type?: string;
  /** Sub-agent ID for SubagentStart/SubagentStop hooks */
  readonly agent_id?: string;
  /** Still-running background tasks, sent with Stop/StopFailure hooks */
  readonly background_tasks?: readonly ClaudeCodeBackgroundTask[];
}

/**
 * A background task entry from the Stop payload's background_tasks array.
 * (StopFailure omits background_tasks entirely.) Shape verified against Claude
 * Code 2.1.202:
 * - shell:    `{id, type: "shell", status: "running", description, command}`
 * - subagent: `{id, type: "subagent", status: "running", description, agent_type}`
 * All fields optional — the payload is external input.
 */
export interface ClaudeCodeBackgroundTask {
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly description?: string;
  readonly command?: string;
  readonly agent_type?: string;
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
 * Note: PreToolUse is handled specially in server-manager.ts — a tool starting
 * while the workspace reads idle transitions it to busy (covers permission
 * resolution and bash-mode "!cmd" turns that never emit UserPromptSubmit).
 */
const HOOK_STATUS_MAP: Readonly<Record<ClaudeCodeHookName, HookStatusChange>> = {
  // Wrapper started, Claude about to be spawned
  WrapperStart: "idle",
  // Wrapper exited, Claude has closed
  WrapperEnd: "none",
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
  // Agent stopped due to API error (rate limit, auth failure), waiting for retry
  StopFailure: "idle",
  // Subagent done, main agent continues (no change)
  SubagentStop: null,
  // Tool starting - handled specially: busy if workspace was idle (see server-manager.ts)
  PreToolUse: null,
  // Tool done, back to busy (handles return from PermissionRequest idle state)
  PostToolUse: "busy",
  // Tool failed, logged for analysis (no change)
  PostToolUseFailure: null,
  // Informational only (no change)
  Notification: null,
  // Compacting context, agent working
  PreCompact: "busy",
  // Subagent spawned, logged for analysis (no change)
  SubagentStart: null,
  // Agent team teammate going idle, logged for analysis (no change)
  TeammateIdle: null,
  // Task marked completed, logged for analysis (no change)
  TaskCompleted: null,
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

/**
 * Detect the `ch-bg` background-wrapper marker in a shell command.
 *
 * `ch-bg` is a passthrough wrapper CodeHydra ships onto the agent's PATH. A
 * background shell invoked through it (`ch-bg npm run dev`) carries the marker
 * in the command string Claude Code reports, which excludes it from keeping the
 * workspace busy. The match is a word boundary so it fires for `ch-bg foo`,
 * `bash -c "ch-bg foo"`, and `/path/to/ch-bg foo`, but not `xch-bg`/`ch-bgx`.
 */
export function isBackgroundWrapped(command: string): boolean {
  return /\bch-bg\b/.test(command);
}

/**
 * Decide whether a running background task keeps the workspace busy.
 *
 * A background sub-agent (type "subagent") is unambiguous agent work and always
 * keeps the workspace busy. A background shell (type "shell") keeps it busy by
 * default — the exception is a shell invoked through the `ch-bg` wrapper, which
 * opts out (see isBackgroundWrapped). Non-running tasks and other types never
 * qualify.
 */
export function taskKeepsBusy(task: ClaudeCodeBackgroundTask): boolean {
  if (task.status !== undefined && task.status !== "running") {
    return false;
  }
  if (task.type === "subagent") {
    return true;
  }
  if (task.type !== "shell") {
    return false;
  }
  return !isBackgroundWrapped(task.command ?? "");
}

/**
 * Wrapper-synthesized hooks. These are NOT POSTed over HTTP anymore — they are
 * triggered internally via ClaudeCodeServerManager.triggerWrapperLifecycle()
 * (driven by the sidekick's agent:lifecycle event). The bridge HTTP server
 * rejects them so a stray POST can't drive status out-of-band.
 */
export const WRAPPER_HOOK_NAMES: ReadonlySet<ClaudeCodeHookName> = new Set([
  "WrapperStart",
  "WrapperEnd",
]);
