/**
 * AudioWorklet processor for resampling and PCM conversion.
 * Resamples from input sample rate to 16kHz and converts to PCM16.
 *
 * Types for AudioWorklet globals (sampleRate, registerProcessor, etc.) are
 * declared in audioworklet.d.ts, which is included via tsconfig.
 */
class AudioProcessor extends AudioWorkletProcessor {
  private inputBuffer: number[] = [];
  private readonly targetSampleRate = 16000;
  private readonly inputSampleRate: number;
  private readonly resampleRatio: number;
  private readonly bufferSize = 800;

  constructor() {
    super();
    // Get actual sample rate from AudioWorkletGlobalScope
    this.inputSampleRate = sampleRate;
    this.resampleRatio = this.inputSampleRate / this.targetSampleRate;
  }

  /**
   * Convert float sample to PCM16
   * @param sample - Float32 sample in range [-1, 1]
   * @returns PCM16 sample in range [-32768, 32767]
   *
   * Note: Uses * 32767 (not * 32768) to ensure symmetric scaling.
   * With 32768, a sample of 1.0 would overflow to -32768 after clamping.
   * This is a common approach in audio processing to avoid asymmetry.
   */
  private floatToPcm16(sample: number): number {
    return Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }

  /**
   * Resample audio using linear interpolation
   * @param input - Input samples at input sample rate
   * @returns Output samples at target sample rate
   */
  private resample(input: Float32Array): Float32Array {
    const outputLength = Math.floor(input.length / this.resampleRatio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * this.resampleRatio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
      const fraction = srcIndex - srcIndexFloor;

      // Linear interpolation
      // noUncheckedIndexedAccess: srcIndexFloor and srcIndexCeil are guaranteed valid
      const floorSample = input[srcIndexFloor] ?? 0;
      const ceilSample = input[srcIndexCeil] ?? 0;
      output[i] = floorSample * (1 - fraction) + ceilSample * fraction;
    }

    return output;
  }

  /**
   * Process audio input
   * @param inputs - Input audio channels
   * @returns Return true to keep processor alive
   */
  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input) {
      return true;
    }
    const channel = input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    // Use first channel (mono)
    const samples = channel;

    // Resample to 16kHz
    const resampled = this.resample(samples);

    // Add to buffer
    for (let i = 0; i < resampled.length; i++) {
      const sample = resampled[i];
      if (sample !== undefined) {
        this.inputBuffer.push(sample);
      }
    }

    // When buffer is full, convert to PCM16 and send
    while (this.inputBuffer.length >= this.bufferSize) {
      const chunk = this.inputBuffer.splice(0, this.bufferSize);
      const pcm16 = new Int16Array(chunk.length);

      for (let i = 0; i < chunk.length; i++) {
        const sample = chunk[i];
        if (sample !== undefined) {
          pcm16[i] = this.floatToPcm16(sample);
        }
      }

      // Send as array (can't transfer ArrayBuffer from worklet)
      this.port.postMessage({ type: "audio", data: Array.from(pcm16) });
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
