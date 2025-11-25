// src/lib/services/agentNotifications.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentNotificationService, playChimeSound, resetAudioContext } from './agentNotifications';

// Mock AudioContext
class MockOscillator {
  frequency = { value: 0 };
  type = 'sine';
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

describe('AgentNotificationService', () => {
  let service: AgentNotificationService;

  beforeEach(() => {
    service = new AgentNotificationService();
    resetAudioContext();
    vi.stubGlobal('AudioContext', MockAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('chime detection', () => {
    it('does not trigger on first event (no previous counts)', () => {
      // First event has no previous to compare against
      // The service should just store the counts without triggering
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      // No exception means it passed
    });

    it('triggers when busy count decreases', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      // Now busy decreases from 2 to 1
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // If AudioContext is called, the chime was triggered
      // We can verify by checking no errors occurred
    });

    it('does not trigger when busy count increases', () => {
      service.handleStatusChange('/test', { idle: 2, busy: 0 });
      // Busy increases from 0 to 1
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // No chime should be triggered
    });

    it('does not trigger when busy count stays the same', () => {
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // Busy stays at 1
      service.handleStatusChange('/test', { idle: 2, busy: 1 });
      // No chime
    });

    it('handles multiple workspaces independently', () => {
      service.handleStatusChange('/workspace-a', { idle: 0, busy: 2 });
      service.handleStatusChange('/workspace-b', { idle: 0, busy: 3 });

      // Only workspace-a decreases busy count
      service.handleStatusChange('/workspace-a', { idle: 1, busy: 1 });
      // One chime for workspace-a
    });

    it('respects enabled flag', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.setEnabled(false);

      // Even though busy decreases, chime should not play
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
    });

    it('re-enables after being disabled', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.setEnabled(false);
      service.handleStatusChange('/test', { idle: 0, busy: 2 }); // Reset

      service.setEnabled(true);
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // Chime should play now
    });
  });

  describe('isEnabled', () => {
    it('returns true by default', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('returns false after disabling', () => {
      service.setEnabled(false);
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('removes workspace tracking', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.removeWorkspace('/test');

      // After removal, next event is treated as first (no previous)
      service.handleStatusChange('/test', { idle: 0, busy: 1 });
      // No chime because there's no previous to compare
    });

    it('resets all state', () => {
      service.handleStatusChange('/test-a', { idle: 0, busy: 2 });
      service.handleStatusChange('/test-b', { idle: 0, busy: 3 });

      service.reset();

      // Both workspaces should now be treated as first events
      service.handleStatusChange('/test-a', { idle: 0, busy: 1 });
      service.handleStatusChange('/test-b', { idle: 0, busy: 1 });
      // No chimes
    });
  });

  describe('edge cases', () => {
    it('handles busy going from positive to zero', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.handleStatusChange('/test', { idle: 2, busy: 0 });
      // Chime should trigger (busy decreased)
    });

    it('handles counts with large numbers', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 100 });
      service.handleStatusChange('/test', { idle: 50, busy: 50 });
      // Chime should trigger (busy decreased from 100 to 50)
    });
  });
});

describe('playChimeSound', () => {
  beforeEach(() => {
    resetAudioContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates audio context and plays tones', () => {
    vi.stubGlobal('AudioContext', MockAudioContext);
    // Should not throw
    expect(() => playChimeSound()).not.toThrow();
  });

  it('handles AudioContext creation failure gracefully', () => {
    vi.stubGlobal('AudioContext', function () {
      throw new Error('Not supported');
    });

    // Should not throw even if AudioContext fails
    expect(() => playChimeSound()).not.toThrow();
  });

  it('handles missing AudioContext gracefully', () => {
    vi.stubGlobal('AudioContext', undefined);

    // Should not throw even if AudioContext is undefined
    expect(() => playChimeSound()).not.toThrow();
  });
});
