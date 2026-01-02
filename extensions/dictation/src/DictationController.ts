import * as vscode from "vscode";
import type { SpeechToTextProvider, DictationError } from "./providers/types";
import { AssemblyAIProvider } from "./providers/assemblyai";
import type { AudioCapturePanel } from "./audio/AudioCapturePanel";
import { getConfig, isConfigured, type DictationConfig } from "./config";
import { createHandlerRegistry } from "./utils";

/**
 * Connection phase during recording
 */
export type ConnectionPhase = "disconnected" | "buffering" | "flushing" | "streaming";

/**
 * State machine for dictation
 */
export type DictationState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "recording";
      phase: ConnectionPhase;
      isActive: boolean;
      startTime: number;
      sessionId: string;
    }
  | { status: "stopping" }
  | { status: "error"; message: string };

/**
 * Callback for state changes
 */
export type StateChangeHandler = (state: DictationState) => void;

/**
 * Factory for creating providers (for testing)
 */
export type ProviderFactory = (apiKey: string) => SpeechToTextProvider;

/**
 * Default provider factory
 */
const defaultProviderFactory: ProviderFactory = (apiKey) => new AssemblyAIProvider(apiKey);

/**
 * Main dictation controller
 * Orchestrates provider, audio capture, and text insertion
 */
export class DictationController implements vscode.Disposable {
  private state: DictationState = { status: "idle" };
  private provider: SpeechToTextProvider | null = null;

  // Timers
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private listeningTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  // Configuration
  private config: DictationConfig | null = null;

  // Audio buffering
  private audioBuffer: ArrayBuffer[] = [];
  private isProviderConnected = false;

  // Event unsubscribe functions
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribePartialTranscript: (() => void) | null = null;
  private unsubscribeActivity: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private unsubscribeAudio: (() => void) | null = null;
  private unsubscribeAudioError: (() => void) | null = null;
  private stateChangeHandlers = createHandlerRegistry<StateChangeHandler>();

  private readonly audioCapturePanel: AudioCapturePanel;
  private readonly providerFactory: ProviderFactory;

  constructor(
    audioCapturePanel: AudioCapturePanel,
    providerFactory: ProviderFactory = defaultProviderFactory
  ) {
    this.audioCapturePanel = audioCapturePanel;
    this.providerFactory = providerFactory;
  }

  /**
   * Get the current state
   */
  getState(): DictationState {
    return this.state;
  }

  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.state.status === "recording";
  }

  /**
   * Start dictation
   */
  async start(): Promise<void> {
    // Check if already loading or recording
    if (this.state.status !== "idle") {
      if (this.state.status === "loading") {
        void vscode.window.showInformationMessage("Dictation: Already connecting...");
      }
      return;
    }

    // Get configuration
    this.config = getConfig();

    // Check for API key
    const apiKey = this.getApiKey(this.config);
    if (!apiKey) {
      void vscode.window.showErrorMessage(
        "Dictation: No API key configured. Please set codehydra.dictation.assemblyai.apiKey in settings."
      );
      return;
    }

    // Transition to loading state
    this.setState({ status: "loading" });

    // Reset state for new session
    this.audioBuffer = [];
    this.isProviderConnected = false;

    try {
      // Create provider
      this.provider = this.providerFactory(apiKey);

      // Set up event handlers
      this.unsubscribeTranscript = this.provider.onTranscript((text) => {
        // Clear live preview when final transcript is received
        this.audioCapturePanel.clearLivePreview();

        // Only emit text when panel is NOT visible (background mode)
        if (!this.audioCapturePanel.isVisible()) {
          this.insertText(text);
        }

        // Always log transcript to panel
        this.audioCapturePanel.logTranscript(text);
      });

      // Set up partial transcript handler for live preview
      this.unsubscribePartialTranscript = this.provider.onPartialTranscript((text) => {
        this.audioCapturePanel.updateLivePreview(text);
      });

      this.unsubscribeActivity = this.provider.onActivity(() => {
        this.handleActivity();
      });

      this.unsubscribeError = this.provider.onError((error) => {
        this.handleError(error);
      });

      // Set up audio handler (buffers during connect, sends directly after)
      this.unsubscribeAudio = this.audioCapturePanel.onAudio((buffer) => {
        this.handleAudioChunk(buffer);
      });

      // Set up audio error handler
      this.unsubscribeAudioError = this.audioCapturePanel.onError((error) => {
        this.handleError(error);
      });

      // Start audio capture and provider connection in parallel
      const sessionId = `dictation-${Date.now()}`;

      // Start audio capture first - this determines when we can enter "recording" state
      await this.audioCapturePanel.start();

      // Start a new session in the log panel
      this.audioCapturePanel.startSession();

      // Transition to recording state with buffering phase (audio ready, API connecting)
      // Always show green (isActive=true) during buffering phase
      this.setState({
        status: "recording",
        phase: "buffering",
        isActive: true,
        startTime: Date.now(),
        sessionId,
      });

      // Start auto-stop timer (will reset on audio chunks during buffering)
      this.startAutoStopTimer();

      // Set up connection timeout
      this.connectionTimer = setTimeout(() => {
        this.handleConnectionTimeout();
      }, this.config.assemblyaiConnectionTimeout);

      // Connect provider in background (don't await - let buffering continue)
      void this.connectProvider();
    } catch (error) {
      // Handle audio start failure
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Dictation: Failed to start audio capture. ${message}`);
      this.cleanup();
      this.setState({ status: "idle" });
    }
  }

  /**
   * Stop dictation
   * @param options Optional: emitEnter for auto-submit feature, cancelled for session end state
   */
  stop(options?: { emitEnter?: boolean; cancelled?: boolean }): void {
    if (this.state.status !== "recording") {
      return;
    }

    // Transition to stopping state
    this.setState({ status: "stopping" });

    // Clear live preview
    this.audioCapturePanel.clearLivePreview();

    // End the session in the log panel
    this.audioCapturePanel.endSession(options?.cancelled ?? false);

    // Cleanup resources
    this.cleanup();

    // Emit Enter if auto-submit is enabled for manual stop
    // Only emit when panel is NOT visible (background mode)
    if (options?.emitEnter && !this.audioCapturePanel.isVisible()) {
      this.insertText("\n");
    }

    // Tab stays open - don't close

    // Transition to idle state
    this.setState({ status: "idle" });
  }

  /**
   * Toggle dictation (start if idle, stop if recording)
   * Uses manual stop behavior (emits Enter if autoSubmit enabled)
   * Opens settings if not configured
   */
  async toggle(): Promise<void> {
    // If not configured, open settings
    if (!isConfigured()) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "codehydra.dictation");
      return;
    }

    if (this.state.status === "idle") {
      await this.start();
    } else if (this.state.status === "recording") {
      // Manual stop - emit Enter if autoSubmit is enabled
      await this.stop({ emitEnter: this.config?.autoSubmit ?? false });
    } else if (this.state.status === "loading") {
      void vscode.window.showInformationMessage("Dictation: Already connecting...");
    }
    // Ignore toggle during "stopping" or "error" states
  }

  /**
   * Cancel dictation (stop WITHOUT emitting Enter)
   * Used for Escape key - allows aborting without submitting
   */
  async cancel(): Promise<void> {
    if (this.state.status === "recording" || this.state.status === "loading") {
      await this.stop({ emitEnter: false, cancelled: true });
    }
  }

  /**
   * Register a handler for state changes
   * @returns Unsubscribe function
   */
  onStateChange(handler: StateChangeHandler): () => void {
    return this.stateChangeHandlers.add(handler);
  }

  dispose(): void {
    this.cleanup();
    this.stateChangeHandlers.clear();
  }

  /**
   * Set the state and notify handlers
   */
  private setState(state: DictationState): void {
    this.state = state;
    this.stateChangeHandlers.forEach((h) => h(state));

    // Update panel status
    this.updatePanelStatus(state);
  }

  /**
   * Update the panel status display
   */
  private updatePanelStatus(state: DictationState): void {
    switch (state.status) {
      case "idle":
        this.audioCapturePanel.updateStatus("Ready");
        break;
      case "loading":
        this.audioCapturePanel.updateStatus("Connecting...");
        break;
      case "recording": {
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const statusText = state.isActive ? "Recording" : "Listening";
        this.audioCapturePanel.updateStatus(statusText, elapsed);
        break;
      }
      case "stopping":
        this.audioCapturePanel.updateStatus("Stopping...");
        break;
      case "error":
        this.audioCapturePanel.updateStatus(`Error: ${state.message}`);
        break;
    }
  }

  /**
   * Update the isActive flag in recording state
   */
  private setIsActive(isActive: boolean): void {
    if (this.state.status !== "recording") {
      return;
    }
    this.setState({
      ...this.state,
      isActive,
    });
  }

  /**
   * Update the connection phase in recording state
   */
  private setPhase(phase: ConnectionPhase): void {
    if (this.state.status !== "recording") {
      return;
    }
    this.setState({
      ...this.state,
      phase,
    });
  }

  /**
   * Get API key from configuration
   */
  private getApiKey(config: DictationConfig): string | null {
    return config.assemblyaiApiKey || null;
  }

  /**
   * Connect to the speech provider
   */
  private async connectProvider(): Promise<void> {
    if (!this.provider) {
      return;
    }

    try {
      await this.provider.connect();

      // Clear connection timeout
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }

      this.isProviderConnected = true;

      // Flush buffered audio
      await this.flushAudioBuffer();
    } catch (error) {
      // Clear connection timeout
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }

      // Handle connection failure
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Dictation: Failed to connect to speech service. ${message}`
      );
      this.cleanup();
      this.setState({ status: "error", message });
    }
  }

  /**
   * Handle connection timeout
   */
  private handleConnectionTimeout(): void {
    if (this.state.status !== "recording") {
      return;
    }

    this.connectionTimer = null;
    this.cleanup();
    this.setState({ status: "error", message: "Connection timeout" });
  }

  /**
   * Flush the audio buffer to the provider
   */
  private async flushAudioBuffer(): Promise<void> {
    if (this.state.status !== "recording" || !this.provider) {
      return;
    }

    // Transition to flushing phase
    this.setPhase("flushing");

    // Send all buffered audio chunks in order
    for (const buffer of this.audioBuffer) {
      this.provider.sendAudio(buffer);
    }

    // Clear the buffer
    this.audioBuffer = [];

    // Transition to streaming phase
    this.setPhase("streaming");

    // Start listening timer (will show orange after delay if no activity)
    this.startListeningTimer();
  }

  /**
   * Handle an incoming audio chunk
   */
  private handleAudioChunk(buffer: ArrayBuffer): void {
    if (this.state.status !== "recording") {
      return;
    }

    const phase = this.state.phase;

    if (phase === "buffering") {
      // Queue audio while API is connecting
      this.audioBuffer.push(buffer);
      // Reset auto-stop timer on audio chunks during buffering
      this.resetAutoStopTimer();
    } else if (
      (phase === "flushing" || phase === "streaming") &&
      this.provider &&
      this.isProviderConnected
    ) {
      // Send directly to provider when connected (flushing or streaming)
      this.provider.sendAudio(buffer);
    }
  }

  /**
   * Handle activity from the speech provider (word-level transcripts)
   */
  private handleActivity(): void {
    if (this.state.status !== "recording") {
      return;
    }

    // Only switch to active in streaming phase (buffering is always active)
    if (this.state.phase === "streaming") {
      this.setIsActive(true);
      this.resetListeningTimer();
    }

    // Always reset auto-stop timer on activity
    this.resetAutoStopTimer();
  }

  /**
   * Insert text at the current cursor position
   * Works in both editors and terminals
   */
  private insertText(text: string): void {
    const activeTerminal = vscode.window.activeTerminal;
    const activeEditor = vscode.window.activeTextEditor;

    if (!activeEditor && activeTerminal) {
      activeTerminal.sendText(text, false);
      return;
    }

    void vscode.commands.executeCommand("type", { text });
  }

  /**
   * Handle errors from provider or audio capture
   */
  private handleError(error: DictationError): void {
    let message: string;

    switch (error.type) {
      case "auth":
        message = "Invalid API key. Please check your settings.";
        break;
      case "permission":
        message = `Microphone access denied. ${error.message}`;
        break;
      case "connection":
        message = `Connection lost. ${error.message}`;
        break;
      case "quota":
        message = `API quota exceeded. ${error.message}`;
        break;
      case "provider":
        message = `Error from speech service. ${error.message}`;
        break;
      default:
        // Exhaustive check: TypeScript errors if not all cases are handled
        message = `Unknown error. ${(error as never as DictationError).message}`;
    }

    // Log error to panel
    this.audioCapturePanel.logError(message);

    // Stop and cleanup (keep panel open so user can see error in log)
    this.cleanup();
    // No Enter emitted on error (auto-stop, not manual)
    this.setState({ status: "error", message });
  }

  /**
   * Start the auto-stop timer
   */
  private startAutoStopTimer(): void {
    const delay = (this.config?.autoStopDelay ?? 5) * 1000;
    this.autoStopTimer = setTimeout(() => {
      void vscode.window.showInformationMessage(
        `Dictation: Recording stopped. No speech detected for ${this.config?.autoStopDelay ?? 5} seconds.`
      );
      // Auto-stop does NOT emit Enter
      void this.stop({ emitEnter: false });
    }, delay);
  }

  /**
   * Reset the auto-stop timer
   */
  private resetAutoStopTimer(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
    }
    this.startAutoStopTimer();
  }

  /**
   * Start the listening timer (shows orange after delay)
   */
  private startListeningTimer(): void {
    const delay = this.config?.listeningDelay ?? 300;
    this.listeningTimer = setTimeout(() => {
      this.setIsActive(false);
    }, delay);
  }

  /**
   * Reset the listening timer
   */
  private resetListeningTimer(): void {
    if (this.listeningTimer) {
      clearTimeout(this.listeningTimer);
    }
    this.startListeningTimer();
  }

  /**
   * Cleanup all resources
   */
  private cleanup(): void {
    // Clear all timers
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    if (this.listeningTimer) {
      clearTimeout(this.listeningTimer);
      this.listeningTimer = null;
    }

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    // Unsubscribe from events
    if (this.unsubscribeTranscript) {
      this.unsubscribeTranscript();
      this.unsubscribeTranscript = null;
    }

    if (this.unsubscribePartialTranscript) {
      this.unsubscribePartialTranscript();
      this.unsubscribePartialTranscript = null;
    }

    if (this.unsubscribeActivity) {
      this.unsubscribeActivity();
      this.unsubscribeActivity = null;
    }

    if (this.unsubscribeError) {
      this.unsubscribeError();
      this.unsubscribeError = null;
    }

    if (this.unsubscribeAudio) {
      this.unsubscribeAudio();
      this.unsubscribeAudio = null;
    }

    if (this.unsubscribeAudioError) {
      this.unsubscribeAudioError();
      this.unsubscribeAudioError = null;
    }

    // Clear audio buffer
    this.audioBuffer = [];
    this.isProviderConnected = false;

    // Stop audio capture (provider manages its own lifecycle)
    this.audioCapturePanel.stop();

    // Dispose provider
    if (this.provider) {
      this.provider.dispose();
      this.provider = null;
    }
  }
}
