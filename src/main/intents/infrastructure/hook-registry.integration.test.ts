/**
 * Integration tests for HookRegistry.
 *
 * Verifies hook execution order, error propagation, and onError handler behavior.
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
  it("empty hook point is no-op", async () => {
    const registry = new HookRegistry();
    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    await hooks.run(TEST_HOOK_POINT, ctx);

    expect(ctx.error).toBeUndefined();
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

    await hooks.run(TEST_HOOK_POINT, ctx);

    expect(order).toEqual([1, 2, 3]);
    expect(ctx.error).toBeUndefined();
  });

  it("error skips non-onError handlers", async () => {
    const registry = new HookRegistry();
    const ran: string[] = [];

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push("first");
        throw new Error("handler failed");
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push("second");
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push("third");
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    await hooks.run(TEST_HOOK_POINT, ctx);

    expect(ran).toEqual(["first"]);
    expect(ctx.error).toBeInstanceOf(Error);
    expect(ctx.error?.message).toBe("handler failed");
  });

  it("onError handler runs after error", async () => {
    const registry = new HookRegistry();
    const ran: string[] = [];

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push("first");
        throw new Error("handler failed");
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        ran.push("normal-skipped");
      },
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async (ctx) => {
        ran.push("error-handler");
        // Verify the error is visible to the onError handler
        expect(ctx.error).toBeInstanceOf(Error);
        expect(ctx.error?.message).toBe("handler failed");
      },
      onError: true,
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    await hooks.run(TEST_HOOK_POINT, ctx);

    expect(ran).toEqual(["first", "error-handler"]);
    expect(ctx.error).toBeInstanceOf(Error);
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

    await hooks.run("point-a", ctx);

    expect(ran).toEqual(["a"]);
  });

  it("non-Error thrown is wrapped in Error", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => {
        throw "string error";
      },
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    await hooks.run(TEST_HOOK_POINT, ctx);

    expect(ctx.error).toBeInstanceOf(Error);
    expect(ctx.error?.message).toBe("string error");
  });
});
