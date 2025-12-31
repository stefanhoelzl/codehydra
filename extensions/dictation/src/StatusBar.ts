import * as vscode from "vscode";
import type { DictationState } from "./DictationController";
import { isConfigured, getConfig } from "./config";
import { COMMANDS } from "./commands";

/**
 * Status bar manager for dictation
 * Shows icon-only status with tooltip
 */
export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tooltipTimer: ReturnType<typeof setInterval> | null = null;
  private currentState: DictationState = { status: "idle" };

  constructor() {
    // Create status bar item on the right side
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    // Initial update
    this.updateAppearance();

    // Show the status bar item
    this.statusBarItem.show();
  }

  /**
   * Update the status bar based on dictation state
   */
  update(state: DictationState): void {
    this.currentState = state;
    this.updateAppearance();

    // Start/stop tooltip timer for recording state
    if (state.status === "recording") {
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
    this.statusBarItem.dispose();
  }

  /**
   * Update the status bar appearance based on current state
   */
  private updateAppearance(): void {
    const configured = isConfigured();

    if (!configured) {
      // Unconfigured state
      this.statusBarItem.text = "$(mic)";
      this.statusBarItem.tooltip = "Dictation: Not configured. Click to open settings.";
      this.statusBarItem.command = "workbench.action.openSettings";
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    switch (this.currentState.status) {
      case "idle":
        this.statusBarItem.text = "$(mic)";
        this.statusBarItem.tooltip = "Dictation: Click to start (Ctrl+Alt+D)";
        this.statusBarItem.command = COMMANDS.TOGGLE;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "starting":
        this.statusBarItem.text = "$(loading~spin)";
        this.statusBarItem.tooltip = "Dictation: Connecting...";
        this.statusBarItem.command = undefined;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "recording":
        this.statusBarItem.text = "$(mic-filled)";
        this.updateRecordingTooltip();
        this.statusBarItem.command = COMMANDS.TOGGLE;
        // Use warning background for visibility
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        break;

      case "stopping":
        this.statusBarItem.text = "$(loading~spin)";
        this.statusBarItem.tooltip = "Dictation: Stopping...";
        this.statusBarItem.command = undefined;
        this.statusBarItem.backgroundColor = undefined;
        break;
    }
  }

  /**
   * Update the tooltip for recording state with elapsed/remaining time
   */
  private updateRecordingTooltip(): void {
    if (this.currentState.status !== "recording") {
      return;
    }

    const config = getConfig();
    const elapsed = Math.floor((Date.now() - this.currentState.startTime) / 1000);
    const maxDuration = config.maxDuration;

    this.statusBarItem.tooltip = `Dictation: Recording (${elapsed}s / ${maxDuration}s)`;
  }

  /**
   * Start the timer to update tooltip every second
   */
  private startTooltipTimer(): void {
    this.stopTooltipTimer();
    this.tooltipTimer = setInterval(() => {
      this.updateRecordingTooltip();
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
