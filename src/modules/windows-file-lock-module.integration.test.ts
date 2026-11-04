// @vitest-environment node
/**
 * Integration tests for WindowsFileLockModule through the Dispatcher.
 *
 * Tests verify: dispatcher -> operation -> release/detect/flush hooks -> ProcessRunner calls.
 */

import { AsyncLogScopeStore } from "../boundaries/platform/log-scope";
import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";

import type { Operation, OperationSchemas } from "../intents/lib/operation";
import type { Intent } from "../intents/lib/types";
import type { WorkspaceName } from "../shared/api/types";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspaceIntent,
  type ReleaseHookResult,
  type DetectHookResult,
  type FlushHookResult,
  type FlushHookInput,
} from "../intents/delete-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateReleaseHookResult,
} from "../intents/hibernate-workspace";
import { createWindowsFileLockModule } from "./windows-file-lock-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import { createMockProcessRunner } from "../boundaries/platform/process.state-mock";
import type { MockProcessRunner } from "../boundaries/platform/process.state-mock";
import { wsPath, projPath, testPath, workspaceRefIn } from "../shared/test-fixtures";
import { projectRefFor } from "../utils/ref";
import { directoryHolders, type HolderScanCall } from "../boundaries/platform/process.state-mock";

// =============================================================================
// Test Helpers
// =============================================================================

function makeDeleteIntent(overrides?: Partial<DeleteWorkspaceIntent["payload"]>): Intent {
  return {
    type: "workspace:delete",
    payload: {
      projectId: "proj-1",
      workspaceName: "feature-1",
      workspacePath: testPath("/workspaces/feature-1").toNative(),
      projectPath: testPath("/projects/my-app").toNative(),
      keepBranch: true,
      force: false,
      removeWorktree: true,
      ...overrides,
    },
  } as unknown as Intent;
}

// =============================================================================
// Minimal Test Operations
// =============================================================================

const releaseOperation = createMinimalOperation<ReleaseHookResult>(
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  "release",
  {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      projectPath: testPath("/projects/my-app").toNative(),
      workspacePath:
        ((ctx.intent as DeleteWorkspaceIntent).payload as { workspacePath?: string })
          .workspacePath ?? "",
    }),
  }
);

const detectOperation = createMinimalOperation<DetectHookResult>(
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  "detect",
  {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      projectPath: testPath("/projects/my-app").toNative(),
      workspacePath:
        ((ctx.intent as DeleteWorkspaceIntent).payload as { workspacePath?: string })
          .workspacePath ?? "",
    }),
  }
);

/**
 * Runs only the "flush" hook point with provided blockingPids.
 */
function createFlushOperation(blockingPids: readonly number[]): Operation<OperationSchemas> {
  return createMinimalOperation<FlushHookResult>(
    DELETE_WORKSPACE_OPERATION_ID,
    INTENT_DELETE_WORKSPACE,
    "flush",
    {
      hookContext: (ctx): FlushHookInput => ({
        intent: ctx.intent,
        projectRef: projectRefFor(projPath("/projects/my-app")),
        projectPath: projPath("/projects/my-app"),
        workspaceRef: workspaceRefIn(projPath("/projects/my-app"), "feature-1"),
        workspacePath: wsPath("/workspaces/feature-1"),
        workspaceName: "feature-1" as WorkspaceName,
        active: false,
        blockingPids,
      }),
      defaultResult: {},
    }
  );
}

// =============================================================================
// Test Setup Helpers
// =============================================================================

function createReleaseSetup(runner: MockProcessRunner, logger = SILENT_LOGGER) {
  const dispatcher = new Dispatcher({
    logScope: new AsyncLogScopeStore(),
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation(releaseOperation);

  const module = createWindowsFileLockModule({
    processRunner: runner,
    logger,
  });
  dispatcher.registerModule(module);

  return dispatcher;
}

function createDetectSetup(runner: MockProcessRunner, logger = SILENT_LOGGER) {
  const dispatcher = new Dispatcher({
    logScope: new AsyncLogScopeStore(),
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation(detectOperation);

  const module = createWindowsFileLockModule({
    processRunner: runner,
    logger,
  });
  dispatcher.registerModule(module);

  return dispatcher;
}

function createFlushSetup(
  runner: MockProcessRunner,
  blockingPids: readonly number[],
  logger = SILENT_LOGGER
) {
  const dispatcher = new Dispatcher({
    logScope: new AsyncLogScopeStore(),
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation(createFlushOperation(blockingPids));

  const module = createWindowsFileLockModule({
    processRunner: runner,
    logger,
  });
  dispatcher.registerModule(module);

  return dispatcher;
}

// =============================================================================
// Tests
// =============================================================================

describe("WindowsFileLockModule Integration", () => {
  let runner: MockProcessRunner;

  beforeEach(() => {
    runner = createMockProcessRunner();
  });

  // ---------------------------------------------------------------------------
  // release hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> release", () => {
    it("kills CWD-blocking processes", async () => {
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders(
          [{ pid: 1234, name: "node.exe", commandLine: "node server.js", cwd: "." }],
          calls
        ),
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // A CWD-only scan of the workspace (the release runs before the removal)...
      expect(calls).toEqual([
        {
          dir: testPath("/workspaces/feature-1").toNative(),
          files: false,
          timeoutMs: expect.any(Number) as number,
        },
      ]);
      // ...and nothing spawned: the kill goes through the boundary, which waits
      // for the process to actually be gone rather than assuming a returning
      // taskkill means dead.
      expect(() => runner.$.spawned(0)).toThrow();
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("still kills CWD-blocking processes when force=true", async () => {
      // Dismiss after a refused pre-delete: that attempt stopped before this
      // hook, so an agent that ignored its close is still sitting in the
      // worktree. Skipping the scan here left it holding the directory and the
      // force removal failing silently (EBUSY, swallowed as a force error).
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders(
          [{ pid: 1234, name: "node.exe", commandLine: "claude", cwd: "." }],
          calls
        ),
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent({ force: true }));

      expect(calls.map((call) => call.files)).toEqual([false]);
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("reports a timed-out scan instead of silently passing", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders("timeout") });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      // Non-fatal — the removal is still attempted — but a scan that never
      // finished must not look like a scan that found nothing. This used to be
      // discarded by a bare catch, leaving the user with a failed deletion and
      // a dialog claiming nothing was blocking.
      expect(result.error).toContain("scan timed out");
    });

    it("reports processes it could not terminate", async () => {
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders([
          { pid: 1234, name: "node.exe", commandLine: "node server.js", cwd: "." },
        ]),
        onKill: () => ({ success: false }),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toContain("node.exe");
      expect(result.error).toContain("1234");
    });

    it("skips kill when no processes detected", async () => {
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({ directoryHolders: directoryHolders([], calls) });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Only the scan ran, and nothing was killed
      expect(calls).toHaveLength(1);
      expect(runner.$.killedPids).toEqual([]);
    });

    it("reports a scan that cannot run on the release result, killing nothing", async () => {
      // A scan that never ran is not a workspace nothing holds.
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders(new Error("no native addon")),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toContain("no native addon");
      expect(runner.$.killedPids).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // detect hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> detect", () => {
    it("returns blocking processes", async () => {
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders(
          [{ pid: 1234, name: "node.exe", commandLine: "node server.js", files: ["src/index.ts"] }],
          calls
        ),
      });

      const dispatcher = createDetectSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as DetectHookResult;

      expect(result.blockingProcesses).toEqual([
        {
          pid: 1234,
          name: "node.exe",
          commandLine: "node server.js",
          files: ["src/index.ts"],
          cwd: null,
        },
      ]);

      // The full scan: open files as well as working directories.
      expect(calls.map((call) => call.files)).toEqual([true]);
    });

    it("gives the scan a longer budget once one has timed out", async () => {
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({ directoryHolders: directoryHolders("timeout", calls) });

      const dispatcher = createDetectSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());
      await dispatcher.dispatch(makeDeleteIntent());

      expect(calls.map((call) => call.timeoutMs)).toEqual([8_000, 45_000]);
    });

    it("reports 'could not determine' on timeout rather than a clean empty scan", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders("timeout") });

      const logger = createBehavioralLogger();
      const dispatcher = createDetectSetup(runner, logger);

      const result = (await dispatcher.dispatch(makeDeleteIntent())) as DetectHookResult;

      // Empty AND an error. Without the error the progress row renders as
      // "Detecting blocking processes... done", telling the user nothing is
      // blocking the removal that just refused to proceed.
      expect(result.blockingProcesses).toEqual([]);
      expect(result.error).toContain("scan timed out");
      const warnings = logger.getMessagesByLevel("warn");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toBe("Blocking process detection timed out");
    });
  });

  // ---------------------------------------------------------------------------
  // flush hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> flush", () => {
    it("kills collected PIDs", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 0 }),
      });

      const dispatcher = createFlushSetup(runner, [1234, 5678]);
      await dispatcher.dispatch(makeDeleteIntent());

      expect(runner.$.killedPids).toEqual([1234, 5678]);
    });

    it("names the PIDs that survived termination", async () => {
      runner = createMockProcessRunner({
        onKill: (pid) => (pid === 1234 ? { success: false } : undefined),
      });

      const dispatcher = createFlushSetup(runner, [1234, 5678]);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as FlushHookResult;

      // The point of waiting: a process that ignored the kill is reportable,
      // instead of the removal failing later with an unexplained EBUSY.
      expect(result.error).toContain("1234");
      expect(result.error).not.toContain("5678");
    });

    it("skips kill when blockingPids is empty", async () => {
      const dispatcher = createFlushSetup(runner, []);
      await dispatcher.dispatch(makeDeleteIntent());

      expect(runner.$.killedPids).toEqual([]);
      expect(() => runner.$.spawned(0)).toThrow();
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
          projectPath: testPath("/projects/my-app").toNative(),
          workspacePath:
            (ctx.intent as { payload: { workspacePath?: string } }).payload.workspacePath ?? "",
          projectId: "proj-1",
          workspaceName: "feature-1",
        }),
      }
    );

    function createHibernateReleaseSetup(r: MockProcessRunner) {
      const dispatcher = new Dispatcher({
        logScope: new AsyncLogScopeStore(),
        logger: createMockLogger(),
        initialCapabilities: { platform: "win32" },
      });
      dispatcher.registerOperation(hibernateReleaseOperation);
      dispatcher.registerModule(
        createWindowsFileLockModule({
          processRunner: r,
          logger: SILENT_LOGGER,
        })
      );
      return dispatcher;
    }

    function makeHibernateIntent(): Intent {
      return {
        type: "workspace:hibernate",
        payload: { workspacePath: testPath("/workspaces/feature-1").toNative() },
      } as unknown as Intent;
    }

    it("kills CWD-blocking processes (no force gate)", async () => {
      const calls: HolderScanCall[] = [];
      runner = createMockProcessRunner({
        directoryHolders: directoryHolders(
          [{ pid: 1234, name: "node.exe", commandLine: "node", cwd: "." }],
          calls
        ),
      });

      const dispatcher = createHibernateReleaseSetup(runner);
      await dispatcher.dispatch(makeHibernateIntent());

      expect(calls.map((call) => call.files)).toEqual([false]);
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("swallows errors from detection during hibernation", async () => {
      runner = createMockProcessRunner({ directoryHolders: directoryHolders(new Error("boom")) });

      const dispatcher = createHibernateReleaseSetup(runner);
      const result = await dispatcher.dispatch(makeHibernateIntent());

      expect(result).toEqual({});
    });
  });
});
