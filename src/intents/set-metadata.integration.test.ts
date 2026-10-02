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
import type { IntentInterceptor } from "./lib/dispatcher";
import { EVENT_METADATA_CHANGED } from "./set-metadata";
import type { MetadataChangedEvent } from "./set-metadata";
import {
  createMetadataTestSetup,
  metadataWorkspaceRef,
  setMetadataIntent,
  type MetadataTestSetup,
} from "./operations.test-utils";
import type { DomainEvent, Intent } from "./lib/types";
import { wsPath } from "../shared/test-fixtures";

// =============================================================================
// Tests
// =============================================================================

describe("SetMetadata Operation", () => {
  let setup: MetadataTestSetup;

  beforeEach(() => {
    setup = createMetadataTestSetup();
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
        dispatcher.dispatch(setMetadataIntent(wsPath("/nonexistent/path"), "key", "value"))
      ).rejects.toThrow(
        `Workspace not found: ${metadataWorkspaceRef(wsPath("/nonexistent/path"))}`
      );
    });

    // The code has to survive the nested workspace:resolve dispatch this
    // operation makes — that is what lets the MCP tools report a bad target
    // path as `workspace-not-found` rather than a generic internal error.
    it("codes an unknown workspace path as WORKSPACE_NOT_FOUND", async () => {
      const { dispatcher } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent(wsPath("/nonexistent/path"), "key", "value"))
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
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
