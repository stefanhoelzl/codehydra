// @vitest-environment node
/**
 * Integration tests for PosixProcessCleanupModule.
 *
 * Tests verify: detection through ProcessRunner.findDirectoryHolders, termination
 * via ProcessRunner.kill, and module release hook behavior through a mocked
 * ProcessRunner (runs on all platforms).
 *
 * Paths here stay POSIX on purpose — unlike the rest of the integration suite,
 * which feeds the code under test OS-native paths. The module declares
 * `requires: { posix: true }`, so a Windows path is a shape this code is never
 * handed.
 */

import { AsyncLogScopeStore } from "../boundaries/platform/log-scope";
import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import type { Intent } from "../intents/lib/types";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspaceIntent,
  type ReleaseHookResult,
} from "../intents/delete-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateReleaseHookResult,
} from "../intents/hibernate-workspace";
import {
  createPosixProcessCleanupModule,
  detectCwdProcesses,
  killPosixProcesses,
} from "./posix-process-cleanup-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import { createMockProcessRunner } from "../boundaries/platform/process.state-mock";
import type { MockProcessRunner } from "../boundaries/platform/process.state-mock";
import { directoryHolders, type HolderScanCall } from "../boundaries/platform/process.state-mock";

// =============================================================================
// Test Helpers
// =============================================================================

/** A shell sitting in the workspace root. */
const BASH = { pid: 1234, name: "bash", commandLine: "bash", cwd: "." };

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

const releaseOperation = createMinimalOperation<ReleaseHookResult>(
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
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
    logScope: new AsyncLogScopeStore(),
    logger: createMockLogger(),
    initialCapabilities: { posix: true },
  });
  dispatcher.registerOperation(releaseOperation);

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
  it("asks for the workspace's CWD holders, within its budget", async () => {
    const calls: HolderScanCall[] = [];
    const runner = createMockProcessRunner({ directoryHolders: directoryHolders([], calls) });

    await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(calls).toEqual([{ dir: "/workspaces/feature-1", files: false, timeoutMs: 10_000 }]);
  });

  it("returns the holders with their working directory", async () => {
    const runner = createMockProcessRunner({
      directoryHolders: directoryHolders([
        { pid: 1234, name: "bash", commandLine: "bash", cwd: "." },
        { pid: 5678, name: "node", commandLine: "node server.js", cwd: "subdir" },
      ]),
    });

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER);

    expect(result).toEqual({
      timedOut: false,
      processes: [
        { pid: 1234, name: "bash", cwd: "." },
        { pid: 5678, name: "node", cwd: "subdir" },
      ],
    });
  });

  it("reports a timeout rather than an empty result", async () => {
    const runner = createMockProcessRunner({ directoryHolders: directoryHolders("timeout") });
    const logger = createBehavioralLogger();

    const result = await detectCwdProcesses(runner, "/workspaces/feature-1", logger);

    expect(result).toEqual({ processes: [], timedOut: true });
    expect(logger.getMessagesByLevel("warn")[0]?.message).toBe("Process detection timed out");
  });

  it("throws when the scan cannot run, rather than reporting nothing found", async () => {
    const runner = createMockProcessRunner({
      directoryHolders: directoryHolders(new Error("no native addon")),
    });

    await expect(
      detectCwdProcesses(runner, "/workspaces/feature-1", SILENT_LOGGER)
    ).rejects.toThrow("no native addon");
  });
});

// =============================================================================
// killPosixProcesses
// =============================================================================

describe("killPosixProcesses", () => {
  it("terminates every PID through ProcessRunner.kill, spawning nothing", async () => {
    const runner = createMockProcessRunner();

    await expect(killPosixProcesses(runner, [1234, 5678])).resolves.toEqual([]);

    expect(runner.$.killedPids).toEqual([1234, 5678]);
    expect(() => runner.$.spawned(0)).toThrow();
  });

  it("returns the PIDs that survived", async () => {
    const runner = createMockProcessRunner({
      onKill: (pid) => (pid === 5678 ? { success: false } : undefined),
    });

    await expect(killPosixProcesses(runner, [1234, 5678])).resolves.toEqual([5678]);
  });

  it("does nothing when pids array is empty", async () => {
    const runner = createMockProcessRunner();

    await expect(killPosixProcesses(runner, [])).resolves.toEqual([]);

    expect(runner.$.killedPids).toEqual([]);
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
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({ directoryHolders: directoryHolders([BASH], calls) });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // One scan of the workspace, nothing spawned, the holder terminated.
      expect(calls.map((call) => call.dir)).toEqual(["/workspaces/feature-1"]);
      expect(() => runner.$.spawned(0)).toThrow();
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("still kills CWD-blocking processes when force=true", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders([BASH]) });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent({ force: true }));

      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("reports a timed-out detection on the release result without failing", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders("timeout") });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toContain("scan timed out");
    });

    it("reports a thrown detection error on the release result", async () => {
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders(new Error("scan exploded")),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toBe("scan exploded");
    });

    it("names the processes that survive the kill on the release result", async () => {
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders([
          BASH,
          { pid: 5678, name: "node", commandLine: "node", cwd: "." },
        ]),
        onKill: (pid) => ({ success: pid !== 1234 }),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toBe("Could not terminate: bash (pid 1234)");
    });

    it("reports nothing when every detected process is killed", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders([BASH]) });

      const dispatcher = createReleaseSetup(runner);
      const result = await dispatcher.dispatch(makeDeleteIntent());

      expect(result).toEqual({});
    });

    it("skips kill when no processes detected", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders([]) });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      expect(runner.$.killedPids).toEqual([]);
    });
  });

  describe("hibernate-workspace -> release", () => {
    const hibernateReleaseOperation = createMinimalOperation<HibernateReleaseHookResult>(
      HIBERNATE_WORKSPACE_OPERATION_ID,
      INTENT_HIBERNATE_WORKSPACE,
      "release",
      {
        hookContext: (ctx) => ({
          intent: ctx.intent,
          projectPath: "/projects/my-app",
          workspacePath:
            (ctx.intent as { payload: { workspacePath?: string } }).payload.workspacePath ?? "",
          projectId: "proj-1",
          workspaceName: "feature-1",
        }),
      }
    );

    function createHibernateReleaseSetup(r: MockProcessRunner, logger = SILENT_LOGGER) {
      const dispatcher = new Dispatcher({
        logScope: new AsyncLogScopeStore(),
        logger: createMockLogger(),
        initialCapabilities: { posix: true },
      });
      dispatcher.registerOperation(hibernateReleaseOperation);
      dispatcher.registerModule(createPosixProcessCleanupModule({ processRunner: r, logger }));
      return dispatcher;
    }

    function makeHibernateIntent(): Intent {
      return {
        type: "workspace:hibernate",
        payload: { workspacePath: "/workspaces/feature-1" },
      } as unknown as Intent;
    }

    it("detects and kills CWD-blocking processes (no force gate)", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders([BASH]) });

      const dispatcher = createHibernateReleaseSetup(runner);
      await dispatcher.dispatch(makeHibernateIntent());

      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("logs, rather than reports, a survivor during hibernation", async () => {
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders([BASH]),
        onKill: () => ({ success: false }),
      });
      const logger = createBehavioralLogger();

      const dispatcher = createHibernateReleaseSetup(runner, logger);
      const result = await dispatcher.dispatch(makeHibernateIntent());

      expect(result).toEqual({});
      const warnings = logger.getMessagesByLevel("warn");
      expect(
        warnings.find((w) => w.message === "CWD process cleanup failed")?.context
      ).toMatchObject({ error: "Could not terminate: bash (pid 1234)" });
    });
  });
});
