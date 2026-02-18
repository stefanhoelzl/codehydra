// @vitest-environment node
/**
 * Integration tests for WindowsFileLockModule through the Dispatcher.
 *
 * Tests verify: dispatcher -> operation -> release/detect/flush hooks -> lockHandler calls,
 * including no-op behavior when handler is undefined (non-Windows).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
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
import { createBehavioralLogger } from "../../services/logging/logging.test-utils";
import type { WorkspaceLockHandler } from "../../services/platform/workspace-lock-handler";
import type { BlockingProcess } from "../../shared/api/types";

// =============================================================================
// Mock Dependencies
// =============================================================================

function createMockLockHandler() {
  return {
    detect: vi.fn<WorkspaceLockHandler["detect"]>().mockResolvedValue([]),
    detectCwd: vi.fn<WorkspaceLockHandler["detectCwd"]>().mockResolvedValue([]),
    killProcesses: vi.fn<WorkspaceLockHandler["killProcesses"]>().mockResolvedValue(undefined),
    closeHandles: vi.fn<WorkspaceLockHandler["closeHandles"]>().mockResolvedValue(undefined),
  };
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

/**
 * Runs only the "release" hook point.
 */
class ReleaseOperation implements Operation<Intent, ReleaseHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<ReleaseHookResult> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results, errors } = await ctx.hooks.collect<ReleaseHookResult>("release", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

/**
 * Runs only the "detect" hook point.
 */
class DetectOperation implements Operation<Intent, DetectHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<DetectHookResult> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results, errors } = await ctx.hooks.collect<DetectHookResult>("detect", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

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

function createReleaseSetup(lockHandler: WorkspaceLockHandler | undefined, logger = SILENT_LOGGER) {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  dispatcher.registerOperation("workspace:delete", new ReleaseOperation());

  const module = createWindowsFileLockModule({
    workspaceLockHandler: lockHandler,
    logger,
  });
  wireModules([module], hookRegistry, dispatcher);

  return dispatcher;
}

function createDetectSetup(lockHandler: WorkspaceLockHandler | undefined, logger = SILENT_LOGGER) {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  dispatcher.registerOperation("workspace:delete", new DetectOperation());

  const module = createWindowsFileLockModule({
    workspaceLockHandler: lockHandler,
    logger,
  });
  wireModules([module], hookRegistry, dispatcher);

  return dispatcher;
}

function createFlushSetup(
  lockHandler: WorkspaceLockHandler | undefined,
  blockingPids: readonly number[],
  logger = SILENT_LOGGER
) {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  dispatcher.registerOperation("workspace:delete", new FlushOperation(blockingPids));

  const module = createWindowsFileLockModule({
    workspaceLockHandler: lockHandler,
    logger,
  });
  wireModules([module], hookRegistry, dispatcher);

  return dispatcher;
}

// =============================================================================
// Tests
// =============================================================================

const BLOCKING_PROCESS: BlockingProcess = {
  pid: 1234,
  name: "node.exe",
  commandLine: "node server.js",
  files: [],
  cwd: "/workspaces/feature-1",
};

describe("WindowsFileLockModule Integration", () => {
  let handler: ReturnType<typeof createMockLockHandler>;

  beforeEach(() => {
    handler = createMockLockHandler();
  });

  // ---------------------------------------------------------------------------
  // release hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> release", () => {
    it("kills CWD-blocking processes", async () => {
      handler.detectCwd.mockResolvedValue([BLOCKING_PROCESS]);
      const dispatcher = createReleaseSetup(handler);

      await dispatcher.dispatch(makeDeleteIntent());

      expect(handler.detectCwd).toHaveBeenCalledOnce();
      expect(handler.killProcesses).toHaveBeenCalledWith([1234]);
    });

    it("skips when force=true", async () => {
      const dispatcher = createReleaseSetup(handler);

      await dispatcher.dispatch(makeDeleteIntent({ force: true }));

      expect(handler.detectCwd).not.toHaveBeenCalled();
      expect(handler.killProcesses).not.toHaveBeenCalled();
    });

    it("is a no-op when handler is undefined", async () => {
      const dispatcher = createReleaseSetup(undefined);

      const result = await dispatcher.dispatch(makeDeleteIntent());

      expect(result).toEqual({});
    });

    it("swallows errors from detectCwd", async () => {
      handler.detectCwd.mockRejectedValue(new Error("powershell failed"));
      const dispatcher = createReleaseSetup(handler);

      const result = await dispatcher.dispatch(makeDeleteIntent());

      // No error propagated
      expect(result).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // detect hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> detect", () => {
    it("returns blocking processes", async () => {
      handler.detect.mockResolvedValue([BLOCKING_PROCESS]);
      const dispatcher = createDetectSetup(handler);

      const result = (await dispatcher.dispatch(makeDeleteIntent())) as DetectHookResult;

      expect(result.blockingProcesses).toEqual([BLOCKING_PROCESS]);
    });

    it("returns empty array on error", async () => {
      handler.detect.mockRejectedValue(new Error("detection failed"));
      const logger = createBehavioralLogger();
      const dispatcher = createDetectSetup(handler, logger);

      const result = (await dispatcher.dispatch(makeDeleteIntent())) as DetectHookResult;

      expect(result.blockingProcesses).toEqual([]);
      const warnings = logger.getMessagesByLevel("warn");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toBe("Detection failed");
    });

    it("is a no-op when handler is undefined", async () => {
      const dispatcher = createDetectSetup(undefined);

      const result = await dispatcher.dispatch(makeDeleteIntent());

      expect(result).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // flush hook
  // ---------------------------------------------------------------------------

  describe("delete-workspace -> flush", () => {
    it("kills collected PIDs", async () => {
      const dispatcher = createFlushSetup(handler, [1234, 5678]);

      await dispatcher.dispatch(makeDeleteIntent());

      expect(handler.killProcesses).toHaveBeenCalledWith([1234, 5678]);
    });

    it("returns error on failure", async () => {
      handler.killProcesses.mockRejectedValue(new Error("access denied"));
      const dispatcher = createFlushSetup(handler, [1234]);

      const result = (await dispatcher.dispatch(makeDeleteIntent())) as FlushHookResult;

      expect(result.error).toBe("access denied");
    });

    it("is a no-op when handler is undefined", async () => {
      const dispatcher = createFlushSetup(undefined, [1234]);

      const result = await dispatcher.dispatch(makeDeleteIntent());

      expect(result).toEqual({});
    });

    it("skips kill when blockingPids is empty", async () => {
      const dispatcher = createFlushSetup(handler, []);

      await dispatcher.dispatch(makeDeleteIntent());

      expect(handler.killProcesses).not.toHaveBeenCalled();
    });
  });
});
