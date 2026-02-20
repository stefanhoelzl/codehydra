// @vitest-environment node
/**
 * Integration tests for AutoUpdaterModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> AutoUpdaterModule handler
 *
 * Uses a MinimalStartOperation (only runs "start" hook point) to avoid
 * the full AppStartOperation pipeline. AppShutdownOperation is simple
 * enough to use directly.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
  type StartHookResult,
} from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../operations/app-shutdown";
import {
  INTENT_UPDATE_AVAILABLE,
  type UpdateAvailableIntent,
} from "../operations/update-available";
import { createAutoUpdaterModule } from "./auto-updater-module";
import { SILENT_LOGGER } from "../../services/logging";
import type { AutoUpdater, UpdateAvailableCallback } from "../../services/auto-updater";
import type { Logger } from "../../services/logging/types";

// =============================================================================
// Minimal Start Operation
// =============================================================================

/**
 * Minimal start operation that only runs the "start" hook point.
 * Avoids the full AppStartOperation pipeline (check-config, check-deps, etc.)
 * while still exercising the auto-updater module's start hook through the dispatcher.
 */
class MinimalStartOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { errors } = await ctx.hooks.collect<StartHookResult>("start", hookCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }
  }
}

// =============================================================================
// Tracking Update Operation
// =============================================================================

/**
 * Minimal operation for update:available that records dispatched intents.
 */
class TrackingUpdateOperation implements Operation<UpdateAvailableIntent, void> {
  readonly id = "update-available";
  readonly dispatched: UpdateAvailableIntent[] = [];

  async execute(ctx: OperationContext<UpdateAvailableIntent>): Promise<void> {
    this.dispatched.push(ctx.intent);
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

interface MockAutoUpdater {
  mock: AutoUpdater;
  startCalled: boolean;
  disposeCalled: boolean;
  capturedCallback: UpdateAvailableCallback | null;
}

function createMockAutoUpdater(overrides?: { disposeThrows?: Error }): MockAutoUpdater {
  let startCalled = false;
  let disposeCalled = false;
  let capturedCallback: UpdateAvailableCallback | null = null;

  const mock: AutoUpdater = {
    start() {
      startCalled = true;
    },
    onUpdateAvailable(callback: UpdateAvailableCallback) {
      capturedCallback = callback;
      return () => {
        capturedCallback = null;
      };
    },
    dispose() {
      disposeCalled = true;
      if (overrides?.disposeThrows) {
        throw overrides.disposeThrows;
      }
    },
  } as AutoUpdater;

  return {
    mock,
    get startCalled() {
      return startCalled;
    },
    get disposeCalled() {
      return disposeCalled;
    },
    get capturedCallback() {
      return capturedCallback;
    },
  };
}

function createTrackingLogger(): { logger: Logger; errors: unknown[] } {
  const errors: unknown[] = [];
  const logger: Logger = {
    silly() {},
    debug() {},
    info() {},
    warn() {},
    error(message: string, _context?: unknown, error?: Error) {
      errors.push({ message, error });
    },
  };
  return { logger, errors };
}

interface TestSetup {
  dispatcher: Dispatcher;
  autoUpdater: MockAutoUpdater;
  updateOperation: TrackingUpdateOperation;
}

function createTestSetup(overrides?: { disposeThrows?: Error; logger?: Logger }): TestSetup {
  const autoUpdater = createMockAutoUpdater(
    overrides?.disposeThrows ? { disposeThrows: overrides.disposeThrows } : undefined
  );
  const updateOperation = new TrackingUpdateOperation();

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const autoUpdaterModule = createAutoUpdaterModule({
    autoUpdater: autoUpdater.mock,
    dispatcher,
    logger: overrides?.logger ?? SILENT_LOGGER,
  });

  dispatcher.registerOperation(INTENT_APP_START, new MinimalStartOperation());
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, updateOperation);

  dispatcher.registerModule(autoUpdaterModule);

  return { dispatcher, autoUpdater, updateOperation };
}

function startIntent(): AppStartIntent {
  return { type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] };
}

function shutdownIntent(): AppShutdownIntent {
  return { type: INTENT_APP_SHUTDOWN, payload: {} as AppShutdownIntent["payload"] };
}

// =============================================================================
// Tests
// =============================================================================

describe("AutoUpdaterModule Integration", () => {
  it("dispatch app:start calls autoUpdater.start()", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(startIntent());

    expect(autoUpdater.startCalled).toBe(true);
  });

  it("dispatch app:start wires onUpdateAvailable to dispatch update:available", async () => {
    const { dispatcher, autoUpdater, updateOperation } = createTestSetup();

    await dispatcher.dispatch(startIntent());

    // Simulate an update becoming available
    autoUpdater.capturedCallback!("2.0.0");

    // Allow the void dispatch to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateOperation.dispatched).toHaveLength(1);
    expect(updateOperation.dispatched[0]!.payload).toEqual({ version: "2.0.0" });
  });

  it("dispatch app:shutdown calls autoUpdater.dispose()", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(shutdownIntent());

    expect(autoUpdater.disposeCalled).toBe(true);
  });

  it("dispose() throws — error logged, no re-throw", async () => {
    const disposeError = new Error("dispose failed");
    const { logger, errors } = createTrackingLogger();
    const { dispatcher } = createTestSetup({
      disposeThrows: disposeError,
      logger,
    });

    await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      message: "AutoUpdater lifecycle shutdown failed (non-fatal)",
      error: disposeError,
    });
  });
});
