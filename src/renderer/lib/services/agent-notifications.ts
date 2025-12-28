/**
 * Agent notification service.
 *
 * Responsible for audio notifications when agent status changes.
 * Plays a chime sound when any workspace's idle agent count increases.
 */

import type { InternalAgentCounts } from "@shared/ipc";

/**
 * Function type for playing chime sound.
 */
export type ChimePlayer = () => void;

/**
 * Service responsible for audio notifications when agent status changes.
 * Extracted from store to separate concerns and improve testability.
 */
export class AgentNotificationService {
  private previousCounts = new Map<string, InternalAgentCounts>();
  private enabled = true;
  private readonly playChime: ChimePlayer;

  /**
   * Create a new notification service.
   * @param playChime - Optional chime player function (defaults to playChimeSound)
   */
  constructor(playChime?: ChimePlayer) {
    this.playChime = playChime ?? playChimeSound;
  }

  /**
   * Handle a status change event and play chime if appropriate.
   * Triggers chime when idle count increases (agent finished work) or
   * when first status report has idle agents (opencode just connected).
   */
  handleStatusChange(workspacePath: string, counts: InternalAgentCounts): void {
    const prev = this.previousCounts.get(workspacePath);

    // Play chime when:
    // 1. Idle count increases from previous (red → green, or more agents became idle)
    // 2. First status report with idle agents (gray → green, opencode just connected)
    if (this.enabled) {
      const idleIncreased = prev && counts.idle > prev.idle;
      const firstIdleReport = !prev && counts.idle > 0;
      if (idleIncreased || firstIdleReport) {
        this.playChime();
      }
    }

    this.previousCounts.set(workspacePath, { ...counts });
  }

  /**
   * Enable or disable chime notifications.
   * @internal Reserved for future use, currently only used in tests
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if notifications are enabled.
   * @internal Reserved for future use, currently only used in tests
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Clean up tracking for a removed workspace.
   */
  removeWorkspace(workspacePath: string): void {
    this.previousCounts.delete(workspacePath);
  }

  /**
   * Reset all state (useful for testing).
   */
  reset(): void {
    this.previousCounts.clear();
  }

  /**
   * Seed the service with initial counts from existing statuses.
   * This establishes the baseline for detecting when idle counts increase.
   * Should be called after loading initial agent statuses.
   *
   * @param statuses - Record of workspace paths to their counts
   */
  seedInitialCounts(statuses: Record<string, InternalAgentCounts>): void {
    for (const [workspacePath, counts] of Object.entries(statuses)) {
      this.previousCounts.set(workspacePath, { ...counts });
    }
  }
}

// Audio context singleton
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Reset audio context (for testing).
 */
export function resetAudioContext(): void {
  audioContext = null;
}

/**
 * Play a chime sound using Web Audio API.
 * Triad chime: A5 -> C#6 -> E6 (A major triad) - fuller, musical resolution
 */
export function playChimeSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // First tone: A5 (880Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.value = 880;
    osc1.type = "sine";
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    // Second tone: C#6 (1109Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.value = 1109;
    osc2.type = "sine";
    gain2.gain.setValueAtTime(0.25, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.25);

    // Third tone: E6 (1319Hz)
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.frequency.value = 1319;
    osc3.type = "sine";
    gain3.gain.setValueAtTime(0.25, now + 0.2);
    gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(now + 0.2);
    osc3.stop(now + 0.4);
  } catch {
    // Audio not supported or blocked - silently ignore
    // No logging to avoid console noise in production
  }
}
