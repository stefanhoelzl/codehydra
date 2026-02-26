/**
 * Integration tests for Dispatcher.
 *
 * Verifies dispatch → execute flow, interceptor modify/cancel/ordering,
 * event emission, causation chain tracking, no-operation error, and logging.
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher, IntentHandle } from "./dispatcher";
import type { IntentInterceptor } from "./dispatcher";
import { HookRegistry } from "./hook-registry";
import type { IntentModule } from "./module";
import type { Intent, DomainEvent } from "./types";
import type { Operation, OperationContext, HookContext } from "./operation";
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
        await ctx.hooks.collect("get", hookCtx);
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

  describe("registerModule", () => {
    it("registers hooks from module", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
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

      const hooks = hookRegistry.resolve("action-op");
      const ctx: HookContext = { intent: createActionIntent() };
      await hooks.collect("execute", ctx);

      expect(hookRan).toHaveBeenCalledOnce();
    });

    it("subscribes events from module", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const eventHandler = vi.fn();

      const testModule: IntentModule = {
        name: "test-event",
        events: {
          "test:completed": eventHandler,
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
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
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
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      const emptyModule: IntentModule = { name: "test-empty" };

      expect(() => dispatcher.registerModule(emptyModule)).not.toThrow();
    });

    it("registers multiple modules in order", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
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

      const hooks = hookRegistry.resolve("action-op");
      const ctx: HookContext = { intent: createActionIntent() };
      await hooks.collect("execute", ctx);

      expect(order).toEqual(["module-a", "module-b"]);
    });
  });

  describe("logging", () => {
    it("logs dispatch start with intent type and causation", async () => {
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

      dispatcher.registerOperation("test:action", createTestOperation("op", undefined));
      await dispatcher.dispatch(createActionIntent());

      const dispatchLog = logger.calls.find((c) => c.level === "info" && c.message === "dispatch");
      expect(dispatchLog).toBeDefined();
      expect(dispatchLog!.context).toEqual(
        expect.objectContaining({ intent: "test:action", causation: "" })
      );
    });

    it("logs completion with intent type and duration", async () => {
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

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
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

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
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

      dispatcher.registerOperation("test:action", createTestOperation("op", undefined));
      dispatcher.addInterceptor({
        id: "block-it",
        async before() {
          return null;
        },
      });

      await dispatcher.dispatch(createActionIntent());

      const blockLog = logger.calls.find(
        (c) => c.level === "warn" && c.message === "interceptor blocked"
      );
      expect(blockLog).toBeDefined();
      expect(blockLog!.context).toEqual(
        expect.objectContaining({ intent: "test:action", interceptor: "block-it" })
      );
    });

    it("logs hook execution with module names", async () => {
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

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

    it("logs hook errors", async () => {
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

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
      const hookRegistry = new HookRegistry();
      const logger = createMockLogger();
      const dispatcher = new Dispatcher(hookRegistry, logger);

      const testModule: IntentModule = {
        name: "subscriber-mod",
        events: {
          "test:completed": () => {},
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

      const emitLog = logger.calls.find((c) => c.level === "info" && c.message === "emit");
      expect(emitLog).toBeDefined();
      expect(emitLog!.context).toEqual(
        expect.objectContaining({
          event: "test:completed",
          subscribers: "subscriber-mod",
        })
      );
    });

    describe("registration logging", () => {
      it("registerOperation logs at debug level", () => {
        const hookRegistry = new HookRegistry();
        const logger = createMockLogger();
        const dispatcher = new Dispatcher(hookRegistry, logger);

        dispatcher.registerOperation("test:action", createTestOperation("op", undefined));

        const registerLog = logger.calls.find(
          (c) => c.level === "debug" && c.message === "register operation"
        );
        expect(registerLog).toBeDefined();
        expect(registerLog!.context).toEqual({ intent: "test:action" });
      });

      it("registerModule logs at debug level", () => {
        const hookRegistry = new HookRegistry();
        const logger = createMockLogger();
        const dispatcher = new Dispatcher(hookRegistry, logger);

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
        const hookRegistry = new HookRegistry();
        const logger = createMockLogger();
        const dispatcher = new Dispatcher(hookRegistry, logger);

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
        const hookRegistry = new HookRegistry();
        const logger = createMockLogger();
        const dispatcher = new Dispatcher(hookRegistry, logger);

        const testModule: IntentModule = {
          name: "event-mod",
          events: {
            "test:completed": () => {},
            "test:failed": () => {},
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
        const hookRegistry = new HookRegistry();
        const logger = createMockLogger();
        const dispatcher = new Dispatcher(hookRegistry, logger);

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
        const hookRegistry = new HookRegistry();
        const logger = createMockLogger();
        const dispatcher = new Dispatcher(hookRegistry, logger);

        dispatcher.registerModule({ name: "empty-mod" });

        expect(logger.calls).toHaveLength(1);
        expect(logger.calls[0]!.level).toBe("debug");
        expect(logger.calls[0]!.message).toBe("register module");
        expect(logger.calls[0]!.context).toEqual({ module: "empty-mod" });
      });
    });

    it("works without logger (backward compatible)", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation("test:action", createTestOperation("op", { ok: true }));

      const result = await dispatcher.dispatch(createActionIntent());
      expect(result).toEqual({ ok: true });
    });
  });
});
