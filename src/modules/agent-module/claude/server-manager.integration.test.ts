// @vitest-environment node
/**
 * Integration tests for ClaudeCodeServerManager.
 *
 * Tests the core functionality:
 * - Hook -> status mapping
 * - Multi-workspace routing
 * - Server lifecycle (start first workspace, stop last workspace)
 * - Config file generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeCodeServerManager } from "./server-manager";
import {
  createPortManagerMock,
  type MockPortManager,
} from "../../../boundaries/platform/network.test-utils";
import { createMockPathProvider } from "../../../boundaries/platform/path-provider.test-utils";
import {
  createFileSystemMock,
  directory,
} from "../../../boundaries/platform/filesystem.state-mock";
import { createMockAccessor } from "../../../boundaries/platform/config.test-utils";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { MockFileSystemBoundary } from "../../../boundaries/platform/filesystem.state-mock";
import type { AgentStatus } from "../types";

/**
 * Send a hook to the bridge server.
 */
async function sendHook(
  port: number,
  hookName: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hook/${hookName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Connection: "close", // Disable keep-alive to prevent server isolation issues
    },
    body: JSON.stringify(payload),
  });
}

/** Current status as observed through the public onStatusChange seam. */
function lastStatus(statusChanges: readonly AgentStatus[]): AgentStatus {
  return statusChanges.at(-1) ?? "none";
}

describe("ClaudeCodeServerManager integration", () => {
  let serverManager: ClaudeCodeServerManager;
  let mockPortManager: MockPortManager;
  let mockPathProvider: PathProvider;
  let mockFileSystem: MockFileSystemBoundary;

  beforeEach(() => {
    vi.clearAllMocks();

    // Provide enough ports for tests
    mockPortManager = createPortManagerMock([15001, 15002, 15003, 15004, 15005]);
    mockPathProvider = createMockPathProvider();
    mockFileSystem = createFileSystemMock({
      entries: {
        "/app-data": directory(),
        "/app-data/claude": directory(),
        "/app-data/claude/configs": directory(),
      },
    });

    serverManager = new ClaudeCodeServerManager({
      portManager: mockPortManager,
      pathProvider: mockPathProvider,
      fileSystem: mockFileSystem,
      logger: SILENT_LOGGER,
      config: {
        hookHandlerPath: "/mock/hook-handler.js",
      },
    });
  });

  afterEach(async () => {
    await serverManager.dispose();
  });

  describe("workspace lifecycle", () => {
    it("starts server on first workspace, returns same port for subsequent", async () => {
      const port1 = await serverManager.startServer("/workspace/feature-a");
      const port2 = await serverManager.startServer("/workspace/feature-b");

      // Both should get the same port (single server for all workspaces)
      expect(port1).toBe(15001);
      expect(port2).toBe(15001);
    });

    it("returns existing port when starting same workspace twice", async () => {
      const port1 = await serverManager.startServer("/workspace/feature-a");
      const port2 = await serverManager.startServer("/workspace/feature-a");

      expect(port1).toBe(port2);
      expect(port1).toBe(15001);
    });

    it("server stops only when last workspace is removed", async () => {
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      // Stop first workspace - server still running, new workspaces reuse its port
      await serverManager.stopServer("/workspace/feature-a");
      expect(await serverManager.startServer("/workspace/feature-c")).toBe(15001);

      // Stop remaining workspaces - server stops, next start allocates a fresh port
      await serverManager.stopServer("/workspace/feature-b");
      await serverManager.stopServer("/workspace/feature-c");
      expect(await serverManager.startServer("/workspace/feature-d")).toBe(15002);
    });
  });

  describe("callback wiring", () => {
    it("onServerStarted fires for each workspace", async () => {
      const startedCallback = vi.fn();
      serverManager.onServerStarted(startedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      expect(startedCallback).toHaveBeenCalledTimes(2);
      expect(startedCallback).toHaveBeenCalledWith("/workspace/feature-a", 15001);
      expect(startedCallback).toHaveBeenCalledWith("/workspace/feature-b", 15001);
    });

    it("onServerStopped fires for each workspace", async () => {
      const stoppedCallback = vi.fn();
      serverManager.onServerStopped(stoppedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");
      await serverManager.stopServer("/workspace/feature-a");
      await serverManager.stopServer("/workspace/feature-b");

      expect(stoppedCallback).toHaveBeenCalledTimes(2);
      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-a", false);
      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-b", false);
    });

    it("unsubscribe works", async () => {
      const startedCallback = vi.fn();
      const unsubscribe = serverManager.onServerStarted(startedCallback);

      await serverManager.startServer("/workspace/feature-a");
      expect(startedCallback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await serverManager.startServer("/workspace/feature-b");
      expect(startedCallback).toHaveBeenCalledTimes(1);
    });

    it("markActiveHandler is called when status becomes idle", async () => {
      const markActiveHandler = vi.fn();
      serverManager.setMarkActiveHandler(markActiveHandler);

      const port = await serverManager.startServer("/workspace/feature-a");

      // WrapperStart sets status to idle, should trigger markActiveHandler
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");

      expect(markActiveHandler).toHaveBeenCalledWith("/workspace/feature-a");

      // Make busy then idle again
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      expect(markActiveHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe("hook handling", () => {
    it("routes hooks to correct workspace based on workspacePath", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      const statusChangesA: AgentStatus[] = [];
      const statusChangesB: AgentStatus[] = [];

      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChangesA.push(status);
      });
      serverManager.onStatusChange("/workspace/feature-b", (status) => {
        statusChangesB.push(status);
      });

      // Send SessionStart to workspace A
      await sendHook(port, "SessionStart", {
        workspacePath: "/workspace/feature-a",
        session_id: "session-a",
      });

      // Send UserPromptSubmit to workspace B
      await sendHook(port, "UserPromptSubmit", {
        workspacePath: "/workspace/feature-b",
      });

      expect(statusChangesA).toEqual(["idle"]);
      expect(statusChangesB).toEqual(["busy"]);
    });

    it.each([
      {
        hookName: "WrapperStart",
        setupHooks: [] as string[],
        extraPayload: {},
        expectedChanges: ["idle"],
        finalStatus: "idle",
      },
      {
        hookName: "WrapperEnd",
        setupHooks: ["SessionStart"],
        extraPayload: {},
        expectedChanges: ["idle", "none"],
        finalStatus: "none",
      },
      {
        hookName: "SessionStart",
        setupHooks: [] as string[],
        extraPayload: { session_id: "test-session" },
        expectedChanges: ["idle"],
        finalStatus: "idle",
      },
      {
        hookName: "UserPromptSubmit",
        setupHooks: ["SessionStart"],
        extraPayload: {},
        expectedChanges: ["idle", "busy"],
        finalStatus: "busy",
      },
      {
        hookName: "PermissionRequest",
        setupHooks: ["SessionStart", "UserPromptSubmit"],
        extraPayload: {},
        expectedChanges: ["idle", "busy", "idle"],
        finalStatus: "idle",
      },
      {
        hookName: "PreCompact",
        setupHooks: ["SessionStart"],
        extraPayload: {},
        expectedChanges: ["idle", "busy"],
        finalStatus: "busy",
      },
      {
        hookName: "Stop",
        setupHooks: ["SessionStart", "UserPromptSubmit"],
        extraPayload: {},
        expectedChanges: ["idle", "busy", "idle"],
        finalStatus: "idle",
      },
      {
        hookName: "StopFailure",
        setupHooks: ["SessionStart", "UserPromptSubmit"],
        extraPayload: {},
        expectedChanges: ["idle", "busy", "idle"],
        finalStatus: "idle",
      },
      {
        hookName: "SessionEnd",
        setupHooks: ["SessionStart"],
        extraPayload: {},
        expectedChanges: ["idle", "none"],
        finalStatus: "none",
      },
    ])(
      "$hookName -> $finalStatus",
      async ({ hookName, setupHooks, extraPayload, expectedChanges }) => {
        const port = await serverManager.startServer("/workspace/feature-a");
        const statusChanges: AgentStatus[] = [];
        serverManager.onStatusChange("/workspace/feature-a", (status) => {
          statusChanges.push(status);
        });

        for (const hook of setupHooks) {
          await sendHook(port, hook, { workspacePath: "/workspace/feature-a" });
        }
        if (hookName === "WrapperStart" || hookName === "WrapperEnd") {
          // Wrapper lifecycle hooks are no longer accepted over HTTP — they are
          // driven internally (via the sidekick's agent:lifecycle event).
          serverManager.triggerWrapperLifecycle("/workspace/feature-a", hookName);
        } else {
          await sendHook(port, hookName, {
            workspacePath: "/workspace/feature-a",
            ...extraPayload,
          });
        }

        expect(statusChanges).toEqual(expectedChanges);
        if (hookName === "SessionStart") {
          expect(serverManager.getSessionId("/workspace/feature-a")).toBe("test-session");
        }
      }
    );

    it("rejects WrapperStart/WrapperEnd over HTTP (driven internally only)", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      const startRes = await sendHook(port, "WrapperStart", {
        workspacePath: "/workspace/feature-a",
      });
      const endRes = await sendHook(port, "WrapperEnd", {
        workspacePath: "/workspace/feature-a",
      });

      expect(startRes.status).toBe(404);
      expect(endRes.status).toBe(404);
      // No status changes — the HTTP path must not drive wrapper lifecycle.
      expect(statusChanges).toEqual([]);
    });

    it("WrapperEnd is idempotent — a second call produces no extra transition", async () => {
      await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperEnd");
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperEnd");

      expect(statusChanges).toEqual(["idle", "none"]);
    });

    it("SessionStart during automatic compaction stays busy", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Agent is working (busy)
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Automatic compaction mid-turn: PreCompact while busy sets flag
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });
      // SessionStart after compaction should stay busy (flag consumed)
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      // No false idle transition — status stays busy throughout
      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("Stop between PreCompact and SessionStart stays busy", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Automatic compaction mid-turn: PreCompact while busy sets flag
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });
      // Inner session ends (Stop) while compaction is in progress — must not go idle
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      // Compaction continues with a fresh SessionStart, still busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("StopFailure between PreCompact and SessionStart stays busy", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });
      // Auto-compaction wrapper observes a non-zero exit during the swap
      await sendHook(port, "StopFailure", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("manual compact: SessionStart goes idle normally", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Agent is idle (waiting for user), user runs /compact
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      // PreCompact while idle does NOT set flag
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });
      // SessionStart after compaction should go idle normally
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("compacting flag cleared after use", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Automatic compaction mid-turn
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      // Agent finishes, stops
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // Next SessionStart should go idle normally (flag was consumed)
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("WrapperEnd clears ignoreNextSessionStart flag", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Automatic compaction sets flag
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });

      // Claude exits before SessionStart (abnormal exit clears flag)
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperEnd");

      // New session should go idle (flag was defensively cleared)
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "none", "idle"]);
    });

    it("Notification(idle_prompt) recovers from failed compaction", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Automatic compaction: busy → PreCompact (stays busy, sets flag)
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });

      // Compaction fails — no SessionStart follows, only a Notification
      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "idle_prompt",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("Notification(idle_prompt) clears ignoreNextSessionStart flag", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Automatic compaction sets flag
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "PreCompact", { workspacePath: "/workspace/feature-a" });

      // idle_prompt clears the flag
      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "idle_prompt",
      });

      // Next SessionStart should go idle normally (flag was cleared)
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy", "idle"]);
    });

    it("Notification(permission_prompt) transitions to idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "permission_prompt",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("Notification(elicitation_dialog) transitions to idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "elicitation_dialog",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("AskUserQuestion parks the workspace on idle until answered", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // AskUserQuestion surfaces as a tool: PreToolUse parks on the user (idle),
      // PostToolUse (the answer) returns to busy.
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });
      expect(lastStatus(statusChanges)).toBe("idle");

      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("Notification(auth_success) does not change status", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "auth_success",
      });

      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("Notification(idle_prompt) is no-op when already idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Get to idle state
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });

      // idle_prompt when already idle should not fire callback
      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "idle_prompt",
      });

      expect(statusChanges).toEqual(["idle"]);
    });

    it("PreToolUse while busy does not change status", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // PreToolUse mid-turn (already busy) should not change status
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      // Status should remain busy
      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("PreToolUse transitions to busy when idle without UserPromptSubmit (bash-mode turn)", async () => {
      // Claude Code's bash-mode ("!cmd") commands run a user-typed shell command
      // without emitting UserPromptSubmit, so the ensuing agent turn never flips
      // to busy. The first tool call the agent makes is our signal that it's
      // working — it must transition the idle workspace to busy.
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Session is idle, waiting for the user; no UserPromptSubmit is sent.
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      expect(lastStatus(statusChanges)).toBe("idle");

      // Agent runs a tool as part of a bash-mode-triggered turn.
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("PreToolUse transitions to busy after PermissionRequest", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Start session and make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Permission request puts us in idle
      await sendHook(port, "PermissionRequest", { workspacePath: "/workspace/feature-a" });

      expect(lastStatus(statusChanges)).toBe("idle");

      // PreToolUse after PermissionRequest should transition to busy
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("permission dialog: real hook ordering stays idle while pending, busy on approve", async () => {
      // Mirrors the real Claude Code ordering observed in the bridge logs, which
      // differs from the simplified test above:
      //   PreToolUse (busy, pre-dialog) → no change
      //   PermissionRequest             → idle  (dialog shown)
      //   PreToolUse (idle, on approve) → busy  (tool runs)
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // Tool wants to run — PreToolUse fires first, while still busy (no change).
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });
      expect(lastStatus(statusChanges)).toBe("busy");

      // Dialog appears → idle while it waits for the user.
      await sendHook(port, "PermissionRequest", { workspacePath: "/workspace/feature-a" });
      expect(lastStatus(statusChanges)).toBe("idle");

      // User approves → the tool runs, PreToolUse fires again → busy.
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("PreToolUse flag is cleared after use", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Start session and make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Permission request
      await sendHook(port, "PermissionRequest", { workspacePath: "/workspace/feature-a" });
      // First PreToolUse clears the flag
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      // Second PreToolUse should NOT change status (flag already cleared)
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      // Should only have 4 status changes, not 5
      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("ignores hooks for unknown workspaces", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      // Send hook for unknown workspace - should not throw
      const response = await sendHook(port, "SessionStart", {
        workspacePath: "/unknown/workspace",
      });

      expect(response.ok).toBe(true);
    });

    it("returns 400 for invalid hook name", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const response = await sendHook(port, "InvalidHook", {
        workspacePath: "/workspace/feature-a",
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const response = await fetch(`http://127.0.0.1:${port}/hook/SessionStart`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: "not json",
      });

      expect(response.status).toBe(400);
    });

    it("returns 405 for non-POST requests", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const response = await fetch(`http://127.0.0.1:${port}/hook/SessionStart`, {
        method: "GET",
        headers: { Connection: "close" },
      });

      expect(response.status).toBe(405);
    });
  });

  describe("restartServer", () => {
    it("restarts workspace and preserves port", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const result = await serverManager.restartServer("/workspace/feature-a");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.port).toBe(port);
      }
    });

    it("fires stop and start callbacks during restart", async () => {
      const startedCallback = vi.fn();
      const stoppedCallback = vi.fn();
      const callOrder: string[] = [];

      serverManager.onServerStarted(() => {
        callOrder.push("started");
        startedCallback();
      });
      serverManager.onServerStopped(() => {
        callOrder.push("stopped");
        stoppedCallback();
      });

      await serverManager.startServer("/workspace/feature-a");
      callOrder.length = 0; // Reset for restart test

      await serverManager.restartServer("/workspace/feature-a");

      expect(stoppedCallback).toHaveBeenCalled();
      expect(startedCallback).toHaveBeenCalledTimes(2); // Initial + restart
      expect(callOrder).toEqual(["stopped", "started"]);
    });

    it("stopped callback has isRestart=true during restart", async () => {
      const stoppedCallback = vi.fn();
      serverManager.onServerStopped(stoppedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.restartServer("/workspace/feature-a");

      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-a", true);
    });

    it("fails for unregistered workspace", async () => {
      const result = await serverManager.restartServer("/unknown/workspace");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not registered");
      }
    });

    it("preserves status callbacks across restart", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      expect(lastStatus(statusChanges)).toBe("busy");

      // Restart
      await serverManager.restartServer("/workspace/feature-a");

      // Callback should still work after restart
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      expect(statusChanges).toContain("idle");
    });
  });

  describe("config file generation", () => {
    it("generates hooks config file", async () => {
      await serverManager.startServer("/workspace/feature-a");

      // Find the generated config file
      const entries = [...mockFileSystem.$.entries.entries()];
      const hooksConfig = entries.find(([path]) => path.includes("codehydra-hooks.json"));

      expect(hooksConfig).toBeDefined();
      if (hooksConfig) {
        const [, entry] = hooksConfig;
        expect(entry.type).toBe("file");
        if (entry.type === "file") {
          const content =
            typeof entry.content === "string" ? entry.content : entry.content.toString();
          // Should contain hook handler path
          expect(content).toContain("/mock/hook-handler.js");
          // Should contain hook definitions
          expect(content).toContain("SessionStart");
          expect(content).toContain("UserPromptSubmit");
        }
      }
    });

    it("generates MCP config file", async () => {
      serverManager.setMcpConfig({ port: 9999 });
      await serverManager.startServer("/workspace/feature-a");

      // Find the generated config file
      const entries = [...mockFileSystem.$.entries.entries()];
      const mcpConfig = entries.find(([path]) => path.includes("codehydra-mcp.json"));

      expect(mcpConfig).toBeDefined();
      if (mcpConfig) {
        const [, entry] = mcpConfig;
        expect(entry.type).toBe("file");
        if (entry.type === "file") {
          const content =
            typeof entry.content === "string" ? entry.content : entry.content.toString();
          // Should contain MCP port
          expect(content).toContain("9999");
          // Should contain workspace path
          expect(content).toContain("/workspace/feature-a");
        }
      }
    });
  });

  describe("config path getters", () => {
    it("returns consistent paths for hooks config", async () => {
      await serverManager.startServer("/workspace/feature-a");

      const path1 = serverManager.getHooksConfigPath("/workspace/feature-a");
      const path2 = serverManager.getHooksConfigPath("/workspace/feature-a");

      expect(path1.toString()).toBe(path2.toString());
      expect(path1.toString()).toContain("codehydra-hooks.json");
    });

    it("returns consistent paths for MCP config", async () => {
      await serverManager.startServer("/workspace/feature-a");

      const path1 = serverManager.getMcpConfigPath("/workspace/feature-a");
      const path2 = serverManager.getMcpConfigPath("/workspace/feature-a");

      expect(path1.toString()).toBe(path2.toString());
      expect(path1.toString()).toContain("codehydra-mcp.json");
    });

    it("returns different paths for different workspaces", async () => {
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      const pathA = serverManager.getHooksConfigPath("/workspace/feature-a");
      const pathB = serverManager.getHooksConfigPath("/workspace/feature-b");

      expect(pathA.toString()).not.toBe(pathB.toString());
    });
  });

  describe("dispose", () => {
    it("stops all workspaces and server", async () => {
      const stoppedCallback = vi.fn();
      serverManager.onServerStopped(stoppedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      await serverManager.dispose();

      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-a", false);
      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-b", false);
    });

    it("is safe to call multiple times", async () => {
      await serverManager.startServer("/workspace/feature-a");

      await serverManager.dispose();
      await serverManager.dispose(); // Should not throw
    });
  });

  describe("initial prompt", () => {
    it("setInitialPrompt stores path retrievable via getInitialPromptPath", async () => {
      await serverManager.startServer("/workspace/feature-a");

      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "Hello, Claude!",
      });

      const path = serverManager.getInitialPromptPath("/workspace/feature-a");
      expect(path).toBeDefined();
      expect(path?.toString()).toContain("initial-prompt.json");
    });

    it("initial prompt file contains correct JSON structure", async () => {
      await serverManager.startServer("/workspace/feature-a");

      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "Test prompt",
        agentName: "coder",
        permissionMode: "plan",
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
      });

      const path = serverManager.getInitialPromptPath("/workspace/feature-a");
      expect(path).toBeDefined();

      // Read file from mock filesystem
      const content = await mockFileSystem.readFile(path!);
      const parsed = JSON.parse(content);

      expect(parsed.prompt).toBe("Test prompt");
      expect(parsed.agentName).toBe("coder");
      expect(parsed.permissionMode).toBe("plan");
      expect(parsed.model).toBe("claude-sonnet"); // modelID only, not full object
    });

    it("getInitialPromptPath returns undefined when no prompt set", async () => {
      await serverManager.startServer("/workspace/feature-a");

      const path = serverManager.getInitialPromptPath("/workspace/feature-a");
      expect(path).toBeUndefined();
    });

    it("getInitialPromptPath returns undefined for unknown workspace", async () => {
      const path = serverManager.getInitialPromptPath("/workspace/unknown");
      expect(path).toBeUndefined();
    });

    it("setInitialPrompt logs warning for unknown workspace", async () => {
      // Should not throw, just log warning and return
      await expect(
        serverManager.setInitialPrompt("/workspace/unknown", { prompt: "Test" })
      ).resolves.not.toThrow();
    });

    it("WrapperStart with non-plan initial prompt sets status to busy", async () => {
      await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      const markActiveHandler = vi.fn();
      serverManager.setMarkActiveHandler(markActiveHandler);

      // Set initial prompt without plan agent (agent undefined → non-plan)
      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "Build a feature",
      });

      // WrapperStart should set status to busy instead of idle
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");

      expect(statusChanges).toEqual(["busy"]);
      expect(markActiveHandler).toHaveBeenCalledWith("/workspace/feature-a");
    });

    it("SessionStart stays busy with non-plan initial prompt", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "Build a feature",
      });

      // Full startup sequence: WrapperStart → SessionStart → UserPromptSubmit
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // Should stay busy throughout — no idle blip
      expect(statusChanges).toEqual(["busy"]);
    });

    it("WrapperStart with a plan-mode prompt still sets status to busy (mode is irrelevant)", async () => {
      await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      const markActiveHandler = vi.fn();
      serverManager.setMarkActiveHandler(markActiveHandler);

      // A prompt is given — the agent works on it regardless of permission mode.
      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "Plan a feature",
        permissionMode: "plan",
      });

      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");

      expect(statusChanges).toEqual(["busy"]);
    });

    it("WrapperStart with an agent/mode-only prompt (empty text) sets status to idle", async () => {
      await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Only an agent name was chosen — no prompt text to process.
      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "",
        agentName: "reviewer",
      });

      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");

      expect(statusChanges).toEqual(["idle"]);
    });

    it("WrapperStart without initial prompt sets status to idle", async () => {
      await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // No setInitialPrompt called

      // WrapperStart should set status to idle (normal behavior)
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");

      expect(statusChanges).toEqual(["idle"]);
    });

    it("flag consumed on SessionStart, subsequent session goes idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await serverManager.setInitialPrompt("/workspace/feature-a", {
        prompt: "Build a feature",
      });

      // First session: flag consumed on SessionStart
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperEnd");

      // Second session: normal idle behavior
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");

      expect(statusChanges).toEqual(["busy", "idle", "none", "idle"]);
    });

    it("setInitialPrompt handles mkdtemp failure gracefully", async () => {
      await serverManager.startServer("/workspace/feature-a");

      // Make mkdtemp throw an error
      mockFileSystem.$.mkdtempShouldFail = true;

      // Should not throw - logs error and continues
      await expect(
        serverManager.setInitialPrompt("/workspace/feature-a", { prompt: "Test" })
      ).resolves.not.toThrow();

      // Path should not be set since mkdtemp failed
      const path = serverManager.getInitialPromptPath("/workspace/feature-a");
      expect(path).toBeUndefined();

      // Reset for other tests
      mockFileSystem.$.mkdtempShouldFail = false;
    });
  });

  describe("no-session marker", () => {
    it("setNoSessionMarker stores path retrievable via getNoSessionMarkerPath", async () => {
      await serverManager.startServer("/workspace/feature-a");

      await serverManager.setNoSessionMarker("/workspace/feature-a");

      const path = serverManager.getNoSessionMarkerPath("/workspace/feature-a");
      expect(path).toBeDefined();
      expect(path?.toString()).toContain("claude/no-session/");
    });

    it("getNoSessionMarkerPath returns undefined when no marker set", async () => {
      await serverManager.startServer("/workspace/feature-a");

      const path = serverManager.getNoSessionMarkerPath("/workspace/feature-a");
      expect(path).toBeUndefined();
    });

    it("getNoSessionMarkerPath returns undefined for unknown workspace", () => {
      const path = serverManager.getNoSessionMarkerPath("/workspace/unknown");
      expect(path).toBeUndefined();
    });

    it("setNoSessionMarker logs warning for unknown workspace", async () => {
      await expect(serverManager.setNoSessionMarker("/workspace/unknown")).resolves.not.toThrow();
    });

    it("marker file is created as empty file", async () => {
      await serverManager.startServer("/workspace/feature-a");

      await serverManager.setNoSessionMarker("/workspace/feature-a");

      const path = serverManager.getNoSessionMarkerPath("/workspace/feature-a");
      expect(path).toBeDefined();

      const content = await mockFileSystem.readFile(path!);
      expect(content).toBe("");
    });
  });

  describe("sub-agent tracking", () => {
    it("StopFailure suppressed when sub-agents are active", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      // Main agent hits API error, but sub-agent is still running
      await sendHook(port, "StopFailure", { workspacePath: "/workspace/feature-a" });

      // Should stay busy — StopFailure suppressed
      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("StopFailure without sub-agents transitions to idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "StopFailure", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("Stop suppressed to busy when sub-agents are active", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Sub-agent spawned
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      // Main agent stops, but sub-agent is still running
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // Should stay busy — Stop suppressed
      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("last SubagentStop stays busy, subsequent Stop goes idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-2",
      });
      // Main agent stops
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // First sub-agent stops — still one active
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      expect(lastStatus(statusChanges)).toBe("busy");

      // Last sub-agent stops — stays busy (main agent will resume to process result)
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-2",
      });
      expect(lastStatus(statusChanges)).toBe("busy");

      // Main agent resumes, processes result, then stops → real idle
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("SubagentStop without prior SubagentStart is a safe no-op", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // SubagentStop for unknown agent — should not crash or change status
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "unknown-agent",
      });

      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("SubagentStart without agent_id is ignored", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // SubagentStart without agent_id — no tracking
      await sendHook(port, "SubagentStart", { workspacePath: "/workspace/feature-a" });

      // Stop should go idle normally (no sub-agents tracked)
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("sub-agent result processing: full cycle stays busy until final Stop", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Matches real log trace: SubagentStart → Stop(suppressed) → SubagentStop → UserPromptSubmit → Stop(idle)
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      // Main agent resumes to process sub-agent result
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Main agent finishes processing → real idle
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // Only one idle transition — no false idle blip after SubagentStop
      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("WrapperEnd clears sub-agent tracking", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      // Main agent stops (suppressed)
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // WrapperEnd — clears all tracking
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperEnd");

      expect(statusChanges).toEqual(["idle", "busy", "none"]);

      // New session: Stop should go idle normally (sub-agent tracking was cleared)
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperStart");
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "none", "idle", "busy", "idle"]);
    });

    it("SessionEnd clears sub-agent tracking", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      // Main agent stops (suppressed)
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // SessionEnd — clears all tracking
      await sendHook(port, "SessionEnd", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "none"]);
    });

    it("orphaned sub-agent (SubagentStop never fires) stays busy until a terminal hook clears it", async () => {
      // Deliberate trade-off: UserPromptSubmit no longer clears sub-agent tracking
      // (that dropped still-running background sub-agents). Claude Code pairs
      // SubagentStart/SubagentStop reliably, so a missing SubagentStop is a crash —
      // rare — and is cleared by the terminal hooks rather than a timeout reaper.
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Sub-agent spawned but SubagentStop never fires (e.g., sub-agent crashes).
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-orphan",
      });

      // The orphan keeps the workspace busy — Stop is suppressed and a new prompt
      // no longer clears it.
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      expect(lastStatus(statusChanges)).toBe("busy");

      // A terminal hook (workspace close) clears the orphan.
      serverManager.triggerWrapperLifecycle("/workspace/feature-a", "WrapperEnd");
      expect(lastStatus(statusChanges)).toBe("none");
    });

    it("concurrent sub-agents: UserPromptSubmit mid-run does not drop still-running sub-agents", async () => {
      // Reproduces the real 2026-07-07 trace: 3 background sub-agents spawned, one
      // finishes and the main agent resumes (UserPromptSubmit) then Stops while the
      // other two are still running. The workspace must stay busy until the last
      // SubagentStop, not blip to idle when the resume-prompt arrives.
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      for (const id of ["sub-1", "sub-2", "sub-3"]) {
        await sendHook(port, "SubagentStart", {
          workspacePath: "/workspace/feature-a",
          agent_id: id,
        });
      }
      // Main agent goes quiet with 3 sub-agents running (Stop suppressed).
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      expect(lastStatus(statusChanges)).toBe("busy");

      // First sub-agent finishes; main agent resumes to consume its result, then Stops.
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      // Two sub-agents still running — must NOT go idle here (the reported bug).
      expect(lastStatus(statusChanges)).toBe("busy");

      // Remaining sub-agents finish; main agent resumes and finishes → real idle.
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-2",
      });
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-3",
      });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // Single clean idle transition — no premature blip while sub-agents ran.
      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("single sub-agent: UserPromptSubmit between start and stop keeps workspace busy", async () => {
      // A UserPromptSubmit landing while one sub-agent is still running (the main
      // agent resumed) must not drop it and let the following Stop go idle.
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      // Interleaved resume-prompt while the sub-agent is still running.
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      expect(lastStatus(statusChanges)).toBe("busy");

      // Sub-agent finishes, main agent resumes and finishes → idle.
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("idle_prompt Notification stays busy while a sub-agent is active", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Matches real log trace: main agent dispatches a sub-agent then goes quiet;
      // Claude Code fires idle_prompt ~60s later while the sub-agent still runs.
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });
      // idle_prompt must NOT blip to idle — the sub-agent is still working
      await sendHook(port, "Notification", {
        workspacePath: "/workspace/feature-a",
        notification_type: "idle_prompt",
      });

      expect(lastStatus(statusChanges)).toBe("busy");

      // Sub-agent finishes, main agent resumes and finishes → single idle transition
      await sendHook(port, "SubagentStop", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // No false idle blip across the whole sub-agent run
      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("AskUserQuestion idle survives concurrent sub-agent tool activity", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Real trace: the main agent dispatches background sub-agents, then asks the
      // user a question. While the question is open, the sub-agents' own tool
      // calls emit PostToolUse (→busy) on this same workspace bridge — which used
      // to stomp the ask-user idle. They must now be suppressed so the workspace
      // stays idle until the user actually answers.
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });
      expect(lastStatus(statusChanges)).toBe("idle");

      // Concurrent sub-agent tool traffic — none of this may flip us to busy.
      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "Agent",
      });
      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "WebSearch",
      });
      expect(lastStatus(statusChanges)).toBe("idle");

      // The user answers → PostToolUse(AskUserQuestion) returns to busy.
      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("AskUserQuestion idle is not resolved by a concurrent sub-agent PreToolUse", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // AskUserQuestion also fires its own PermissionRequest. The generic
      // permission flow would let the *next* PreToolUse (here a sub-agent's)
      // resolve it back to busy — that must not happen while parked.
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SubagentStart", {
        workspacePath: "/workspace/feature-a",
        agent_id: "sub-1",
      });
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });
      await sendHook(port, "PermissionRequest", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });
      // A sub-agent starts a tool while the question is open.
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "Bash",
      });
      expect(lastStatus(statusChanges)).toBe("idle");

      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("AskUserQuestion unparks (→busy) on PostToolUseFailure so the flag can't stick", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });
      expect(lastStatus(statusChanges)).toBe("idle");

      // The question is cancelled/errors → PostToolUseFailure must clear the park.
      await sendHook(port, "PostToolUseFailure", {
        workspacePath: "/workspace/feature-a",
        tool_name: "AskUserQuestion",
      });
      expect(lastStatus(statusChanges)).toBe("busy");

      // Subsequent normal work is no longer suppressed to idle.
      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "Bash",
      });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "busy"]);
    });

    it("Stop without sub-agents still transitions to idle normally", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      // Normal flow — no sub-agents, Stop goes idle
      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });
  });

  describe("background shell handling (experimental.busy-during-background-shell)", () => {
    const WORKSPACE = "/workspace/feature-a";

    /** Background task entry as carried by the Stop payload (Claude Code 2.1.170). */
    function shellTask(command: string): Record<string, unknown> {
      return { id: "task-1", type: "shell", status: "running", description: command, command };
    }

    /** Stop payload with the given still-running background tasks. */
    function stopWithTasks(tasks: Record<string, unknown>[]): Record<string, unknown> {
      return { workspacePath: WORKSPACE, background_tasks: tasks };
    }

    function createManager(value: boolean | readonly string[]): ClaudeCodeServerManager {
      return new ClaudeCodeServerManager({
        portManager: mockPortManager,
        pathProvider: mockPathProvider,
        fileSystem: mockFileSystem,
        logger: SILENT_LOGGER,
        config: { hookHandlerPath: "/mock/hook-handler.js" },
        busyDuringBackgroundShell: createMockAccessor<boolean | readonly string[]>(
          "experimental.busy-during-background-shell",
          value,
          false
        ),
      });
    }

    async function startBusyWorkspace(manager: ClaudeCodeServerManager): Promise<{
      port: number;
      statusChanges: AgentStatus[];
    }> {
      const port = await manager.startServer(WORKSPACE);
      const statusChanges: AgentStatus[] = [];
      manager.onStatusChange(WORKSPACE, (status) => {
        statusChanges.push(status);
      });
      await sendHook(port, "SessionStart", { workspacePath: WORKSPACE });
      await sendHook(port, "UserPromptSubmit", { workspacePath: WORKSPACE });
      return { port, statusChanges };
    }

    it("true: Stop with a running background shell stays busy", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("npx tsx ship-wait.ts 512")]));

      expect(statusChanges).toEqual(["idle", "busy"]);
    });

    it("true: Stop with no background tasks goes idle", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([]));

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("true: Stop without a background_tasks field goes idle", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", { workspacePath: WORKSPACE });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("true: idle_prompt Notification after suppressed Stop stays busy", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("npx tsx ship-wait.ts 512")]));
      // ~60s after Stop, Claude Code sends an idle_prompt notification
      await sendHook(port, "Notification", {
        workspacePath: WORKSPACE,
        notification_type: "idle_prompt",
      });

      expect(lastStatus(statusChanges)).toBe("busy");
    });

    it("true: full cycle — resume after shell exit, final Stop goes idle", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("npx tsx ship-wait.ts 512")]));
      // Shell exits → harness re-invokes the agent with the task notification
      await sendHook(port, "UserPromptSubmit", { workspacePath: WORKSPACE });
      await sendHook(port, "Stop", stopWithTasks([]));

      // Exactly one idle transition — no false idle while waiting
      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("patterns: matching command keeps busy", async () => {
      serverManager = createManager(["ship-wait"]);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("npx tsx ship-wait.ts 512")]));

      expect(lastStatus(statusChanges)).toBe("busy");
    });

    it("patterns: non-matching command (dev server) goes idle", async () => {
      serverManager = createManager(["ship-wait"]);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(
        port,
        "Stop",
        stopWithTasks([shellTask("python3 -m http.server 8000 --bind 127.0.0.1")])
      );

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("patterns: one matching among non-matching tasks keeps busy", async () => {
      serverManager = createManager(["ship-wait"]);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(
        port,
        "Stop",
        stopWithTasks([
          shellTask("python3 -m http.server 8000"),
          shellTask("npx tsx ship-wait.ts 512"),
        ])
      );

      expect(lastStatus(statusChanges)).toBe("busy");
    });

    it("non-shell task types do not keep busy", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(
        port,
        "Stop",
        stopWithTasks([{ id: "agent-1", type: "agent", status: "running" }])
      );

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("real user prompt clears the stash — idle_prompt then goes idle", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("pnpm dev")]));
      expect(lastStatus(statusChanges)).toBe("busy");

      // User re-engages; agent goes busy, then the turn ends at its idle prompt
      await sendHook(port, "UserPromptSubmit", { workspacePath: WORKSPACE });
      await sendHook(port, "Notification", {
        workspacePath: WORKSPACE,
        notification_type: "idle_prompt",
      });

      expect(lastStatus(statusChanges)).toBe("idle");
    });

    it("StopFailure is suppressed like Stop", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "StopFailure", stopWithTasks([shellTask("npx tsx ship-wait.ts 512")]));

      expect(lastStatus(statusChanges)).toBe("busy");
    });

    it("flag disabled: Stop goes idle even with a running background shell", async () => {
      serverManager = createManager(false);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("npx tsx ship-wait.ts 512")]));

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("WrapperEnd clears the stash", async () => {
      serverManager = createManager(true);
      const { port, statusChanges } = await startBusyWorkspace(serverManager);

      await sendHook(port, "Stop", stopWithTasks([shellTask("pnpm dev")]));
      serverManager.triggerWrapperLifecycle(WORKSPACE, "WrapperEnd");

      // New session: idle_prompt is not suppressed by the stale stash
      serverManager.triggerWrapperLifecycle(WORKSPACE, "WrapperStart");
      await sendHook(port, "SessionStart", { workspacePath: WORKSPACE });
      await sendHook(port, "UserPromptSubmit", { workspacePath: WORKSPACE });
      await sendHook(port, "Stop", { workspacePath: WORKSPACE });

      expect(statusChanges).toEqual(["idle", "busy", "none", "idle", "busy", "idle"]);
    });
  });
});
