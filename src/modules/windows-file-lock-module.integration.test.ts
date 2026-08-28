// @vitest-environment node
/**
 * Integration tests for WindowsFileLockModule through the Dispatcher.
 *
 * Tests verify: dispatcher -> operation -> release/detect/flush hooks -> ProcessRunner calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";

import { z } from "zod/v4";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../intents/lib/operation";
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
import { wsPath, projPath, testPath } from "../shared/test-fixtures";

// =============================================================================
// Test Helpers
// =============================================================================

function createDetectJson(
  blocking: Array<{
    pid: number;
    name: string;
    commandLine: string;
    files?: string[];
    cwd?: string | null;
  }>
): string {
  return JSON.stringify({
    blocking: blocking.map((p) => ({
      pid: p.pid,
      name: p.name,
      commandLine: p.commandLine,
      files: p.files ?? [],
      cwd: p.cwd ?? null,
    })),
  });
}

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
const flushOpSchemas = {
  type: INTENT_DELETE_WORKSPACE,
  payload: z.unknown(),
  result: z.custom<FlushHookResult>(),
} satisfies OperationSchemas;

class FlushOperation implements Operation<typeof flushOpSchemas> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;
  readonly schemas = flushOpSchemas;

  constructor(private readonly blockingPids: readonly number[]) {}

  async execute(
    ctx: OperationContext<IntentOf<typeof flushOpSchemas>, typeof flushOpSchemas>
  ): Promise<FlushHookResult> {
    const flushCtx: FlushHookInput = {
      intent: ctx.intent,
      projectPath: projPath("/projects/my-app"),
      workspacePath: wsPath("/workspaces/feature-1"),
      workspaceName: "feature-1" as WorkspaceName,
      active: false,
      blockingPids: this.blockingPids,
    };
    const { results, errors } = await ctx.hooks.collect("flush", flushCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

// =============================================================================
// Test Setup Helpers
// =============================================================================

const SCRIPT_PATH = testPath("/scripts/blocking-processes.ps1").toNative();

function createReleaseSetup(runner: MockProcessRunner, logger = SILENT_LOGGER) {
  const dispatcher = new Dispatcher({
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation(releaseOperation);

  const module = createWindowsFileLockModule({
    processRunner: runner,
    scriptPath: SCRIPT_PATH,
    logger,
  });
  dispatcher.registerModule(module);

  return dispatcher;
}

function createDetectSetup(runner: MockProcessRunner, logger = SILENT_LOGGER) {
  const dispatcher = new Dispatcher({
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation(detectOperation);

  const module = createWindowsFileLockModule({
    processRunner: runner,
    scriptPath: SCRIPT_PATH,
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
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation(new FlushOperation(blockingPids));

  const module = createWindowsFileLockModule({
    processRunner: runner,
    scriptPath: SCRIPT_PATH,
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
      let callIndex = 0;
      runner = createMockProcessRunner({
        onSpawn: () => {
          callIndex++;
          if (callIndex === 1) {
            // DetectCwd: return a blocking process
            return {
              stdout: createDetectJson([
                { pid: 1234, name: "node.exe", commandLine: "node server.js", cwd: "." },
              ]),
              exitCode: 0,
            };
          }
          // any later spawn (there should be none — the kill no longer shells
          // out to taskkill from this module)
          return { exitCode: 0 };
        },
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Verify detection was called (powershell -Action DetectCwd)
      const detectProc = runner.$.spawned(0);
      expect(detectProc.$.command).toBe("powershell");
      expect(detectProc.$.args).toEqual(
        expect.arrayContaining(["-Action", "DetectCwd", "-File", SCRIPT_PATH])
      );

      // The kill goes through the boundary now, which waits for the process to
      // actually be gone rather than assuming a returning taskkill means dead.
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("skips when force=true", async () => {
      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent({ force: true }));

      // No processes spawned
      expect(() => runner.$.spawned(0)).toThrow();
    });

    it("reports a timed-out scan instead of silently passing", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: null, running: true }),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      // Non-fatal — the removal is still attempted — but a scan that never
      // finished must not look like a scan that found nothing. This used to be
      // discarded by a bare catch, leaving the user with a failed deletion and
      // a dialog claiming nothing was blocking.
      expect(result.error).toContain("scan timed out");
    });

    it("reports processes it could not terminate", async () => {
      let callIndex = 0;
      runner = createMockProcessRunner({
        onSpawn: () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              stdout: createDetectJson([
                { pid: 1234, name: "node.exe", commandLine: "node server.js", cwd: "." },
              ]),
              exitCode: 0,
            };
          }
          return { exitCode: 0 };
        },
        onKill: () => ({ success: false }),
      });

      const dispatcher = createReleaseSetup(runner);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as { error?: string };

      expect(result.error).toContain("node.exe");
      expect(result.error).toContain("1234");
    });

    it("skips kill when no processes detected", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ stdout: createDetectJson([]), exitCode: 0 }),
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Only detection was spawned, and nothing was killed
      expect(runner.$.spawned(0).$.command).toBe("powershell");
      expect(runner.$.killedPids).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // detect hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> detect", () => {
    it("returns blocking processes", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({
          stdout: createDetectJson([
            {
              pid: 1234,
              name: "node.exe",
              commandLine: "node server.js",
              files: ["src/index.ts"],
              cwd: null,
            },
          ]),
          exitCode: 0,
        }),
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

      // Verify -Action Detect was used
      expect(runner.$.spawned(0).$.args).toEqual(expect.arrayContaining(["-Action", "Detect"]));
    });

    it("reports 'could not determine' on timeout rather than a clean empty scan", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: null, running: true }),
      });

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
        logger: createMockLogger(),
        initialCapabilities: { platform: "win32" },
      });
      dispatcher.registerOperation(hibernateReleaseOperation);
      dispatcher.registerModule(
        createWindowsFileLockModule({
          processRunner: r,
          scriptPath: SCRIPT_PATH,
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
      let callIndex = 0;
      runner = createMockProcessRunner({
        onSpawn: () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              stdout: createDetectJson([
                {
                  pid: 1234,
                  name: "node.exe",
                  commandLine: "node",
                  cwd: testPath("/workspaces/feature-1").toNative(),
                },
              ]),
              exitCode: 0,
            };
          }
          return { exitCode: 0 };
        },
      });

      const dispatcher = createHibernateReleaseSetup(runner);
      await dispatcher.dispatch(makeHibernateIntent());

      expect(runner.$.spawned(0).$.command).toBe("powershell");
      expect(runner.$.killedPids).toEqual([1234]);
    });

    it("swallows errors from detection during hibernation", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 1, stderr: "boom" }),
      });

      const dispatcher = createHibernateReleaseSetup(runner);
      const result = await dispatcher.dispatch(makeHibernateIntent());

      expect(result).toEqual({});
    });
  });
});
