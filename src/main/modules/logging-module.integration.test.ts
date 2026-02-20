// @vitest-environment node
/**
 * Integration tests for LoggingModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, InitHookContext } from "../operations/app-start";
import { createLoggingModule } from "./logging-module";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/** Runs "init" hook point with InitHookContext. */
class MinimalInitOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const initCtx: InitHookContext = {
      intent: ctx.intent,
      requiredScripts: [],
    };
    const { errors } = await ctx.hooks.collect<void>("init", initCtx);
    if (errors.length > 0) throw errors[0]!;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("LoggingModule Integration", () => {
  it("initializes logging service and registers log handlers during init hook", async () => {
    const loggingService = {
      initialize: vi.fn(),
    };
    const registerLogHandlers = vi.fn();

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

    const module = createLoggingModule({ loggingService, registerLogHandlers });
    wireModules([module], hookRegistry, dispatcher);

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    expect(loggingService.initialize).toHaveBeenCalledOnce();
    expect(registerLogHandlers).toHaveBeenCalledOnce();
  });
});
