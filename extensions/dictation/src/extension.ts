import * as vscode from "vscode";
import { DictationController } from "./DictationController";
import { StatusBar } from "./StatusBar";
import { AudioCaptureViewProvider } from "./audio/AudioCaptureViewProvider";
import { COMMANDS } from "./commands";

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

  // Wire up state changes to status bar
  controller.onStateChange((state) => {
    statusBar?.update(state);
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
