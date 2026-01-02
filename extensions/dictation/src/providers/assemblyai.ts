import { AssemblyAI } from "assemblyai";
import type { StreamingTranscriber } from "assemblyai";
import type {
  SpeechToTextProvider,
  TranscriptHandler,
  ActivityHandler,
  ErrorHandler,
  DictationError,
} from "./types";
import { createHandlerRegistry } from "../utils";

/**
 * AssemblyAI speech-to-text provider
 * Uses the official AssemblyAI SDK for streaming transcription
 */
export class AssemblyAIProvider implements SpeechToTextProvider {
  private client: AssemblyAI;
  private transcriber: StreamingTranscriber | null = null;
  private transcriptHandlers = createHandlerRegistry<TranscriptHandler>();
  private activityHandlers = createHandlerRegistry<ActivityHandler>();
  private errorHandlers = createHandlerRegistry<ErrorHandler>();
  private isConnected = false;

  constructor(apiKey: string) {
    this.client = new AssemblyAI({ apiKey });
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    // Create streaming transcriber with configuration
    // Use defaults with formatting enabled for proper punctuation/capitalization
    this.transcriber = this.client.streaming.transcriber({
      sampleRate: 16_000,
      formatTurns: true,
    });

    // Set up event handlers
    this.transcriber.on("open", ({ id }) => {
      console.log(`[Dictation] AssemblyAI session started: ${id}`);
      this.isConnected = true;
    });

    this.transcriber.on("turn", (turn) => {
      // Fire activity on any turn event with transcript text
      // This happens more frequently than end_of_turn events
      if (turn.transcript) {
        this.activityHandlers.forEach((h: ActivityHandler) => h());
      }

      // Emit transcript when turn ends and formatting is complete
      // turn_is_formatted ensures we get punctuation/capitalization
      if (turn.transcript && turn.end_of_turn && turn.turn_is_formatted) {
        this.transcriptHandlers.forEach((h: TranscriptHandler) => h(turn.transcript + " "));
      }
    });

    this.transcriber.on("error", (error) => {
      console.error("[Dictation] AssemblyAI error:", error);

      // Determine error type based on error message/code
      const dictationError = this.mapError(error);
      this.errorHandlers.forEach((h: ErrorHandler) => h(dictationError));
    });

    this.transcriber.on("close", (code, reason) => {
      console.log(`[Dictation] AssemblyAI connection closed: ${code} - ${reason}`);
      this.isConnected = false;

      // Only emit error for abnormal closure
      if (code !== 1000) {
        const error: DictationError = {
          type: "connection",
          message: reason || "Connection closed unexpectedly",
        };
        this.errorHandlers.forEach((h: ErrorHandler) => h(error));
      }
    });

    // Connect to AssemblyAI
    try {
      await this.transcriber.connect();
    } catch (err) {
      this.isConnected = false;
      const error = this.mapError(err);
      throw new Error(error.message);
    }
  }

  async disconnect(): Promise<void> {
    if (this.transcriber) {
      try {
        await this.transcriber.close();
      } catch {
        // Ignore close errors
      }
      this.transcriber = null;
    }
    this.isConnected = false;
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.transcriber || !this.isConnected) {
      console.warn("[Dictation] Cannot send audio: not connected");
      return;
    }

    // AssemblyAI SDK expects a Buffer or ArrayBuffer
    this.transcriber.sendAudio(buffer);
  }

  onTranscript(handler: TranscriptHandler): () => void {
    return this.transcriptHandlers.add(handler);
  }

  onError(handler: ErrorHandler): () => void {
    return this.errorHandlers.add(handler);
  }

  onActivity(handler: ActivityHandler): () => void {
    return this.activityHandlers.add(handler);
  }

  dispose(): void {
    void this.disconnect();
    this.transcriptHandlers.clear();
    this.activityHandlers.clear();
    this.errorHandlers.clear();
  }

  /**
   * Map SDK errors to DictationError type
   */
  private mapError(error: unknown): DictationError {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();

    // Check for auth errors
    if (
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("invalid api key") ||
      lowerMessage.includes("authentication")
    ) {
      return { type: "auth", message: "Invalid API key" };
    }

    // Check for quota/rate limit errors
    if (
      lowerMessage.includes("quota") ||
      lowerMessage.includes("rate limit") ||
      lowerMessage.includes("429") ||
      lowerMessage.includes("too many requests")
    ) {
      return { type: "quota", message };
    }

    // Check for connection errors
    if (
      lowerMessage.includes("network") ||
      lowerMessage.includes("connection") ||
      lowerMessage.includes("timeout") ||
      lowerMessage.includes("websocket")
    ) {
      return { type: "connection", message };
    }

    // Default to provider error
    return { type: "provider", code: 0, message };
  }
}
