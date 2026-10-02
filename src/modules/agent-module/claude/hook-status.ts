/**
 * The Claude hook state machine, as a pure reducer.
 *
 * Every hook the bridge receives — and the WrapperStart/WrapperEnd lifecycle the
 * sidekick reports — goes through {@link deriveStatus}: given the workspace's
 * flags and current status, it decides the status the hook leads to and the
 * flags it leaves behind. The server manager applies the result (status
 * callbacks, timers, logging); nothing here has side effects.
 *
 * The rules are order-dependent — a later rule may override an earlier one's
 * status (AskUserQuestion's park wins over "PreToolUse while idle", the park's
 * suppression runs last) — so they stay one sequential pass, in this order.
 */

import type { AgentActivity } from "../types";
import {
  getStatusChangeForHook,
  taskKeepsBusy,
  type ClaudeCodeBridgePayload,
  type ClaudeCodeHookName,
} from "./types";

/** The per-workspace flags the hook rules read and write. */
export interface HookFlags {
  /**
   * The first WrapperStart (and the SessionStart after it) should read busy:
   * there is a non-empty initial prompt for the agent to process.
   */
  readonly busyOnWrapperStart: boolean;
  /**
   * Parked on an AskUserQuestion (the main agent is blocked on the user). Set by
   * PreToolUse(AskUserQuestion), cleared by its PostToolUse. While set, busy
   * transitions from concurrent sub-agent tool activity on this shared workspace
   * bridge are suppressed so the workspace stays idle until the user answers.
   */
  readonly awaitingUserInputResolution: boolean;
  /** PreCompact arrived while busy (compaction mid-turn); cleared on SessionStart. */
  readonly ignoreNextSessionStart: boolean;
  /**
   * The last Stop was suppressed because background tasks keep the workspace
   * busy — running shells and/or background sub-agents, read from the Stop
   * payload's background_tasks. Also suppresses the ~60s-lagging idle_prompt.
   */
  readonly busyForBackgroundTasks: boolean;
  /**
   * The agent terminal is open (WrapperStart, until WrapperEnd). Open without an
   * inbox means `claude` is still starting.
   */
  readonly terminalOpen: boolean;
}

/** Flags of a workspace no hook has touched yet. */
export const INITIAL_HOOK_FLAGS: HookFlags = {
  busyOnWrapperStart: false,
  awaitingUserInputResolution: false,
  ignoreNextSessionStart: false,
  busyForBackgroundTasks: false,
  terminalOpen: false,
};

/** What the reducer needs to know about the workspace besides the hook. */
export interface HookStatusInput {
  readonly flags: HookFlags;
  /** The workspace's current status. */
  readonly status: AgentActivity;
  /** Whether the startup timer (initial prompt waiting on its session) is armed. */
  readonly startupTimerArmed: boolean;
}

/** Why a status the rules computed was dropped, for the log. */
export type HookSuppression =
  | {
      readonly reason: "background-tasks";
      /** The tasks keeping the workspace busy (Stop only; idle_prompt names none). */
      readonly tasks?: string;
    }
  | { readonly reason: "ask-user-question" };

/** A hook that does not drive the main status at all. */
export interface IgnoredHook {
  readonly kind: "ignored";
  /** A sub-agent's Stop/StopFailure, or a sub-agent's (or prompt-suggestion fork's) PreToolUse. */
  readonly reason: "subagent-stop" | "subagent-pre-tool-use";
}

/** The outcome of a hook that went through the status rules. */
export interface DerivedStatus {
  readonly kind: "derived";
  readonly flags: HookFlags;
  /** The status the hook leads to; null = no change. May equal the current status. */
  readonly status: AgentActivity | null;
  /** Arm or clear the startup timer; null leaves it as it is. */
  readonly startupTimer: "arm" | "clear" | null;
  /**
   * The main agent's Stop landed on an already-idle workspace: a turn ran that
   * was never seen to start. The caller emits a synthetic busy→idle edge.
   */
  readonly untrackedTurn: boolean;
  /** Statuses the rules dropped, in the order they were dropped. */
  readonly suppressed: readonly HookSuppression[];
}

export type HookStatusResult = IgnoredHook | DerivedStatus;

/** Notification types that mean the agent is waiting for the user. */
const WAITING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  // idle_prompt: agent is at its idle prompt (recovers from failed compaction).
  "idle_prompt",
  // permission_prompt: agent is waiting for permission (redundant with PermissionRequest).
  "permission_prompt",
  // elicitation_dialog: agent is waiting for MCP elicitation input.
  "elicitation_dialog",
]);

/**
 * Decide what a hook does to a workspace's status and flags.
 */
export function deriveStatus(
  input: HookStatusInput,
  hookName: ClaudeCodeHookName,
  payload: ClaudeCodeBridgePayload
): HookStatusResult {
  // A Stop/StopFailure carrying an agent_id is a *sub-agent's* turn end, not the
  // main agent's (the main agent's Stop has no agent_id). Sub-agent turn-ends
  // must not drive the workspace status — the main agent's own Stop does that,
  // and background sub-agents are already reflected in that Stop's
  // background_tasks. Ignore it entirely.
  if ((hookName === "Stop" || hookName === "StopFailure") && payload.agent_id) {
    return { kind: "ignored", reason: "subagent-stop" };
  }

  // Likewise a PreToolUse carrying an agent_id is not the main agent starting
  // a tool. Besides sub-agents, it comes from the hidden agent Claude forks
  // after every interactive turn to suggest the user's next prompt (checked on
  // 2.1.280): the fork runs the session's hooks, denies every tool it tries,
  // and emits nothing after PreToolUse. Letting it through would either park
  // the workspace on an AskUserQuestion nobody sees — idle for as long as
  // background sub-agents keep working, their busy signals suppressed by the
  // park — or, after an idle Stop, trip "PreToolUse while idle → busy" with
  // no Stop ever to follow. A sub-agent's tool activity reaches the status
  // through PostToolUse; its PreToolUse has nothing to add.
  if (hookName === "PreToolUse" && payload.agent_id) {
    return { kind: "ignored", reason: "subagent-pre-tool-use" };
  }

  const current = input.status;
  let {
    busyOnWrapperStart,
    awaitingUserInputResolution,
    ignoreNextSessionStart,
    busyForBackgroundTasks,
    terminalOpen,
  } = input.flags;
  let startupTimer: DerivedStatus["startupTimer"] = null;
  const suppressed: HookSuppression[] = [];

  if (hookName === "WrapperStart") terminalOpen = true;
  else if (hookName === "WrapperEnd") terminalOpen = false;

  let status = getStatusChangeForHook(hookName);

  // When a workspace has a non-empty initial prompt, override WrapperStart and
  // SessionStart to busy so there is no idle blip before UserPromptSubmit.
  if (busyOnWrapperStart && (hookName === "WrapperStart" || hookName === "SessionStart")) {
    status = "busy";
    if (hookName === "SessionStart") {
      busyOnWrapperStart = false;
    } else if (!input.startupTimerArmed) {
      startupTimer = "arm";
    }
  }
  if (hookName === "SessionStart" || hookName === "WrapperEnd") {
    startupTimer = "clear";
  }

  // A tool starting while the workspace reads idle means the agent is
  // actually working — flip to busy. Two paths reach here:
  //  1. Permission resolution: PermissionRequest transitioned us to idle
  //     (waiting for the user); once approved, the tool runs.
  //  2. Bash-mode ("!cmd") turns: Claude Code runs a user-typed shell command
  //     without emitting UserPromptSubmit, so the ensuing agent turn never
  //     flipped to busy. The first tool call is the earliest reliable signal
  //     that the agent is working. (A text-only reply has no hook and can't
  //     be caught here.)
  // PreToolUse while already busy (normal mid-turn tool use) is a no-op.
  if (hookName === "PreToolUse" && current === "idle") {
    status = "busy";
  }

  // AskUserQuestion parks the workspace on the user: the main agent is blocked
  // until the user answers. It surfaces as a normal tool
  // (PreToolUse → PermissionRequest → PostToolUse, all tool_name
  // "AskUserQuestion"), but the generic handling above can't cope when
  // sub-agents run concurrently:
  //  - the "PreToolUse while idle → busy" rule would un-park us the moment a
  //    *sub-agent's* tool call fires, not the user's answer;
  //  - concurrent sub-agent tool calls emit PostToolUse (→busy) on this same
  //    workspace bridge, which would immediately overwrite the idle.
  // So we bracket it explicitly: PreToolUse(AskUserQuestion) parks (→idle),
  // PostToolUse(AskUserQuestion) unparks (→busy); while parked, every busy
  // transition is suppressed (the last rule below). This rule runs after the
  // generalized PreToolUse rule so the park wins.
  if (hookName === "PreToolUse" && payload.tool_name === "AskUserQuestion") {
    awaitingUserInputResolution = true;
    status = "idle";
  } else if (
    (hookName === "PostToolUse" || hookName === "PostToolUseFailure") &&
    payload.tool_name === "AskUserQuestion" &&
    !payload.agent_id
  ) {
    // The main agent's answer only: the park is the main agent's (sub-agent
    // PreToolUse never reaches it, above), so no one else's Post may lift it.
    // Unpark on either outcome (answered or cancelled/errored) so the flag can
    // never get stuck and keep the workspace suppressed to idle.
    awaitingUserInputResolution = false;
    status = "busy";
  }

  // Compaction:
  // PreCompact while busy sets the flag (automatic compaction mid-turn).
  // Stop/StopFailure between PreCompact and SessionStart is suppressed so the
  // workspace doesn't blip to idle while compaction is running.
  // SessionStart during compaction stays busy instead of going idle.
  // Manual /compact starts from idle, so the flag is NOT set and SessionStart goes idle normally.
  // Terminal hooks (WrapperEnd, SessionEnd) clear the flag as defensive cleanup.
  if (hookName === "PreCompact" && current === "busy") {
    ignoreNextSessionStart = true;
  } else if ((hookName === "Stop" || hookName === "StopFailure") && ignoreNextSessionStart) {
    status = null;
  } else if (hookName === "SessionStart" && ignoreNextSessionStart) {
    ignoreNextSessionStart = false;
    status = "busy";
  } else if ((hookName === "WrapperEnd" || hookName === "SessionEnd") && ignoreNextSessionStart) {
    ignoreNextSessionStart = false;
  }

  if (
    hookName === "Notification" &&
    payload.notification_type !== undefined &&
    WAITING_NOTIFICATION_TYPES.has(payload.notification_type)
  ) {
    // idle_prompt fires ~60s after the main thread goes quiet — which also
    // happens while the main agent waits on background tasks (a running shell
    // or a background sub-agent). When the preceding Stop was suppressed for
    // that reason (busyForBackgroundTasks), this idle_prompt is just its
    // lagging echo, so suppress it too and stay busy. The other two types
    // genuinely need the user, so they still transition to idle.
    if (payload.notification_type === "idle_prompt" && busyForBackgroundTasks) {
      status = null;
      suppressed.push({ reason: "background-tasks" });
    } else {
      status = "idle";
      ignoreNextSessionStart = false;
    }
  }

  // Sub-agent status is derived from the Stop payload's background_tasks below
  // (background sub-agents surface there as type "subagent"), so SubagentStart/
  // SubagentStop do not drive status — they stay subscribed for logging only.
  // A synchronous sub-agent runs nested inside its parent Agent tool call, so
  // no Stop fires while it runs and the workspace stays busy from the tool.

  // Background tasks: the Stop payload carries background_tasks — the live list
  // of still-running background work (shells and background sub-agents).
  // taskKeepsBusy() decides which keep the workspace busy: sub-agents always
  // do; shells do by default, unless invoked through the `ch-bg` wrapper (its
  // marker in the command opts the shell out). When any qualifies, the idle
  // transition is suppressed and the decision is stashed so the ~60s-later
  // idle_prompt Notification (handled above) stays suppressed too. When a task
  // finishes, Claude Code re-invokes the agent (UserPromptSubmit), which clears
  // the stash — the next Stop re-evaluates from fresh ground truth.
  // PermissionRequest is deliberately NOT suppressed.
  //
  // StopFailure carries no background_tasks (it's an API error — rate limit,
  // auth, max-tokens — and the payload omits the field), so it always goes idle
  // to surface the stuck main agent regardless of background work; clear the
  // stash there.
  //
  // The main agent's Stop also ends any AskUserQuestion park: its turn is over,
  // so no question of its own can still be open. Claude can drop a question
  // without a PostToolUse (seen when a message arriving mid-tool started a
  // second turn branch that asked it, and the first branch then ended the
  // turn), and a park left behind would suppress every busy signal from the
  // still-running background tasks. So a Stop that lifts a park while tasks
  // keep the workspace busy goes busy rather than staying parked idle.
  if (hookName === "Stop") {
    const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
    const busyTasks = tasks.filter((task) => taskKeepsBusy(task));
    const wasParked = awaitingUserInputResolution;
    awaitingUserInputResolution = false;
    busyForBackgroundTasks = busyTasks.length > 0;
    if (busyTasks.length > 0) {
      status = wasParked ? "busy" : null;
      suppressed.push({
        reason: "background-tasks",
        tasks: busyTasks.map((task) => task.command ?? task.agent_type ?? task.type).join(", "),
      });
    }
  } else if (hookName === "StopFailure") {
    busyForBackgroundTasks = false;
  }
  if (hookName === "UserPromptSubmit") {
    busyForBackgroundTasks = false;
    awaitingUserInputResolution = false;
  }

  // Terminal hooks clear background-task state as defensive cleanup.
  if (hookName === "WrapperEnd" || hookName === "SessionEnd") {
    busyForBackgroundTasks = false;
    awaitingUserInputResolution = false;
  }

  // While parked on an AskUserQuestion the main agent is blocked on the user;
  // any "busy" computed above comes from concurrent sub-agent tool activity on
  // this shared workspace bridge, not real main-agent progress. Suppress it so
  // the workspace stays idle. The AskUserQuestion PostToolUse clears the flag
  // above before reaching here, so the user's answer still returns us to busy.
  if (awaitingUserInputResolution && status === "busy") {
    status = null;
    suppressed.push({ reason: "ask-user-question" });
  }

  // The main agent's Stop landed on an already-idle workspace — a turn ran
  // that we never saw start. Bash-mode ("!cmd") turns emit only a Stop (no
  // UserPromptSubmit, no PreToolUse), so a text-only reply never flipped the
  // workspace to busy.
  const untrackedTurn =
    hookName === "Stop" && status === "idle" && current === "idle" && !awaitingUserInputResolution;

  return {
    kind: "derived",
    flags: {
      busyOnWrapperStart,
      awaitingUserInputResolution,
      ignoreNextSessionStart,
      busyForBackgroundTasks,
      terminalOpen,
    },
    status,
    startupTimer,
    untrackedTurn,
    suppressed,
  };
}
