// @vitest-environment node
/**
 * Integration tests for ElectronLifecycleModule through the Dispatcher.
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
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { createElectronLifecycleModule } from "./electron-lifecycle-module";

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

describe("ElectronLifecycleModule Integration", () => {
  it("calls whenReady during await-ready hook", async () => {
    const mockApp = { whenReady: vi.fn().mockResolvedValue(undefined), quit: vi.fn() };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAwaitReadyOperation());

    const module = createElectronLifecycleModule({ app: mockApp });
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(mockApp.whenReady).toHaveBeenCalledOnce();
  });

  it("propagates whenReady rejection", async () => {
    const mockApp = {
      whenReady: vi.fn().mockRejectedValue(new Error("app failed to initialize")),
      quit: vi.fn(),
    };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalAwaitReadyOperation());

    const module = createElectronLifecycleModule({ app: mockApp });
    dispatcher.registerModule(module);

    await expect(
      dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)
    ).rejects.toThrow("app failed to initialize");
  });

  it("calls app.quit() when dispatching app:shutdown", async () => {
    const mockApp = { whenReady: vi.fn().mockResolvedValue(undefined), quit: vi.fn() };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const module = createElectronLifecycleModule({ app: mockApp });
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    expect(mockApp.quit).toHaveBeenCalledOnce();
  });
});
