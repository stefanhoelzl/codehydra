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
 * Wrap a chime player so it stays quiet while `isSilent()` holds (config `silent`).
 *
 * `isSilent` is a thunk, not a boolean: the caller builds this once at mount but
 * the config applies live, so the value must be read when the chime fires.
 */
export function createChimePlayer(
  isSilent: () => boolean,
  play: ChimePlayer = playChimeSound
): ChimePlayer {
  return () => {
    if (!isSilent()) play();
  };
}

/**
 * Service responsible for audio notifications when agent status changes.
 * Extracted from store to separate concerns and improve testability.
 */
export class AgentNotificationService {
  private previousCounts = new Map<string, InternalAgentCounts>();
  private readonly playChime: ChimePlayer;

  /**
   * Create a new notification service.
   * @param playChime - Chime player function (see createChimePlayer)
   */
  constructor(playChime: ChimePlayer) {
    this.playChime = playChime;
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
    const idleIncreased = prev && counts.idle > prev.idle;
    const firstIdleReport = !prev && counts.idle > 0;
    if (idleIncreased || firstIdleReport) {
      this.playChime();
    }

    this.previousCounts.set(workspacePath, { ...counts });
  }

  /**
   * Clean up tracking for a removed workspace.
   */
  removeWorkspace(workspacePath: string): void {
    this.previousCounts.delete(workspacePath);
  }
}

/** Triad chime: A5 -> C#6 -> E6 (A major triad) - fuller, musical resolution. */
const CHIME_TONES = [
  { frequency: 880, start: 0, end: 0.15 },
  { frequency: 1109, start: 0.1, end: 0.25 },
  { frequency: 1319, start: 0.2, end: 0.4 },
] as const;

/** Extra wall-clock time after the last tone ends, so it is not cut off by the suspend. */
const CHIME_RELEASE_MS = 50;

/** Wall-clock wait before suspending: the last tone's end plus the release margin. */
export const CHIME_DURATION_MS =
  Math.max(...CHIME_TONES.map((tone) => tone.end)) * 1000 + CHIME_RELEASE_MS;

/**
 * Plays the chime and owns the `AudioContext` it plays on.
 *
 * The context runs only while a chime plays: it is resumed before the tones and
 * suspended after them. A running context keeps Chromium's audio output stream
 * and `AudioOutputDevice` thread busy for as long as it lives, even in silence.
 *
 * Chimes never overlap: one requested while another plays (including its
 * resume and suspend) is dropped, since it would sound the same.
 */
export class ChimeSound {
  private context: AudioContext | null = null;
  private playing = false;

  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  play(): void {
    if (this.playing) return;
    this.playing = true;
    void this.run()
      .catch(() => {
        // Audio not supported or blocked - silently ignore
        // No logging to avoid console noise in production
      })
      .finally(() => {
        this.playing = false;
      });
  }

  private async run(): Promise<void> {
    this.context ??= this.createContext();
    const ctx = this.context;
    if (ctx.state !== "running") await ctx.resume();

    const now = ctx.currentTime;
    for (const tone of CHIME_TONES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = tone.frequency;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.25, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.01, now + tone.end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.start);
      osc.stop(now + tone.end);
    }

    // Wall clock, not the last oscillator's `onended`: that never fires if the
    // context fails to run, which would leave `playing` stuck.
    await new Promise<void>((resolve) => setTimeout(resolve, CHIME_DURATION_MS));
    await ctx.suspend();
  }
}

const defaultChime = new ChimeSound();

/**
 * Play the chime on the shared {@link ChimeSound}; dropped if one is already playing.
 */
export function playChimeSound(): void {
  defaultChime.play();
}
