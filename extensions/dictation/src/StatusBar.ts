import * as vscode from "vscode";
import { isConfigured } from "./config";
import { COMMANDS } from "./commands";

/**
 * Status bar state type
 */
export type StatusBarState = "idle" | "loading" | "listening" | "active" | "stopping" | "error";

/**
 * Status bar manager for dictation
 * Shows icon-only status with tooltip
 */
export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tooltipTimer: ReturnType<typeof setInterval> | null = null;
  private errorClearTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: StatusBarState = "idle";
  private recordingStartTime: number | null = null;
  private errorMessage: string | null = null;

  constructor() {
    // Create status bar item on the right side
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    // Initial update
    this.updateAppearance();

    // Show the status bar item
    this.statusBarItem.show();
  }

  /**
   * Update the status bar state
   * @param state The new status bar state
   * @param options Optional: error message for error state, or startTime for recording states
   */
  update(state: StatusBarState, options?: { errorMessage?: string; startTime?: number }): void {
    this.currentState = state;
    this.errorMessage = options?.errorMessage ?? null;
    this.recordingStartTime = options?.startTime ?? null;

    // Clear any existing error auto-clear timer
    if (this.errorClearTimer) {
      clearTimeout(this.errorClearTimer);
      this.errorClearTimer = null;
    }

    // Set up error auto-clear timer (only for error state)
    if (state === "error") {
      this.errorClearTimer = setTimeout(() => {
        this.update("idle");
      }, 3000);
    }

    this.updateAppearance();

    // Start/stop tooltip timer for recording states (listening, active)
    if (state === "listening" || state === "active") {
      this.startTooltipTimer();
    } else {
      this.stopTooltipTimer();
    }
  }

  /**
   * Refresh the status bar (e.g., when configuration changes)
   */
  refresh(): void {
    this.updateAppearance();
  }

  dispose(): void {
    this.stopTooltipTimer();
    if (this.errorClearTimer) {
      clearTimeout(this.errorClearTimer);
      this.errorClearTimer = null;
    }
    this.statusBarItem.dispose();
  }

  /**
   * Update the status bar appearance based on current state
   */
  private updateAppearance(): void {
    const configured = isConfigured();

    if (!configured) {
      // Unconfigured state - show muted record icon
      this.statusBarItem.text = "$(record)";
      this.statusBarItem.tooltip = "Dictation: Not configured. Click to open settings.";
      this.statusBarItem.command = {
        command: "workbench.action.openSettings",
        arguments: ["codehydra.dictation"],
        title: "Open Dictation Settings",
      };
      this.statusBarItem.color = new vscode.ThemeColor("disabledForeground");
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    switch (this.currentState) {
      case "idle":
        this.statusBarItem.text = "$(record)";
        this.statusBarItem.tooltip = "Start dictation (F10)";
        this.statusBarItem.command = COMMANDS.TOGGLE;
        this.statusBarItem.color = undefined;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "loading":
        this.statusBarItem.text = "$(loading~spin)";
        this.statusBarItem.tooltip = "Initializing dictation...";
        this.statusBarItem.command = undefined;
        this.statusBarItem.color = undefined;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "listening":
        this.statusBarItem.text = "$(mic)";
        this.updateRecordingTooltip("no speech");
        this.statusBarItem.command = COMMANDS.TOGGLE;
        this.statusBarItem.color = new vscode.ThemeColor("editorWarning.foreground");
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "active":
        this.statusBarItem.text = "$(mic-filled)";
        this.updateRecordingTooltip("speech detected");
        this.statusBarItem.command = COMMANDS.TOGGLE;
        this.statusBarItem.color = new vscode.ThemeColor("testing.iconPassed");
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "stopping":
        this.statusBarItem.text = "$(loading~spin)";
        this.statusBarItem.tooltip = "Stopping dictation...";
        this.statusBarItem.command = undefined;
        this.statusBarItem.color = undefined;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "error":
        this.statusBarItem.text = "$(error)";
        this.statusBarItem.tooltip = `Dictation failed: ${this.errorMessage || "Unknown error"}`;
        this.statusBarItem.command = COMMANDS.TOGGLE;
        this.statusBarItem.color = new vscode.ThemeColor("errorForeground");
        this.statusBarItem.backgroundColor = undefined;
        break;
    }
  }

  /**
   * Update the tooltip for recording state with elapsed time
   */
  private updateRecordingTooltip(speechStatus: string): void {
    const startTime = this.recordingStartTime;
    if (startTime === null) {
      this.statusBarItem.tooltip = `Recording - ${speechStatus} (F10 to stop)`;
      return;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    this.statusBarItem.tooltip = `Recording (${elapsed}s) - ${speechStatus} (F10 to stop)`;
  }

  /**
   * Start the timer to update tooltip every second
   */
  private startTooltipTimer(): void {
    this.stopTooltipTimer();
    this.tooltipTimer = setInterval(() => {
      if (this.currentState === "listening") {
        this.updateRecordingTooltip("no speech");
      } else if (this.currentState === "active") {
        this.updateRecordingTooltip("speech detected");
      }
    }, 1000);
  }

  /**
   * Stop the tooltip update timer
   */
  private stopTooltipTimer(): void {
    if (this.tooltipTimer) {
      clearInterval(this.tooltipTimer);
      this.tooltipTimer = null;
    }
  }
}
