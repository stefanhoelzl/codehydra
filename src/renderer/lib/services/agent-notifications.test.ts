/**
 * Tests for agent notification service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  AgentNotificationService,
  playChimeSound,
  resetAudioContext,
  type ChimePlayer,
} from "./agent-notifications";

// Mock AudioContext
class MockOscillator {
  frequency = { value: 0 };
  type = "sine";
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockGainNode {
  gain = {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return new MockOscillator();
  }
  createGain() {
    return new MockGainNode();
  }
}

describe("AgentNotificationService", () => {
  let service: AgentNotificationService;
  let mockPlayChime: Mock<ChimePlayer>;

  beforeEach(() => {
    // Inject mock chime player for testability
    mockPlayChime = vi.fn<ChimePlayer>();
    service = new AgentNotificationService(mockPlayChime);
    resetAudioContext();
    vi.stubGlobal("AudioContext", MockAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("chime detection", () => {
    it("plays chime on first status report with idle agents (gray → green)", () => {
      // First event with idle agents - opencode just connected
      service.handleStatusChange("/test", { idle: 1, busy: 0 });

      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("does not play chime on first status report with no idle agents", () => {
      // First event with no idle agents (all busy)
      service.handleStatusChange("/test", { idle: 0, busy: 2 });

      expect(mockPlayChime).not.toHaveBeenCalled();
    });

    it("triggers when idle count increases", () => {
      service.handleStatusChange("/test", { idle: 0, busy: 2 });
      expect(mockPlayChime).not.toHaveBeenCalled();

      // Now idle increases from 0 to 1
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("does not trigger when idle count decreases", () => {
      // Seed to establish initial state without triggering first-report chime
      service.seedInitialCounts({ "/test": { idle: 2, busy: 0 } });
      // Idle decreases from 2 to 1
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      expect(mockPlayChime).not.toHaveBeenCalled();
    });

    it("does not trigger when idle count stays the same", () => {
      // Seed to establish initial state without triggering first-report chime
      service.seedInitialCounts({ "/test": { idle: 1, busy: 1 } });
      // Idle stays at 1
      service.handleStatusChange("/test", { idle: 1, busy: 2 });

      expect(mockPlayChime).not.toHaveBeenCalled();
    });

    it("handles multiple workspaces independently", () => {
      service.handleStatusChange("/workspace-a", { idle: 0, busy: 2 });
      service.handleStatusChange("/workspace-b", { idle: 0, busy: 3 });

      // Only workspace-a increases idle count
      service.handleStatusChange("/workspace-a", { idle: 1, busy: 1 });

      // Exactly one chime for workspace-a
      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("respects enabled flag", () => {
      service.handleStatusChange("/test", { idle: 0, busy: 2 });
      service.setEnabled(false);

      // Even though idle increases, chime should not play
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      expect(mockPlayChime).not.toHaveBeenCalled();
    });

    it("re-enables after being disabled", () => {
      service.handleStatusChange("/test", { idle: 0, busy: 2 });
      service.setEnabled(false);
      service.handleStatusChange("/test", { idle: 0, busy: 2 }); // Reset

      service.setEnabled(true);
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });
  });

  describe("isEnabled", () => {
    it("returns true by default", () => {
      expect(service.isEnabled()).toBe(true);
    });

    it("returns false after disabling", () => {
      service.setEnabled(false);
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("removes workspace tracking", () => {
      service.handleStatusChange("/test", { idle: 0, busy: 2 });
      service.removeWorkspace("/test");

      // After removal, next event is treated as first report with idle agents
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      // Chime plays because first report with idle > 0 (gray → green)
      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("resets all state", () => {
      service.handleStatusChange("/test-a", { idle: 0, busy: 2 });
      service.handleStatusChange("/test-b", { idle: 0, busy: 3 });

      service.reset();

      // Both workspaces should now be treated as first events with idle agents
      service.handleStatusChange("/test-a", { idle: 1, busy: 1 });
      service.handleStatusChange("/test-b", { idle: 1, busy: 2 });

      // Both chime because first report with idle > 0 (gray → green)
      expect(mockPlayChime).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge cases", () => {
    it("handles idle going from zero to positive", () => {
      service.handleStatusChange("/test", { idle: 0, busy: 2 });
      service.handleStatusChange("/test", { idle: 2, busy: 0 });

      // Chime should trigger (idle increased from 0 to 2)
      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("handles counts with large numbers", () => {
      // Seed to establish initial state without triggering first-report chime
      service.seedInitialCounts({ "/test": { idle: 50, busy: 50 } });
      service.handleStatusChange("/test", { idle: 100, busy: 0 });

      // Chime should trigger (idle increased from 50 to 100)
      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });
  });

  describe("seedInitialCounts", () => {
    it("allows chime on first status change after seeding", () => {
      // Seed with initial busy state (simulating getAllAgentStatuses)
      service.seedInitialCounts({
        "/test": { idle: 0, busy: 2 },
      });

      // First status change event shows agent finished work
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      // Chime should trigger because we have seeded previous counts
      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("seeds multiple workspaces", () => {
      service.seedInitialCounts({
        "/workspace-a": { idle: 0, busy: 1 },
        "/workspace-b": { idle: 0, busy: 2 },
      });

      // Both workspaces finish work
      service.handleStatusChange("/workspace-a", { idle: 1, busy: 0 });
      service.handleStatusChange("/workspace-b", { idle: 2, busy: 0 });

      // Both should trigger chimes
      expect(mockPlayChime).toHaveBeenCalledTimes(2);
    });

    it("does not trigger chime when idle count does not increase after seeding", () => {
      service.seedInitialCounts({
        "/test": { idle: 2, busy: 0 },
      });

      // Agent goes busy (idle decreases)
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      expect(mockPlayChime).not.toHaveBeenCalled();
    });

    it("handles empty statuses object", () => {
      service.seedInitialCounts({});

      // Even without seeding for this workspace, first event with idle > 0 triggers chime
      // (gray → green transition)
      service.handleStatusChange("/test", { idle: 1, busy: 0 });

      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });

    it("overwrites existing counts when seeding", () => {
      // First establish some state (triggers first-report chime since idle > 0)
      service.handleStatusChange("/test", { idle: 5, busy: 0 });
      expect(mockPlayChime).toHaveBeenCalledTimes(1);

      // Seed overwrites with new state
      service.seedInitialCounts({
        "/test": { idle: 0, busy: 2 },
      });

      // Now idle increases from 0 to 1 (not from 5)
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      // Total: 1 (first report) + 1 (increase after seed) = 2
      expect(mockPlayChime).toHaveBeenCalledTimes(2);
    });
  });
});

describe("playChimeSound", () => {
  beforeEach(() => {
    resetAudioContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates audio context and plays tones", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    // Should not throw
    expect(() => playChimeSound()).not.toThrow();
  });

  it("handles AudioContext creation failure gracefully", () => {
    vi.stubGlobal("AudioContext", function () {
      throw new Error("Not supported");
    });

    // Should not throw even if AudioContext fails
    expect(() => playChimeSound()).not.toThrow();
  });

  it("handles missing AudioContext gracefully", () => {
    vi.stubGlobal("AudioContext", undefined);

    // Should not throw even if AudioContext is undefined
    expect(() => playChimeSound()).not.toThrow();
  });
});
