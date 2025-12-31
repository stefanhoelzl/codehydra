/**
 * Messages sent from the extension to the webview
 */
export type ToWebviewMessage =
  | { type: "start" }
  | { type: "stop" }
  | { type: "log"; level: "loading" | "started" | "stopped" | "error"; message: string };

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
  | { type: "error"; code: MicrophoneErrorCode; message: string };
