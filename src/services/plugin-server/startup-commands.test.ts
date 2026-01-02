/**
 * Unit tests for startup commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { STARTUP_COMMANDS, sendStartupCommands } from "./startup-commands";
import type { PluginServer } from "./plugin-server";
import type { PluginResult } from "../../shared/plugin-protocol";
import { createMockLogger } from "../logging/logging.test-utils";

interface MockPluginServerOptions {
  /**
   * Results to return for each command.
   * If not specified, all commands succeed.
   */
  readonly commandResults?: Map<string, PluginResult<unknown>>;

  /**
   * Delay per command in ms (simulates network latency).
   */
  readonly delayMs?: number;
}

function createMockPluginServer(options?: MockPluginServerOptions): {
  server: PluginServer;
  sendCommand: ReturnType<typeof vi.fn>;
  commandOrder: string[];
} {
  const commandOrder: string[] = [];
  const delayMs = options?.delayMs ?? 0;
  const commandResults = options?.commandResults ?? new Map<string, PluginResult<unknown>>();

  const sendCommand = vi.fn(
    async (workspacePath: string, command: string): Promise<PluginResult<unknown>> => {
      // Track that the correct workspace was used
      void workspacePath;
      commandOrder.push(command);

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      return commandResults.get(command) ?? { success: true, data: undefined };
    }
  );

  const server = {
    sendCommand,
    // Minimal mock - only sendCommand is needed
    start: vi.fn(),
    close: vi.fn(),
    getPort: vi.fn().mockReturnValue(3000),
    isConnected: vi.fn().mockReturnValue(true),
    onConnect: vi.fn(),
  } as unknown as PluginServer;

  return { server, sendCommand, commandOrder };
}

// ============================================================================
// Tests
// ============================================================================

describe("STARTUP_COMMANDS", () => {
  it("has 7 command strings", () => {
    expect(STARTUP_COMMANDS).toHaveLength(7);
  });

  it("contains expected VS Code command IDs", () => {
    expect(STARTUP_COMMANDS).toContain("workbench.action.closeSidebar");
    expect(STARTUP_COMMANDS).toContain("workbench.action.closeAuxiliaryBar");
    expect(STARTUP_COMMANDS).toContain("opencode.openTerminal");
    expect(STARTUP_COMMANDS).toContain("workbench.action.unlockEditorGroup");
    expect(STARTUP_COMMANDS).toContain("workbench.action.closeEditorsInOtherGroups");
    expect(STARTUP_COMMANDS).toContain("codehydra.dictation.openPanel");
    expect(STARTUP_COMMANDS).toContain("workbench.action.terminal.focus");
  });

  it("is readonly tuple (type-level immutability)", () => {
    // as const creates a readonly tuple type at compile-time
    // Runtime verification: check that the array is not empty and contains strings
    expect(STARTUP_COMMANDS.length).toBeGreaterThan(0);
    expect(STARTUP_COMMANDS.every((cmd) => typeof cmd === "string")).toBe(true);
  });
});

describe("sendStartupCommands", () => {
  let mockServer: ReturnType<typeof createMockPluginServer>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockServer = createMockPluginServer();
    logger = createMockLogger();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("sends all 7 commands to correct workspace path", async () => {
      const promise = sendStartupCommands(mockServer.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockServer.sendCommand).toHaveBeenCalledTimes(7);

      // Verify each command was sent to correct workspace
      for (const command of STARTUP_COMMANDS) {
        expect(mockServer.sendCommand).toHaveBeenCalledWith(
          "/test/workspace",
          command,
          [],
          expect.any(Number)
        );
      }
    });

    it("sends commands sequentially (second waits for first)", async () => {
      // Create server with delay to verify sequential execution
      const mockWithDelay = createMockPluginServer({ delayMs: 10 });

      const promise = sendStartupCommands(mockWithDelay.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      // Verify commands were called in order
      expect(mockWithDelay.commandOrder).toEqual([
        "workbench.action.closeSidebar",
        "workbench.action.closeAuxiliaryBar",
        "opencode.openTerminal",
        "workbench.action.unlockEditorGroup",
        "workbench.action.closeEditorsInOtherGroups",
        "codehydra.dictation.openPanel",
        "workbench.action.terminal.focus",
      ]);
    });

    it("waits for delay before sending commands", async () => {
      const promise = sendStartupCommands(mockServer.server, "/test/workspace", logger, 100);

      // Before delay, no commands sent
      expect(mockServer.sendCommand).not.toHaveBeenCalled();

      // Advance partial time - still no commands
      await vi.advanceTimersByTimeAsync(50);
      expect(mockServer.sendCommand).not.toHaveBeenCalled();

      // Advance past delay
      await vi.advanceTimersByTimeAsync(50);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockServer.sendCommand).toHaveBeenCalledTimes(7);
    });
  });

  describe("error handling", () => {
    it("continues on failure of one command", async () => {
      const commandResults = new Map<string, PluginResult<unknown>>([
        ["opencode.openTerminal", { success: false, error: "Terminal not available" }],
      ]);
      const mockWithFailure = createMockPluginServer({ commandResults });

      const promise = sendStartupCommands(mockWithFailure.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      // All 7 commands should still be sent
      expect(mockWithFailure.sendCommand).toHaveBeenCalledTimes(7);
    });

    it("logs failures with command ID, error, and workspace path", async () => {
      const commandResults = new Map<string, PluginResult<unknown>>([
        ["opencode.openTerminal", { success: false, error: "Terminal not available" }],
      ]);
      const mockWithFailure = createMockPluginServer({ commandResults });

      const promise = sendStartupCommands(mockWithFailure.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      expect(logger.warn).toHaveBeenCalledWith("Startup command failed", {
        workspace: "/test/workspace",
        command: "opencode.openTerminal",
        error: "Terminal not available",
      });
    });

    it("handles multiple command failures gracefully", async () => {
      const commandResults = new Map<string, PluginResult<unknown>>([
        ["workbench.action.closeSidebar", { success: false, error: "Error 1" }],
        ["opencode.openTerminal", { success: false, error: "Error 2" }],
        ["workbench.action.closeEditorsInOtherGroups", { success: false, error: "Error 3" }],
      ]);
      const mockWithFailures = createMockPluginServer({ commandResults });

      const promise = sendStartupCommands(mockWithFailures.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      // All 7 commands should still be sent
      expect(mockWithFailures.sendCommand).toHaveBeenCalledTimes(7);

      // Should log 3 warnings
      expect(logger.warn).toHaveBeenCalledTimes(3);
    });
  });

  describe("invalid workspace path", () => {
    it("handles empty workspace path gracefully", async () => {
      const promise = sendStartupCommands(mockServer.server, "", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      // No commands should be sent
      expect(mockServer.sendCommand).not.toHaveBeenCalled();

      // Should log warning
      expect(logger.warn).toHaveBeenCalledWith("Startup commands skipped: invalid workspace path", {
        workspacePath: "",
      });
    });

    // Note: null/undefined workspace path testing removed because:
    // - TypeScript prevents passing null/undefined to string parameter at compile time
    // - Runtime validation is covered by the empty string test above
    // - The sendStartupCommands function validates falsy values (including null/undefined)
  });

  describe("logging", () => {
    it("logs debug message when starting", async () => {
      const promise = sendStartupCommands(mockServer.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      expect(logger.debug).toHaveBeenCalledWith("Sending startup commands", {
        workspace: "/test/workspace",
        commandCount: 7,
      });
    });

    it("logs debug message for each successful command", async () => {
      const promise = sendStartupCommands(mockServer.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      // 7 commands + 1 start + 1 complete = 9 debug calls
      expect(logger.debug).toHaveBeenCalledTimes(9);

      expect(logger.debug).toHaveBeenCalledWith("Startup command executed", {
        workspace: "/test/workspace",
        command: "workbench.action.closeSidebar",
      });
    });

    it("logs debug message when complete", async () => {
      const promise = sendStartupCommands(mockServer.server, "/test/workspace", logger, 0);
      await vi.runAllTimersAsync();
      await promise;

      expect(logger.debug).toHaveBeenCalledWith("Startup commands complete", {
        workspace: "/test/workspace",
      });
    });
  });
});
