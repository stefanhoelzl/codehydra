// @vitest-environment node

/**
 * Integration tests for AppState.
 *
 * Tests verify agent lifecycle management including server manager wiring
 * and MCP server manager injection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppState } from "./app-state";
import { createMockLoggingService, type MockLoggingService } from "../services";

describe("AppState Integration", () => {
  let appState: AppState;
  let mockLoggingService: MockLoggingService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoggingService = createMockLoggingService();
    appState = new AppState(mockLoggingService, "claude");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("setServerManager", () => {
    it("wires onServerStarted and onServerStopped callbacks", () => {
      const onServerStarted = vi.fn();
      const onServerStopped = vi.fn();
      const mockManager = {
        onServerStarted,
        onServerStopped,
      };

      appState.setServerManager(mockManager as never);

      expect(appState.getServerManager()).toBe(mockManager);
      expect(onServerStarted).toHaveBeenCalledOnce();
      expect(onServerStopped).toHaveBeenCalledOnce();
    });
  });

  describe("MCP server manager lifecycle", () => {
    it("injects and retrieves MCP server manager", () => {
      const mockMcpManager = {};

      appState.setMcpServerManager(mockMcpManager as never);

      expect(appState.getMcpServerManager()).toBe(mockMcpManager);
    });
  });

  describe("waitForProvider", () => {
    it("resolves immediately when no pending promise exists", async () => {
      await expect(appState.waitForProvider("/some/path")).resolves.toBeUndefined();
    });
  });
});
