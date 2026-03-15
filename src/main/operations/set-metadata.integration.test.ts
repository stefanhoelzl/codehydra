// @vitest-environment node
/**
 * Integration tests for set-metadata operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> store,
 * using a simple Map-based metadata store and domain event subscriptions.
 *
 * Test plan items covered:
 * #9:  Set metadata writes to store
 * #10: Set metadata emits domain event
 * #12: Invalid metadata key throws
 * #13: Unknown workspace throws
 * #15: Interceptor cancels metadata intent (no state change, no event)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
  EVENT_METADATA_CHANGED,
} from "./set-metadata";
import type { SetMetadataIntent, MetadataChangedEvent, SetHookInput } from "./set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./get-metadata";
import type { GetMetadataHookResult, GetHookInput } from "./get-metadata";
import { registerTestInfrastructure } from "./operations.test-utils";
import { Path } from "../../services/platform/path";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { isValidMetadataKey } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent, Intent } from "../intents/infrastructure/types";
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
  metadataStore: Map<string, Record<string, string>>;
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

  // Register operations
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
    metadataStore,
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

// =============================================================================
// Tests
// =============================================================================

describe("SetMetadata Operation", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  it("writes to metadata store (#9)", async () => {
    const { dispatcher, metadataStore, workspacePath } = setup;

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "my workspace"));

    // Verify metadata was written to the store
    const record = metadataStore.get(workspacePath);
    expect(record).toBeDefined();
    expect(record!["description"]).toBe("my workspace");
  });

  it("emits workspace:metadata-changed domain event (#10)", async () => {
    const { dispatcher, projectId, workspaceName, workspacePath } = setup;

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "my workspace"));

    // Verify domain event was emitted
    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as MetadataChangedEvent;
    expect(event.type).toBe(EVENT_METADATA_CHANGED);
    expect(event.payload.projectId).toBe(projectId);
    expect(event.payload.workspaceName).toBe(workspaceName);
    expect(event.payload.key).toBe("description");
    expect(event.payload.value).toBe("my workspace");
  });

  it("emits domain event with null value for deletion", async () => {
    const { dispatcher, projectId, workspaceName, workspacePath } = setup;

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", null));

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as MetadataChangedEvent;
    expect(event.type).toBe(EVENT_METADATA_CHANGED);
    expect(event.payload.projectId).toBe(projectId);
    expect(event.payload.workspaceName).toBe(workspaceName);
    expect(event.payload.key).toBe("description");
    expect(event.payload.value).toBeNull();
  });

  it("domain event subscriber receives event directly (#10)", async () => {
    const { dispatcher, projectId, workspacePath } = setup;

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "test"));

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as MetadataChangedEvent;
    expect(event.type).toBe(EVENT_METADATA_CHANGED);
    expect(event.payload.projectId).toBe(projectId);
    expect(event.payload.key).toBe("description");
    expect(event.payload.value).toBe("test");
  });

  describe("error cases", () => {
    it("invalid metadata key throws (#12)", async () => {
      const { dispatcher, workspacePath } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent(workspacePath, "invalid key!", "value"))
      ).rejects.toThrow("Invalid metadata key");
    });

    it("unknown workspace path throws (#13)", async () => {
      const { dispatcher } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent("/nonexistent/path", "key", "value"))
      ).rejects.toThrow("Workspace not found: /nonexistent/path");
    });

    it("no event emitted on error", async () => {
      const { dispatcher, workspacePath } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
        receivedEvents.push(event);
      });

      await expect(
        dispatcher.dispatch(setMetadataIntent(workspacePath, "invalid key!", "value"))
      ).rejects.toThrow();

      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("interceptor", () => {
    it("cancels metadata intent - no state change, no event (#15)", async () => {
      const { dispatcher, metadataStore, workspacePath } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
        receivedEvents.push(event);
      });

      // Add cancel interceptor
      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      dispatcher.addInterceptor(cancelInterceptor);

      // Dispatch should return undefined (cancelled)
      const result = await dispatcher.dispatch(
        setMetadataIntent(workspacePath, "description", "my workspace")
      );

      expect(result).toBeUndefined();

      // No metadata written to the store
      const record = metadataStore.get(workspacePath);
      expect(record).toBeUndefined();

      // No event emitted
      expect(receivedEvents).toHaveLength(0);
    });
  });
});
