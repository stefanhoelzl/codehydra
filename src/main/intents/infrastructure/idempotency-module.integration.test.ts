// @vitest-environment node
/**
 * Integration tests for createIdempotencyModule.
 *
 * Uses real Dispatcher + HookRegistry with trivial no-op operations.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "./hook-registry";
import { Dispatcher } from "./dispatcher";
import { wireModules } from "./wire";
import { createIdempotencyModule } from "./idempotency-module";
import type { Intent, DomainEvent } from "./types";
import type { Operation, OperationContext } from "./operation";

// =============================================================================
// Test Helpers
// =============================================================================

function noopOperation(id: string): Operation<Intent, void> {
  return {
    id,
    execute: async () => {},
  };
}

function setup(...args: Parameters<typeof createIdempotencyModule>): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const mod = createIdempotencyModule(...args);
  wireModules([mod], hookRegistry, dispatcher);
  return { dispatcher };
}

// =============================================================================
// Tests
// =============================================================================

describe("createIdempotencyModule", () => {
  it("singleton: blocks duplicate dispatch", async () => {
    const { dispatcher } = setup([{ intentType: "test:shutdown" }]);
    dispatcher.registerOperation("test:shutdown", noopOperation("shutdown-op"));

    // First dispatch succeeds
    const h1 = dispatcher.dispatch({ type: "test:shutdown", payload: {} });
    expect(await h1.accepted).toBe(true);
    await h1;

    // Second dispatch blocked
    const h2 = dispatcher.dispatch({ type: "test:shutdown", payload: {} });
    expect(await h2.accepted).toBe(false);
  });

  it("singleton: passes through unrelated intents", async () => {
    const { dispatcher } = setup([{ intentType: "test:shutdown" }]);
    dispatcher.registerOperation("test:shutdown", noopOperation("shutdown-op"));
    dispatcher.registerOperation("test:other", noopOperation("other-op"));

    // Dispatch the guarded intent
    await dispatcher.dispatch({ type: "test:shutdown", payload: {} });

    // Unrelated intent still passes through
    const h = dispatcher.dispatch({ type: "test:other", payload: {} });
    expect(await h.accepted).toBe(true);
  });

  it("singleton with reset: blocks during active, unblocks after reset event", async () => {
    const { dispatcher } = setup([{ intentType: "test:setup", resetOn: "test:setup-error" }]);
    dispatcher.registerOperation("test:setup", {
      id: "setup-op",
      execute: async (ctx: OperationContext<Intent>) => {
        ctx.emit({ type: "test:setup-error", payload: {} });
      },
    } satisfies Operation<Intent, void>);

    // First dispatch succeeds and emits reset event
    await dispatcher.dispatch({ type: "test:setup", payload: {} });

    // After reset, second dispatch succeeds
    const h2 = dispatcher.dispatch({ type: "test:setup", payload: {} });
    expect(await h2.accepted).toBe(true);
  });

  it("per-key: blocks duplicate key, allows different key", async () => {
    const { dispatcher } = setup([
      {
        intentType: "test:delete",
        getKey: (p) => (p as { path: string }).path,
      },
    ]);
    dispatcher.registerOperation("test:delete", noopOperation("delete-op"));

    // First dispatch for /a succeeds
    const h1 = dispatcher.dispatch({ type: "test:delete", payload: { path: "/a" } });
    expect(await h1.accepted).toBe(true);

    // Duplicate /a blocked
    const h2 = dispatcher.dispatch({ type: "test:delete", payload: { path: "/a" } });
    expect(await h2.accepted).toBe(false);

    // Different key /b succeeds
    const h3 = dispatcher.dispatch({ type: "test:delete", payload: { path: "/b" } });
    expect(await h3.accepted).toBe(true);
  });

  it("per-key with reset: clears specific key, does not clear other keys", async () => {
    const { dispatcher } = setup([
      {
        intentType: "test:delete",
        getKey: (p) => (p as { path: string }).path,
        resetOn: "test:deleted",
      },
    ]);

    let emitFn: ((event: DomainEvent) => void) | undefined;
    dispatcher.registerOperation("test:delete", {
      id: "delete-op",
      execute: async (ctx: OperationContext<Intent>) => {
        emitFn = ctx.emit;
      },
    });

    // Dispatch /a and /b
    await dispatcher.dispatch({ type: "test:delete", payload: { path: "/a" } });
    await dispatcher.dispatch({ type: "test:delete", payload: { path: "/b" } });

    // Both blocked now
    expect(
      await dispatcher.dispatch({ type: "test:delete", payload: { path: "/a" } }).accepted
    ).toBe(false);
    expect(
      await dispatcher.dispatch({ type: "test:delete", payload: { path: "/b" } }).accepted
    ).toBe(false);

    // Reset /a via event
    emitFn!({ type: "test:deleted", payload: { path: "/a" } });

    // /a unblocked, /b still blocked
    expect(
      await dispatcher.dispatch({ type: "test:delete", payload: { path: "/a" } }).accepted
    ).toBe(true);
    expect(
      await dispatcher.dispatch({ type: "test:delete", payload: { path: "/b" } }).accepted
    ).toBe(false);
  });

  it("per-key with force: bypasses block but still tracks key", async () => {
    const { dispatcher } = setup([
      {
        intentType: "test:delete",
        getKey: (p) => (p as { path: string }).path,
        isForced: (intent) => (intent.payload as { force: boolean }).force,
      },
    ]);
    dispatcher.registerOperation("test:delete", noopOperation("delete-op"));

    // First dispatch for /a
    await dispatcher.dispatch({ type: "test:delete", payload: { path: "/a", force: false } });

    // Duplicate /a blocked (no force)
    const h2 = dispatcher.dispatch({ type: "test:delete", payload: { path: "/a", force: false } });
    expect(await h2.accepted).toBe(false);

    // Force bypasses
    const h3 = dispatcher.dispatch({ type: "test:delete", payload: { path: "/a", force: true } });
    expect(await h3.accepted).toBe(true);
  });

  it("multiple rules: handles different intent types independently", async () => {
    const { dispatcher } = setup([
      { intentType: "test:shutdown" },
      {
        intentType: "test:delete",
        getKey: (p) => (p as { path: string }).path,
      },
    ]);
    dispatcher.registerOperation("test:shutdown", noopOperation("shutdown-op"));
    dispatcher.registerOperation("test:delete", noopOperation("delete-op"));

    // Shutdown blocks on second call
    await dispatcher.dispatch({ type: "test:shutdown", payload: {} });
    expect(await dispatcher.dispatch({ type: "test:shutdown", payload: {} }).accepted).toBe(false);

    // Delete still works independently
    const h = dispatcher.dispatch({ type: "test:delete", payload: { path: "/x" } });
    expect(await h.accepted).toBe(true);

    // But duplicate delete key is blocked
    expect(
      await dispatcher.dispatch({ type: "test:delete", payload: { path: "/x" } }).accepted
    ).toBe(false);
  });
});
