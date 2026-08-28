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
 * How a hook is registered in Claude's `--settings` file.
 *
 * `null` means it never is. The wrapper-synthesized hooks are triggered
 * internally (see {@link WRAPPER_HOOK_NAMES}), so telling Claude to send them
 * would only let a stray POST drive status out-of-band.
 */
export type HookRegistration = { readonly matcher?: "*" } | null;

/** Everything the app needs to know about one Claude Code hook. */
interface HookSpec {
  /** The status change the hook causes, or null for no change. */
  readonly status: HookStatusChange;
  /** How the hook is registered with Claude, or null if it never is. */
  readonly register: HookRegistration;
}

/**
 * Every hook name, in one exhaustive map.
 *
 * Exhaustive on purpose: `Record<ClaudeCodeHookName, ...>` means adding a name
 * to the union fails to compile until both questions about it are answered.
 * The settings file used to be a checked-in JSON template listing 15 of these
 * by hand, with nothing tying the two together — a new hook could be added to
 * the union and silently never registered.
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
const HOOK_SPEC: Readonly<Record<ClaudeCodeHookName, HookSpec>> = {
  // Wrapper started, Claude about to be spawned
  WrapperStart: { status: "idle", register: null },
  // Wrapper exited, Claude has closed
  WrapperEnd: { status: "none", register: null },
  // Session started, waiting for user prompt
  SessionStart: { status: "idle", register: {} },
  // Session ended
  SessionEnd: { status: "none", register: {} },
  // User submitted prompt, agent working
  UserPromptSubmit: { status: "busy", register: {} },
  // Waiting for user to answer permission
  PermissionRequest: { status: "idle", register: { matcher: "*" } },
  // Agent finished working, waiting for next prompt
  Stop: { status: "idle", register: {} },
  // Agent stopped due to API error (rate limit, auth failure), waiting for retry
  StopFailure: { status: "idle", register: {} },
  // Subagent done, main agent continues (no change)
  SubagentStop: { status: null, register: {} },
  // Tool starting - handled specially: busy if workspace was idle (see server-manager.ts)
  PreToolUse: { status: null, register: { matcher: "*" } },
  // Tool done, back to busy (handles return from PermissionRequest idle state)
  PostToolUse: { status: "busy", register: { matcher: "*" } },
  // Tool failed, logged for analysis (no change)
  PostToolUseFailure: { status: null, register: {} },
  // Informational only (no change)
  Notification: { status: null, register: {} },
  // Compacting context, agent working
  PreCompact: { status: "busy", register: {} },
  // Subagent spawned, logged for analysis (no change)
  SubagentStart: { status: null, register: {} },
  // Agent team teammate going idle, logged for analysis (no change)
  TeammateIdle: { status: null, register: {} },
  // Task marked completed, logged for analysis (no change)
  TaskCompleted: { status: null, register: {} },
};

/** Every hook name, in declaration order. */
export const ALL_HOOK_NAMES = Object.keys(HOOK_SPEC) as readonly ClaudeCodeHookName[];

/**
 * Get the status change for a given hook name.
 * Returns null if the hook doesn't cause a status change.
 */
export function getStatusChangeForHook(hookName: ClaudeCodeHookName): HookStatusChange {
  return HOOK_SPEC[hookName].status;
}

/**
 * The hooks Claude is told to send, paired with their registration options.
 *
 * Derived from {@link HOOK_SPEC} rather than listed, so the settings file and
 * the bridge's reject-list cannot disagree about which hooks exist.
 */
export function registeredHooks(): readonly (readonly [
  ClaudeCodeHookName,
  NonNullable<HookRegistration>,
])[] {
  return ALL_HOOK_NAMES.flatMap((name) => {
    const register = HOOK_SPEC[name].register;
    return register === null ? [] : [[name, register] as const];
  });
}

/**
 * Check if a string is a valid Claude Code hook name.
 */
export function isValidHookName(name: string): name is ClaudeCodeHookName {
  return name in HOOK_SPEC;
}

/**
 * Detect the background-wrapper marker in a shell command.
 *
 * A background shell invoked through the wrapper carries the marker in the
 * command string Claude Code reports, which excludes it from keeping the
 * workspace busy.
 *
 * Both spellings count. `ch bg npm run dev` is the canonical form — `bg` is a
 * subcommand of the `ch` CLI — and `ch-bg npm run dev` is the standalone alias,
 * which is still on PATH and still what most existing prompts and habits reach
 * for. Matching only one of them would silently make every wrapped shell keep
 * the workspace busy again.
 *
 * The word boundaries mean it fires for `ch-bg foo`, `bash -c "ch-bg foo"` and
 * `/path/to/ch-bg foo`, but not `xch-bg` or `ch-bgx`. The spaced form requires
 * real whitespace between the two words, so `ch bgfoo` does not qualify.
 */
export function isBackgroundWrapped(command: string): boolean {
  return /\bch-bg\b|\bch\s+bg\b/.test(command);
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
 *
 * Derived from {@link HOOK_SPEC}: a hook Claude is never told to send is
 * exactly a hook the bridge must not accept, so the two cannot drift.
 */
export const WRAPPER_HOOK_NAMES: ReadonlySet<ClaudeCodeHookName> = new Set(
  ALL_HOOK_NAMES.filter((name) => HOOK_SPEC[name].register === null)
);
