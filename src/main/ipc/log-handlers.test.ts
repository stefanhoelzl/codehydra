/**
 * Unit tests for log IPC handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ipcMain } from "electron";
import { ApiIpcChannels } from "../../shared/ipc";
import { createMockLoggingService } from "../../boundaries/platform/logging";
import { registerLogHandlers } from "./log-handlers";

// Mock Electron ipcMain
vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
  },
}));

describe("registerLogHandlers", () => {
  let mockLoggingService: ReturnType<typeof createMockLoggingService>;
  let handlers: Map<string, (event: unknown, payload: unknown) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoggingService = createMockLoggingService();
    handlers = new Map();

    // Capture handlers registered with ipcMain.on
    vi.mocked(ipcMain.on).mockImplementation((channel: string, handler) => {
      handlers.set(channel, handler as (event: unknown, payload: unknown) => void);
      return ipcMain;
    });

    registerLogHandlers(mockLoggingService);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("registers handlers for all log channels", () => {
    expect(handlers.has(ApiIpcChannels.LOG_DEBUG)).toBe(true);
    expect(handlers.has(ApiIpcChannels.LOG_INFO)).toBe(true);
    expect(handlers.has(ApiIpcChannels.LOG_WARN)).toBe(true);
    expect(handlers.has(ApiIpcChannels.LOG_ERROR)).toBe(true);
  });

  describe("LOG_DEBUG handler", () => {
    it("creates logger and calls debug", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_DEBUG)!;
      handler({}, { logger: "ui", message: "Test debug", context: { key: "value" } });

      expect(mockLoggingService.createLogger).toHaveBeenCalledWith("ui");
      const logger = mockLoggingService.getLogger("ui");
      expect(logger?.debug).toHaveBeenCalledWith("Test debug", { key: "value" });
    });

    it("handles missing context", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_DEBUG)!;
      handler({}, { logger: "ui", message: "No context" });

      const logger = mockLoggingService.getLogger("ui");
      expect(logger?.debug).toHaveBeenCalledWith("No context", undefined);
    });
  });

  describe("LOG_INFO handler", () => {
    it("creates logger and calls info", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_INFO)!;
      handler({}, { logger: "ui", message: "Test info" });

      expect(mockLoggingService.createLogger).toHaveBeenCalledWith("ui");
      const logger = mockLoggingService.getLogger("ui");
      expect(logger?.info).toHaveBeenCalledWith("Test info", undefined);
    });
  });

  describe("LOG_WARN handler", () => {
    it("creates logger and calls warn", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_WARN)!;
      handler({}, { logger: "ui", message: "Test warn", context: { code: 123 } });

      const logger = mockLoggingService.getLogger("ui");
      expect(logger?.warn).toHaveBeenCalledWith("Test warn", { code: 123 });
    });
  });

  describe("LOG_ERROR handler", () => {
    it("creates logger and calls error", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_ERROR)!;
      handler({}, { logger: "ui", message: "Test error" });

      const logger = mockLoggingService.getLogger("ui");
      expect(logger?.error).toHaveBeenCalledWith("Test error", undefined);
    });
  });

  describe("logger name validation", () => {
    it("accepts valid ui logger name", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_INFO)!;
      handler({}, { logger: "ui", message: "From UI" });

      expect(mockLoggingService.createLogger).toHaveBeenCalledWith("ui");
    });

    it("accepts valid api logger name", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_INFO)!;
      handler({}, { logger: "api", message: "From API" });

      expect(mockLoggingService.createLogger).toHaveBeenCalledWith("api");
    });

    it("falls back to ui for invalid logger name", () => {
      const handler = handlers.get(ApiIpcChannels.LOG_INFO)!;
      handler({}, { logger: "invalid", message: "From invalid" });

      expect(mockLoggingService.createLogger).toHaveBeenCalledWith("ui");
    });
  });

  describe("error handling", () => {
    it("swallows errors and does not throw", () => {
      // Make createLogger throw
      mockLoggingService.createLogger.mockImplementation(() => {
        throw new Error("Test error");
      });

      const handler = handlers.get(ApiIpcChannels.LOG_INFO)!;

      // Should not throw
      expect(() => {
        handler({}, { logger: "ui", message: "Test" });
      }).not.toThrow();
    });
  });
});
