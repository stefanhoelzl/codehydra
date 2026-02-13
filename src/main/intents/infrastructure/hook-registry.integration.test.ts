/**
 * Integration tests for HookRegistry.
 *
 * Verifies hook execution order, collect() isolation, error collection,
 * and context freezing behavior.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "./hook-registry";
import type { HookContext } from "./operation";

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_OPERATION_ID = "test-operation";
const TEST_HOOK_POINT = "test-hook";

function createHookContext(): HookContext {
  return {
    intent: { type: "test:noop", payload: {} },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("HookRegistry", () => {
  it("empty hook point returns empty results and errors", async () => {
    const registry = new HookRegistry();
    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect(TEST_HOOK_POINT, ctx);

    expect(result.results).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("handlers run in registration order", async () => {
    const registry = new HookRegistry();
    const order: number[] = [];

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        order.push(1);
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        order.push(2);
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        order.push(3);
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    await hooks.collect(TEST_HOOK_POINT, ctx);

    expect(order).toEqual([1, 2, 3]);
  });

  it("returns typed results from handlers", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => ({ value: 1 }),
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => ({ value: 2 }),
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => ({ value: 3 }),
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect<{ value: number }>(TEST_HOOK_POINT, ctx);

    expect(result.results).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(result.errors).toEqual([]);
  });

  it("handler mutation of frozen context throws TypeError", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async (ctx: HookContext) => {
        // Attempt to mutate frozen context — should throw TypeError
        (ctx as unknown as Record<string, unknown>).isDirty = true;
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect(TEST_HOOK_POINT, ctx);

    expect(result.results).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeInstanceOf(TypeError);
  });

  it("all handlers run even when earlier handlers throw", async () => {
    const registry = new HookRegistry();
    const ran: number[] = [];

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push(1);
        throw new Error("first failed");
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push(2);
        return "ok";
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push(3);
        throw new Error("third failed");
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect<string>(TEST_HOOK_POINT, ctx);

    expect(ran).toEqual([1, 2, 3]);
    expect(result.results).toEqual(["ok"]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.message).toBe("first failed");
    expect(result.errors[1]?.message).toBe("third failed");
  });

  it("non-Error throws are wrapped in Error", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        throw "string error";
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect(TEST_HOOK_POINT, ctx);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeInstanceOf(Error);
    expect(result.errors[0]?.message).toBe("string error");
  });

  it("separate hook points are independent", async () => {
    const registry = new HookRegistry();
    const ran: string[] = [];

    registry.register(TEST_OPERATION_ID, "point-a", {
      handler: async () => {
        ran.push("a");
      },
    });

    registry.register(TEST_OPERATION_ID, "point-b", {
      handler: async () => {
        ran.push("b");
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    await hooks.collect("point-a", ctx);

    expect(ran).toEqual(["a"]);
  });

  it("original input context is not mutated", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => "result",
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();
    const originalIntent = ctx.intent;

    await hooks.collect(TEST_HOOK_POINT, ctx);

    expect(ctx.intent).toBe(originalIntent);
  });
});
