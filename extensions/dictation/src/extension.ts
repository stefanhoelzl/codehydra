import * as vscode from "vscode";
import { DictationController, type DictationState } from "./DictationController";
import { StatusBar, type StatusBarState } from "./StatusBar";
import { AudioCaptureViewProvider } from "./audio/AudioCaptureViewProvider";
import { COMMANDS, CONTEXT_KEYS } from "./commands";

/**
 * Map DictationState to StatusBarState
 */
function mapDictationStateToStatusBar(state: DictationState): {
  state: StatusBarState;
  options?: { errorMessage?: string; startTime?: number };
} {
  switch (state.status) {
    case "idle":
      return { state: "idle" };
    case "loading":
      return { state: "loading" };
    case "recording": {
      // During buffering/flushing phases, always show as active (green)
      // During streaming, use the isActive flag
      const isActive = state.phase !== "streaming" || state.isActive;
      return {
        state: isActive ? "active" : "listening",
        options: { startTime: state.startTime },
      };
    }
    case "stopping":
      return { state: "stopping" };
    case "error":
      return { state: "error", options: { errorMessage: state.message } };
  }
}

let controller: DictationController | null = null;
let statusBar: StatusBar | null = null;

export function activate(context: vscode.ExtensionContext): void {
  console.log("[Dictation] Extension activating...");

  // Create audio capture view provider and register it
  const audioCaptureProvider = new AudioCaptureViewProvider(context.extensionUri);
  const viewProviderDisposable = vscode.window.registerWebviewViewProvider(
    AudioCaptureViewProvider.viewType,
    audioCaptureProvider
  );

  // Create controller and status bar
  controller = new DictationController(audioCaptureProvider);
  statusBar = new StatusBar();

  // Wire up state changes to status bar and context key
  controller.onStateChange((state) => {
    const mapped = mapDictationStateToStatusBar(state);
    statusBar?.update(mapped.state, mapped.options);

    // Set context key for conditional keybindings (Escape only works when recording)
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_KEYS.IS_RECORDING,
      state.status === "recording" || state.status === "loading"
    );
  });

  // Register commands
  const toggleCommand = vscode.commands.registerCommand(COMMANDS.TOGGLE, () => {
    void controller?.toggle();
  });

  const startCommand = vscode.commands.registerCommand(COMMANDS.START, () => {
    void controller?.start();
  });

  const stopCommand = vscode.commands.registerCommand(COMMANDS.STOP, () => {
    void controller?.stop();
  });

  const cancelCommand = vscode.commands.registerCommand(COMMANDS.CANCEL, () => {
    void controller?.cancel();
  });

  // Watch for configuration changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("codehydra.dictation")) {
      // Refresh status bar to reflect configuration changes
      statusBar?.refresh();

      // If recording and API key was removed, stop recording
      if (controller?.isRecording()) {
        const apiKey = vscode.workspace
          .getConfiguration("codehydra.dictation")
          .get<string>("assemblyai.apiKey", "");
        if (!apiKey) {
          void vscode.window.showWarningMessage("Dictation: API key removed. Stopping recording.");
          void controller.stop();
        }
      }
    }
  });

  // Register disposables
  context.subscriptions.push(
    viewProviderDisposable,
    toggleCommand,
    startCommand,
    stopCommand,
    cancelCommand,
    configWatcher,
    controller,
    statusBar
  );

  console.log("[Dictation] Extension activated");
}

export function deactivate(): void {
  console.log("[Dictation] Extension deactivating...");

  // Cleanup is handled by VS Code's disposal of subscriptions
  controller = null;
  statusBar = null;

  console.log("[Dictation] Extension deactivated");
}
