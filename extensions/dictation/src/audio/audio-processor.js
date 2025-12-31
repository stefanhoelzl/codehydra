/**
 * AudioWorklet processor for resampling and PCM conversion
 * Resamples from input sample rate to 16kHz and converts to PCM16
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputBuffer = [];
    this.targetSampleRate = 16000;
    // Get actual sample rate from AudioWorkletGlobalScope
    this.inputSampleRate = sampleRate; // sampleRate is a global in AudioWorkletGlobalScope
    this.resampleRatio = this.inputSampleRate / this.targetSampleRate;
    // Buffer ~50ms of audio at 16kHz = 800 samples = 1600 bytes
    this.bufferSize = 800;
  }

  /**
   * Convert float sample to PCM16
   * @param {number} sample - Float32 sample in range [-1, 1]
   * @returns {number} PCM16 sample in range [-32768, 32767]
   *
   * Note: Uses * 32767 (not * 32768) to ensure symmetric scaling.
   * With 32768, a sample of 1.0 would overflow to -32768 after clamping.
   * This is a common approach in audio processing to avoid asymmetry.
   */
  floatToPcm16(sample) {
    return Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }

  /**
   * Resample audio using linear interpolation
   * @param {Float32Array} input - Input samples at input sample rate
   * @returns {Float32Array} Output samples at target sample rate
   */
  resample(input) {
    const outputLength = Math.floor(input.length / this.resampleRatio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * this.resampleRatio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
      const fraction = srcIndex - srcIndexFloor;

      // Linear interpolation
      output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction;
    }

    return output;
  }

  /**
   * Process audio input
   * @param {Float32Array[][]} inputs - Input audio channels
   * @returns {boolean} - Return true to keep processor alive
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    // Use first channel (mono)
    const samples = input[0];

    // Resample to 16kHz
    const resampled = this.resample(samples);

    // Add to buffer
    for (let i = 0; i < resampled.length; i++) {
      this.inputBuffer.push(resampled[i]);
    }

    // When buffer is full, convert to PCM16 and send
    while (this.inputBuffer.length >= this.bufferSize) {
      const chunk = this.inputBuffer.splice(0, this.bufferSize);
      const pcm16 = new Int16Array(chunk.length);

      for (let i = 0; i < chunk.length; i++) {
        pcm16[i] = this.floatToPcm16(chunk[i]);
      }

      // Send as array (can't transfer ArrayBuffer from worklet)
      this.port.postMessage({ type: "audio", data: Array.from(pcm16) });
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
