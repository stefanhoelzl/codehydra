import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { ToWebviewMessage, FromWebviewMessage } from "./types";
import type { DictationError } from "../providers/types";
import { createHandlerRegistry } from "../utils";
import { isConfigured } from "../config";

/** Timeout waiting for webview to be ready (ms) */
const WEBVIEW_READY_TIMEOUT_MS = 10000;

/**
 * Handler for audio data received from the webview
 */
export type AudioHandler = (buffer: ArrayBuffer) => void;

/**
 * Handler for audio capture errors
 */
export type CaptureErrorHandler = (error: DictationError) => void;

/**
 * WebviewPanel for audio capture - runs in an editor tab
 * Uses retainContextWhenHidden to keep running in background
 */
export class AudioCapturePanel implements vscode.Disposable {
  public static readonly viewType = "codehydra.dictation.audioCapture";
  private static instance: AudioCapturePanel | null = null;

  private panel: vscode.WebviewPanel | null = null;
  private audioHandlers = createHandlerRegistry<AudioHandler>();
  private errorHandlers = createHandlerRegistry<CaptureErrorHandler>();
  private isCapturing = false;
  private isDisposing = false;
  private isPanelVisible = false;
  private startedResolve: (() => void) | null = null;
  private startedReject: ((error: Error) => void) | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Get the singleton instance
   */
  static getInstance(extensionUri: vscode.Uri): AudioCapturePanel {
    if (!AudioCapturePanel.instance) {
      AudioCapturePanel.instance = new AudioCapturePanel(extensionUri);
    }
    return AudioCapturePanel.instance;
  }

  /**
   * Open the panel in background (ViewColumn.One, preserveFocus)
   * Does nothing if not configured (for startup use)
   */
  open(): void {
    // Do nothing if not configured - silent no-op for startup
    if (!isConfigured()) {
      return;
    }

    // Skip if disposing
    if (this.isDisposing) {
      return;
    }

    // If panel exists and is not disposed, just return
    if (this.panel) {
      return;
    }

    this.createPanel();
  }

  /**
   * Create the webview panel
   */
  private createPanel(): void {
    this.panel = vscode.window.createWebviewPanel(
      AudioCapturePanel.viewType,
      "Dictate",
      {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true, // Don't steal focus from current editor
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep running in background
        localResourceRoots: [this.extensionUri],
      }
    );

    // Note: VS Code's WebviewPanel.iconPath only accepts Uri (not ThemeIcon).
    // Using a codicon like $(mic) would require bundling the icon as a file.
    // Since the webview already shows the mic icon in the header, the default
    // tab icon is acceptable. This is a known VS Code API limitation.

    // Set HTML content
    this.panel.webview.html = this.getWebviewHtml();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: FromWebviewMessage) => {
        this.handleMessage(message);
      },
      null,
      this.disposables
    );

    // Handle disposal
    this.panel.onDidDispose(
      () => {
        this.handlePanelDispose();
      },
      null,
      this.disposables
    );

    // Track visibility changes
    this.panel.onDidChangeViewState(
      (e) => {
        this.isPanelVisible = e.webviewPanel.visible;
      },
      null,
      this.disposables
    );

    // Initialize visibility state
    this.isPanelVisible = this.panel.visible;

    // Send initial config state
    this.sendConfigUpdate();
  }

  /**
   * Handle panel disposal (user closed tab)
   */
  private handlePanelDispose(): void {
    // Set disposing flag to prevent race conditions
    this.isDisposing = true;

    // Stop recording if active
    if (this.isCapturing) {
      this.stop();
      // Notify listeners
      this.errorHandlers.forEach((h: CaptureErrorHandler) =>
        h({ type: "connection", message: "Recording stopped - tab was closed" })
      );
    }

    // Clean up
    this.panel = null;

    // Clear disposables
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    // Reset disposing flag after cleanup
    this.isDisposing = false;
  }

  /**
   * Start audio capture
   * Opens panel if needed
   */
  async start(): Promise<void> {
    if (this.isCapturing) {
      return;
    }

    if (this.isDisposing) {
      throw new Error("Panel is being disposed");
    }

    // Ensure panel exists
    if (!this.panel) {
      this.createPanel();
    }

    if (!this.panel) {
      throw new Error("Failed to create audio capture panel");
    }

    // Send start message
    this.postMessage({ type: "start" });

    // Wait for the webview to start recording
    return new Promise<void>((resolve, reject) => {
      this.startedResolve = resolve;
      this.startedReject = reject;

      // Timeout after WEBVIEW_READY_TIMEOUT_MS
      setTimeout(() => {
        if (this.startedReject) {
          this.startedReject(new Error("Timeout waiting for audio capture to start"));
          this.startedResolve = null;
          this.startedReject = null;
        }
      }, WEBVIEW_READY_TIMEOUT_MS);
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
   * Log a transcript to the webview
   */
  logTranscript(text: string): void {
    this.postMessage({
      type: "transcript",
      text,
      timestamp: Date.now(),
    });
  }

  /**
   * Log an error to the webview
   */
  logError(message: string): void {
    this.postMessage({
      type: "errorLog",
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Update status in the webview
   */
  updateStatus(status: string, duration?: number): void {
    this.postMessage({
      type: "statusUpdate",
      status,
      duration,
    });
  }

  /**
   * Clear the log
   */
  clearLog(): void {
    this.postMessage({ type: "clearLog" });
  }

  /**
   * Start a new recording session in the log
   * Creates a new session card
   */
  startSession(): void {
    this.postMessage({
      type: "sessionStart",
      timestamp: Date.now(),
    });
  }

  /**
   * End the current recording session
   * @param cancelled - If true, session was cancelled (shows red border)
   */
  endSession(cancelled: boolean): void {
    this.postMessage({
      type: "sessionEnd",
      cancelled,
    });
  }

  /**
   * Update the live preview text
   */
  updateLivePreview(text: string): void {
    this.postMessage({ type: "livePreview", text });
  }

  /**
   * Clear the live preview
   */
  clearLivePreview(): void {
    this.postMessage({ type: "livePreview", text: "" });
  }

  /**
   * Check if the panel is currently visible (active tab)
   */
  isVisible(): boolean {
    return this.isPanelVisible;
  }

  /**
   * Send config update to webview
   */
  sendConfigUpdate(): void {
    this.postMessage({
      type: "configUpdate",
      configured: isConfigured(),
    });
  }

  /**
   * Handle messages from the webview
   */
  private handleMessage(message: FromWebviewMessage): void {
    // Skip if disposing
    if (this.isDisposing) {
      return;
    }

    switch (message.type) {
      case "started":
        this.isCapturing = true;
        if (this.startedResolve) {
          this.startedResolve();
          this.startedResolve = null;
          this.startedReject = null;
        }
        break;

      case "stopped":
        this.isCapturing = false;
        break;

      case "audio": {
        const int16Array = new Int16Array(message.data);
        const buffer = int16Array.buffer;
        this.audioHandlers.forEach((h: AudioHandler) => h(buffer));
        break;
      }

      case "error": {
        const error = this.mapMicError(message.message);
        this.errorHandlers.forEach((h: CaptureErrorHandler) => h(error));
        if (this.startedReject) {
          this.startedReject(new Error(message.message));
          this.startedResolve = null;
          this.startedReject = null;
        }
        break;
      }

      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "codehydra.dictation");
        break;
    }
  }

  /**
   * Post a message to the webview
   */
  private postMessage(message: ToWebviewMessage): void {
    if (this.panel && !this.isDisposing) {
      void this.panel.webview.postMessage(message);
    }
  }

  /**
   * Map microphone error message to DictationError
   */
  private mapMicError(message: string): DictationError {
    return { type: "permission", message };
  }

  /**
   * Generate webview HTML content
   * Note: HTML is NOT cached because the codiconsUri changes per webview instance
   */
  private getWebviewHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, "dist", "audio", "webview.html");
    const processorPath = path.join(
      this.extensionUri.fsPath,
      "dist",
      "audio",
      "audio-processor.js"
    );

    let html: string;
    let processorCode: string;
    let codiconsFontPath: string;

    try {
      html = fs.readFileSync(htmlPath, "utf-8");
      processorCode = fs.readFileSync(processorPath, "utf-8");
      codiconsFontPath = path.join(this.extensionUri.fsPath, "dist", "codicons", "codicon.ttf");
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
      // In dev mode, use the node_modules path
      codiconsFontPath = path.join(
        this.extensionUri.fsPath,
        "node_modules",
        "@vscode",
        "codicons",
        "dist",
        "codicon.ttf"
      );
    }

    const escapedProcessorCode = processorCode
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");
    html = html.replace(/{{processorCode}}/g, escapedProcessorCode);

    // Generate webview URI for the codicons font
    if (this.panel) {
      const codiconsUri = this.panel.webview.asWebviewUri(vscode.Uri.file(codiconsFontPath));
      html = html.replace(/{{codiconsUri}}/g, codiconsUri.toString());
    }

    return html;
  }

  /**
   * Dispose the panel and cleanup
   */
  dispose(): void {
    this.isDisposing = true;

    // Clear handlers
    this.audioHandlers.clear();
    this.errorHandlers.clear();

    // Dispose panel
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }

    // Clear disposables
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    // Clear singleton reference
    AudioCapturePanel.instance = null;
  }
}
