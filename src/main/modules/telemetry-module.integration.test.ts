// @vitest-environment node
/**
 * Integration tests for TelemetryModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> TelemetryModule handler
 *
 * Uses a MinimalStartOperation (only runs "start" hook point) to avoid
 * the full AppStartOperation pipeline. AppShutdownOperation is simple
 * enough to use directly.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
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
import { createTelemetryModule } from "./telemetry-module";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import type { TelemetryService } from "../../services/telemetry/types";
import type { Logger } from "../../services/logging/types";
import type { AgentType } from "../../agents/types";

// =============================================================================
// Minimal Start Operation
// =============================================================================

/**
 * Minimal start operation that only runs the "start" hook point.
 * Avoids the full AppStartOperation pipeline (check-config, check-deps, etc.)
 * while still exercising the telemetry module's start hook through the dispatcher.
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
// Test Helpers
// =============================================================================

interface CaptureCall {
  event: string;
  properties: Record<string, unknown> | undefined;
}

function createTrackingTelemetryService(): {
  service: TelemetryService;
  captures: CaptureCall[];
  shutdownCalled: boolean;
} {
  const captures: CaptureCall[] = [];
  let shutdownCalled = false;

  const service: TelemetryService = {
    capture(event: string, properties?: Record<string, unknown>) {
      captures.push({ event, properties });
    },
    captureError() {},
    async shutdown() {
      shutdownCalled = true;
    },
  };

  return {
    service,
    captures,
    get shutdownCalled() {
      return shutdownCalled;
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
  captures: CaptureCall[];
  shutdownCalled: boolean;
}

function createTestSetup(overrides?: {
  telemetryService?: TelemetryService | null;
  selectedAgentType?: AgentType;
  logger?: Logger;
}): TestSetup {
  const tracking = createTrackingTelemetryService();
  const platformInfo = createMockPlatformInfo({ platform: "darwin", arch: "arm64" });
  const buildInfo = { version: "1.0.0", isDevelopment: true, isPackaged: false, appPath: "/app" };

  const telemetryModule = createTelemetryModule({
    telemetryService:
      overrides?.telemetryService !== undefined ? overrides.telemetryService : tracking.service,
    platformInfo,
    buildInfo,
    selectedAgentType: overrides?.selectedAgentType ?? "opencode",
    logger: overrides?.logger ?? SILENT_LOGGER,
  });

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_APP_START, new MinimalStartOperation());
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  wireModules([telemetryModule], hookRegistry, dispatcher);

  return {
    dispatcher,
    captures: tracking.captures,
    get shutdownCalled() {
      return tracking.shutdownCalled;
    },
  };
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

describe("TelemetryModule Integration", () => {
  it("dispatch app:start captures telemetry with platform info", async () => {
    const { dispatcher, captures } = createTestSetup();

    await dispatcher.dispatch(startIntent());

    expect(captures).toEqual([
      {
        event: "app_launched",
        properties: {
          platform: "darwin",
          arch: "arm64",
          isDevelopment: true,
          agent: "opencode",
        },
      },
    ]);
  });

  it("dispatch app:shutdown calls telemetryService.shutdown()", async () => {
    const setup = createTestSetup();

    await setup.dispatcher.dispatch(shutdownIntent());

    expect(setup.shutdownCalled).toBe(true);
  });

  it("telemetryService is null — no errors on start or shutdown", async () => {
    const { dispatcher } = createTestSetup({ telemetryService: null });

    await expect(dispatcher.dispatch(startIntent())).resolves.toBeUndefined();
    await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
  });

  it("shutdown() throws — error logged, no re-throw", async () => {
    const shutdownError = new Error("PostHog flush failed");
    const failingService: TelemetryService = {
      capture() {},
      captureError() {},
      async shutdown() {
        throw shutdownError;
      },
    };
    const { logger, errors } = createTrackingLogger();
    const { dispatcher } = createTestSetup({
      telemetryService: failingService,
      logger,
    });

    await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      message: "Telemetry lifecycle shutdown failed (non-fatal)",
      error: shutdownError,
    });
  });
});
