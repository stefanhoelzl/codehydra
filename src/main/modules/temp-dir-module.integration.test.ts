// @vitest-environment node
/**
 * Integration tests for TempDirModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * - app:start / init → recreates temp directory for a clean start
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { createTempDirModule, type TempDirModuleDeps } from "./temp-dir-module";
import { createMockPathProvider } from "../../services/platform/path-provider.test-utils";

// =============================================================================
// Mock FileSystemLayer
// =============================================================================

function createMockFileSystem() {
  return {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  fileSystem: ReturnType<typeof createMockFileSystem>;
}

function createTestSetup(): TestSetup {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const fileSystem = createMockFileSystem();
  const pathProvider = createMockPathProvider();

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "init", {
      throwOnError: false,
      hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
    })
  );

  const tempDirModule = createTempDirModule({
    fileSystem: fileSystem as unknown as TempDirModuleDeps["fileSystem"],
    pathProvider,
  });

  dispatcher.registerModule(tempDirModule);

  return { dispatcher, fileSystem };
}

// =============================================================================
// Tests
// =============================================================================

describe("TempDirModule Integration", () => {
  describe("app:start / init hook", () => {
    it("creates the temp directory", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(fileSystem.mkdir).toHaveBeenCalledWith(
        expect.objectContaining({ toString: expect.any(Function) })
      );
    });

    it("uses the temp path under data root", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const mkdirPath = fileSystem.mkdir.mock.calls[0]![0];
      expect(mkdirPath.toString()).toBe("/test/app-data/temp");
    });
  });
});
