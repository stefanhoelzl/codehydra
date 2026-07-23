// @vitest-environment node
/**
 * The dispatcher's contract carriers reject non-serializable values.
 *
 * This is T1's thesis as an executable claim. The dispatcher already validates six carriers
 * with zod — intent payload, hook input context, hook result, provided capabilities, event
 * payload, and operation result. Those `parse` calls only amount to a serializability gate if
 * no schema opts out of validating, and two zod forms do exactly that:
 *
 *   z.instanceof(Path)  requires a class instance rather than merely permitting one
 *   z.custom<T>()       with no validator runs no validation at all
 *
 * With both closed (and an eslint rule keeping them closed), a branded string rejects a class
 * instance and a structural object rejects a function — so the parses that were already there
 * become the gate, with no new runtime machinery. If someone reintroduces an escape, the
 * carrier it guards stops rejecting and a test here fails.
 *
 * Note what this file does NOT assert: that a *live* value is converted. `z.object` accepts an
 * `Error` instance (it can read `name`/`message`/`stack` off the prototype) and strips it to a
 * plain object — and the dispatcher discards the hook-input parse result, so stripping alone
 * would not make the context serializable. That is why `app:start` converts explicitly with
 * `toSerializedError()`, and why the last test here checks the *operation's* output rather
 * than the schema's tolerance.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { Dispatcher } from "./dispatcher";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import type { Operation, OperationSchemas, HookOutput } from "./operation";
import { hookCtxSchema, workspacePathSchema, serializedErrorSchema } from "../contract";
import { toSerializedError } from "../../shared/error-utils";

// =============================================================================
// Values that must never cross a carrier
// =============================================================================

class Path {
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const NON_SERIALIZABLE: ReadonlyArray<readonly [string, unknown]> = [
  ["a class instance", new Path("/ws/a")],
  ["a function", () => "/ws/a"],
];

// =============================================================================
// A probe operation whose every carrier is declared
// =============================================================================

const INTENT_PROBE = "probe:run";
const PROBE_OP_ID = "probe";
const EVENT_PROBE_DONE = "probe:done";

const probePayloadSchema = z.object({ workspacePath: workspacePathSchema }).readonly();
const probeResultSchema = z.object({ workspacePath: workspacePathSchema }).readonly();
const probeHookResultSchema = z.object({ workspacePath: workspacePathSchema }).readonly();
const probeProvidesSchema = z.object({ ready: z.boolean() });
const probeEventSchema = z.object({ workspacePath: workspacePathSchema }).readonly();
const probeInputSchema = hookCtxSchema(probePayloadSchema, {
  workspacePath: workspacePathSchema,
});

const schemas = {
  type: INTENT_PROBE,
  payload: probePayloadSchema,
  result: probeResultSchema,
  hooks: {
    run: {
      input: probeInputSchema,
      result: probeHookResultSchema,
      provides: probeProvidesSchema,
    },
  },
  events: { [EVENT_PROBE_DONE]: probeEventSchema },
} satisfies OperationSchemas;

/** Drives whichever carrier a test is exercising, from values the test injects. */
interface ProbeControls {
  /** Enrichment the operation puts on the hook input context. */
  readonly enrichment?: Record<string, unknown>;
  /** Emit the event with this payload before returning. */
  readonly eventPayload?: unknown;
  /** Return this as the operation result instead of the payload. */
  readonly result?: unknown;
  /** Receives what `collect()` actually let through, so a test can assert on it directly. */
  readonly onCollect?: (collected: {
    readonly results: readonly unknown[];
    readonly errors: readonly Error[];
    readonly capabilities: Readonly<Record<string, unknown>>;
  }) => void;
}

function createProbeOperation(controls: ProbeControls = {}): Operation<typeof schemas> {
  return {
    id: PROBE_OP_ID,
    schemas,
    async execute(ctx) {
      const enrichment = controls.enrichment ?? { workspacePath: ctx.intent.payload.workspacePath };
      const collected = await ctx.hooks.collect("run", {
        intent: ctx.intent,
        ...enrichment,
      } as Parameters<typeof ctx.hooks.collect>[1]);
      controls.onCollect?.(collected);
      if (controls.eventPayload !== undefined) {
        // Deliberately invalid data: the point is that the carrier rejects it. Built as a
        // separate value so the assertion is not inside the emit() call expression.
        const badEvent = {
          type: EVENT_PROBE_DONE,
          payload: controls.eventPayload,
        } as Parameters<typeof ctx.emit>[0];
        await ctx.emit(badEvent);
      }
      return (controls.result ?? ctx.intent.payload) as { workspacePath: never };
    },
  };
}

function createDispatcher(controls?: ProbeControls): Dispatcher {
  const dispatcher = new Dispatcher({ logger: SILENT_LOGGER });
  dispatcher.registerOperation(createProbeOperation(controls));
  return dispatcher;
}

const GOOD_PATH = workspacePathSchema.parse("/ws/a");

// =============================================================================
// Tests
// =============================================================================

describe("the dispatcher's carriers reject non-serializable values", () => {
  describe("intent payload", () => {
    for (const [label, value] of NON_SERIALIZABLE) {
      it(`rejects ${label}`, async () => {
        const dispatcher = createDispatcher();
        await expect(
          dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: value } })
        ).rejects.toThrow();
      });
    }

    it("accepts a branded string", async () => {
      const dispatcher = createDispatcher();
      await expect(
        dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } })
      ).resolves.toEqual({ workspacePath: GOOD_PATH });
    });
  });

  describe("hook input context", () => {
    for (const [label, value] of NON_SERIALIZABLE) {
      it(`rejects ${label} in the operation-added enrichment`, async () => {
        const dispatcher = createDispatcher({ enrichment: { workspacePath: value } });
        dispatcher.registerModule({
          name: "probe-handler",
          hooks: { [PROBE_OP_ID]: { run: { handler: async () => ({}) } } },
        });
        await expect(
          dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } })
        ).rejects.toThrow();
      });
    }

    it("rejects an undeclared enrichment field (strict)", async () => {
      const dispatcher = createDispatcher({
        enrichment: { workspacePath: GOOD_PATH, smuggled: new Path("/ws/b") },
      });
      dispatcher.registerModule({
        name: "probe-handler",
        hooks: { [PROBE_OP_ID]: { run: { handler: async () => ({}) } } },
      });
      await expect(
        dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } })
      ).rejects.toThrow();
    });
  });

  describe("hook result", () => {
    for (const [label, value] of NON_SERIALIZABLE) {
      it(`rejects ${label}`, async () => {
        // A bad hook result is isolated to its handler (it becomes a collected error rather
        // than a rejected dispatch), so assert on what collect() actually admitted.
        let collected: { results: readonly unknown[]; errors: readonly Error[] } | undefined;
        const dispatcher = createDispatcher({
          onCollect: (c) => {
            collected = c;
          },
        });
        dispatcher.registerModule({
          name: "probe-handler",
          hooks: {
            [PROBE_OP_ID]: {
              run: {
                handler: async (): Promise<HookOutput> => ({ result: { workspacePath: value } }),
              },
            },
          },
        });
        await dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } });
        expect(collected?.results).toEqual([]);
        expect(collected?.errors).toHaveLength(1);
      });
    }

    it("admits a branded string", async () => {
      let collected: { results: readonly unknown[]; errors: readonly Error[] } | undefined;
      const dispatcher = createDispatcher({
        onCollect: (c) => {
          collected = c;
        },
      });
      dispatcher.registerModule({
        name: "probe-handler",
        hooks: {
          [PROBE_OP_ID]: {
            run: {
              handler: async (): Promise<HookOutput> => ({
                result: { workspacePath: GOOD_PATH },
              }),
            },
          },
        },
      });
      await dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } });
      expect(collected?.errors).toEqual([]);
      expect(collected?.results).toEqual([{ workspacePath: GOOD_PATH }]);
    });
  });

  describe("provided capabilities", () => {
    for (const [label, value] of NON_SERIALIZABLE) {
      it(`rejects ${label}`, async () => {
        let collected: { capabilities: Readonly<Record<string, unknown>> } | undefined;
        const dispatcher = createDispatcher({
          onCollect: (c) => {
            collected = c;
          },
        });
        dispatcher.registerModule({
          name: "probe-provider",
          hooks: {
            [PROBE_OP_ID]: {
              run: { handler: async (): Promise<HookOutput> => ({ provides: { ready: value } }) },
            },
          },
        });
        await dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } });
        // The bad capability was never merged into the bag.
        expect(collected?.capabilities).not.toHaveProperty("ready");
      });
    }

    it("merges a scalar", async () => {
      let collected: { capabilities: Readonly<Record<string, unknown>> } | undefined;
      const dispatcher = createDispatcher({
        onCollect: (c) => {
          collected = c;
        },
      });
      dispatcher.registerModule({
        name: "probe-provider",
        hooks: {
          [PROBE_OP_ID]: {
            run: { handler: async (): Promise<HookOutput> => ({ provides: { ready: true } }) },
          },
        },
      });
      await dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } });
      expect(collected?.capabilities.ready).toBe(true);
    });
  });

  describe("event payload", () => {
    for (const [label, value] of NON_SERIALIZABLE) {
      it(`rejects ${label}`, async () => {
        const dispatcher = createDispatcher({ eventPayload: { workspacePath: value } });
        await expect(
          dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } })
        ).rejects.toThrow();
      });
    }
  });

  describe("operation result", () => {
    for (const [label, value] of NON_SERIALIZABLE) {
      it(`rejects ${label}`, async () => {
        const dispatcher = createDispatcher({ result: { workspacePath: value } });
        await expect(
          dispatcher.dispatch({ type: INTENT_PROBE, payload: { workspacePath: GOOD_PATH } })
        ).rejects.toThrow();
      });
    }
  });
});

describe("errors cross the contract as plain data", () => {
  it("serializedErrorSchema keeps the cause chain and survives a JSON round-trip", () => {
    const inner = new TypeError("inner boom");
    const outer = new Error("outer boom", { cause: inner });

    const serialized = toSerializedError(outer);
    expect(serialized.name).toBe("Error");
    expect(serialized.cause?.name).toBe("TypeError");
    expect(serialized.cause?.message).toBe("inner boom");

    // The real check: it is data, not an instance.
    const roundTripped: unknown = JSON.parse(JSON.stringify(serialized));
    expect(serializedErrorSchema.parse(roundTripped)).toEqual(serialized);
  });

  it("a converted error carries no prototype identity", () => {
    const serialized = toSerializedError(new TypeError("boom"));
    expect(serialized).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(serialized)).toBe(Object.prototype);
    // `name` is preserved explicitly — rebuilding without it would regroup a TypeError
    // under "Error" in the crash reporter.
    expect(serialized.name).toBe("TypeError");
  });
});
