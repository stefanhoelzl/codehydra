// @vitest-environment node
/**
 * Integration tests for KeepFilesModule through the Dispatcher.
 *
 * Tests verify: dispatcher -> operation -> setup hook -> keepFilesService call,
 * including best-effort error handling (errors are logged, not re-thrown).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  type SetupHookInput,
  type SetupHookResult,
} from "../operations/open-workspace";
import { createKeepFilesModule } from "./keepfiles-module";
import { SILENT_LOGGER } from "../../services/logging";
import { createBehavioralLogger } from "../../services/logging/logging.test-utils";
import { Path } from "../../services/platform/path";
import type { IKeepFilesService } from "../../services/keepfiles/types";

// =============================================================================
// Mock Dependencies
// =============================================================================

function createMockKeepFilesService() {
  return {
    copyToWorkspace: vi.fn().mockResolvedValue({
      configExists: true,
      copiedCount: 0,
      skippedCount: 0,
      errors: [],
    }),
  };
}

// =============================================================================
// Minimal Test Operation
// =============================================================================

/**
 * Minimal operation that runs only the "setup" hook point.
 * Avoids needing stubs for resolve-project, create, finalize.
 */
class MinimalSetupOperation implements Operation<Intent, SetupHookResult> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<SetupHookResult> {
    const payload = ctx.intent.payload as { projectPath: string; workspacePath: string };
    const input: SetupHookInput = {
      intent: ctx.intent,
      projectPath: payload.projectPath,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<SetupHookResult>("setup", input);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  keepFilesService: ReturnType<typeof createMockKeepFilesService>;
}

function createTestSetup(logger = SILENT_LOGGER): TestSetup {
  const keepFilesService = createMockKeepFilesService();

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation("workspace:open", new MinimalSetupOperation());

  const module = createKeepFilesModule({
    keepFilesService: keepFilesService as unknown as IKeepFilesService,
    logger,
  });
  dispatcher.registerModule(module);

  return { dispatcher, keepFilesService };
}

// =============================================================================
// Tests
// =============================================================================

describe("KeepFilesModule Integration", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  describe("open-workspace -> setup", () => {
    it("calls copyToWorkspace with Path arguments", async () => {
      const { dispatcher, keepFilesService } = setup;

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectPath: "/projects/my-app", workspacePath: "/workspaces/feature-1" },
      } as Intent);

      expect(keepFilesService.copyToWorkspace).toHaveBeenCalledWith(
        new Path("/projects/my-app"),
        new Path("/workspaces/feature-1")
      );
    });

    it("logs error and succeeds when copyToWorkspace throws", async () => {
      const logger = createBehavioralLogger();
      const { dispatcher, keepFilesService } = createTestSetup(logger);

      keepFilesService.copyToWorkspace.mockRejectedValue(new Error("disk full"));

      const result = await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectPath: "/projects/my-app", workspacePath: "/workspaces/feature-1" },
      } as Intent);

      // Operation succeeds despite the error
      expect(result).toEqual({});

      // Error was logged
      const errors = logger.getMessagesByLevel("error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Keepfiles copy failed for workspace (non-fatal)");
      expect(errors[0]!.context).toEqual({ workspacePath: "/workspaces/feature-1" });
    });

    it("returns empty result on success", async () => {
      const { dispatcher } = setup;

      const result = await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectPath: "/projects/my-app", workspacePath: "/workspaces/feature-1" },
      } as Intent);

      expect(result).toEqual({});
    });
  });
});
