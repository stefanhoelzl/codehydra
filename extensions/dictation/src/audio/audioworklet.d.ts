/**
 * AudioWorklet global scope type declarations.
 * These globals are available in AudioWorkletProcessor context but not in standard TypeScript libs.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope
 */

/** Sample rate of the audio context (e.g., 48000) */
declare const sampleRate: number;

/**
 * Base class for audio processing in AudioWorklet context.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor
 */
declare class AudioWorkletProcessor {
  /** Port for communicating with the main thread */
  readonly port: MessagePort;
  constructor();
  /**
   * Process audio data.
   * @param inputs - Array of inputs, each containing channels of Float32Array samples
   * @param outputs - Array of outputs, each containing channels of Float32Array samples
   * @param parameters - Audio parameters for this processing block
   * @returns true to keep the processor alive, false to terminate
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

/** Register an AudioWorkletProcessor class */
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;
