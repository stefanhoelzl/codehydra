// @vitest-environment node
/**
 * Integration tests for mcp-attached operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> domain event emission.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { McpAttachedOperation, INTENT_MCP_ATTACHED, EVENT_MCP_ATTACHED } from "./mcp-attached";
import type { McpAttachedIntent, McpAttachedEvent } from "./mcp-attached";
import type { DomainEvent } from "../intents/infrastructure/types";

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_MCP_ATTACHED, new McpAttachedOperation());

  return { dispatcher };
}

// =============================================================================
// Tests
// =============================================================================

describe("McpAttached Operation", () => {
  it("emits workspace:mcp-attached event with correct workspacePath", async () => {
    const { dispatcher } = createTestSetup();
    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_MCP_ATTACHED, (event) => {
      receivedEvents.push(event);
    });

    const intent: McpAttachedIntent = {
      type: INTENT_MCP_ATTACHED,
      payload: { workspacePath: "/workspace/test" },
    };
    await dispatcher.dispatch(intent);

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as McpAttachedEvent;
    expect(event.type).toBe(EVENT_MCP_ATTACHED);
    expect(event.payload.workspacePath).toBe("/workspace/test");
  });

  it("event handler receives different workspace paths", async () => {
    const { dispatcher } = createTestSetup();
    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_MCP_ATTACHED, (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch({
      type: INTENT_MCP_ATTACHED,
      payload: { workspacePath: "/workspace/alpha" },
    } as McpAttachedIntent);

    await dispatcher.dispatch({
      type: INTENT_MCP_ATTACHED,
      payload: { workspacePath: "/workspace/beta" },
    } as McpAttachedIntent);

    expect(receivedEvents).toHaveLength(2);
    expect((receivedEvents[0] as McpAttachedEvent).payload.workspacePath).toBe("/workspace/alpha");
    expect((receivedEvents[1] as McpAttachedEvent).payload.workspacePath).toBe("/workspace/beta");
  });
});
