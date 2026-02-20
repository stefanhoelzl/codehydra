// @vitest-environment node
/**
 * Integration tests for LifecycleReadyModule through the Dispatcher.
 *
 * Tests verify:
 * - app:started event resolves projectsLoadedPromise
 * - readyHandler resolves mount signal and awaits projectsLoadedPromise
 * - readyHandler is idempotent (second call is no-op)
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  EVENT_APP_STARTED,
} from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import type { MountSignal } from "./view-module";
import { createLifecycleReadyModule } from "./lifecycle-ready-module";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/**
 * Minimal app-start operation that emits app:started after activate.
 * Simulates the real AppStartOperation's event emission flow.
 */
class MinimalAppStartOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    ctx.emit({ type: EVENT_APP_STARTED, payload: {} });
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("LifecycleReadyModule Integration", () => {
  it("app:started event resolves projectsLoadedPromise so readyHandler completes", async () => {
    const mountSignal: MountSignal = { resolve: null };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

    const { module, readyHandler } = createLifecycleReadyModule({ mountSignal });
    dispatcher.registerModule(module);

    // Set up mount signal so readyHandler has something to resolve
    let mountResolved = false;
    mountSignal.resolve = () => {
      mountResolved = true;
    };

    // Dispatch app:start to emit app:started (resolves projectsLoadedPromise)
    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    // Now readyHandler should complete because projectsLoadedPromise is already resolved
    await readyHandler();

    expect(mountResolved).toBe(true);
  });

  it("readyHandler resolves mount signal and awaits projectsLoadedPromise", async () => {
    const mountSignal: MountSignal = { resolve: null };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

    const { module, readyHandler } = createLifecycleReadyModule({ mountSignal });
    dispatcher.registerModule(module);

    // Set up mount signal
    let mountResolved = false;
    mountSignal.resolve = () => {
      mountResolved = true;
    };

    // Call readyHandler before app:started -- it should block on projectsLoadedPromise
    let handlerCompleted = false;
    const handlerPromise = readyHandler().then(() => {
      handlerCompleted = true;
    });

    // Mount signal should be resolved immediately
    expect(mountResolved).toBe(true);
    // But handler should be blocked waiting for projectsLoadedPromise
    expect(handlerCompleted).toBe(false);

    // Dispatch app:start to emit app:started (resolves projectsLoadedPromise)
    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    await handlerPromise;
    expect(handlerCompleted).toBe(true);
  });

  it("readyHandler is idempotent (second call is no-op)", async () => {
    const mountSignal: MountSignal = { resolve: null };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

    const { module, readyHandler } = createLifecycleReadyModule({ mountSignal });
    dispatcher.registerModule(module);

    // Set up mount signal
    let callCount = 0;
    mountSignal.resolve = () => {
      callCount++;
    };

    // Dispatch app:start to emit app:started (resolves projectsLoadedPromise)
    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    // First call resolves mount signal
    await readyHandler();
    expect(callCount).toBe(1);

    // Second call is a no-op (mountSignal.resolve was set to null)
    await readyHandler();
    expect(callCount).toBe(1);
  });

  it("readyHandler is no-op when mountSignal.resolve is null", async () => {
    const mountSignal: MountSignal = { resolve: null };

    const { readyHandler } = createLifecycleReadyModule({ mountSignal });

    // Should complete immediately without error
    await readyHandler();
  });
});
