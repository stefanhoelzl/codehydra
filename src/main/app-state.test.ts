// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMockLoggingService, type MockLoggingService } from "../services";

import { AppState } from "./app-state";

describe("AppState", () => {
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

  describe("constructor", () => {
    it("creates an AppState instance", () => {
      expect(appState).toBeInstanceOf(AppState);
    });
  });

  describe("getAgentType", () => {
    it("returns configured agent type for claude", () => {
      expect(appState.getAgentType()).toBe("claude");
    });

    it("returns configured agent type for opencode", () => {
      const opcAppState = new AppState(mockLoggingService, "opencode");
      expect(opcAppState.getAgentType()).toBe("opencode");
    });
  });

  describe("agent status manager", () => {
    it("returns null when not set", () => {
      expect(appState.getAgentStatusManager()).toBeNull();
    });

    it("returns manager after set", () => {
      const mockManager = { mock: true };
      appState.setAgentStatusManager(mockManager as never);
      expect(appState.getAgentStatusManager()).toBe(mockManager);
    });
  });

  describe("server manager", () => {
    it("returns null when not set", () => {
      expect(appState.getServerManager()).toBeNull();
    });
  });

  describe("waitForProvider", () => {
    it("resolves immediately when no pending promise", async () => {
      await expect(appState.waitForProvider("/some/path")).resolves.toBeUndefined();
    });
  });
});
