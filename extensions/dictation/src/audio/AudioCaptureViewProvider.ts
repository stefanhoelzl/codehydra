import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { ToWebviewMessage, FromWebviewMessage } from "./types";
import type { DictationError } from "../providers/types";
import { createHandlerRegistry } from "../utils";

/** Timeout waiting for view to be ready (ms) */
const VIEW_READY_TIMEOUT_MS = 10000;
/** Retry interval waiting for view (ms) */
const VIEW_READY_RETRY_MS = 200;
/** Delay for panel to settle before refocusing editor (ms) */
const PANEL_SETTLE_MS = 100;

/**
 * Handler for audio data received from the webview
 */
export type AudioHandler = (buffer: ArrayBuffer) => void;

/**
 * Handler for audio capture errors
 */
export type CaptureErrorHandler = (error: DictationError) => void;

/**
 * WebviewView provider for audio capture
 * Uses the Secondary Sidebar which can be completely hidden by the user
 */
export class AudioCaptureViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codehydra.dictation.audioCapture";

  private view: vscode.WebviewView | undefined;
  private audioHandlers = createHandlerRegistry<AudioHandler>();
  private errorHandlers = createHandlerRegistry<CaptureErrorHandler>();
  private isCapturing = false;
  private startedResolve: (() => void) | null = null;
  private startedReject: ((error: Error) => void) | null = null;
  private recordingStartTime: number | null = null;
  private cachedHtml: string | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Called when the view is first created
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewHtml();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message: FromWebviewMessage) => {
      this.handleMessage(message);
    });

    // Handle visibility changes - stop recording if panel is hidden
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible && this.isCapturing) {
        // Panel was hidden while recording - stop capture
        this.stop();
        // Notify listeners that capture stopped due to panel close
        this.errorHandlers.forEach((h: CaptureErrorHandler) =>
          h({ type: "connection", message: "Recording stopped - panel was closed" })
        );
      }
    });
  }

  /**
   * Start audio capture
   */
  async start(): Promise<void> {
    if (this.isCapturing) {
      return;
    }

    // Show the view (this triggers resolveWebviewView if needed)
    await vscode.commands.executeCommand(`${AudioCaptureViewProvider.viewType}.focus`);

    // Wait for the view to be ready, with retries
    let retries = 0;
    const maxRetries = Math.ceil(VIEW_READY_TIMEOUT_MS / VIEW_READY_RETRY_MS);
    while (!this.view && retries < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, VIEW_READY_RETRY_MS));
      retries++;
    }

    if (!this.view) {
      throw new Error("Failed to initialize audio capture view");
    }

    // Log loading state and send start message
    this.log("loading", "Connecting to microphone...");
    this.postMessage({ type: "start" });

    // Wait for the webview to start recording
    return new Promise<void>((resolve, reject) => {
      this.startedResolve = resolve;
      this.startedReject = reject;

      // Timeout after VIEW_READY_TIMEOUT_MS
      setTimeout(() => {
        if (this.startedReject) {
          this.startedReject(new Error("Timeout waiting for audio capture to start"));
          this.startedResolve = null;
          this.startedReject = null;
        }
      }, VIEW_READY_TIMEOUT_MS);
    });
  }

  /**
   * Stop audio capture
   */
  stop(): void {
    if (!this.isCapturing) {
      return;
    }

    this.postMessage({ type: "stop" });
    this.isCapturing = false;
  }

  /**
   * Register a handler for audio data
   */
  onAudio(handler: AudioHandler): () => void {
    return this.audioHandlers.add(handler);
  }

  /**
   * Register a handler for capture errors
   */
  onError(handler: CaptureErrorHandler): () => void {
    return this.errorHandlers.add(handler);
  }

  /**
   * Handle messages from the webview
   */
  private handleMessage(message: FromWebviewMessage): void {
    switch (message.type) {
      case "started":
        this.isCapturing = true;
        this.recordingStartTime = Date.now();
        this.log("started", "Recording started");
        this.log("loading", "Keep this panel open while recording");
        if (this.startedResolve) {
          this.startedResolve();
          this.startedResolve = null;
          this.startedReject = null;
        }
        // Refocus editor after panel opens
        void this.minimizePanel();
        break;

      case "stopped": {
        this.isCapturing = false;
        const duration = this.formatDuration(this.recordingStartTime);
        this.recordingStartTime = null;
        this.log("stopped", `Recording stopped${duration}`);
        break;
      }

      case "audio": {
        const int16Array = new Int16Array(message.data);
        const buffer = int16Array.buffer;
        this.audioHandlers.forEach((h: AudioHandler) => h(buffer));
        break;
      }

      case "error": {
        const error = this.mapMicError(message.message);
        this.log("error", message.message);
        this.errorHandlers.forEach((h: CaptureErrorHandler) => h(error));
        if (this.startedReject) {
          this.startedReject(new Error(message.message));
          this.startedResolve = null;
          this.startedReject = null;
        }
        break;
      }
    }
  }

  /**
   * Format recording duration
   */
  private formatDuration(startTime: number | null): string {
    if (!startTime) {
      return "";
    }
    const durationMs = Date.now() - startTime;
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 60) {
      return ` (${seconds}s)`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return ` (${minutes}m ${remainingSeconds}s)`;
  }

  /**
   * Refocus the editor after panel opens
   * User can manually resize the panel as needed
   */
  private async minimizePanel(): Promise<void> {
    // Small delay to let the panel settle
    await new Promise((resolve) => setTimeout(resolve, PANEL_SETTLE_MS));

    // Return focus to the editor
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }

  /**
   * Post a message to the webview
   */
  private postMessage(message: ToWebviewMessage): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    }
  }

  /**
   * Add a log entry to the webview
   */
  log(level: "loading" | "started" | "stopped" | "error", message: string): void {
    this.postMessage({ type: "log", level, message });
  }

  /**
   * Map microphone error message to DictationError
   */
  private mapMicError(message: string): DictationError {
    return { type: "permission", message };
  }

  /**
   * Generate webview HTML content (cached after first read)
   */
  private getWebviewHtml(): string {
    if (this.cachedHtml) {
      return this.cachedHtml;
    }

    const htmlPath = path.join(this.extensionUri.fsPath, "dist", "audio", "webview.html");
    const processorPath = path.join(
      this.extensionUri.fsPath,
      "dist",
      "audio",
      "audio-processor.js"
    );

    let html: string;
    let processorCode: string;

    try {
      html = fs.readFileSync(htmlPath, "utf-8");
      processorCode = fs.readFileSync(processorPath, "utf-8");
    } catch {
      const srcHtmlPath = path.join(this.extensionUri.fsPath, "src", "audio", "webview.html");
      const srcProcessorPath = path.join(
        this.extensionUri.fsPath,
        "src",
        "audio",
        "audio-processor.js"
      );
      html = fs.readFileSync(srcHtmlPath, "utf-8");
      processorCode = fs.readFileSync(srcProcessorPath, "utf-8");
    }

    const escapedProcessorCode = processorCode
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");
    html = html.replace(/{{processorCode}}/g, escapedProcessorCode);

    this.cachedHtml = html;
    return html;
  }
}
