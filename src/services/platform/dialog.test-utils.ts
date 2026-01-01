/**
 * Test utilities for DialogLayer.
 * Provides behavioral mock for testing dialog operations without Electron.
 */

import type {
  DialogLayer,
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult,
  DialogMessageBoxOptions,
  MessageBoxResult,
} from "./dialog";
import { Path } from "./path";

// ============================================================================
// Types
// ============================================================================

/**
 * Configured response for open dialog.
 */
export interface OpenDialogResponse {
  readonly canceled: boolean;
  /** File paths as strings (will be converted to Path objects) */
  readonly filePaths: readonly string[];
}

/**
 * Configured response for save dialog.
 */
export interface SaveDialogResponse {
  readonly canceled: boolean;
  /** File path as string (will be converted to Path object), undefined if canceled */
  readonly filePath?: string;
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
  readonly method: "showOpenDialog" | "showSaveDialog" | "showMessageBox" | "showErrorBox";
  readonly options?: OpenDialogOptions | SaveDialogOptions | DialogMessageBoxOptions;
  readonly title?: string;
  readonly content?: string;
}

/**
 * State of the DialogLayer behavioral mock.
 */
export interface DialogLayerState {
  /** All dialog calls in order */
  readonly calls: readonly DialogCall[];
  /** Count of showOpenDialog calls */
  readonly openDialogCount: number;
  /** Count of showSaveDialog calls */
  readonly saveDialogCount: number;
  /** Count of showMessageBox calls */
  readonly messageBoxCount: number;
  /** Count of showErrorBox calls */
  readonly errorBoxCount: number;
}

/**
 * Extended DialogLayer interface with state inspection and response configuration.
 */
export interface BehavioralDialogLayer extends DialogLayer {
  /**
   * Get internal state for test assertions.
   */
  _getState(): DialogLayerState;

  /**
   * Set the next response for showOpenDialog.
   * @param response - Response to return (used once, then returns to default)
   */
  _setNextOpenDialogResponse(response: OpenDialogResponse): void;

  /**
   * Set the next response for showSaveDialog.
   * @param response - Response to return (used once, then returns to default)
   */
  _setNextSaveDialogResponse(response: SaveDialogResponse): void;

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
 * Creates a behavioral mock of DialogLayer for testing.
 *
 * By default, dialogs return canceled state. Use `_setNextResponse()` methods
 * to configure specific responses for the next dialog call.
 *
 * @example Basic usage - verify dialog was shown
 * ```typescript
 * const dialogLayer = createBehavioralDialogLayer();
 * await dialogLayer.showOpenDialog({ properties: ["openDirectory"] });
 *
 * const state = dialogLayer._getState();
 * expect(state.openDialogCount).toBe(1);
 * expect(state.calls[0].method).toBe("showOpenDialog");
 * ```
 *
 * @example Configure response
 * ```typescript
 * const dialogLayer = createBehavioralDialogLayer();
 * dialogLayer._setNextOpenDialogResponse({
 *   canceled: false,
 *   filePaths: ["/path/to/folder"],
 * });
 *
 * const result = await dialogLayer.showOpenDialog({ properties: ["openDirectory"] });
 * expect(result.canceled).toBe(false);
 * expect(result.filePaths[0].toString()).toBe("/path/to/folder");
 * ```
 */
export function createBehavioralDialogLayer(): BehavioralDialogLayer {
  // State tracking
  const calls: DialogCall[] = [];
  let openDialogCount = 0;
  let saveDialogCount = 0;
  let messageBoxCount = 0;
  let errorBoxCount = 0;

  // Pending responses (used once then cleared)
  let nextOpenDialogResponse: OpenDialogResponse | null = null;
  let nextSaveDialogResponse: SaveDialogResponse | null = null;
  let nextMessageBoxResponse: MessageBoxResponse | null = null;

  return {
    async showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult> {
      calls.push({ method: "showOpenDialog", options });
      openDialogCount++;

      // Use configured response or default to canceled
      const response = nextOpenDialogResponse ?? { canceled: true, filePaths: [] };
      nextOpenDialogResponse = null;

      return {
        canceled: response.canceled,
        filePaths: response.filePaths.map((p) => new Path(p)),
      };
    },

    async showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult> {
      calls.push({ method: "showSaveDialog", options });
      saveDialogCount++;

      // Use configured response or default to canceled
      const response = nextSaveDialogResponse ?? { canceled: true };
      nextSaveDialogResponse = null;

      return {
        canceled: response.canceled,
        filePath: response.filePath ? new Path(response.filePath) : undefined,
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

    _getState(): DialogLayerState {
      return {
        calls: [...calls],
        openDialogCount,
        saveDialogCount,
        messageBoxCount,
        errorBoxCount,
      };
    },

    _setNextOpenDialogResponse(response: OpenDialogResponse): void {
      nextOpenDialogResponse = response;
    },

    _setNextSaveDialogResponse(response: SaveDialogResponse): void {
      nextSaveDialogResponse = response;
    },

    _setNextMessageBoxResponse(response: MessageBoxResponse): void {
      nextMessageBoxResponse = response;
    },

    _reset(): void {
      calls.length = 0;
      openDialogCount = 0;
      saveDialogCount = 0;
      messageBoxCount = 0;
      errorBoxCount = 0;
      nextOpenDialogResponse = null;
      nextSaveDialogResponse = null;
      nextMessageBoxResponse = null;
    },
  };
}
