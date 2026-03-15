// @vitest-environment node
/**
 * Integration tests for createMinimalOperation factory.
 *
 * Verifies the factory produces operations that correctly collect a single
 * hook point, handle errors, and support custom hook contexts.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "./dispatcher";
import type { HookContext } from "./operation";
import type { Intent } from "./types";
import { createMinimalOperation } from "./operation.test-utils";
import { createMockLogger } from "../../../services/logging/logging.test-utils";

// =============================================================================
// Test Constants
// =============================================================================

const TEST_OPERATION_ID = "test-op";
const TEST_INTENT_TYPE = "test:action";
const TEST_HOOK_POINT = "do-work";

function testIntent(): Intent {
  return { type: TEST_INTENT_TYPE, payload: {} };
}

function createTestSetup() {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });
  return { dispatcher };
}

// =============================================================================
// Tests
// =============================================================================

describe("createMinimalOperation", () => {
  it("returns first result by default", async () => {
    const { dispatcher } = createTestSetup();
    dispatcher.registerModule({
      name: "test-handler",
      hooks: {
        [TEST_OPERATION_ID]: {
          [TEST_HOOK_POINT]: { handler: async () => ({ value: 42 }) },
        },
      },
    });

    const op = createMinimalOperation<Intent, { value: number }>(
      TEST_OPERATION_ID,
      TEST_HOOK_POINT
    );
    dispatcher.registerOperation(TEST_INTENT_TYPE, op);

    const result = await dispatcher.dispatch(testIntent());

    expect(result).toEqual({ value: 42 });
  });

  it("returns undefined when no results (void operation)", async () => {
    const { dispatcher } = createTestSetup();

    const op = createMinimalOperation(TEST_OPERATION_ID, TEST_HOOK_POINT);
    dispatcher.registerOperation(TEST_INTENT_TYPE, op);

    const result = await dispatcher.dispatch(testIntent());

    expect(result).toBeUndefined();
  });

  it("throws first error when throwOnError is true (default)", async () => {
    const { dispatcher } = createTestSetup();
    dispatcher.registerModule({
      name: "test-handler",
      hooks: {
        [TEST_OPERATION_ID]: {
          [TEST_HOOK_POINT]: {
            handler: async () => {
              throw new Error("hook failed");
            },
          },
        },
      },
    });

    const op = createMinimalOperation(TEST_OPERATION_ID, TEST_HOOK_POINT);
    dispatcher.registerOperation(TEST_INTENT_TYPE, op);

    await expect(dispatcher.dispatch(testIntent())).rejects.toThrow("hook failed");
  });

  it("does not throw when throwOnError is false", async () => {
    const { dispatcher } = createTestSetup();
    dispatcher.registerModule({
      name: "test-handler",
      hooks: {
        [TEST_OPERATION_ID]: {
          [TEST_HOOK_POINT]: {
            handler: async () => {
              throw new Error("hook failed");
            },
          },
        },
      },
    });

    const op = createMinimalOperation(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      throwOnError: false,
    });
    dispatcher.registerOperation(TEST_INTENT_TYPE, op);

    await expect(dispatcher.dispatch(testIntent())).resolves.toBeUndefined();
  });

  it("uses custom hookContext when provided", async () => {
    const { dispatcher } = createTestSetup();

    let receivedContext: HookContext | undefined;
    dispatcher.registerModule({
      name: "test-handler",
      hooks: {
        [TEST_OPERATION_ID]: {
          [TEST_HOOK_POINT]: {
            handler: async (ctx: HookContext) => {
              receivedContext = ctx;
              return "ok";
            },
          },
        },
      },
    });

    interface CustomContext extends HookContext {
      readonly workspacePath: string;
    }

    const op = createMinimalOperation<Intent, string>(TEST_OPERATION_ID, TEST_HOOK_POINT, {
      hookContext: (ctx) => ({
        intent: ctx.intent,
        workspacePath: "/test/workspace",
      }),
    });
    dispatcher.registerOperation(TEST_INTENT_TYPE, op);

    await dispatcher.dispatch(testIntent());

    expect((receivedContext as CustomContext).workspacePath).toBe("/test/workspace");
  });

  it("uses default { intent } context when no hookContext provided", async () => {
    const { dispatcher } = createTestSetup();

    let receivedContext: HookContext | undefined;
    dispatcher.registerModule({
      name: "test-handler",
      hooks: {
        [TEST_OPERATION_ID]: {
          [TEST_HOOK_POINT]: {
            handler: async (ctx: HookContext) => {
              receivedContext = ctx;
            },
          },
        },
      },
    });

    const op = createMinimalOperation(TEST_OPERATION_ID, TEST_HOOK_POINT);
    dispatcher.registerOperation(TEST_INTENT_TYPE, op);

    const intent = testIntent();
    await dispatcher.dispatch(intent);

    expect(receivedContext?.intent).toEqual(intent);
    expect(Object.keys(receivedContext!)).toEqual(["intent", "capabilities"]);
  });
});
