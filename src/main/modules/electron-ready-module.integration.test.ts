// @vitest-environment node
/**
 * Integration tests for ElectronReadyModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import { createElectronReadyModule } from "./electron-ready-module";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/** Runs "await-ready" hook point only. */
class MinimalAwaitReadyOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect<void>("await-ready", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("ElectronReadyModule Integration", () => {
  it("calls whenReady during await-ready hook", async () => {
    const whenReady = vi.fn().mockResolvedValue(undefined);

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAwaitReadyOperation());

    const module = createElectronReadyModule({ whenReady });
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(whenReady).toHaveBeenCalledOnce();
  });

  it("propagates whenReady rejection", async () => {
    const whenReady = vi.fn().mockRejectedValue(new Error("app failed to initialize"));

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAwaitReadyOperation());

    const module = createElectronReadyModule({ whenReady });
    dispatcher.registerModule(module);

    await expect(
      dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)
    ).rejects.toThrow("app failed to initialize");
  });
});
