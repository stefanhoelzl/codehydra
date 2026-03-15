/**
 * Integration tests for Dispatcher.
 *
 * Verifies dispatch → execute flow, interceptor modify/cancel/ordering,
 * event emission, causation chain tracking, no-operation error,
 * capability-based hook ordering, and logging.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher, IntentHandle } from "./dispatcher";
import type { IntentInterceptor } from "./dispatcher";
import type { IntentModule } from "./module";
import type { Intent, DomainEvent } from "./types";
import type {
  Operation,
  OperationContext,
  HookContext,
  HookHandler,
  HookResult,
} from "./operation";
import { ANY_VALUE } from "./operation";
import type { Logger } from "../../../services/logging/types";

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

function createMockLogger(): Logger & {
  calls: { level: string; message: string; context?: unknown }[];
} {
  const calls: { level: string; message: string; context?: unknown }[] = [];
  return {
    calls,
    silly(message: string, context?: unknown) {
      calls.push({ level: "silly", message, context });
    },
    debug(message: string, context?: unknown) {
      calls.push({ level: "debug", message, context });
    },
    info(message: string, context?: unknown) {
      calls.push({ level: "info", message, context });
    },
    warn(message: string, context?: unknown) {
      calls.push({ level: "warn", message, context });
    },
    error(message: string, context?: unknown) {
      calls.push({ level: "error", message, context });
    },
  };
}

function createDispatcher(
  options?: Partial<{ logger: Logger; initialCapabilities: Record<string, unknown> }>
): Dispatcher {
  return new Dispatcher({ logger: options?.logger ?? createMockLogger(), ...options });
}

// =============================================================================
// Tests
// =============================================================================

describe("Dispatcher", () => {
  it("dispatch executes operation and returns result", async () => {
    const dispatcher = createDispatcher();

    const result = { answer: 42 };
    const operation = createTestOperation("query-op", result);
    dispatcher.registerOperation("test:query", operation);

    const actual = await dispatcher.dispatch(createQueryIntent());

    expect(actual).toEqual(result);
  });

  it("throws when no operation registered for intent type", async () => {
    const dispatcher = createDispatcher();

    await expect(dispatcher.dispatch(createActionIntent())).rejects.toThrow(
      "No operation registered for intent type: test:action"
    );
  });

  it("throws on duplicate operation registration", () => {
    const dispatcher = createDispatcher();

    const operation = createTestOperation("op", undefined);
    dispatcher.registerOperation("test:action", operation);

    expect(() => dispatcher.registerOperation("test:action", operation)).toThrow(
      "Operation already registered for intent type: test:action"
    );
  });

  it("interceptor cancels intent", async () => {
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

    const hookRan = vi.fn();

    // Register a hook via module
    dispatcher.registerModule({
      name: "test-hook-mod",
      hooks: {
        "query-op": {
          get: {
            handler: async () => {
              hookRan();
            },
          },
        },
      },
    });

    dispatcher.registerOperation("test:query", {
      id: "query-op",
      execute: async (ctx) => {
        const hookCtx: HookContext = { intent: ctx.intent };
        await ctx.hooks.collect("get", hookCtx);
        return { answer: 42 };
      },
    });

    const result = await dispatcher.dispatch(createQueryIntent());

    expect(hookRan).toHaveBeenCalledOnce();
    expect(result).toEqual({ answer: 42 });
  });

  it("dispatch returns IntentHandle", () => {
    const dispatcher = createDispatcher();

    dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

    const handle = dispatcher.dispatch(createActionIntent());

    expect(handle).toBeInstanceOf(IntentHandle);
  });

  it("accepted resolves to true when no interceptors cancel", async () => {
    const dispatcher = createDispatcher();

    dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

    const handle = dispatcher.dispatch(createActionIntent());
    const accepted = await handle.accepted;

    expect(accepted).toBe(true);
  });

  it("accepted resolves to false when interceptor cancels", async () => {
    const dispatcher = createDispatcher();

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
    const dispatcher = createDispatcher();

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

  describe("registerModule", () => {
    it("registers hooks from module", async () => {
      const dispatcher = createDispatcher();
      const hookRan = vi.fn();

      const testModule: IntentModule = {
        name: "test-hook",
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

      dispatcher.registerModule(testModule);
      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("execute", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      expect(hookRan).toHaveBeenCalledOnce();
    });

    it("subscribes events from module", async () => {
      const dispatcher = createDispatcher();
      const eventHandler = vi.fn();

      const testModule: IntentModule = {
        name: "test-event",
        events: {
          "test:completed": { handler: async (event) => eventHandler(event) },
        },
      };

      dispatcher.registerModule(testModule);

      const operation: Operation<Intent, void> = {
        id: "action-op",
        execute: async (ctx: OperationContext<Intent>) => {
          ctx.emit({ type: "test:completed", payload: { id: "123" } });
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

    it("registers interceptors from module", async () => {
      const dispatcher = createDispatcher();
      const operationExecuted = vi.fn();

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before() {
          return null;
        },
      };

      const testModule: IntentModule = {
        name: "test-interceptor",
        interceptors: [cancelInterceptor],
      };

      dispatcher.registerModule(testModule);

      const operation: Operation<Intent, void> = {
        id: "action-op",
        execute: async () => {
          operationExecuted();
        },
      };
      dispatcher.registerOperation("test:action", operation);

      const result = await dispatcher.dispatch(createActionIntent());

      expect(result).toBeUndefined();
      expect(operationExecuted).not.toHaveBeenCalled();
    });

    it("handles empty module", () => {
      const dispatcher = createDispatcher();

      const emptyModule: IntentModule = { name: "test-empty" };

      expect(() => dispatcher.registerModule(emptyModule)).not.toThrow();
    });

    it("module-level requires applied to hooks with no requires", async () => {
      const dispatcher = createDispatcher();

      // Provider module supplies the capability
      dispatcher.registerModule({
        name: "provider",
        hooks: {
          "action-op": {
            run: {
              provides: () => ({ serverPort: 3000 }),
              handler: async () => undefined,
            },
          },
        },
      });

      // Consumer module requires capability at module level
      let capturedPort: unknown;
      dispatcher.registerModule({
        name: "consumer",
        requires: { serverPort: ANY_VALUE },
        hooks: {
          "action-op": {
            run: {
              handler: async (ctx) => {
                capturedPort = ctx.capabilities?.serverPort;
              },
            },
          },
        },
      });

      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      expect(capturedPort).toBe(3000);
    });

    it("module-level requires merged with hook-level requires", async () => {
      const dispatcher = createDispatcher();

      // Provider supplies both capabilities
      dispatcher.registerModule({
        name: "provider",
        hooks: {
          "action-op": {
            run: {
              provides: () => ({ portA: 1000, portB: 2000 }),
              handler: async () => undefined,
            },
          },
        },
      });

      // Consumer requires portA at module level, portB at hook level
      let capturedCaps: Record<string, unknown> | undefined;
      dispatcher.registerModule({
        name: "consumer",
        requires: { portA: ANY_VALUE },
        hooks: {
          "action-op": {
            run: {
              requires: { portB: ANY_VALUE },
              handler: async (ctx) => {
                capturedCaps = ctx.capabilities as Record<string, unknown>;
              },
            },
          },
        },
      });

      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      expect(capturedCaps?.portA).toBe(1000);
      expect(capturedCaps?.portB).toBe(2000);
    });

    it("hook-level requires override module-level on conflict", async () => {
      const dispatcher = createDispatcher();

      // Provider supplies capability with value 42
      dispatcher.registerModule({
        name: "provider",
        hooks: {
          "action-op": {
            run: {
              provides: () => ({ setting: 42 }),
              handler: async () => undefined,
            },
          },
        },
      });

      // Module requires setting=99 but hook overrides to ANY_VALUE
      let hookRan = false;
      dispatcher.registerModule({
        name: "consumer",
        requires: { setting: 99 },
        hooks: {
          "action-op": {
            run: {
              requires: { setting: ANY_VALUE },
              handler: async () => {
                hookRan = true;
              },
            },
          },
        },
      });

      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      // Hook runs because hook-level ANY_VALUE overrides module-level 99
      expect(hookRan).toBe(true);
    });

    it("registers multiple modules in order", async () => {
      const dispatcher = createDispatcher();
      const order: string[] = [];

      const moduleA: IntentModule = {
        name: "test-a",
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
        name: "test-b",
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

      dispatcher.registerModule(moduleA);
      dispatcher.registerModule(moduleB);

      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("execute", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      expect(order).toEqual(["module-a", "module-b"]);
    });
  });

  describe("AsyncLocalStorage causation", () => {
    it("hook handler inherits causation via ALS when calling dispatcher.dispatch() directly", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      // Child operation captures its causation
      const capturedCausation: (readonly string[])[] = [];
      dispatcher.registerOperation("test:child", {
        id: "child-op",
        execute: async (ctx) => {
          capturedCausation.push(ctx.causation);
        },
      });

      // Parent operation with a hook point
      dispatcher.registerOperation("test:parent", {
        id: "parent-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      // Hook handler dispatches directly on the dispatcher (not via ctx.dispatch)
      // — simulating what hook modules do in practice
      const hookModule: IntentModule = {
        name: "dispatching-hook",
        hooks: {
          "parent-op": {
            run: {
              handler: async () => {
                await dispatcher.dispatch({ type: "test:child", payload: {} });
              },
            },
          },
        },
      };
      dispatcher.registerModule(hookModule);

      await dispatcher.dispatch({ type: "test:parent", payload: {} });

      // Child should see parent in its causation chain via ALS
      expect(capturedCausation).toHaveLength(1);
      expect(capturedCausation[0]).toEqual(["test:parent", "test:child"]);

      // Verify the log shows the ALS-resolved causation
      const childDispatchLog = logger.calls.find(
        (c) =>
          c.level === "info" &&
          c.message === "dispatch" &&
          (c.context as Record<string, unknown>).intent === "test:child"
      );
      expect(childDispatchLog).toBeDefined();
      expect((childDispatchLog!.context as Record<string, unknown>).causation).toBe("test:parent");
    });

    it("explicit causation takes precedence over ALS context", async () => {
      const dispatcher = createDispatcher();

      const capturedCausation: (readonly string[])[] = [];
      dispatcher.registerOperation("test:child", {
        id: "child-op",
        execute: async (ctx) => {
          capturedCausation.push(ctx.causation);
        },
      });

      dispatcher.registerOperation("test:parent", {
        id: "parent-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      // Hook handler passes explicit causation — should override ALS
      const hookModule: IntentModule = {
        name: "explicit-causation-hook",
        hooks: {
          "parent-op": {
            run: {
              handler: async () => {
                await dispatcher.dispatch({ type: "test:child", payload: {} }, ["custom:origin"]);
              },
            },
          },
        },
      };
      dispatcher.registerModule(hookModule);

      await dispatcher.dispatch({ type: "test:parent", payload: {} });

      // Explicit causation should be used, not ALS
      expect(capturedCausation).toHaveLength(1);
      expect(capturedCausation[0]).toEqual(["custom:origin", "test:child"]);
    });
  });

  describe("logging", () => {
    it("logs dispatch start with intent type and causation", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      dispatcher.registerOperation("test:action", createTestOperation("op", undefined));
      await dispatcher.dispatch(createActionIntent());

      const dispatchLog = logger.calls.find((c) => c.level === "info" && c.message === "dispatch");
      expect(dispatchLog).toBeDefined();
      expect(dispatchLog!.context).toEqual(
        expect.objectContaining({ intent: "test:action", causation: "" })
      );
    });

    it("logs completion with intent type and duration", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      dispatcher.registerOperation("test:action", createTestOperation("op", undefined));
      await dispatcher.dispatch(createActionIntent());

      const completedLog = logger.calls.find(
        (c) => c.level === "info" && c.message === "completed"
      );
      expect(completedLog).toBeDefined();
      expect(completedLog!.context).toEqual(
        expect.objectContaining({ intent: "test:action", ms: expect.any(Number) })
      );
    });

    it("logs failure when operation throws", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      dispatcher.registerOperation("test:action", {
        id: "op",
        execute: async () => {
          throw new Error("boom");
        },
      });

      await expect(dispatcher.dispatch(createActionIntent())).rejects.toThrow("boom");

      const failedLog = logger.calls.find((c) => c.level === "error" && c.message === "failed");
      expect(failedLog).toBeDefined();
      expect(failedLog!.context).toEqual(
        expect.objectContaining({ intent: "test:action", error: "boom" })
      );
    });

    it("logs interceptor block", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      dispatcher.registerOperation("test:action", createTestOperation("op", undefined));
      dispatcher.addInterceptor({
        id: "block-it",
        async before() {
          return null;
        },
      });

      await dispatcher.dispatch(createActionIntent());

      const blockLog = logger.calls.find(
        (c) => c.level === "debug" && c.message === "interceptor blocked"
      );
      expect(blockLog).toBeDefined();
      expect(blockLog!.context).toEqual(
        expect.objectContaining({ intent: "test:action", interceptor: "block-it" })
      );
    });

    it("logs hook execution with module names in execution order", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      const testModule: IntentModule = {
        name: "test-mod",
        hooks: {
          "action-op": {
            run: { handler: async () => ({ value: 1 }) },
          },
        },
      };

      dispatcher.registerModule(testModule);
      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      const hookLog = logger.calls.find((c) => c.level === "debug" && c.message === "hook");
      expect(hookLog).toBeDefined();
      expect(hookLog!.context).toEqual(
        expect.objectContaining({
          op: "action-op",
          hook: "run",
          modules: "test-mod",
          results: 1,
          errors: 0,
          ms: expect.any(Number),
        })
      );
    });

    it("logs modules in capability-sorted execution order", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      // consumer registered first but requires capability from provider
      dispatcher.registerModule({
        name: "consumer",
        hooks: {
          "action-op": {
            run: {
              requires: { port: ANY_VALUE },
              handler: async () => undefined,
            },
          },
        },
      });

      dispatcher.registerModule({
        name: "provider",
        hooks: {
          "action-op": {
            run: {
              provides: () => ({ port: 3000 }),
              handler: async () => undefined,
            },
          },
        },
      });

      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      const hookLog = logger.calls.find((c) => c.level === "debug" && c.message === "hook");
      expect(hookLog).toBeDefined();
      // provider ran first despite being registered second
      expect((hookLog!.context as Record<string, unknown>).modules).toBe("provider,consumer");
    });

    it("logs skipped modules with unsatisfied capabilities", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      dispatcher.registerModule({
        name: "stuck-mod",
        hooks: {
          "action-op": {
            run: {
              requires: { missing: ANY_VALUE },
              handler: async () => undefined,
            },
          },
        },
      });

      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      const skippedLog = logger.calls.find(
        (c) => c.level === "debug" && c.message === "hook skipped"
      );
      expect(skippedLog).toBeDefined();
      expect(skippedLog!.context).toEqual(
        expect.objectContaining({
          op: "action-op",
          hook: "run",
          modules: "stuck-mod(missing)",
        })
      );
    });

    it("logs hook errors", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      const testModule: IntentModule = {
        name: "failing-mod",
        hooks: {
          "action-op": {
            run: {
              handler: async () => {
                throw new Error("hook failed");
              },
            },
          },
        },
      };

      dispatcher.registerModule(testModule);
      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          await ctx.hooks.collect("run", { intent: ctx.intent });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      const hookErrorLog = logger.calls.find(
        (c) => c.level === "warn" && c.message === "hook error"
      );
      expect(hookErrorLog).toBeDefined();
      expect(hookErrorLog!.context).toEqual(
        expect.objectContaining({
          op: "action-op",
          hook: "run",
          error: "hook failed",
        })
      );
    });

    it("logs event emission with subscriber names", async () => {
      const logger = createMockLogger();
      const dispatcher = createDispatcher({ logger });

      const testModule: IntentModule = {
        name: "subscriber-mod",
        events: {
          "test:completed": { handler: async () => {} },
        },
      };

      dispatcher.registerModule(testModule);
      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => {
          ctx.emit({ type: "test:completed", payload: {} });
        },
      });

      await dispatcher.dispatch(createActionIntent());

      // Events are routed through the hook system as hook calls on "event:<type>" / "handle"
      const emitLog = logger.calls.find(
        (c) =>
          c.level === "debug" &&
          c.message === "hook" &&
          (c.context as Record<string, unknown>).op === "event:test:completed"
      );
      expect(emitLog).toBeDefined();
      expect(emitLog!.context).toEqual(
        expect.objectContaining({
          op: "event:test:completed",
          hook: "handle",
          modules: "subscriber-mod",
        })
      );
    });

    describe("registration logging", () => {
      it("registerOperation logs at debug level", () => {
        const logger = createMockLogger();
        const dispatcher = createDispatcher({ logger });

        dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

        const registerLog = logger.calls.find(
          (c) => c.level === "debug" && c.message === "register operation"
        );
        expect(registerLog).toBeDefined();
        expect(registerLog!.context).toEqual({ intent: "test:action" });
      });

      it("registerModule logs at debug level", () => {
        const logger = createMockLogger();
        const dispatcher = createDispatcher({ logger });

        const testModule: IntentModule = {
          name: "my-module",
          hooks: {
            "action-op": {
              run: { handler: async () => {} },
            },
          },
        };

        dispatcher.registerModule(testModule);

        const moduleLog = logger.calls.find(
          (c) => c.level === "debug" && c.message === "register module"
        );
        expect(moduleLog).toBeDefined();
        expect(moduleLog!.context).toEqual({ module: "my-module" });
      });

      it("registerModule logs hooks at silly level", () => {
        const logger = createMockLogger();
        const dispatcher = createDispatcher({ logger });

        const testModule: IntentModule = {
          name: "hook-mod",
          hooks: {
            "action-op": {
              start: { handler: async () => {} },
              stop: { handler: async () => {} },
            },
          },
        };

        dispatcher.registerModule(testModule);

        const hookLogs = logger.calls.filter((c) => c.level === "silly" && c.message === "  hook");
        expect(hookLogs).toHaveLength(2);
        expect(hookLogs[0]!.context).toEqual({
          module: "hook-mod",
          op: "action-op",
          hook: "start",
        });
        expect(hookLogs[1]!.context).toEqual({
          module: "hook-mod",
          op: "action-op",
          hook: "stop",
        });
      });

      it("registerModule logs events at silly level", () => {
        const logger = createMockLogger();
        const dispatcher = createDispatcher({ logger });

        const testModule: IntentModule = {
          name: "event-mod",
          events: {
            "test:completed": { handler: async () => {} },
            "test:failed": { handler: async () => {} },
          },
        };

        dispatcher.registerModule(testModule);

        const eventLogs = logger.calls.filter(
          (c) => c.level === "silly" && c.message === "  event"
        );
        expect(eventLogs).toHaveLength(2);
        expect(eventLogs[0]!.context).toEqual({ module: "event-mod", event: "test:completed" });
        expect(eventLogs[1]!.context).toEqual({ module: "event-mod", event: "test:failed" });
      });

      it("registerModule logs interceptors at silly level", () => {
        const logger = createMockLogger();
        const dispatcher = createDispatcher({ logger });

        const testModule: IntentModule = {
          name: "interceptor-mod",
          interceptors: [
            {
              id: "guard-a",
              async before(i: Intent) {
                return i;
              },
            },
            {
              id: "guard-b",
              async before(i: Intent) {
                return i;
              },
            },
          ],
        };

        dispatcher.registerModule(testModule);

        const interceptorLogs = logger.calls.filter(
          (c) => c.level === "silly" && c.message === "  interceptor"
        );
        expect(interceptorLogs).toHaveLength(2);
        expect(interceptorLogs[0]!.context).toEqual({
          module: "interceptor-mod",
          interceptor: "guard-a",
        });
        expect(interceptorLogs[1]!.context).toEqual({
          module: "interceptor-mod",
          interceptor: "guard-b",
        });
      });

      it("registerModule with no contributions only logs module name", () => {
        const logger = createMockLogger();
        const dispatcher = createDispatcher({ logger });

        dispatcher.registerModule({ name: "empty-mod" });

        expect(logger.calls).toHaveLength(1);
        expect(logger.calls[0]!.level).toBe("debug");
        expect(logger.calls[0]!.message).toBe("register module");
        expect(logger.calls[0]!.context).toEqual({ module: "empty-mod" });
      });
    });
  });

  // ===========================================================================
  // Capability-based hook ordering (absorbed from hook-registry tests)
  // ===========================================================================

  describe("capability-based hook ordering", () => {
    /**
     * Helper: registers each handler as a separate module, creates a trivial
     * operation that calls hooks.collect(), dispatches, and returns the HookResult.
     */
    async function collectWithModules(
      handlers: HookHandler[],
      ctx: HookContext,
      initialCapabilities?: Record<string, unknown>,
      logger?: ReturnType<typeof createMockLogger>
    ) {
      const log = logger ?? createMockLogger();
      const dispatcher = new Dispatcher({
        logger: log,
        ...(initialCapabilities && { initialCapabilities }),
      });
      handlers.forEach((h, i) =>
        dispatcher.registerModule({
          name: h.name ?? `handler-${i}`,
          hooks: { "test-op": { "test-hook": h } },
        })
      );
      let hookResult!: HookResult;
      dispatcher.registerOperation("test:collect", {
        id: "test-op",
        execute: async (opCtx) => {
          hookResult = await opCtx.hooks.collect("test-hook", ctx);
          return hookResult;
        },
      });
      await dispatcher.dispatch({ type: "test:collect", payload: {} });
      return hookResult;
    }

    it("empty hook point returns empty results and errors", async () => {
      const dispatcher = createDispatcher();
      dispatcher.registerOperation("test:action", {
        id: "action-op",
        execute: async (ctx) => ctx.hooks.collect("nonexistent", { intent: ctx.intent }),
      });

      const result = (await dispatcher.dispatch(createActionIntent())) as HookResult;

      expect(result.results).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("handlers run in registration order", async () => {
      const order: number[] = [];

      const result = await collectWithModules(
        [
          {
            handler: async () => {
              order.push(1);
            },
          },
          {
            handler: async () => {
              order.push(2);
            },
          },
          {
            handler: async () => {
              order.push(3);
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(order).toEqual([1, 2, 3]);
      expect(result.errors).toEqual([]);
    });

    it("returns typed results from handlers", async () => {
      const result = await collectWithModules(
        [
          { handler: async () => ({ value: 1 }) },
          { handler: async () => ({ value: 2 }) },
          { handler: async () => ({ value: 3 }) },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(result.results).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
      expect(result.errors).toEqual([]);
    });

    it("handler mutation of frozen context throws TypeError", async () => {
      const result = await collectWithModules(
        [
          {
            handler: async (ctx: HookContext) => {
              (ctx as unknown as Record<string, unknown>).isDirty = true;
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(result.results).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(TypeError);
    });

    it("all handlers run even when earlier handlers throw", async () => {
      const ran: number[] = [];

      const result = await collectWithModules(
        [
          {
            handler: async () => {
              ran.push(1);
              throw new Error("first failed");
            },
          },
          {
            handler: async () => {
              ran.push(2);
              return "ok";
            },
          },
          {
            handler: async () => {
              ran.push(3);
              throw new Error("third failed");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual([1, 2, 3]);
      expect(result.results).toEqual(["ok"]);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]?.message).toBe("first failed");
      expect(result.errors[1]?.message).toBe("third failed");
    });

    it("non-Error throws are wrapped in Error", async () => {
      const result = await collectWithModules(
        [
          {
            handler: async () => {
              throw "string error";
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(Error);
      expect(result.errors[0]?.message).toBe("string error");
    });

    it("filters undefined results from self-selecting handlers", async () => {
      const result = await collectWithModules(
        [
          { handler: async () => undefined },
          { handler: async () => ({ projectPath: "/selected" }) },
          { handler: async () => undefined },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(result.results).toEqual([{ projectPath: "/selected" }]);
      expect(result.errors).toEqual([]);
    });

    it("filters null results from self-selecting handlers", async () => {
      const result = await collectWithModules(
        [{ handler: async () => null }, { handler: async () => ({ value: "kept" }) }],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(result.results).toEqual([{ value: "kept" }]);
      expect(result.errors).toEqual([]);
    });

    it("original input context is not mutated", async () => {
      const ctx: HookContext = {
        intent: { type: "test:noop", payload: {} },
      };
      const originalIntent = ctx.intent;

      await collectWithModules([{ handler: async () => "result" }], ctx);

      expect(ctx.intent).toBe(originalIntent);
    });

    it("handler with requires runs after handler with matching provides", async () => {
      const order: string[] = [];

      await collectWithModules(
        [
          {
            requires: { port: ANY_VALUE },
            handler: async () => {
              order.push("consumer");
            },
          },
          {
            provides: () => ({ port: 3000 }),
            handler: async () => {
              order.push("provider");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(order).toEqual(["provider", "consumer"]);
    });

    it("handler with multiple requires waits for all", async () => {
      const order: string[] = [];

      await collectWithModules(
        [
          {
            requires: { a: ANY_VALUE, b: ANY_VALUE },
            handler: async () => {
              order.push("needs-both");
            },
          },
          {
            provides: () => ({ a: 1 }),
            handler: async () => {
              order.push("provides-a");
            },
          },
          {
            provides: () => ({ b: 2 }),
            handler: async () => {
              order.push("provides-b");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(order).toEqual(["provides-a", "provides-b", "needs-both"]);
    });

    it("capabilities accessible via ctx.capabilities", async () => {
      let receivedCaps: Record<string, unknown> | undefined;

      await collectWithModules(
        [
          {
            provides: () => ({ port: 8080 }),
            handler: async () => undefined,
          },
          {
            requires: { port: ANY_VALUE },
            handler: async (ctx) => {
              receivedCaps = { ...ctx.capabilities };
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(receivedCaps).toEqual({ port: 8080 });
    });

    it("failed handler does not contribute provides", async () => {
      const ran: string[] = [];

      const result = await collectWithModules(
        [
          {
            provides: () => ({ token: "abc" }),
            handler: async () => {
              throw new Error("provider failed");
            },
          },
          {
            requires: { token: ANY_VALUE },
            handler: async () => {
              ran.push("consumer");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toBe("provider failed");
    });

    it("unsatisfied requirements: handler does not run, no error", async () => {
      const ran: string[] = [];

      const result = await collectWithModules(
        [
          {
            requires: { missing: ANY_VALUE },
            handler: async () => {
              ran.push("should-not-run");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual([]);
      expect(result.results).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("multi-round resolution (A→B→C chain)", async () => {
      const order: string[] = [];

      await collectWithModules(
        [
          {
            requires: { y: ANY_VALUE },
            provides: () => ({ z: 3 }),
            handler: async () => {
              order.push("C");
            },
          },
          {
            requires: { x: ANY_VALUE },
            provides: () => ({ y: 2 }),
            handler: async () => {
              order.push("B");
            },
          },
          {
            provides: () => ({ x: 1 }),
            handler: async () => {
              order.push("A");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(order).toEqual(["A", "B", "C"]);
    });

    it("circular dependencies: none of the stuck handlers run", async () => {
      const ran: string[] = [];

      const result = await collectWithModules(
        [
          {
            requires: { b: ANY_VALUE },
            provides: () => ({ a: 1 }),
            handler: async () => {
              ran.push("A");
            },
          },
          {
            requires: { a: ANY_VALUE },
            provides: () => ({ b: 2 }),
            handler: async () => {
              ran.push("B");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual([]);
      expect(result.results).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("mixed handlers: some with capabilities, some without", async () => {
      const order: string[] = [];

      await collectWithModules(
        [
          {
            requires: { setup: ANY_VALUE },
            handler: async () => {
              order.push("needs-setup");
            },
          },
          {
            handler: async () => {
              order.push("plain");
            },
          },
          {
            provides: () => ({ setup: true }),
            handler: async () => {
              order.push("provides-setup");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(order).toEqual(["plain", "provides-setup", "needs-setup"]);
    });

    it("initial capabilities from context seed", async () => {
      const ran: string[] = [];

      await collectWithModules(
        [
          {
            requires: { seed: true },
            handler: async () => {
              ran.push("seeded");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} }, capabilities: { seed: true } }
      );

      expect(ran).toEqual(["seeded"]);
    });

    it("initial capabilities from constructor", async () => {
      const ran: string[] = [];

      const dispatcher = new Dispatcher({
        logger: createMockLogger(),
        initialCapabilities: { platform: "linux" },
      });
      dispatcher.registerModule({
        name: "platform-mod",
        hooks: {
          "test-op": {
            "test-hook": {
              requires: { platform: "linux" },
              handler: async () => {
                ran.push("linux-handler");
              },
            },
          },
        },
      });
      dispatcher.registerOperation("test:collect", {
        id: "test-op",
        execute: async (ctx) => ctx.hooks.collect("test-hook", { intent: ctx.intent }),
      });

      await dispatcher.dispatch({ type: "test:collect", payload: {} });

      expect(ran).toEqual(["linux-handler"]);
    });

    it("value matching: requires with ANY_VALUE accepts any value", async () => {
      const ran: string[] = [];

      await collectWithModules(
        [
          {
            provides: () => ({ key: 42 }),
            handler: async () => undefined,
          },
          {
            requires: { key: ANY_VALUE },
            handler: async () => {
              ran.push("accepted");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual(["accepted"]);
    });

    it("value matching: requires with specific value rejects mismatch", async () => {
      const ran: string[] = [];

      await collectWithModules(
        [
          {
            provides: () => ({ platform: "darwin" }),
            handler: async () => undefined,
          },
          {
            requires: { platform: "linux" },
            handler: async () => {
              ran.push("linux-only");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual([]);
    });

    it("value matching: requires with undefined means capability must NOT exist", async () => {
      const ran: string[] = [];

      await collectWithModules(
        [
          {
            requires: { flag: undefined },
            handler: async () => {
              ran.push("no-flag");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(ran).toEqual(["no-flag"]);
    });

    it("value matching: requires undefined blocked when capability exists", async () => {
      const ran: string[] = [];

      await collectWithModules(
        [
          {
            requires: { flag: undefined },
            handler: async () => {
              ran.push("no-flag");
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} }, capabilities: { flag: true } }
      );

      expect(ran).toEqual([]);
    });

    it("dynamic provides: closure value read at call time", async () => {
      let port = 0;
      let receivedCaps: Record<string, unknown> | undefined;

      await collectWithModules(
        [
          {
            provides: () => ({ port }),
            handler: async () => {
              port = 9090;
            },
          },
          {
            requires: { port: ANY_VALUE },
            handler: async (ctx) => {
              receivedCaps = { ...ctx.capabilities };
            },
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(receivedCaps).toEqual({ port: 9090 });
    });

    it("collect() returns accumulated capabilities", async () => {
      const result = await collectWithModules(
        [
          {
            provides: () => ({ port: 8080 }),
            handler: async () => undefined,
          },
          {
            provides: () => ({ host: "127.0.0.1" }),
            handler: async () => undefined,
          },
        ],
        { intent: { type: "test:noop", payload: {} } }
      );

      expect(result.capabilities).toEqual({ port: 8080, host: "127.0.0.1" });
    });

    it("logs ran modules in execution order", async () => {
      const logger = createMockLogger();
      await collectWithModules(
        [
          {
            name: "consumer",
            requires: { port: ANY_VALUE },
            handler: async () => undefined,
          },
          {
            name: "provider",
            provides: () => ({ port: 3000 }),
            handler: async () => undefined,
          },
        ],
        { intent: { type: "test:noop", payload: {} } },
        undefined,
        logger
      );

      const hookLog = logger.calls.find((c) => c.level === "debug" && c.message === "hook");
      // provider ran first (despite being registered second) because consumer requires port
      expect((hookLog!.context as Record<string, unknown>).modules).toBe("provider,consumer");
    });

    it("logs skipped modules with unsatisfied caps", async () => {
      const logger = createMockLogger();
      await collectWithModules(
        [
          {
            name: "stuck-a",
            requires: { missing: ANY_VALUE },
            handler: async () => undefined,
          },
          {
            name: "stuck-b",
            requires: { token: ANY_VALUE, host: ANY_VALUE },
            handler: async () => undefined,
          },
          {
            name: "ok-mod",
            handler: async () => undefined,
          },
        ],
        { intent: { type: "test:noop", payload: {} } },
        undefined,
        logger
      );

      const hookLog = logger.calls.find((c) => c.level === "debug" && c.message === "hook");
      expect((hookLog!.context as Record<string, unknown>).modules).toBe("ok-mod");

      const skippedLog = logger.calls.find(
        (c) => c.level === "debug" && c.message === "hook skipped"
      );
      expect((skippedLog!.context as Record<string, unknown>).modules).toBe(
        "stuck-a(missing),stuck-b(token,host)"
      );
    });
  });
});
