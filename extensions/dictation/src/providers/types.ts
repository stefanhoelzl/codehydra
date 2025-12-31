import type * as vscode from "vscode";

/**
 * Discriminated union for dictation errors
 */
export type DictationError =
  | { type: "connection"; message: string }
  | { type: "permission"; message: string }
  | { type: "auth"; message: string }
  | { type: "quota"; message: string }
  | { type: "provider"; code: number; message: string };

/**
 * Transcript handler callback type
 */
export type TranscriptHandler = (text: string) => void;

/**
 * Error handler callback type
 */
export type ErrorHandler = (error: DictationError) => void;

/**
 * Speech-to-text provider interface
 */
export interface SpeechToTextProvider extends vscode.Disposable {
  /**
   * Connect to the STT service
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the STT service
   */
  disconnect(): Promise<void>;

  /**
   * Send audio data to the STT service
   * @param buffer PCM16 audio data at 16kHz
   */
  sendAudio(buffer: ArrayBuffer): void;

  /**
   * Register a handler for transcript events
   * @returns Unsubscribe function
   */
  onTranscript(handler: TranscriptHandler): () => void;

  /**
   * Register a handler for error events
   * @returns Unsubscribe function
   */
  onError(handler: ErrorHandler): () => void;
}
