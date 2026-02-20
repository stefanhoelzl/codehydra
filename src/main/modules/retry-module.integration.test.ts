// @vitest-environment node
/**
 * Integration tests for RetryModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> app-start show-ui hook -> waitForRetry -> IPC lifecycle:retry
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, ShowUIHookResult } from "../operations/app-start";
import { ApiIpcChannels } from "../../shared/ipc";
import {
  createBehavioralIpcLayer,
  type BehavioralIpcLayer,
} from "../../services/platform/ipc.test-utils";
import { createRetryModule } from "./retry-module";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/** Runs "show-ui" hook point and returns merged results. */
class MinimalShowUIOperation implements Operation<Intent, ShowUIHookResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ShowUIHookResult> {
    const { results, errors } = await ctx.hooks.collect<ShowUIHookResult>("show-ui", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    // Merge results (same as AppStartOperation)
    let waitForRetry: (() => Promise<void>) | undefined;
    for (const result of results) {
      if (result.waitForRetry !== undefined) waitForRetry = result.waitForRetry;
    }
    return waitForRetry ? { waitForRetry } : {};
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("RetryModule Integration", () => {
  function createTestSetup(): { dispatcher: Dispatcher; ipcLayer: BehavioralIpcLayer } {
    const ipcLayer = createBehavioralIpcLayer();
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalShowUIOperation());

    const module = createRetryModule({ ipcLayer });
    dispatcher.registerModule(module);

    return { dispatcher, ipcLayer };
  }

  it("show-ui hook returns a waitForRetry function", async () => {
    const { dispatcher } = createTestSetup();

    const result = (await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent)) as unknown as ShowUIHookResult;

    expect(result.waitForRetry).toBeTypeOf("function");
  });

  it("waitForRetry resolves when lifecycle:retry IPC is received", async () => {
    const { dispatcher, ipcLayer } = createTestSetup();

    const result = (await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent)) as unknown as ShowUIHookResult;

    let resolved = false;
    const retryPromise = result.waitForRetry!().then(() => {
      resolved = true;
    });

    // Before IPC signal, the promise should not be resolved
    expect(resolved).toBe(false);

    // Simulate renderer sending lifecycle:retry
    ipcLayer._emit(ApiIpcChannels.LIFECYCLE_RETRY);

    await retryPromise;
    expect(resolved).toBe(true);
  });

  it("waitForRetry removes IPC listener after receiving retry signal", async () => {
    const { dispatcher, ipcLayer } = createTestSetup();

    const result = (await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent)) as unknown as ShowUIHookResult;

    const retryPromise = result.waitForRetry!();

    // Listener should be registered
    expect(ipcLayer._getListeners(ApiIpcChannels.LIFECYCLE_RETRY).length).toBe(1);

    // Simulate retry signal
    ipcLayer._emit(ApiIpcChannels.LIFECYCLE_RETRY);
    await retryPromise;

    // Listener should be removed
    expect(ipcLayer._getListeners(ApiIpcChannels.LIFECYCLE_RETRY).length).toBe(0);
  });
});
