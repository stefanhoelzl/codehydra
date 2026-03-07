/**
 * Integration tests for HookRegistry.
 *
 * Verifies hook execution order, collect() isolation, error collection,
 * and context freezing behavior.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "./hook-registry";
import type { HookContext } from "./operation";
import { ANY_VALUE } from "./operation";

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_OPERATION_ID = "test-operation";
const TEST_HOOK_POINT = "test-hook";

function createHookContext(capabilities: Record<string, unknown> = {}): HookContext {
  return {
    intent: { type: "test:noop", payload: {} },
    capabilities,
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

  it("filters undefined results from self-selecting handlers", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => undefined,
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => ({ projectPath: "/selected" }),
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => undefined,
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect<{ projectPath: string }>(TEST_HOOK_POINT, ctx);

    expect(result.results).toEqual([{ projectPath: "/selected" }]);
    expect(result.errors).toEqual([]);
  });

  it("filters null results from self-selecting handlers", async () => {
    const registry = new HookRegistry();

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => null,
    });

    registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      handler: async () => ({ value: "kept" }),
    });

    const hooks = registry.resolve(TEST_OPERATION_ID);
    const ctx = createHookContext();

    const result = await hooks.collect<{ value: string }>(TEST_HOOK_POINT, ctx);

    expect(result.results).toEqual([{ value: "kept" }]);
    expect(result.errors).toEqual([]);
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

  // ===========================================================================
  // Capability-based ordering
  // ===========================================================================

  describe("capability-based ordering", () => {
    it("no-capability handlers preserve registration order", async () => {
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
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(order).toEqual([1, 2, 3]);
    });

    it("handler with requires runs after handler with matching provides", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { port: ANY_VALUE },
        handler: async () => {
          order.push("consumer");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { port: 3000 },
        handler: async () => {
          order.push("provider");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(order).toEqual(["provider", "consumer"]);
    });

    it("handler with multiple requires waits for all", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { a: ANY_VALUE, b: ANY_VALUE },
        handler: async () => {
          order.push("needs-both");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { a: 1 },
        handler: async () => {
          order.push("provides-a");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { b: 2 },
        handler: async () => {
          order.push("provides-b");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(order).toEqual(["provides-a", "provides-b", "needs-both"]);
    });

    it("capabilities accessible via ctx.capabilities", async () => {
      const registry = new HookRegistry();
      let receivedCaps: Record<string, unknown> | undefined;

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { port: 8080 },
        handler: async () => undefined,
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { port: ANY_VALUE },
        handler: async (ctx) => {
          receivedCaps = { ...ctx.capabilities };
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(receivedCaps).toEqual({ port: 8080 });
    });

    it("provides values are the declared values", async () => {
      const registry = new HookRegistry();
      let receivedCaps: Record<string, unknown> | undefined;

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { url: "http://127.0.0.1:3000" },
        handler: async () => undefined,
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { url: ANY_VALUE },
        handler: async (ctx) => {
          receivedCaps = { ...ctx.capabilities };
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(receivedCaps).toEqual({ url: "http://127.0.0.1:3000" });
    });

    it("failed handler does not contribute provides", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { token: "abc" },
        handler: async () => {
          throw new Error("provider failed");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { token: ANY_VALUE },
        handler: async () => {
          ran.push("consumer");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      const result = await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(ran).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toBe("provider failed");
    });

    it("unsatisfied requirements: handler does not run, no error", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { missing: ANY_VALUE },
        handler: async () => {
          ran.push("should-not-run");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      const result = await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(ran).toEqual([]);
      expect(result.results).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("multi-round resolution (A→B→C chain)", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { y: ANY_VALUE },
        provides: { z: 3 },
        handler: async () => {
          order.push("C");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { x: ANY_VALUE },
        provides: { y: 2 },
        handler: async () => {
          order.push("B");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { x: 1 },
        handler: async () => {
          order.push("A");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(order).toEqual(["A", "B", "C"]);
    });

    it("circular dependencies: none of the stuck handlers run", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { b: ANY_VALUE },
        provides: { a: 1 },
        handler: async () => {
          ran.push("A");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { a: ANY_VALUE },
        provides: { b: 2 },
        handler: async () => {
          ran.push("B");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      const result = await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(ran).toEqual([]);
      expect(result.results).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("mixed handlers: some with capabilities, some without", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { setup: ANY_VALUE },
        handler: async () => {
          order.push("needs-setup");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        handler: async () => {
          order.push("plain");
        },
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { setup: true },
        handler: async () => {
          order.push("provides-setup");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(order).toEqual(["plain", "provides-setup", "needs-setup"]);
    });

    it("initial capabilities from context seed", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { seed: true },
        handler: async () => {
          ran.push("seeded");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext({ seed: true }));

      expect(ran).toEqual(["seeded"]);
    });

    it("handlers without requires but with provides add to capabilities", async () => {
      const registry = new HookRegistry();
      let receivedCaps: Record<string, unknown> | undefined;

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { contributed: "yes" },
        handler: async () => undefined,
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { contributed: ANY_VALUE },
        handler: async (ctx) => {
          receivedCaps = { ...ctx.capabilities };
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(receivedCaps).toEqual({ contributed: "yes" });
    });

    it("value matching: requires with ANY_VALUE accepts any value", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { key: 42 },
        handler: async () => undefined,
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { key: ANY_VALUE },
        handler: async () => {
          ran.push("accepted");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(ran).toEqual(["accepted"]);
    });

    it("value matching: requires with specific value rejects mismatch", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        provides: { platform: "darwin" },
        handler: async () => undefined,
      });
      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { platform: "linux" },
        handler: async () => {
          ran.push("linux-only");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(ran).toEqual([]);
    });

    it("value matching: requires with undefined means capability must NOT exist", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { flag: undefined },
        handler: async () => {
          ran.push("no-flag");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext());

      expect(ran).toEqual(["no-flag"]);
    });

    it("value matching: requires undefined blocked when capability exists", async () => {
      const registry = new HookRegistry();
      const ran: string[] = [];

      registry.register(TEST_OPERATION_ID, TEST_HOOK_POINT, {
        requires: { flag: undefined },
        handler: async () => {
          ran.push("no-flag");
        },
      });

      const hooks = registry.resolve(TEST_OPERATION_ID);
      await hooks.collect(TEST_HOOK_POINT, createHookContext({ flag: true }));

      expect(ran).toEqual([]);
    });
  });
});
