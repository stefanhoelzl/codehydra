/**
 * Focused tests for the Claude hook reducer: input flags + status + hook in,
 * status + flags + effects out. The order the rules run in is part of the
 * contract, so several cases pit two rules against each other.
 */

import { describe, it, expect } from "vitest";
import {
  deriveStatus,
  INITIAL_HOOK_FLAGS,
  type DerivedStatus,
  type HookFlags,
  type HookStatusInput,
} from "./hook-status";
import type { ClaudeCodeBridgePayload, ClaudeCodeHookName } from "./types";
import type { AgentActivity } from "../types";

function input(
  status: AgentActivity,
  flags: Partial<HookFlags> = {},
  startupTimerArmed = false
): HookStatusInput {
  return { status, flags: { ...INITIAL_HOOK_FLAGS, ...flags }, startupTimerArmed };
}

function derive(
  from: HookStatusInput,
  hookName: ClaudeCodeHookName,
  payload: ClaudeCodeBridgePayload = {}
): DerivedStatus {
  const result = deriveStatus(from, hookName, payload);
  if (result.kind !== "derived") throw new Error(`hook was ignored: ${result.reason}`);
  return result;
}

describe("deriveStatus", () => {
  describe("sub-agent hooks", () => {
    it.each(["Stop", "StopFailure"] as const)("ignores a sub-agent's %s", (hookName) => {
      expect(deriveStatus(input("busy"), hookName, { agent_id: "a1" })).toEqual({
        kind: "ignored",
        reason: "subagent-stop",
      });
    });

    it("ignores a sub-agent's PreToolUse, even an AskUserQuestion", () => {
      expect(
        deriveStatus(input("idle"), "PreToolUse", { agent_id: "a1", tool_name: "AskUserQuestion" })
      ).toEqual({ kind: "ignored", reason: "subagent-pre-tool-use" });
    });
  });

  describe("plain hooks", () => {
    it("maps a hook to its status", () => {
      expect(derive(input("idle"), "UserPromptSubmit").status).toBe("busy");
      expect(derive(input("busy"), "PermissionRequest").status).toBe("idle");
      expect(derive(input("idle"), "SessionEnd").status).toBe("none");
      expect(derive(input("busy"), "SubagentStart").status).toBeNull();
    });

    it("tracks the agent terminal", () => {
      const opened = derive(input("none"), "WrapperStart");
      expect(opened).toMatchObject({ status: "idle", flags: { terminalOpen: true } });
      const closed = derive(input("idle", { terminalOpen: true }), "WrapperEnd");
      expect(closed).toMatchObject({
        status: "none",
        flags: { terminalOpen: false },
        startupTimer: "clear",
      });
    });

    it("reports no effects for an ordinary hook", () => {
      expect(derive(input("busy"), "PostToolUse")).toEqual({
        kind: "derived",
        flags: INITIAL_HOOK_FLAGS,
        status: "busy",
        startupTimer: null,
        untrackedTurn: false,
        suppressed: [],
      });
    });
  });

  describe("initial prompt", () => {
    it("reads busy on WrapperStart and arms the startup timer", () => {
      const result = derive(input("none", { busyOnWrapperStart: true }), "WrapperStart");
      expect(result).toMatchObject({
        status: "busy",
        startupTimer: "arm",
        flags: { busyOnWrapperStart: true, terminalOpen: true },
      });
    });

    it("does not re-arm a timer that is already armed", () => {
      const result = derive(input("busy", { busyOnWrapperStart: true }, true), "WrapperStart");
      expect(result.startupTimer).toBeNull();
    });

    it("reads busy on the SessionStart, then forgets the prompt and clears the timer", () => {
      const result = derive(input("idle", { busyOnWrapperStart: true }, true), "SessionStart");
      expect(result).toMatchObject({
        status: "busy",
        startupTimer: "clear",
        flags: { busyOnWrapperStart: false },
      });
    });

    it("clears the startup timer on every SessionStart", () => {
      expect(derive(input("busy"), "SessionStart").startupTimer).toBe("clear");
    });
  });

  describe("PreToolUse", () => {
    it("turns an idle workspace busy", () => {
      expect(derive(input("idle"), "PreToolUse", { tool_name: "Bash" }).status).toBe("busy");
    });

    it("changes nothing mid-turn", () => {
      expect(derive(input("busy"), "PreToolUse", { tool_name: "Bash" }).status).toBeNull();
    });
  });

  describe("AskUserQuestion", () => {
    it("parks an idle workspace: the park wins over PreToolUse-while-idle", () => {
      const result = derive(input("idle"), "PreToolUse", { tool_name: "AskUserQuestion" });
      expect(result).toMatchObject({
        status: "idle",
        flags: { awaitingUserInputResolution: true },
      });
    });

    it("suppresses busy from other tool activity while parked", () => {
      const result = derive(input("idle", { awaitingUserInputResolution: true }), "PostToolUse", {
        tool_name: "Read",
      });
      expect(result.status).toBeNull();
      expect(result.suppressed).toEqual([{ reason: "ask-user-question" }]);
    });

    it("does not let a sub-agent's AskUserQuestion answer lift the park", () => {
      const result = derive(input("idle", { awaitingUserInputResolution: true }), "PostToolUse", {
        tool_name: "AskUserQuestion",
        agent_id: "a1",
      });
      expect(result.status).toBeNull();
      expect(result.flags.awaitingUserInputResolution).toBe(true);
    });

    it.each(["PostToolUse", "PostToolUseFailure"] as const)(
      "unparks to busy on the main agent's %s",
      (hookName) => {
        const result = derive(input("idle", { awaitingUserInputResolution: true }), hookName, {
          tool_name: "AskUserQuestion",
        });
        expect(result).toMatchObject({
          status: "busy",
          flags: { awaitingUserInputResolution: false },
          suppressed: [],
        });
      }
    );

    it.each(["UserPromptSubmit", "SessionEnd", "WrapperEnd"] as const)(
      "clears the park on %s",
      (hookName) => {
        const result = derive(input("idle", { awaitingUserInputResolution: true }), hookName);
        expect(result.flags.awaitingUserInputResolution).toBe(false);
      }
    );

    it("lets UserPromptSubmit read busy once the park is cleared", () => {
      const result = derive(
        input("idle", { awaitingUserInputResolution: true }),
        "UserPromptSubmit"
      );
      expect(result.status).toBe("busy");
    });
  });

  describe("compaction", () => {
    it("remembers a PreCompact that arrives while busy", () => {
      expect(derive(input("busy"), "PreCompact").flags.ignoreNextSessionStart).toBe(true);
    });

    it("does not remember a manual /compact (from idle)", () => {
      const result = derive(input("idle"), "PreCompact");
      expect(result).toMatchObject({ status: "busy", flags: { ignoreNextSessionStart: false } });
    });

    it.each(["Stop", "StopFailure"] as const)("suppresses %s during compaction", (hookName) => {
      const result = derive(input("busy", { ignoreNextSessionStart: true }), hookName);
      expect(result.status).toBeNull();
      expect(result.flags.ignoreNextSessionStart).toBe(true);
    });

    it("keeps the SessionStart that ends compaction busy, and forgets it", () => {
      const result = derive(input("busy", { ignoreNextSessionStart: true }), "SessionStart");
      expect(result).toMatchObject({ status: "busy", flags: { ignoreNextSessionStart: false } });
    });

    it.each(["WrapperEnd", "SessionEnd"] as const)("forgets compaction on %s", (hookName) => {
      const result = derive(input("busy", { ignoreNextSessionStart: true }), hookName);
      expect(result).toMatchObject({ status: "none", flags: { ignoreNextSessionStart: false } });
    });
  });

  describe("Notification", () => {
    it.each(["idle_prompt", "permission_prompt", "elicitation_dialog"])(
      "turns %s idle and ends a stuck compaction",
      (type) => {
        const result = derive(input("busy", { ignoreNextSessionStart: true }), "Notification", {
          notification_type: type,
        });
        expect(result).toMatchObject({ status: "idle", flags: { ignoreNextSessionStart: false } });
      }
    );

    it("ignores other notification types", () => {
      const result = derive(input("busy"), "Notification", { notification_type: "auth_success" });
      expect(result.status).toBeNull();
    });

    it("suppresses idle_prompt while background tasks keep the workspace busy", () => {
      const result = derive(input("busy", { busyForBackgroundTasks: true }), "Notification", {
        notification_type: "idle_prompt",
      });
      expect(result.status).toBeNull();
      expect(result.suppressed).toEqual([{ reason: "background-tasks" }]);
    });

    it("still goes idle for a permission prompt during background tasks", () => {
      const result = derive(input("busy", { busyForBackgroundTasks: true }), "Notification", {
        notification_type: "permission_prompt",
      });
      expect(result.status).toBe("idle");
    });
  });

  describe("background tasks", () => {
    it("stays busy on a Stop with a running shell, and remembers why", () => {
      const result = derive(input("busy"), "Stop", {
        background_tasks: [
          { type: "shell", status: "running", command: "npm run dev" },
          { type: "subagent", status: "running", agent_type: "Explore" },
        ],
      });
      expect(result).toMatchObject({ status: null, flags: { busyForBackgroundTasks: true } });
      expect(result.suppressed).toEqual([
        { reason: "background-tasks", tasks: "npm run dev, Explore" },
      ]);
    });

    it("goes idle when every shell opted out through ch-bg", () => {
      const result = derive(input("busy", { busyForBackgroundTasks: true }), "Stop", {
        background_tasks: [{ type: "shell", status: "running", command: "ch-bg npm run dev" }],
      });
      expect(result).toMatchObject({ status: "idle", flags: { busyForBackgroundTasks: false } });
    });

    it("goes busy when a Stop lifts a dropped AskUserQuestion park while tasks run", () => {
      const result = derive(input("idle", { awaitingUserInputResolution: true }), "Stop", {
        background_tasks: [{ type: "subagent", status: "running", agent_type: "Explore" }],
      });
      expect(result).toMatchObject({
        status: "busy",
        flags: { awaitingUserInputResolution: false, busyForBackgroundTasks: true },
      });
    });

    it("stays put on a Stop with running tasks when nothing was parked", () => {
      const result = derive(input("busy"), "Stop", {
        background_tasks: [{ type: "subagent", status: "running" }],
      });
      expect(result).toMatchObject({ status: null, flags: { awaitingUserInputResolution: false } });
    });

    it.each(["StopFailure", "UserPromptSubmit", "SessionEnd", "WrapperEnd"] as const)(
      "forgets background tasks on %s",
      (hookName) => {
        const result = derive(input("busy", { busyForBackgroundTasks: true }), hookName);
        expect(result.flags.busyForBackgroundTasks).toBe(false);
      }
    );
  });

  describe("untracked turns", () => {
    it("flags a main-agent Stop on an idle workspace", () => {
      expect(derive(input("idle"), "Stop").untrackedTurn).toBe(true);
    });

    it("does not flag a Stop that ends a tracked turn", () => {
      expect(derive(input("busy"), "Stop").untrackedTurn).toBe(false);
    });

    it("flags a Stop that ends a turn parked on an AskUserQuestion", () => {
      // The main agent's Stop lifts the park first, so its turn end is reported.
      expect(
        derive(input("idle", { awaitingUserInputResolution: true }), "Stop").untrackedTurn
      ).toBe(true);
    });

    it("does not flag a Stop suppressed for background tasks", () => {
      const result = derive(input("idle"), "Stop", {
        background_tasks: [{ type: "subagent", status: "running" }],
      });
      expect(result.untrackedTurn).toBe(false);
    });
  });
});
