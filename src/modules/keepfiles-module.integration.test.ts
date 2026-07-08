// @vitest-environment node
/**
 * Integration tests for KeepFilesModule through the Dispatcher.
 *
 * Tests verify: dispatcher -> operation -> setup hook -> KeepFilesService behavior,
 * including best-effort error handling (errors are logged, not re-thrown).
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import type { Intent } from "../intents/lib/types";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  type SetupHookResult,
} from "../intents/open-workspace";
import { createKeepFilesModule } from "./keepfiles-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import {
  createFileSystemMock,
  file,
  directory,
} from "../boundaries/platform/filesystem.state-mock";

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  mockFs: ReturnType<typeof createFileSystemMock>;
}

function createTestSetup(
  logger = SILENT_LOGGER,
  fsEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/projects/my-app": directory(),
    "/workspaces/feature-1": directory(),
  }
): TestSetup {
  const mockFs = createFileSystemMock({ entries: fsEntries });

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(
    createMinimalOperation<SetupHookResult>(
      OPEN_WORKSPACE_OPERATION_ID,
      INTENT_OPEN_WORKSPACE,
      "setup",
      {
        hookContext: (ctx) => {
          const payload = ctx.intent.payload as { projectPath: string; workspacePath: string };
          return {
            intent: ctx.intent,
            projectPath: payload.projectPath,
            workspacePath: payload.workspacePath,
          };
        },
      }
    )
  );

  const module = createKeepFilesModule({
    fileSystem: mockFs,
    logger,
  });
  dispatcher.registerModule(module);

  return { dispatcher, mockFs };
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
    it("copies matching files when .keepfiles exists", async () => {
      const { dispatcher, mockFs } = createTestSetup(SILENT_LOGGER, {
        "/projects/my-app": directory(),
        "/projects/my-app/.keepfiles": file(".env"),
        "/projects/my-app/.env": file("SECRET=value"),
        "/workspaces/feature-1": directory(),
      });

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: { projectPath: "/projects/my-app", workspacePath: "/workspaces/feature-1" },
      } as Intent);

      expect(mockFs).toHaveFile("/workspaces/feature-1/.env", "SECRET=value");
    });

    it("logs error and succeeds when filesystem throws", async () => {
      const logger = createBehavioralLogger();

      // Use a mock FS where readFile throws a non-ENOENT error
      const failingFs = createFileSystemMock({
        entries: {
          "/projects/my-app": directory(),
          "/workspaces/feature-1": directory(),
        },
      });
      // Override readFile to throw a generic error (not ENOENT)
      vi.spyOn(failingFs, "readFile").mockRejectedValue(new Error("disk full"));

      const dispatcher = createMockDispatcher();

      dispatcher.registerOperation(
        createMinimalOperation<SetupHookResult>(
          OPEN_WORKSPACE_OPERATION_ID,
          INTENT_OPEN_WORKSPACE,
          "setup",
          {
            hookContext: (ctx) => {
              const payload = ctx.intent.payload as { projectPath: string; workspacePath: string };
              return {
                intent: ctx.intent,
                projectPath: payload.projectPath,
                workspacePath: payload.workspacePath,
              };
            },
          }
        )
      );

      const module = createKeepFilesModule({
        fileSystem: failingFs,
        logger,
      });
      dispatcher.registerModule(module);

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

    it("skips copyToWorkspace when existingWorkspace is set", async () => {
      const { dispatcher, mockFs } = createTestSetup(SILENT_LOGGER, {
        "/projects/my-app": directory(),
        "/projects/my-app/.keepfiles": file(".env"),
        "/projects/my-app/.env": file("SECRET=value"),
        "/workspaces/feature-1": directory(),
      });

      const readFileSpy = vi.spyOn(mockFs, "readFile");

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/projects/my-app",
          workspacePath: "/workspaces/feature-1",
          existingWorkspace: {
            path: "/workspaces/feature-1",
            name: "feature-1",
            branch: "feature-1",
          },
        },
      } as Intent);

      // readFile should not have been called (skipped entirely)
      expect(readFileSpy).not.toHaveBeenCalled();
    });
  });
});
