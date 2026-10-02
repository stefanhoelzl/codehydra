// @vitest-environment node
/**
 * Integration tests for get-metadata operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> provider,
 * using a simple Map-based metadata store instead of real services.
 *
 * Test plan items covered:
 * #11: Get metadata returns record
 * #16: Hook data flows to operation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { INTENT_GET_METADATA } from "./get-metadata";
import type { GetMetadataIntent } from "./get-metadata";
import {
  createMetadataTestSetup,
  metadataWorkspaceRef,
  setMetadataIntent,
  type MetadataTestSetup,
} from "./operations.test-utils";
import type { Intent } from "./lib/types";
import type { WorkspacePath } from "./contract";

// =============================================================================
// Helpers
// =============================================================================

function getMetadataIntent(workspacePath: WorkspacePath): GetMetadataIntent {
  return {
    type: INTENT_GET_METADATA,
    payload: { workspaceRef: metadataWorkspaceRef(workspacePath) },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetMetadata Operation", () => {
  let setup: MetadataTestSetup;

  beforeEach(() => {
    setup = createMetadataTestSetup();
  });

  it("returns metadata record from provider (#11)", async () => {
    const { dispatcher, workspacePath } = setup;

    // First set some metadata
    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "my workspace"));

    // Then get metadata
    const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

    // Should contain our custom key; no base since none was set in config
    expect(result).toBeDefined();
    expect(result.base).toBeUndefined();
    expect(result.description).toBe("my workspace");
  });

  it("returns empty metadata without custom keys (#11)", async () => {
    const { dispatcher, workspacePath } = setup;

    const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

    // No config set, so metadata is empty
    expect(result).toBeDefined();
    expect(result.base).toBeUndefined();
  });

  it("hook data flows from hook to operation via extended context (#16)", async () => {
    const { dispatcher, workspacePath } = setup;

    // The get metadata hook returns { metadata } (GetMetadataHookResult)
    // The operation merges results from all handlers
    const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

    // If hook data flow is broken, operation throws "Get metadata hook did not provide metadata result"
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  describe("interceptor", () => {
    it("cancels get metadata intent", async () => {
      const { dispatcher, workspacePath } = setup;

      dispatcher.addInterceptor({
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      });

      const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

      expect(result).toBeUndefined();
    });
  });
});
