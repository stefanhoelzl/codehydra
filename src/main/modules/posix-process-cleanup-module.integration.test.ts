// @vitest-environment node
/**
 * Integration tests for PosixProcessCleanupModule.
 *
 * Tests verify: lsof output parsing, kill invocation, and module release hook behavior
 * through mocked ProcessRunner (runs on all platforms).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type ReleaseHookResult,
} from "../operations/delete-workspace";
import {
  createPosixProcessCleanupModule,
  detectCwdProcesses,
  killPosixProcesses,
} from "./posix-process-cleanup-module";
import { SILENT_LOGGER } from "../../services/logging";
import {
  createBehavioralLogger,
  createMockLogger,
} from "../../services/logging/logging.test-utils";
import { createMockProcessRunner } from "../../services/platform/process.state-mock";
import type { MockProcessRunner } from "../../services/platform/process.state-mock";

// =============================================================================
// Test Helpers
// =============================================================================

function makeDeleteIntent(overrides?: Partial<DeleteWorkspaceIntent["payload"]>): Intent {
  return {
    type: "workspace:delete",
    payload: {
      projectId: "proj-1",
      workspaceName: "feature-1",
      workspacePath: "/workspaces/feature-1",
      projectPath: "/projects/my-app",
      keepBranch: true,
      force: false,
      removeWorktree: true,
      ...overrides,
    },
  } as unknown as Intent;
}

const releaseOperation = createMinimalOperation<Intent, ReleaseHookResult>(
  DELETE_WORKSPACE_OPERATION_ID,
  "release",
  {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      projectPath: "/projects/my-app",
      workspacePath:
        ((ctx.intent as DeleteWorkspaceIntent).payload as { workspacePath?: string })
          .workspacePath ?? "",
    }),
  }
);

function createReleaseSetup(runner: MockProcessRunner, logger = SILENT_LOGGER) {
  const dispatcher = new Dispatcher({
    logger: createMockLogger(),
    initialCapabilities: { posix: true },
  });
  dispatcher.registerOperation("workspace:delete", releaseOperation);

  const module = createPosixProcessCleanupModule({
    processRunner: runner,
    logger,
  });
  dispatcher.registerModule(module);

  return dispatcher;
}

// =============================================================================
// detectCwdProcesses
// =============================================================================

describe("detectCwdProcesses", () => {
  it("parses lsof -Fpnc output for matching processes", async () => {
    const lsofOutput = [
      "p1234",
      "cbash",
      "n/workspaces/feature-1",
      "p5678",
      "cnode",
      "n/workspaces/feature-1/subdir",
    ].join("\n");

    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: lsofOutput, exitCode: 0 }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual([
      { pid: 1234, name: "bash", cwd: "/workspaces/feature-1" },
      { pid: 5678, name: "node", cwd: "/workspaces/feature-1/subdir" },
    ]);
  });

  it("filters out processes outside workspace path (defense-in-depth)", async () => {
    const lsofOutput = [
      "p1234",
      "cbash",
      "n/workspaces/feature-1",
      "p5678",
      "cnode",
      "n/workspaces/other-workspace",
      "p9999",
      "czsh",
      "n/home/user",
    ].join("\n");

    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: lsofOutput, exitCode: 0 }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toHaveLength(1);
    expect(result[0]!.pid).toBe(1234);
  });

  it("returns empty array when no matches (defense-in-depth)", async () => {
    const lsofOutput = ["p1234", "cbash", "n/other/path"].join("\n");

    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: lsofOutput, exitCode: 0 }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual([]);
  });

  it("does not match workspace path as substring prefix (defense-in-depth)", async () => {
    const lsofOutput = ["p1234", "cbash", "n/workspaces/feature-10"].join("\n");

    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: lsofOutput, exitCode: 0 }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual([]);
  });

  it("treats lsof exit code 1 as no files found (not error)", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", exitCode: 1 }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual([]);
  });

  it("returns empty array on lsof failure (exit > 1)", async () => {
    const logger = createBehavioralLogger();
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", stderr: "lsof error", exitCode: 2 }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", logger);

    expect(result).toEqual([]);
    const warnings = logger.getMessagesByLevel("warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe("Process detection failed");
  });

  it("returns empty array on timeout", async () => {
    const logger = createBehavioralLogger();
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", exitCode: null, running: true }),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", logger);

    expect(result).toEqual([]);
    const warnings = logger.getMessagesByLevel("warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe("Process detection timed out");
  });

  it("invokes lsof with correct arguments", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", exitCode: 0 }),
    });

    await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(runner).toHaveSpawned([
      {
        command: "lsof",
        args: ["-a", "-d", "cwd", "+c", "0", "-Fpnc", "+D", "/workspaces/feature-1"],
      },
    ]);
  });
});

// =============================================================================
// killPosixProcesses
// =============================================================================

describe("killPosixProcesses", () => {
  it("runs kill -TERM with correct PID args", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ exitCode: 0 }),
    });

    await killPosixProcesses(runner, [1234, 5678]);

    expect(runner).toHaveSpawned([{ command: "kill", args: ["-TERM", "1234", "5678"] }]);
  });

  it("throws on non-zero exit code with real error", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ exitCode: 1, stderr: "kill: (1234): Operation not permitted" }),
    });

    await expect(killPosixProcesses(runner, [1234])).rejects.toThrow("kill -TERM failed");
  });

  it("treats 'No such process' as success", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({
        exitCode: 1,
        stderr: "kill: (1234): No such process\nkill: (5678): No such process\n",
      }),
    });

    await expect(killPosixProcesses(runner, [1234, 5678])).resolves.toBeUndefined();
  });

  it("does nothing when pids array is empty", async () => {
    const runner = createMockProcessRunner();

    await killPosixProcesses(runner, []);

    expect(() => runner.$.spawned(0)).toThrow();
  });
});

// =============================================================================
// Module release hook
// =============================================================================

describe("PosixProcessCleanupModule Integration", () => {
  let runner: MockProcessRunner;

  beforeEach(() => {
    runner = createMockProcessRunner();
  });

  describe("delete-workspace -> release", () => {
    it("detects and kills CWD-blocking processes", async () => {
      let callIndex = 0;
      runner = createMockProcessRunner({
        onSpawn: () => {
          callIndex++;
          if (callIndex === 1) {
            // Detection: return processes via lsof output
            return {
              stdout: "p1234\ncbash\nn/workspaces/feature-1\n",
              exitCode: 0,
            };
          }
          // Kill: success
          return { exitCode: 0 };
        },
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Verify detection was called (lsof)
      const detectProc = runner.$.spawned(0);
      expect(detectProc.$.command).toBe("lsof");

      // Verify kill was called
      const killProc = runner.$.spawned(1);
      expect(killProc.$.command).toBe("kill");
      expect(killProc.$.args).toEqual(["-TERM", "1234"]);
    });

    it("skips when force=true", async () => {
      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent({ force: true }));

      // No processes spawned
      expect(() => runner.$.spawned(0)).toThrow();
    });

    it("swallows errors from detection", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: null, running: true }),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = await dispatcher.dispatch(makeDeleteIntent());

      // No error propagated
      expect(result).toEqual({});
    });

    it("swallows errors from kill", async () => {
      let callIndex = 0;
      runner = createMockProcessRunner({
        onSpawn: () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              stdout: "p1234\ncbash\nn/workspaces/feature-1\n",
              exitCode: 0,
            };
          }
          // Kill fails
          return { exitCode: 1, stderr: "Operation not permitted" };
        },
      });

      const dispatcher = createReleaseSetup(runner);
      const result = await dispatcher.dispatch(makeDeleteIntent());

      // No error propagated
      expect(result).toEqual({});
    });

    it("skips kill when no processes detected", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ stdout: "", exitCode: 0 }),
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Only detection was spawned, no kill
      expect(runner.$.spawned(0).$.command).toBe("lsof");
      expect(() => runner.$.spawned(1)).toThrow();
    });
  });
});
