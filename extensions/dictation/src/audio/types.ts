/**
 * Transcript message for the log
 */
export interface TranscriptMessage {
  type: "transcript";
  text: string;
  timestamp: number;
}

/**
 * Error message for the log
 */
export interface ErrorMessage {
  type: "error";
  message: string;
  timestamp: number;
}

/**
 * Status message for the log
 */
export interface StatusMessage {
  type: "status";
  status: string;
  duration?: number;
}

/**
 * Session start message - begins a new recording session card in the log
 */
export interface SessionStartMessage {
  type: "sessionStart";
  timestamp: number;
}

/**
 * Session end message - finalizes the current session card
 */
export interface SessionEndMessage {
  type: "sessionEnd";
  cancelled: boolean;
}

/**
 * Messages sent from the extension to the webview
 */
export type ToWebviewMessage =
  | { type: "start" }
  | { type: "stop" }
  | { type: "log"; level: "loading" | "started" | "stopped" | "error"; message: string }
  | { type: "transcript"; text: string; timestamp: number }
  | { type: "errorLog"; message: string; timestamp: number }
  | { type: "statusUpdate"; status: string; duration?: number }
  | { type: "clearLog" }
  | { type: "configUpdate"; configured: boolean }
  | { type: "livePreview"; text: string }
  | SessionStartMessage
  | SessionEndMessage;

/**
 * Error codes for microphone access
 */
export type MicrophoneErrorCode = "PERMISSION_DENIED" | "NOT_FOUND" | "NOT_READABLE" | "UNKNOWN";

/**
 * Messages sent from the webview to the extension
 *
 * Note: The audio data is `number[]` instead of `ArrayBuffer` because:
 * 1. postMessage between webview and extension requires JSON-serializable types
 * 2. ArrayBuffer cannot be directly transferred from AudioWorklet to main thread
 * 3. The array is converted back to Int16Array in AudioCapture.handleMessage()
 */
export type FromWebviewMessage =
  | { type: "audio"; data: number[] }
  | { type: "started" }
  | { type: "stopped" }
  | { type: "error"; code: MicrophoneErrorCode; message: string }
  | { type: "openSettings" };
