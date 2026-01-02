import type {
  SpeechToTextProvider,
  TranscriptHandler,
  ActivityHandler,
  ErrorHandler,
  DictationError,
} from "./types";

/**
 * Mock provider for testing
 * Allows simulating transcripts and errors
 */
export class MockProvider implements SpeechToTextProvider {
  private state: "disconnected" | "connecting" | "connected" = "disconnected";
  private transcriptHandlers: TranscriptHandler[] = [];
  private activityHandlers: ActivityHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];

  // Test configuration
  public shouldFailConnect = false;

  // Deferred connection - set to control when connect() resolves
  private connectResolver: (() => void) | null = null;
  public deferConnect = false;

  // Test tracking
  public receivedAudio: ArrayBuffer[] = [];

  async connect(): Promise<void> {
    if (this.shouldFailConnect) {
      throw new Error("Connection failed");
    }

    if (this.deferConnect) {
      this.state = "connecting";
      await new Promise<void>((resolve) => {
        this.connectResolver = resolve;
      });
    }

    this.state = "connected";
  }

  /**
   * Complete a deferred connection (for testing starting state)
   */
  completeConnect(): void {
    if (this.connectResolver) {
      this.connectResolver();
      this.connectResolver = null;
    }
  }

  async disconnect(): Promise<void> {
    this.state = "disconnected";
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (this.state !== "connected") {
      throw new Error("Not connected");
    }
    this.receivedAudio.push(buffer);
  }

  onTranscript(handler: TranscriptHandler): () => void {
    this.transcriptHandlers.push(handler);
    return () => {
      const index = this.transcriptHandlers.indexOf(handler);
      if (index >= 0) {
        this.transcriptHandlers.splice(index, 1);
      }
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const index = this.errorHandlers.indexOf(handler);
      if (index >= 0) {
        this.errorHandlers.splice(index, 1);
      }
    };
  }

  onActivity(handler: ActivityHandler): () => void {
    this.activityHandlers.push(handler);
    return () => {
      const index = this.activityHandlers.indexOf(handler);
      if (index >= 0) {
        this.activityHandlers.splice(index, 1);
      }
    };
  }

  dispose(): void {
    this.state = "disconnected";
    this.transcriptHandlers = [];
    this.activityHandlers = [];
    this.errorHandlers = [];
  }

  // Test helpers
  simulateTranscript(text: string): void {
    this.transcriptHandlers.forEach((h) => h(text));
  }

  simulateActivity(): void {
    this.activityHandlers.forEach((h) => h());
  }

  simulateError(error: DictationError): void {
    this.errorHandlers.forEach((h) => h(error));
  }

  simulateClose(): void {
    this.state = "disconnected";
    this.errorHandlers.forEach((h) => h({ type: "connection", message: "Connection closed" }));
  }

  getState(): string {
    return this.state;
  }
}
