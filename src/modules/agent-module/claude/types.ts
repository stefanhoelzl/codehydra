/**
 * Types for Claude Code integration.
 * Defines hook payloads and status mapping for the Claude Code agent.
 */

import {
  storeCustom,
  type PersistedTypeBuilder,
} from "../../../boundaries/platform/store-definition";
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
 * A background task entry from the Stop/StopFailure payload's background_tasks
 * array. Shape verified against Claude Code 2.1.170:
 * `{id, type: "shell", status: "running", description, command}`.
 * All fields optional — the payload is external input.
 */
export interface ClaudeCodeBackgroundTask {
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly description?: string;
  readonly command?: string;
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
  // Tool starting - handled specially with flag (see server-manager.ts)
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
 * Value of the experimental.busy-during-background-shell config key:
 * false = off, true = every running background shell keeps the workspace busy,
 * string[] = regexes selecting the waited-on commands (match ⇒ keep busy).
 */
export type BusyDuringBackgroundShell = boolean | readonly string[];

/**
 * Config type builder for experimental.busy-during-background-shell.
 * CLI/env accept booleans only (regexes can contain commas, so no list
 * syntax); the pattern array form is config.json-only. Invalid regexes are
 * rejected at validation time so misconfiguration fails at startup.
 */
export function configBusyDuringBackgroundShell(): PersistedTypeBuilder<BusyDuringBackgroundShell> {
  return storeCustom<BusyDuringBackgroundShell>({
    parse: (s) =>
      s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : undefined,
    validate: (v) => {
      if (typeof v === "boolean") {
        return v;
      }
      if (!Array.isArray(v) || !v.every((p) => typeof p === "string")) {
        return undefined;
      }
      try {
        for (const pattern of v) {
          new RegExp(pattern);
        }
      } catch {
        return undefined;
      }
      return v as readonly string[];
    },
    validValues: "true|false|[<regex>, ...] (array via config.json only)",
    // Settings UI: a checkbox guarding a comma-separated regex field.
    //   unchecked            → false (never busy)
    //   checked, empty text  → true  (every background shell keeps busy)
    //   checked, "a, b"      → ["a","b"] (only matching commands keep busy)
    settingsControl: {
      kind: "guarded-text",
      offValue: false,
      onEmptyValue: true,
      fromText: (text: string) =>
        text
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      toText: (value: unknown) => {
        if (value === false) return { active: false, text: "" };
        if (value === true) return { active: true, text: "" };
        if (Array.isArray(value)) return { active: true, text: value.join(", ") };
        return { active: false, text: "" };
      },
    },
  });
}

/**
 * Decide whether a background task keeps the workspace busy under the given
 * config value. Only running shell tasks qualify (background agents are
 * covered by sub-agent tracking). true keeps every qualifying shell busy;
 * a pattern array keeps a shell busy if any regex tests true against its
 * command (partial, case-sensitive). false never matches.
 */
export function taskKeepsBusy(
  config: BusyDuringBackgroundShell,
  task: ClaudeCodeBackgroundTask
): boolean {
  if (task.type !== "shell" || (task.status !== undefined && task.status !== "running")) {
    return false;
  }
  if (typeof config === "boolean") {
    return config;
  }
  const command = task.command;
  if (typeof command !== "string") {
    return false;
  }
  return config.some((pattern) => new RegExp(pattern).test(command));
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
