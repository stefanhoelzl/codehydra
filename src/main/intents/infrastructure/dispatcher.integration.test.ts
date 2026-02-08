/**
 * Integration tests for Dispatcher.
 *
 * Verifies dispatch → execute flow, interceptor modify/cancel/ordering,
 * event emission, causation chain tracking, and no-operation error.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher, IntentHandle } from "./dispatcher";
import type { IntentInterceptor } from "./dispatcher";
import { HookRegistry } from "./hook-registry";
import type { Intent, DomainEvent } from "./types";
import type { Operation, OperationContext, HookContext } from "./operation";

// =============================================================================
// Test Helpers
// =============================================================================

function createActionIntent(): Intent {
  return { type: "test:action", payload: { id: "123" } };
}

function createQueryIntent(): Intent {
  return { type: "test:query", payload: { question: "meaning" } };
}

function createTestOperation<R>(
  id: string,
  returnValue: R,
  sideEffect?: (ctx: OperationContext<Intent>) => void
): Operation<Intent, R> {
  return {
    id,
    execute: async (ctx) => {
      sideEffect?.(ctx);
      return returnValue;
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Dispatcher", () => {
  it("dispatch executes operation and returns result", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const result = { answer: 42 };
    const operation = createTestOperation("query-op", result);
    dispatcher.registerOperation("test:query", operation);

    const actual = await dispatcher.dispatch(createQueryIntent());

    expect(actual).toEqual(result);
  });

  it("throws when no operation registered for intent type", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    await expect(dispatcher.dispatch(createActionIntent())).rejects.toThrow(
      "No operation registered for intent type: test:action"
    );
  });

  it("throws on duplicate operation registration", () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const operation = createTestOperation("op", undefined);
    dispatcher.registerOperation("test:action", operation);

    expect(() => dispatcher.registerOperation("test:action", operation)).toThrow(
      "Operation already registered for intent type: test:action"
    );
  });

  it("interceptor cancels intent", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const executeSpy = vi.fn().mockResolvedValue(undefined);
    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: executeSpy,
    });

    const cancelInterceptor: IntentInterceptor = {
      id: "cancel-all",
      async before() {
        return null;
      },
    };
    dispatcher.addInterceptor(cancelInterceptor);

    const result = await dispatcher.dispatch(createActionIntent());

    expect(result).toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("interceptor modifies intent payload", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    let capturedIntent: Intent | undefined;
    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: async (ctx) => {
        capturedIntent = ctx.intent;
      },
    });

    const modifyInterceptor: IntentInterceptor = {
      id: "modify-payload",
      async before(intent: Intent): Promise<Intent | null> {
        return {
          ...intent,
          payload: { ...(intent.payload as Record<string, unknown>), extra: "added" },
        };
      },
    };
    dispatcher.addInterceptor(modifyInterceptor);

    await dispatcher.dispatch(createActionIntent());

    expect(capturedIntent).toBeDefined();
    expect((capturedIntent?.payload as Record<string, unknown>)?.extra).toBe("added");
  });

  it("interceptors run in order priority", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const order: string[] = [];

    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: async () => undefined,
    });

    dispatcher.addInterceptor({
      id: "second",
      order: 20,
      async before(intent: Intent): Promise<Intent | null> {
        order.push("second");
        return intent;
      },
    });

    dispatcher.addInterceptor({
      id: "first",
      order: 10,
      async before(intent: Intent): Promise<Intent | null> {
        order.push("first");
        return intent;
      },
    });

    dispatcher.addInterceptor({
      id: "third",
      order: 30,
      async before(intent: Intent): Promise<Intent | null> {
        order.push("third");
        return intent;
      },
    });

    await dispatcher.dispatch(createActionIntent());

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("events emitted after execution", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const testEvent: DomainEvent = {
      type: "test:completed",
      payload: { id: "123" },
    };

    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: async (ctx) => {
        ctx.emit(testEvent);
      },
    });

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe("test:completed", (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch(createActionIntent());

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual(testEvent);
  });

  it("unsubscribe removes event handler", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: async (ctx) => {
        ctx.emit({ type: "test:completed", payload: {} });
      },
    });

    const receivedEvents: DomainEvent[] = [];
    const unsubscribe = dispatcher.subscribe("test:completed", (event) => {
      receivedEvents.push(event);
    });

    unsubscribe();
    await dispatcher.dispatch(createActionIntent());

    expect(receivedEvents).toHaveLength(0);
  });

  it("causation tracks chain for nested dispatch", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const capturedCausations: (readonly string[])[] = [];

    // Register an action operation that triggers a query
    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: async (ctx) => {
        capturedCausations.push(ctx.causation);
        await ctx.dispatch(createQueryIntent());
      },
    });

    dispatcher.registerOperation("test:query", {
      id: "query-op",
      execute: async (ctx) => {
        capturedCausations.push(ctx.causation);
        return { answer: 42 };
      },
    });

    await dispatcher.dispatch(createActionIntent());

    // First operation has its own intent type in causation
    expect(capturedCausations[0]).toEqual(["test:action"]);

    // Nested operation has both intent types in causation
    expect(capturedCausations[1]).toEqual(["test:action", "test:query"]);
  });

  it("events emitted inline even if operation later throws", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation("test:action", {
      id: "action-op",
      execute: async (ctx) => {
        ctx.emit({ type: "test:completed", payload: {} });
        throw new Error("operation failed");
      },
    });

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe("test:completed", (event) => {
      receivedEvents.push(event);
    });

    await expect(dispatcher.dispatch(createActionIntent())).rejects.toThrow("operation failed");

    // Events are emitted inline — the operation decides when to emit
    expect(receivedEvents).toHaveLength(1);
  });

  it("hooks are available in operation context", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const hookRan = vi.fn();

    // Register a hook for the operation
    hookRegistry.register("query-op", "get", {
      handler: async () => {
        hookRan();
      },
    });

    dispatcher.registerOperation("test:query", {
      id: "query-op",
      execute: async (ctx) => {
        const hookCtx: HookContext = { intent: ctx.intent };
        await ctx.hooks.run("get", hookCtx);
        return { answer: 42 };
      },
    });

    const result = await dispatcher.dispatch(createQueryIntent());

    expect(hookRan).toHaveBeenCalledOnce();
    expect(result).toEqual({ answer: 42 });
  });

  it("dispatch returns IntentHandle", () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

    const handle = dispatcher.dispatch(createActionIntent());

    expect(handle).toBeInstanceOf(IntentHandle);
  });

  it("accepted resolves to true when no interceptors cancel", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

    const handle = dispatcher.dispatch(createActionIntent());
    const accepted = await handle.accepted;

    expect(accepted).toBe(true);
  });

  it("accepted resolves to false when interceptor cancels", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

    dispatcher.addInterceptor({
      id: "cancel",
      async before() {
        return null;
      },
    });

    const handle = dispatcher.dispatch(createActionIntent());
    const accepted = await handle.accepted;

    expect(accepted).toBe(false);
    expect(await handle).toBeUndefined();
  });

  it("accepted resolves before operation completes", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    let resolveOperation!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    let operationFinished = false;

    dispatcher.registerOperation("test:action", {
      id: "slow-op",
      execute: async () => {
        resolveOperation();
        // Wait for an extra microtask tick to simulate slow work
        await new Promise<void>((r) => setTimeout(r, 10));
        operationFinished = true;
      },
    });

    const handle = dispatcher.dispatch(createActionIntent());

    // Wait for accepted — should resolve once interceptors pass (before operation finishes)
    const accepted = await handle.accepted;
    await operationStarted;

    expect(accepted).toBe(true);
    expect(operationFinished).toBe(false);

    // Now await the full result
    await handle;
    expect(operationFinished).toBe(true);
  });
});
