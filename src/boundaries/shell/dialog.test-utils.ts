/**
 * Test utilities for DialogBoundary.
 * Provides behavioral mock for testing dialog operations without Electron.
 */

import type {
  DialogBoundary,
  ShowDialogOptions,
  ShowDialogResult,
  DialogMessageBoxOptions,
  MessageBoxResult,
} from "./dialog";
import { Path } from "../../utils/path/path";

// ============================================================================
// Types
// ============================================================================

/**
 * Configured response for a file dialog.
 */
export interface ShowDialogResponse {
  readonly canceled: boolean;
  /** File paths as strings (will be converted to Path objects) */
  readonly filePaths: readonly string[];
}

/**
 * Configured response for message box.
 */
export interface MessageBoxResponse {
  readonly response: number;
  readonly checkboxChecked?: boolean;
}

/**
 * Call record for dialog operations.
 */
export interface DialogCall {
  readonly method: "showDialog" | "showMessageBox" | "showErrorBox";
  readonly options?: ShowDialogOptions | DialogMessageBoxOptions;
  readonly title?: string;
  readonly content?: string;
}

/**
 * State of the DialogBoundary behavioral mock.
 */
export interface DialogBoundaryState {
  /** All dialog calls in order */
  readonly calls: readonly DialogCall[];
  /** Count of showDialog calls */
  readonly openDialogCount: number;
  /** Count of showMessageBox calls */
  readonly messageBoxCount: number;
  /** Count of showErrorBox calls */
  readonly errorBoxCount: number;
}

/**
 * Extended DialogBoundary interface with state inspection and response configuration.
 */
export interface BehavioralDialogBoundary extends DialogBoundary {
  /**
   * Get internal state for test assertions.
   */
  _getState(): DialogBoundaryState;

  /**
   * Set the next response for showDialog.
   * @param response - Response to return (used once, then returns to default)
   */
  _setNextOpenDialogResponse(response: ShowDialogResponse): void;

  /**
   * Set the next response for showMessageBox.
   * @param response - Response to return (used once, then returns to default)
   */
  _setNextMessageBoxResponse(response: MessageBoxResponse): void;

  /**
   * Reset all state (calls and pending responses).
   */
  _reset(): void;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a behavioral mock of DialogBoundary for testing.
 *
 * By default, dialogs return canceled state. Use `_setNextResponse()` methods
 * to configure specific responses for the next dialog call.
 *
 * @example Basic usage - verify dialog was shown
 * ```typescript
 * const dialogLayer = createBehavioralDialogBoundary();
 * await dialogLayer.showDialog({ properties: ["openDirectory"] });
 *
 * const state = dialogLayer._getState();
 * expect(state.openDialogCount).toBe(1);
 * expect(state.calls[0].method).toBe("showDialog");
 * ```
 *
 * @example Configure response
 * ```typescript
 * const dialogLayer = createBehavioralDialogBoundary();
 * dialogLayer._setNextOpenDialogResponse({
 *   canceled: false,
 *   filePaths: ["/path/to/folder"],
 * });
 *
 * const result = await dialogLayer.showDialog({ properties: ["openDirectory"] });
 * expect(result.canceled).toBe(false);
 * expect(result.filePaths[0].toString()).toBe("/path/to/folder");
 * ```
 */
export function createBehavioralDialogBoundary(): BehavioralDialogBoundary {
  // State tracking
  const calls: DialogCall[] = [];
  let openDialogCount = 0;
  let messageBoxCount = 0;
  let errorBoxCount = 0;

  // Pending responses (used once then cleared)
  let nextOpenDialogResponse: ShowDialogResponse | null = null;
  let nextMessageBoxResponse: MessageBoxResponse | null = null;

  return {
    async showDialog(options: ShowDialogOptions): Promise<ShowDialogResult> {
      calls.push({ method: "showDialog", options });
      openDialogCount++;

      // Use configured response or default to canceled
      const response = nextOpenDialogResponse ?? { canceled: true, filePaths: [] };
      nextOpenDialogResponse = null;

      return {
        canceled: response.canceled,
        filePaths: response.filePaths.map((p) => new Path(p)),
      };
    },

    async showMessageBox(options: DialogMessageBoxOptions): Promise<MessageBoxResult> {
      calls.push({ method: "showMessageBox", options });
      messageBoxCount++;

      // Use configured response or default to first button (index 0)
      const response = nextMessageBoxResponse ?? { response: 0 };
      nextMessageBoxResponse = null;

      return {
        response: response.response,
        checkboxChecked: response.checkboxChecked ?? false,
      };
    },

    showErrorBox(title: string, content: string): void {
      calls.push({ method: "showErrorBox", title, content });
      errorBoxCount++;
    },

    _getState(): DialogBoundaryState {
      return {
        calls: [...calls],
        openDialogCount,
        messageBoxCount,
        errorBoxCount,
      };
    },

    _setNextOpenDialogResponse(response: ShowDialogResponse): void {
      nextOpenDialogResponse = response;
    },

    _setNextMessageBoxResponse(response: MessageBoxResponse): void {
      nextMessageBoxResponse = response;
    },

    _reset(): void {
      calls.length = 0;
      openDialogCount = 0;
      messageBoxCount = 0;
      errorBoxCount = 0;
      nextOpenDialogResponse = null;
      nextMessageBoxResponse = null;
    },
  };
}
