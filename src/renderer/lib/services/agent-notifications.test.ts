/**
 * Tests for agent notification service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  AgentNotificationService,
  CHIME_DURATION_MS,
  ChimeSound,
  createChimePlayer,
  type ChimePlayer,
} from "./agent-notifications";

// Behavioral AudioContext mock: tracks state and the oscillators started on it.
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
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  oscillators: MockOscillator[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  createOscillator(): MockOscillator {
    const osc = new MockOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createGain(): MockGainNode {
    return new MockGainNode();
  }
}

function chimeWithMock(): { chime: ChimeSound; ctx: MockAudioContext; factory: Mock } {
  const ctx = new MockAudioContext();
  const factory = vi.fn(() => ctx as unknown as AudioContext);
  return { chime: new ChimeSound(factory), ctx, factory };
}

describe("AgentNotificationService", () => {
  let service: AgentNotificationService;
  let mockPlayChime: Mock<ChimePlayer>;

  beforeEach(() => {
    // Inject mock chime player for testability
    mockPlayChime = vi.fn<ChimePlayer>();
    service = new AgentNotificationService(mockPlayChime);
  });

  afterEach(() => {
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

describe("ChimeSound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays the three tones and suspends the context once the chime ends", async () => {
    const { chime, ctx } = chimeWithMock();

    chime.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([880, 1109, 1319]);
    expect(ctx.suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHIME_DURATION_MS);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("suspended");
  });

  it("drops a chime requested while one is playing", async () => {
    const { chime, ctx } = chimeWithMock();

    chime.play();
    await vi.advanceTimersByTimeAsync(100);
    chime.play();
    await vi.advanceTimersByTimeAsync(CHIME_DURATION_MS);

    expect(ctx.oscillators).toHaveLength(3);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it("resumes the same context for the next chime", async () => {
    const { chime, ctx, factory } = chimeWithMock();

    chime.play();
    await vi.advanceTimersByTimeAsync(CHIME_DURATION_MS);
    chime.play();
    await vi.advanceTimersByTimeAsync(0);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.oscillators).toHaveLength(6);
  });

  it("stays quiet when the context cannot be created, and retries on the next chime", async () => {
    const factory = vi.fn((): AudioContext => {
      throw new Error("Not supported");
    });
    const chime = new ChimeSound(factory);

    expect(() => chime.play()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    chime.play();
    await vi.advanceTimersByTimeAsync(0);

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("can chime again after resume fails", async () => {
    const { chime, ctx } = chimeWithMock();
    ctx.state = "suspended";
    ctx.resume.mockRejectedValueOnce(new Error("blocked"));

    chime.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.oscillators).toHaveLength(0);

    chime.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.oscillators).toHaveLength(3);
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
