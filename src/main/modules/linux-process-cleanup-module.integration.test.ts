// @vitest-environment node
/**
 * Integration tests for LinuxProcessCleanupModule.
 *
 * Tests verify: detection parsing, kill invocation, and module release hook behavior
 * through mocked ProcessRunner (runs on all platforms).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type ReleaseHookResult,
} from "../operations/delete-workspace";
import {
  createLinuxProcessCleanupModule,
  detectLinuxCwdProcesses,
  killUnixProcesses,
} from "./linux-process-cleanup-module";
import { SILENT_LOGGER } from "../../services/logging";
import { createBehavioralLogger } from "../../services/logging/logging.test-utils";
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
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  dispatcher.registerOperation("workspace:delete", releaseOperation);

  const module = createLinuxProcessCleanupModule({
    processRunner: runner,
    logger,
  });
  dispatcher.registerModule(module);

  return dispatcher;
}

// =============================================================================
// detectLinuxCwdProcesses
// =============================================================================

describe("detectLinuxCwdProcesses", () => {
  it("parses tab-separated output into DetectedProcess array", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({
        stdout:
          "1234\tbash\t/workspaces/feature-1\tbash --login\n5678\tnode\t/workspaces/feature-1/subdir\tnode index.js\n",
        exitCode: 0,
      }),
    });

    const result = await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual([
      { pid: 1234, name: "bash", cwd: "/workspaces/feature-1", cmdline: "bash --login" },
      { pid: 5678, name: "node", cwd: "/workspaces/feature-1/subdir", cmdline: "node index.js" },
    ]);
  });

  it("returns empty array for empty output", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", exitCode: 0 }),
    });

    const result = await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual([]);
  });

  it("returns empty array on non-zero exit code", async () => {
    const logger = createBehavioralLogger();
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", stderr: "error", exitCode: 2 }),
    });

    const result = await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", logger);

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

    const result = await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", logger);

    expect(result).toEqual([]);
    const warnings = logger.getMessagesByLevel("warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe("Process detection timed out");
  });

  it("filters out own process PID", async () => {
    const ownPid = process.pid;
    const runner = createMockProcessRunner({
      onSpawn: () => ({
        stdout: `${ownPid}\tbash\t/workspaces/feature-1\tbash\n9999\tnode\t/workspaces/feature-1\tnode\n`,
        exitCode: 0,
      }),
    });

    const result = await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toHaveLength(1);
    expect(result[0]!.pid).toBe(9999);
  });

  it("skips malformed lines", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({
        stdout:
          "not-a-pid\tbash\t/workspaces/feature-1\n\n1234\tbash\t/workspaces/feature-1\tbash\n",
        exitCode: 0,
      }),
    });

    const result = await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toHaveLength(1);
    expect(result[0]!.pid).toBe(1234);
  });

  it("passes workspace path via TARGET_PATH env var", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ stdout: "", exitCode: 0 }),
    });

    await detectLinuxCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    const spawned = runner.$.spawned(0);
    expect(spawned.$.env).toBeDefined();
    expect(spawned.$.env!.TARGET_PATH).toBe("/workspaces/feature-1");
  });
});

// =============================================================================
// killUnixProcesses
// =============================================================================

describe("killUnixProcesses", () => {
  it("runs kill -TERM with correct PID args", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ exitCode: 0 }),
    });

    await killUnixProcesses(runner, [1234, 5678], SILENT_LOGGER);

    expect(runner).toHaveSpawned([{ command: "kill", args: ["-TERM", "1234", "5678"] }]);
  });

  it("throws on non-zero exit code", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ exitCode: 1, stderr: "No such process" }),
    });

    await expect(killUnixProcesses(runner, [1234], SILENT_LOGGER)).rejects.toThrow(
      "kill -TERM failed"
    );
  });

  it("does nothing when pids array is empty", async () => {
    const runner = createMockProcessRunner();

    await killUnixProcesses(runner, [], SILENT_LOGGER);

    expect(() => runner.$.spawned(0)).toThrow();
  });
});

// =============================================================================
// Module release hook
// =============================================================================

describe("LinuxProcessCleanupModule Integration", () => {
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
            // Detection: return processes
            return {
              stdout: "1234\tbash\t/workspaces/feature-1\tbash\n",
              exitCode: 0,
            };
          }
          // Kill: success
          return { exitCode: 0 };
        },
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Verify detection was called (bash -c <script>)
      const detectProc = runner.$.spawned(0);
      expect(detectProc.$.command).toBe("bash");

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
              stdout: "1234\tbash\t/workspaces/feature-1\tbash\n",
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
      expect(runner.$.spawned(0).$.command).toBe("bash");
      expect(() => runner.$.spawned(1)).toThrow();
    });
  });
});
