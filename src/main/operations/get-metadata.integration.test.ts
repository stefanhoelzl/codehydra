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
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./set-metadata";
import type { SetMetadataIntent, SetHookInput } from "./set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./get-metadata";
import type { GetMetadataIntent, GetMetadataHookResult, GetHookInput } from "./get-metadata";
import { registerTestInfrastructure } from "./operations.test-utils";
import { Path } from "../../services/platform/path";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { isValidMetadataKey } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { IntentModule } from "../intents/infrastructure/module";
import type { Intent } from "../intents/infrastructure/types";
import type { HookContext } from "../intents/infrastructure/operation";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = new Path("/project");
const WORKSPACES_DIR = new Path("/workspaces");

// =============================================================================
// Test Setup Helper
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  projectId: ProjectId;
  workspaceName: WorkspaceName;
  workspacePath: string;
}

function createTestSetup(): TestSetup {
  const workspacePath = new Path(WORKSPACES_DIR, "feature-x");
  const projectId = "project-ea0135bc" as ProjectId;
  const workspaceName = extractWorkspaceName(workspacePath.toString()) as WorkspaceName;

  // Simple Map-based metadata store: workspacePath → Record<string, string>
  const metadataStore = new Map<string, Record<string, string>>();

  // Build dispatcher with hook registry
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  // Register set-metadata and get-metadata operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());

  // Register infrastructure operations (resolve-workspace, resolve-project, etc.)
  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [workspacePath.toString()]: {
        projectPath: PROJECT_ROOT.toString(),
        workspaceName,
      },
    },
    projects: {
      [PROJECT_ROOT.toString()]: { projectId },
    },
  });

  // set/get module: performs metadata operations using the Map store
  const metadataModule: IntentModule = {
    name: "test-metadata",
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const { workspacePath: wp } = ctx as SetHookInput;
            const intent = ctx.intent as SetMetadataIntent;
            if (!isValidMetadataKey(intent.payload.key)) {
              throw new Error(
                `Invalid metadata key '${intent.payload.key}': must start with a letter, contain only letters, digits, and hyphens, and not end with a hyphen`
              );
            }
            const record = metadataStore.get(wp) ?? {};
            if (intent.payload.value === null) {
              delete record[intent.payload.key];
            } else {
              record[intent.payload.key] = intent.payload.value;
            }
            metadataStore.set(wp, record);
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetMetadataHookResult> => {
            const { workspacePath: wp } = ctx as GetHookInput;
            const metadata = metadataStore.get(wp) ?? {};
            return { metadata };
          },
        },
      },
    },
  };

  dispatcher.registerModule(metadataModule);

  return {
    dispatcher,
    projectId,
    workspaceName,
    workspacePath: workspacePath.toString(),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function setMetadataIntent(
  workspacePath: string,
  key: string,
  value: string | null
): SetMetadataIntent {
  return {
    type: INTENT_SET_METADATA,
    payload: { workspacePath, key, value },
  };
}

function getMetadataIntent(workspacePath: string): GetMetadataIntent {
  return {
    type: INTENT_GET_METADATA,
    payload: { workspacePath },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetMetadata Operation", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
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
