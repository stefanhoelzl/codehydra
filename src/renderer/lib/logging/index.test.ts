/**
 * Unit tests for renderer logging module.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

describe("createLogger", () => {
  const originalWindow = global.window;
  let mockEmitEvent: Mock;

  beforeEach(() => {
    // Set up mock window.api
    mockEmitEvent = vi.fn();
    global.window = {
      api: { emitEvent: mockEmitEvent },
    } as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    global.window = originalWindow;
    vi.resetModules();
  });

  async function getCreateLogger() {
    // Dynamic import to get fresh module after window mock is set up
    const { createLogger } = await import("./index");
    return createLogger;
  }

  it("creates logger with IPC transport", async () => {
    const createLogger = await getCreateLogger();
    const logger = createLogger("ui");

    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("includes logger name in emitted log events", async () => {
    const createLogger = await getCreateLogger();
    const logger = createLogger("ui");

    logger.info("Test message");

    expect(mockEmitEvent).toHaveBeenCalledWith({
      kind: "log",
      level: "info",
      logger: "ui",
      message: "Test message",
    });
  });

  it("passes context in emitted log events", async () => {
    const createLogger = await getCreateLogger();
    const logger = createLogger("ui");

    logger.debug("Test", { key: "value", count: 42 });

    expect(mockEmitEvent).toHaveBeenCalledWith({
      kind: "log",
      level: "debug",
      logger: "ui",
      message: "Test",
      context: { key: "value", count: 42 },
    });
  });

  describe("log level methods", () => {
    it.each(["debug", "info", "warn", "error"] as const)(
      "%s emits a log event with that level",
      async (level) => {
        const createLogger = await getCreateLogger();
        const logger = createLogger("ui");

        logger[level]("message");

        expect(mockEmitEvent).toHaveBeenCalledWith({
          kind: "log",
          level,
          logger: "ui",
          message: "message",
        });
      }
    );
  });

  describe("error handling", () => {
    it("handles IPC errors gracefully - never throws", async () => {
      const createLogger = await getCreateLogger();
      const logger = createLogger("ui");

      // Make IPC throw
      mockEmitEvent.mockImplementation(() => {
        throw new Error("IPC error");
      });

      // Should not throw
      expect(() => logger.info("Test")).not.toThrow();
    });

    it("handles missing api.emitEvent gracefully", async () => {
      // Set up window without emitEvent
      global.window = {
        api: {},
      } as unknown as Window & typeof globalThis;

      const createLogger = await getCreateLogger();
      const logger = createLogger("ui");

      // Should not throw
      expect(() => logger.info("Test")).not.toThrow();
    });
  });

  describe("logger names", () => {
    it("accepts ui logger name", async () => {
      const createLogger = await getCreateLogger();
      const logger = createLogger("ui");

      logger.info("From UI");
      expect(mockEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ logger: "ui", message: "From UI" })
      );
    });

    it("accepts api logger name", async () => {
      const createLogger = await getCreateLogger();
      const logger = createLogger("api");

      logger.info("From API");
      expect(mockEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ logger: "api", message: "From API" })
      );
    });
  });
});
