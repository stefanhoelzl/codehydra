/**
 * Tests for agent notification service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  AgentNotificationService,
  createChimePlayer,
  playChimeSound,
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

    it("chimes again when an idle agent goes none then idle (close → reopen)", () => {
      // Agent idle (green).
      service.handleStatusChange("/test", { idle: 1, busy: 0 });
      expect(mockPlayChime).toHaveBeenCalledTimes(1);

      // Terminal closed → none, delivered as zero idle by the status binding.
      service.handleStatusChange("/test", { idle: 0, busy: 0 });
      // Terminal reopened → idle again.
      service.handleStatusChange("/test", { idle: 1, busy: 0 });

      expect(mockPlayChime).toHaveBeenCalledTimes(2);
    });

    it("does not trigger when idle count decreases", () => {
      // Establish initial state (first report with idle agents chimes; clear it)
      service.handleStatusChange("/test", { idle: 2, busy: 0 });
      mockPlayChime.mockClear();
      // Idle decreases from 2 to 1
      service.handleStatusChange("/test", { idle: 1, busy: 1 });

      expect(mockPlayChime).not.toHaveBeenCalled();
    });

    it("does not trigger when idle count stays the same", () => {
      // Establish initial state (first report with idle agents chimes; clear it)
      service.handleStatusChange("/test", { idle: 1, busy: 1 });
      mockPlayChime.mockClear();
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
      // Establish initial state (first report with idle agents chimes; clear it)
      service.handleStatusChange("/test", { idle: 50, busy: 50 });
      mockPlayChime.mockClear();
      service.handleStatusChange("/test", { idle: 100, busy: 0 });

      // Chime should trigger (idle increased from 50 to 100)
      expect(mockPlayChime).toHaveBeenCalledTimes(1);
    });
  });
});

describe("playChimeSound", () => {
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

describe("createChimePlayer", () => {
  it("plays when not silent", () => {
    const play = vi.fn();
    createChimePlayer(() => false, play)();

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when silent", () => {
    const play = vi.fn();
    createChimePlayer(() => true, play)();

    expect(play).not.toHaveBeenCalled();
  });

  it("reads `silent` at each chime, so the config applies live", () => {
    const play = vi.fn();
    let silent = true;
    const chime = createChimePlayer(() => silent, play);

    chime();
    expect(play).not.toHaveBeenCalled();

    silent = false;
    chime();
    expect(play).toHaveBeenCalledTimes(1);
  });
});
