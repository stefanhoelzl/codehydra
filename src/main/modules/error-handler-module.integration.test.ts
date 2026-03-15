// @vitest-environment node
/**
 * Integration tests for ErrorHandlerModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> ErrorHandlerModule handler
 *
 * Uses monkey-patching of process.on to capture the uncaughtException
 * handler registration without actually registering on the real process.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../operations/app-start";
import { createErrorHandlerModule } from "./error-handler-module";
import { createMockLogger } from "../../services/logging/logging.test-utils";

// =============================================================================
// Test Helpers
// =============================================================================

type ProcessHandler = (...args: unknown[]) => void;

function createTestSetup() {
  const logger = createMockLogger();

  const registeredHandlers: { event: string; handler: ProcessHandler }[] = [];
  const originalOn = process.on;
  process.on = ((event: string, handler: ProcessHandler) => {
    registeredHandlers.push({ event, handler });
    return process;
  }) as typeof process.on;

  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const errorHandlerModule = createErrorHandlerModule({ logger });

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "before-ready")
  );
  dispatcher.registerModule(errorHandlerModule);

  const cleanup = () => {
    process.on = originalOn;
  };

  return { dispatcher, logger, registeredHandlers, cleanup };
}

function startIntent(): AppStartIntent {
  return { type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] };
}

// =============================================================================
// Tests
// =============================================================================

describe("ErrorHandlerModule Integration", () => {
  it("registers uncaughtException listener during before-ready hook", async () => {
    const { dispatcher, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "uncaughtException");
      expect(handler).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("logs uncaught exception with correct message and error object", async () => {
    const { dispatcher, logger, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "uncaughtException")!;
      const testError = new Error("test uncaught");

      expect(() => handler.handler(testError, "uncaughtException")).toThrow(testError);
      expect(logger.error).toHaveBeenCalledWith("Uncaught exception", {}, testError);
    } finally {
      cleanup();
    }
  });

  it("logs unhandled rejection with different message", async () => {
    const { dispatcher, logger, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "uncaughtException")!;
      const testError = new Error("test rejection");

      expect(() => handler.handler(testError, "unhandledRejection")).toThrow(testError);
      expect(logger.error).toHaveBeenCalledWith("Unhandled promise rejection", {}, testError);
    } finally {
      cleanup();
    }
  });

  it("re-throws the error after logging", async () => {
    const { dispatcher, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "uncaughtException")!;
      const testError = new Error("should be re-thrown");

      expect(() => handler.handler(testError, "uncaughtException")).toThrow(testError);
    } finally {
      cleanup();
    }
  });

  it("registers unhandledRejection listener during before-ready hook", async () => {
    const { dispatcher, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "unhandledRejection");
      expect(handler).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("logs unhandled rejection without crashing", async () => {
    const { dispatcher, logger, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "unhandledRejection")!;
      const testError = new Error("test rejection");

      handler.handler(testError);

      expect(logger.error).toHaveBeenCalledWith("Unhandled promise rejection", {}, testError);
    } finally {
      cleanup();
    }
  });

  it("wraps non-Error rejection reasons", async () => {
    const { dispatcher, logger, registeredHandlers, cleanup } = createTestSetup();
    try {
      await dispatcher.dispatch(startIntent());

      const handler = registeredHandlers.find((h) => h.event === "unhandledRejection")!;

      handler.handler("string rejection");

      expect(logger.error).toHaveBeenCalledWith(
        "Unhandled promise rejection",
        {},
        expect.objectContaining({ message: "string rejection" })
      );
    } finally {
      cleanup();
    }
  });
});
