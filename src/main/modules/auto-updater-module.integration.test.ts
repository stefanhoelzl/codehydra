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

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
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
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedEvent } from "../operations/config-set-values";
import type { AutoUpdater, UpdateAvailableCallback } from "../../services/auto-updater";

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

interface TestSetup {
  dispatcher: Dispatcher;
  autoUpdater: MockAutoUpdater;
  updateOperation: TrackingUpdateOperation;
  module: IntentModule;
}

function createTestSetup(overrides?: { disposeThrows?: Error }): TestSetup {
  const autoUpdater = createMockAutoUpdater(
    overrides?.disposeThrows ? { disposeThrows: overrides.disposeThrows } : undefined
  );
  const updateOperation = new TrackingUpdateOperation();

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const autoUpdaterModule = createAutoUpdaterModule({
    autoUpdater: autoUpdater.mock,
    dispatcher,
  });

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, updateOperation);

  dispatcher.registerModule(autoUpdaterModule);

  return { dispatcher, autoUpdater, updateOperation, module: autoUpdaterModule };
}

/**
 * Simulate a config:updated event by calling the module's event handler directly.
 */
function simulateConfigUpdated(
  module: IntentModule,
  values: Readonly<Record<string, unknown>>
): void {
  const event: ConfigUpdatedEvent = {
    type: EVENT_CONFIG_UPDATED,
    payload: { values },
  };
  module.events![EVENT_CONFIG_UPDATED]!(event as DomainEvent);
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

  it("dispose() throws — collect catches error, dispatch still resolves", async () => {
    const { dispatcher } = createTestSetup({
      disposeThrows: new Error("dispose failed"),
    });

    // Handler throws, but collect() catches it and shutdown is best-effort
    await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
  });

  it("auto-update=always (default) starts autoUpdater", async () => {
    const { dispatcher, autoUpdater, module } = createTestSetup();

    simulateConfigUpdated(module, { "auto-update": "always" });

    await dispatcher.dispatch(startIntent());

    expect(autoUpdater.startCalled).toBe(true);
  });

  it("auto-update=never skips autoUpdater.start()", async () => {
    const { dispatcher, autoUpdater, module } = createTestSetup();

    simulateConfigUpdated(module, { "auto-update": "never" });

    await dispatcher.dispatch(startIntent());

    expect(autoUpdater.startCalled).toBe(false);
  });

  it("auto-update=never still calls dispose() on shutdown", async () => {
    const { dispatcher, autoUpdater, module } = createTestSetup();

    simulateConfigUpdated(module, { "auto-update": "never" });

    await dispatcher.dispatch(startIntent());
    await dispatcher.dispatch(shutdownIntent());

    expect(autoUpdater.startCalled).toBe(false);
    expect(autoUpdater.disposeCalled).toBe(true);
  });
});
