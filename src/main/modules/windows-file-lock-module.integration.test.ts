// @vitest-environment node
/**
 * Integration tests for WindowsFileLockModule through the Dispatcher.
 *
 * Tests verify: dispatcher -> operation -> release/detect/flush hooks -> ProcessRunner calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type ReleaseHookResult,
  type DetectHookResult,
  type FlushHookResult,
  type FlushHookInput,
} from "../operations/delete-workspace";
import { createWindowsFileLockModule } from "./windows-file-lock-module";
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
      workspacePath: "/workspaces/feature-1",
      projectPath: "/projects/my-app",
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

const detectOperation = createMinimalOperation<Intent, DetectHookResult>(
  DELETE_WORKSPACE_OPERATION_ID,
  "detect",
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

/**
 * Runs only the "flush" hook point with provided blockingPids.
 */
class FlushOperation implements Operation<Intent, FlushHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  constructor(private readonly blockingPids: readonly number[]) {}

  async execute(ctx: OperationContext<Intent>): Promise<FlushHookResult> {
    const flushCtx: FlushHookInput = {
      intent: ctx.intent,
      projectPath: "/projects/my-app",
      workspacePath: "/workspaces/feature-1",
      blockingPids: this.blockingPids,
    };
    const { results, errors } = await ctx.hooks.collect<FlushHookResult>("flush", flushCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

// =============================================================================
// Test Setup Helpers
// =============================================================================

const SCRIPT_PATH = "/scripts/blocking-processes.ps1";

function createReleaseSetup(runner: MockProcessRunner, logger = SILENT_LOGGER) {
  const dispatcher = new Dispatcher({
    logger: createMockLogger(),
    initialCapabilities: { platform: "win32" },
  });
  dispatcher.registerOperation("workspace:delete", releaseOperation);

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
  dispatcher.registerOperation("workspace:delete", detectOperation);

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
  dispatcher.registerOperation("workspace:delete", new FlushOperation(blockingPids));

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
          // taskkill: success
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

      // Verify kill was called
      const killProc = runner.$.spawned(1);
      expect(killProc.$.command).toBe("taskkill");
      expect(killProc.$.args).toEqual(["/pid", "1234", "/t", "/f"]);
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

    it("skips kill when no processes detected", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ stdout: createDetectJson([]), exitCode: 0 }),
      });

      const dispatcher = createReleaseSetup(runner);
      await dispatcher.dispatch(makeDeleteIntent());

      // Only detection was spawned, no taskkill
      expect(runner.$.spawned(0).$.command).toBe("powershell");
      expect(() => runner.$.spawned(1)).toThrow();
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

    it("returns empty array on timeout", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: null, running: true }),
      });

      const logger = createBehavioralLogger();
      const dispatcher = createDetectSetup(runner, logger);

      const result = (await dispatcher.dispatch(makeDeleteIntent())) as DetectHookResult;

      expect(result.blockingProcesses).toEqual([]);
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

      expect(runner.$.spawned(0).$.command).toBe("taskkill");
      expect(runner.$.spawned(0).$.args).toEqual(["/pid", "1234", "/pid", "5678", "/t", "/f"]);
    });

    it("returns error on failure", async () => {
      runner = createMockProcessRunner({
        onSpawn: () => ({ exitCode: 1, stderr: "access denied" }),
      });

      const dispatcher = createFlushSetup(runner, [1234]);
      const result = (await dispatcher.dispatch(makeDeleteIntent())) as FlushHookResult;

      expect(result.error).toContain("Failed to kill processes");
    });

    it("skips kill when blockingPids is empty", async () => {
      const dispatcher = createFlushSetup(runner, []);
      await dispatcher.dispatch(makeDeleteIntent());

      // No processes spawned
      expect(() => runner.$.spawned(0)).toThrow();
    });
  });
});
