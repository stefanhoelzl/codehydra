// @vitest-environment node
/**
 * Integration tests for ExtensionModule through the Dispatcher.
 *
 * Tests verify the init hook loads the manifest and returns
 * extension requirements, or returns empty result on failure.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type { InitResult } from "../operations/app-start";
import { createExtensionModule, type ExtensionModuleDeps } from "./extension-module";
import { SILENT_LOGGER, createMockLogger } from "../../services/logging";
import { Path } from "../../services/platform/path";
import type { FileSystemLayer } from "../../services/platform/filesystem";

// =============================================================================
// Test Setup
// =============================================================================

const TEST_MANIFEST = JSON.stringify([
  { id: "codehydra.sidekick", version: "0.0.1", vsix: "codehydra-sidekick-0.0.1.vsix" },
  { id: "publisher.extension", version: "1.2.3", vsix: "publisher-extension-1.2.3.vsix" },
]);

function createMockDeps(overrides?: Partial<ExtensionModuleDeps>): ExtensionModuleDeps {
  return {
    pathProvider: {
      runtimePath: vi.fn().mockImplementation((subpath: string) => {
        return new Path(`/mock/runtime/${subpath}`);
      }),
    },
    fileSystemLayer: {
      readFile: vi.fn().mockResolvedValue(TEST_MANIFEST),
    } as unknown as Pick<FileSystemLayer, "readFile">,
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

function createTestSetup(deps: ExtensionModuleDeps) {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });
  const module = createExtensionModule(deps);
  dispatcher.registerModule(module);

  dispatcher.registerOperation(
    "app:start",
    createMinimalOperation<never, InitResult>(APP_START_OPERATION_ID, "init", {
      hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
    })
  );

  return { dispatcher };
}

// =============================================================================
// Tests
// =============================================================================

describe("ExtensionModule", () => {
  describe("init hook", () => {
    it("loads manifest and returns extension requirements", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toHaveLength(2);
      expect(result.extensionRequirements![0]).toEqual({
        id: "codehydra.sidekick",
        version: "0.0.1",
        vsixPath: expect.stringContaining("codehydra-sidekick-0.0.1.vsix"),
      });
      expect(result.extensionRequirements![1]).toEqual({
        id: "publisher.extension",
        version: "1.2.3",
        vsixPath: expect.stringContaining("publisher-extension-1.2.3.vsix"),
      });
    });

    it("returns empty result on invalid manifest", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi.fn().mockResolvedValue("not valid json"),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toBeUndefined();
    });

    it("returns empty result on missing manifest file", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi.fn().mockRejectedValue(new Error("ENOENT: file not found")),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toBeUndefined();
    });

    it("returns empty result on structurally invalid manifest", async () => {
      const invalidManifest = JSON.stringify([{ id: "missing-fields" }]);
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi.fn().mockResolvedValue(invalidManifest),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toBeUndefined();
    });

    it("returns empty result when manifest is not an array", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi.fn().mockResolvedValue(JSON.stringify({ marketplace: [], bundled: [] })),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toBeUndefined();
    });

    it("returns empty result when manifest contains string items", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi.fn().mockResolvedValue(JSON.stringify(["codehydra.sidekick-0.0.3.vsix"])),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toBeUndefined();
    });

    it("returns empty result when manifest item has missing fields", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi
            .fn()
            .mockResolvedValue(JSON.stringify([{ id: "test.ext", version: "0.0.1" }])),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toBeUndefined();
    });

    it("handles empty array manifest", async () => {
      const deps = createMockDeps({
        fileSystemLayer: {
          readFile: vi.fn().mockResolvedValue(JSON.stringify([])),
        } as unknown as Pick<FileSystemLayer, "readFile">,
      });
      const { dispatcher } = createTestSetup(deps);

      const result = (await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      })) as InitResult;

      expect(result.extensionRequirements).toHaveLength(0);
    });
  });
});
