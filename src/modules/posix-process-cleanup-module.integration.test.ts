// @vitest-environment node
/**
 * Integration tests for PosixProcessCleanupModule.
 *
 * Tests verify: the release hooks ask the process monitor what the workspace
 * runs (a deletion also what sits in its directory), terminate it via
 * ProcessRunner.kill, and report or log what went wrong (runs on all
 * platforms). Which processes the monitor answers with is attribution's
 * concern (process-monitor tests).
 *
 * Paths here stay POSIX on purpose — unlike the rest of the integration suite,
 * which feeds the code under test OS-native paths. The module declares
 * `requires: { posix: true }`, so a Windows path is a shape this code is never
 * handed.
 */

import { AsyncLogScopeStore } from "../boundaries/platform/log-scope";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import type { Intent } from "../intents/lib/types";
import type { WorkspaceRef } from "../intents/contract";
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
  killPosixProcesses,
} from "./posix-process-cleanup-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import { createMockProcessRunner } from "../boundaries/platform/process.state-mock";
import type { MockProcessRunner } from "../boundaries/platform/process.state-mock";
import type { ProcessMonitorModule } from "./process-monitor/process-monitor-module";
import { teardownMonitor, type TeardownCall } from "./release-sweep.test-utils";

// =============================================================================
// Test Helpers
// =============================================================================

const WORKSPACE_REF = "ch::m::my-app::feature-1" as WorkspaceRef;
const WORKSPACE_PATH = "/workspaces/feature-1";

/** A shell the workspace started. */
const BASH = { pid: 1234, name: "bash" };

function makeDeleteIntent(overrides?: Partial<DeleteWorkspaceIntent["payload"]>): Intent {
  return {
    type: "workspace:delete",
    payload: {
      projectId: "proj-1",
      workspaceName: "feature-1",
      workspacePath: WORKSPACE_PATH,
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
      workspaceRef: WORKSPACE_REF,
      workspacePath:
        ((ctx.intent as DeleteWorkspaceIntent).payload as { workspacePath?: string })
          .workspacePath ?? "",
    }),
  }
);

function createReleaseSetup(
  runner: MockProcessRunner,
  processMonitor: Pick<ProcessMonitorModule, "teardownProcesses">,
  logger = SILENT_LOGGER
) {
  const dispatcher = new Dispatcher({
    logScope: new AsyncLogScopeStore(),
    logger: createMockLogger(),
    initialCapabilities: { posix: true },
  });
  dispatcher.registerOperation(releaseOperation);
  dispatcher.registerModule(
    createPosixProcessCleanupModule({ processRunner: runner, processMonitor, logger })
  );
  return dispatcher;
}

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
  describe("delete-workspace -> release", () => {
    it("kills what the workspace runs and what sits in its directory", async () => {
      const calls: TeardownCall[] = [];
      const runner = createMockProcessRunner();

      const dispatcher = createReleaseSetup(runner, teardownMonitor([BASH], calls));
      await dispatcher.dispatch(makeDeleteIntent());

      // One question about this workspace, its directory included; nothing
      // spawned; the process terminated.
      expect(calls).toEqual([{ ref: WORKSPACE_REF, path: WORKSPACE_PATH, cwdInside: true }]);
      expect(() => runner.$.spawned(0)).toThrow();
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("still kills when force=true", async () => {
      const runner = createMockProcessRunner();

      const dispatcher = createReleaseSetup(runner, teardownMonitor([BASH]));
      await dispatcher.dispatch(makeDeleteIntent({ force: true }));

      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("reports a failed scan on the release result without failing", async () => {
      const runner = createMockProcessRunner();

      const dispatcher = createReleaseSetup(runner, teardownMonitor(null));
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      // A scan that never finished must not look like one that found nothing.
      expect(result.error).toContain("process scan failed");
      expect(runner.$.killedPids).toEqual([]);
    });

    it("reports a thrown scan error on the release result", async () => {
      const runner = createMockProcessRunner();

      const dispatcher = createReleaseSetup(runner, teardownMonitor(new Error("scan exploded")));
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toBe("scan exploded");
    });

    it("names the processes that survive the kill on the release result", async () => {
      const runner = createMockProcessRunner({ onKill: (pid) => ({ success: pid !== 1234 }) });

      const dispatcher = createReleaseSetup(
        runner,
        teardownMonitor([BASH, { pid: 5678, name: "node" }])
      );
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toBe("Could not terminate: bash (pid 1234)");
    });

    it("reports nothing when every process is killed", async () => {
      const dispatcher = createReleaseSetup(createMockProcessRunner(), teardownMonitor([BASH]));
      const result = await dispatcher.dispatch(makeDeleteIntent());

      expect(result).toEqual({});
    });

    it("skips kill when nothing runs", async () => {
      const runner = createMockProcessRunner();

      const dispatcher = createReleaseSetup(runner, teardownMonitor([]));
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
          workspaceRef: WORKSPACE_REF,
          workspacePath:
            (ctx.intent as { payload: { workspacePath?: string } }).payload.workspacePath ?? "",
          projectId: "proj-1",
          workspaceName: "feature-1",
        }),
      }
    );

    function createHibernateReleaseSetup(
      runner: MockProcessRunner,
      processMonitor: Pick<ProcessMonitorModule, "teardownProcesses">,
      logger = SILENT_LOGGER
    ) {
      const dispatcher = new Dispatcher({
        logScope: new AsyncLogScopeStore(),
        logger: createMockLogger(),
        initialCapabilities: { posix: true },
      });
      dispatcher.registerOperation(hibernateReleaseOperation);
      dispatcher.registerModule(
        createPosixProcessCleanupModule({ processRunner: runner, processMonitor, logger })
      );
      return dispatcher;
    }

    function makeHibernateIntent(): Intent {
      return {
        type: "workspace:hibernate",
        payload: { workspacePath: WORKSPACE_PATH },
      } as unknown as Intent;
    }

    it("kills what the workspace runs, but not what only sits in its directory", async () => {
      const calls: TeardownCall[] = [];
      const runner = createMockProcessRunner();

      const dispatcher = createHibernateReleaseSetup(runner, teardownMonitor([BASH], calls));
      await dispatcher.dispatch(makeHibernateIntent());

      // The worktree stays, so another workspace's build running in it is left alone.
      expect(calls).toEqual([{ ref: WORKSPACE_REF, path: WORKSPACE_PATH, cwdInside: false }]);
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("logs, rather than reports, a survivor during hibernation", async () => {
      const runner = createMockProcessRunner({ onKill: () => ({ success: false }) });
      const logger = createBehavioralLogger();

      const dispatcher = createHibernateReleaseSetup(runner, teardownMonitor([BASH]), logger);
      const result = await dispatcher.dispatch(makeHibernateIntent());

      expect(result).toEqual({});
      const warnings = logger.getMessagesByLevel("warn");
      expect(
        warnings.find((w) => w.message === "Workspace process cleanup failed")?.context
      ).toMatchObject({ error: "Could not terminate: bash (pid 1234)" });
    });
  });
});
