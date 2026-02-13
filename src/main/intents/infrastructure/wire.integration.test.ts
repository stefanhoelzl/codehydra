/**
 * Integration tests for wireModules utility.
 *
 * Verifies that wireModules correctly registers hooks into the HookRegistry
 * and subscribes events into the Dispatcher.
 */

import { describe, it, expect, vi } from "vitest";
import { wireModules } from "./wire";
import { HookRegistry } from "./hook-registry";
import { Dispatcher } from "./dispatcher";
import type { IntentInterceptor } from "./dispatcher";
import type { IntentModule } from "./module";
import type { Intent, DomainEvent } from "./types";
import type { Operation, OperationContext, HookContext } from "./operation";

// =============================================================================
// Test Helpers
// =============================================================================

function createActionIntent(): Intent {
  return { type: "test:action", payload: { id: "123" } };
}

// =============================================================================
// Tests
// =============================================================================

describe("wireModules", () => {
  it("registers hooks into registry", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);
    const hookRan = vi.fn();

    const testModule: IntentModule = {
      hooks: {
        "action-op": {
          execute: {
            handler: async () => {
              hookRan();
            },
          },
        },
      },
    };

    wireModules([testModule], hookRegistry, dispatcher);

    // Verify the hook was registered by resolving and running it
    const hooks = hookRegistry.resolve("action-op");
    const ctx: HookContext = { intent: createActionIntent() };
    await hooks.collect("execute", ctx);

    expect(hookRan).toHaveBeenCalledOnce();
  });

  it("subscribes events into dispatcher", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);
    const eventHandler = vi.fn();

    const testModule: IntentModule = {
      events: {
        "test:completed": eventHandler,
      },
    };

    wireModules([testModule], hookRegistry, dispatcher);

    // Register a simple operation that emits the event
    const operation: Operation<Intent, void> = {
      id: "action-op",
      execute: async (ctx: OperationContext<Intent>) => {
        ctx.emit({
          type: "test:completed",
          payload: { id: "123" },
        });
      },
    };
    dispatcher.registerOperation("test:action", operation);

    await dispatcher.dispatch(createActionIntent());

    expect(eventHandler).toHaveBeenCalledOnce();
    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "test:completed",
        payload: expect.objectContaining({ id: "123" }),
      })
    );
  });

  it("wires multiple modules", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);
    const order: string[] = [];

    const moduleA: IntentModule = {
      hooks: {
        "action-op": {
          execute: {
            handler: async () => {
              order.push("module-a");
            },
          },
        },
      },
    };

    const moduleB: IntentModule = {
      hooks: {
        "action-op": {
          execute: {
            handler: async () => {
              order.push("module-b");
            },
          },
        },
      },
    };

    wireModules([moduleA, moduleB], hookRegistry, dispatcher);

    const hooks = hookRegistry.resolve("action-op");
    const ctx: HookContext = { intent: createActionIntent() };
    await hooks.collect("execute", ctx);

    expect(order).toEqual(["module-a", "module-b"]);
  });

  it("handles module with no hooks or events", () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const emptyModule: IntentModule = {};

    // Should not throw
    wireModules([emptyModule], hookRegistry, dispatcher);
  });

  it("event handler only receives matching event type", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);
    const handler = vi.fn();

    const testModule: IntentModule = {
      events: {
        "test:completed": handler,
      },
    };

    wireModules([testModule], hookRegistry, dispatcher);

    const operation: Operation<Intent, void> = {
      id: "action-op",
      execute: async (ctx: OperationContext<Intent>) => {
        ctx.emit({
          type: "test:completed",
          payload: { id: "123" },
        } satisfies DomainEvent);
      },
    };
    dispatcher.registerOperation("test:action", operation);

    await dispatcher.dispatch(createActionIntent());

    expect(handler).toHaveBeenCalledOnce();
  });

  it("registers interceptors from module", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);
    const operationExecuted = vi.fn();

    // Cancelling interceptor: before() returns null
    const cancelInterceptor: IntentInterceptor = {
      id: "cancel-all",
      async before() {
        return null;
      },
    };

    const testModule: IntentModule = {
      interceptors: [cancelInterceptor],
    };

    wireModules([testModule], hookRegistry, dispatcher);

    const operation: Operation<Intent, void> = {
      id: "action-op",
      execute: async () => {
        operationExecuted();
      },
    };
    dispatcher.registerOperation("test:action", operation);

    const result = await dispatcher.dispatch(createActionIntent());

    // Interceptor cancelled the intent — operation never ran
    expect(result).toBeUndefined();
    expect(operationExecuted).not.toHaveBeenCalled();
  });
});
