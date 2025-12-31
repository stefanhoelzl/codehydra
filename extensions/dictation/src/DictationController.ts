import * as vscode from "vscode";
import type { SpeechToTextProvider, DictationError } from "./providers/types";
import { AssemblyAIProvider } from "./providers/assemblyai";
import type { AudioCaptureViewProvider } from "./audio/AudioCaptureViewProvider";
import { getConfig, type DictationConfig } from "./config";
import { CONTEXT_KEYS } from "./commands";
import { createHandlerRegistry } from "./utils";

/**
 * State machine for dictation
 */
export type DictationState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startTime: number; sessionId: string }
  | { status: "stopping" };

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
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private unsubscribeAudio: (() => void) | null = null;
  private unsubscribeAudioError: (() => void) | null = null;
  private stateChangeHandlers = createHandlerRegistry<StateChangeHandler>();

  private readonly audioCaptureProvider: AudioCaptureViewProvider;
  private readonly providerFactory: ProviderFactory;

  constructor(
    audioCaptureProvider: AudioCaptureViewProvider,
    providerFactory: ProviderFactory = defaultProviderFactory
  ) {
    this.audioCaptureProvider = audioCaptureProvider;
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
    // Check if already starting or recording
    if (this.state.status !== "idle") {
      if (this.state.status === "starting") {
        void vscode.window.showInformationMessage("Dictation: Already connecting...");
      }
      return;
    }

    // Get configuration
    const config = getConfig();

    // Check for API key
    const apiKey = this.getApiKey(config);
    if (!apiKey) {
      void vscode.window.showErrorMessage(
        "Dictation: No API key configured. Please set codehydra.dictation.assemblyai.apiKey in settings."
      );
      return;
    }

    // Transition to starting state
    this.setState({ status: "starting" });

    try {
      // Create provider
      this.provider = this.providerFactory(apiKey);

      // Set up event handlers
      this.unsubscribeTranscript = this.provider.onTranscript((text) => {
        this.insertText(text);
      });

      this.unsubscribeError = this.provider.onError((error) => {
        this.handleError(error);
      });

      // Connect provider
      await this.provider.connect();

      // Set up audio handler
      this.unsubscribeAudio = this.audioCaptureProvider.onAudio((buffer) => {
        this.provider?.sendAudio(buffer);
      });

      // Set up audio error handler (reuse provider error handler)
      this.unsubscribeAudioError = this.audioCaptureProvider.onError((error) => {
        this.handleError(error);
      });

      // Start audio capture
      await this.audioCaptureProvider.start();

      // Generate session ID
      const sessionId = `dictation-${Date.now()}`;

      // Transition to recording state
      this.setState({
        status: "recording",
        startTime: Date.now(),
        sessionId,
      });

      // Set recording context for keybindings
      await vscode.commands.executeCommand("setContext", CONTEXT_KEYS.IS_RECORDING, true);

      // Start duration timer
      this.startDurationTimer(config.maxDuration);
    } catch (error) {
      // Handle connection failure
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Dictation: Failed to connect to speech service. ${message}`
      );
      this.cleanup();
      this.setState({ status: "idle" });
    }
  }

  /**
   * Stop dictation
   */
  async stop(): Promise<void> {
    if (this.state.status !== "recording") {
      return;
    }

    // Transition to stopping state
    this.setState({ status: "stopping" });

    // Cleanup resources
    this.cleanup();

    // Clear recording context
    await vscode.commands.executeCommand("setContext", CONTEXT_KEYS.IS_RECORDING, false);

    // Close the panel (where audio capture view lives)
    await vscode.commands.executeCommand("workbench.action.closePanel");

    // Transition to idle state
    this.setState({ status: "idle" });
  }

  /**
   * Toggle dictation (start if idle, stop if recording)
   */
  async toggle(): Promise<void> {
    if (this.state.status === "idle") {
      await this.start();
    } else if (this.state.status === "recording") {
      await this.stop();
    } else if (this.state.status === "starting") {
      void vscode.window.showInformationMessage("Dictation: Already connecting...");
    }
    // Ignore toggle during "stopping" state
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
  }

  /**
   * Get API key from configuration
   */
  private getApiKey(config: DictationConfig): string | null {
    return config.assemblyaiApiKey || null;
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
        message = "Dictation: Invalid API key. Please check your settings.";
        break;
      case "permission":
        message = `Dictation: Microphone access denied. ${error.message}`;
        break;
      case "connection":
        message = `Dictation: Connection lost. ${error.message}`;
        break;
      case "quota":
        message = `Dictation: API quota exceeded. ${error.message}`;
        break;
      case "provider":
        message = `Dictation: Error from speech service. ${error.message}`;
        break;
      default: {
        const _exhaustive: never = error;
        message = `Dictation: Unknown error. ${(error as DictationError).message}`;
      }
    }

    void vscode.window.showErrorMessage(message);

    // Stop and cleanup (keep panel open so user can see error in log)
    this.cleanup();
    void vscode.commands.executeCommand("setContext", CONTEXT_KEYS.IS_RECORDING, false);
    this.setState({ status: "idle" });
  }

  /**
   * Start the duration timeout timer
   */
  private startDurationTimer(maxDuration: number): void {
    this.durationTimer = setTimeout(() => {
      void vscode.window.showInformationMessage(
        `Dictation: Recording stopped. Maximum duration (${maxDuration}s) reached.`
      );
      void this.stop();
    }, maxDuration * 1000);
  }

  /**
   * Cleanup all resources
   */
  private cleanup(): void {
    // Clear timers
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }

    // Unsubscribe from events
    if (this.unsubscribeTranscript) {
      this.unsubscribeTranscript();
      this.unsubscribeTranscript = null;
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

    // Stop audio capture (provider manages its own lifecycle)
    this.audioCaptureProvider.stop();

    // Dispose provider
    if (this.provider) {
      this.provider.dispose();
      this.provider = null;
    }
  }
}
