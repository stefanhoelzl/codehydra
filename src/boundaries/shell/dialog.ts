/**
 * DialogBoundary - Abstraction over Electron's dialog module.
 *
 * Provides an injectable interface for dialog operations, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron dialog
 * - Normalized path handling via Path class
 */

import { Path } from "../../utils/path/path";
import type { Logger } from "../platform/logging";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for a native file dialog.
 *
 * `mode` selects the underlying Electron dialog: "open" (default) maps to
 * `dialog.showOpenDialog` (pick existing files/directories); "save" maps to
 * `dialog.showSaveDialog` (name a file that may not exist yet — the only
 * cross-platform way to let the user create a new file). `properties` apply to
 * open mode only.
 */
export interface ShowDialogOptions {
  /** Which native dialog to show. Defaults to "open". */
  readonly mode?: "open" | "save";
  /** Title of the dialog window */
  readonly title?: string;
  /** Default path to open dialog at */
  readonly defaultPath?: string;
  /** Button label for the confirm button */
  readonly buttonLabel?: string;
  /** Filter files by type */
  readonly filters?: readonly DialogFileFilter[];
  /** Dialog behavior properties (open mode only) */
  readonly properties?: readonly OpenDialogProperty[];
  /** Message to show above input boxes (macOS only) */
  readonly message?: string;
}

/**
 * File filter for dialog file type filtering.
 */
export interface DialogFileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

/**
 * Properties that control open dialog behavior.
 */
export type OpenDialogProperty =
  | "openFile"
  | "openDirectory"
  | "multiSelections"
  | "showHiddenFiles"
  | "createDirectory"
  | "promptToCreate"
  | "noResolveAliases"
  | "treatPackageAsDirectory"
  | "dontAddToRecent";

/**
 * Result from a file dialog.
 *
 * Unified across open and save modes: save mode yields a single chosen path (or
 * none when canceled), surfaced as a 0-or-1 element `filePaths` array so callers
 * read the result the same way regardless of mode.
 */
export interface ShowDialogResult {
  /** Whether the dialog was canceled */
  readonly canceled: boolean;
  /** Selected file paths (as Path objects for normalized handling) */
  readonly filePaths: readonly Path[];
}

/**
 * Options for message box dialogs.
 */
export interface DialogMessageBoxOptions {
  /** Type of message box icon */
  readonly type?: "none" | "info" | "error" | "question" | "warning";
  /** Array of button labels */
  readonly buttons?: readonly string[];
  /** Index of default button */
  readonly defaultId?: number;
  /** Title of the message box */
  readonly title?: string;
  /** Main content of the message box */
  readonly message: string;
  /** Extra information below the message */
  readonly detail?: string;
  /** Index of button to trigger on Escape */
  readonly cancelId?: number;
  /** Whether to not display the message box until user moves mouse (macOS only) */
  readonly noLink?: boolean;
}

/**
 * Result from a message box dialog.
 */
export interface MessageBoxResult {
  /** Index of clicked button */
  readonly response: number;
  /** Whether checkbox was checked (if checkbox was shown) */
  readonly checkboxChecked: boolean;
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's dialog module.
 *
 * Returns Path objects for file paths to ensure consistent normalized path handling.
 */
export interface DialogBoundary {
  /**
   * Show a native file dialog. `options.mode` selects open (pick existing) or
   * save (name a possibly-new file); defaults to open.
   *
   * @param options - Dialog options
   * @returns Result with selected paths as Path objects
   */
  showDialog(options: ShowDialogOptions): Promise<ShowDialogResult>;

  /**
   * Show a message box dialog.
   *
   * @param options - Message box options
   * @returns Result with button response
   */
  showMessageBox(options: DialogMessageBoxOptions): Promise<MessageBoxResult>;

  /**
   * Show a synchronous error dialog.
   * This is a blocking call that should only be used for fatal errors
   * before the app is fully initialized.
   *
   * @param title - Error title
   * @param content - Error content/message
   */
  showErrorBox(title: string, content: string): void;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { dialog } from "electron";

/**
 * Helper to build Electron dialog options, excluding undefined values.
 * This satisfies exactOptionalPropertyTypes requirements.
 */
/** Copy the fields common to open and save dialogs onto the target options. */
function applyCommonDialogOptions(
  result: Electron.OpenDialogOptions | Electron.SaveDialogOptions,
  options: ShowDialogOptions
): void {
  if (options.title !== undefined) result.title = options.title;
  if (options.defaultPath !== undefined) result.defaultPath = options.defaultPath;
  if (options.buttonLabel !== undefined) result.buttonLabel = options.buttonLabel;
  if (options.message !== undefined) result.message = options.message;
  if (options.filters !== undefined) {
    result.filters = options.filters.map((f) => ({
      name: f.name,
      extensions: [...f.extensions],
    }));
  }
}

function buildOpenDialogOptions(options: ShowDialogOptions): Electron.OpenDialogOptions {
  const result: Electron.OpenDialogOptions = {};
  applyCommonDialogOptions(result, options);
  if (options.properties !== undefined) {
    result.properties = [...options.properties];
  }
  return result;
}

function buildSaveDialogOptions(options: ShowDialogOptions): Electron.SaveDialogOptions {
  const result: Electron.SaveDialogOptions = {};
  applyCommonDialogOptions(result, options);
  return result;
}

function buildMessageBoxOptions(options: DialogMessageBoxOptions): Electron.MessageBoxOptions {
  const result: Electron.MessageBoxOptions = {
    message: options.message,
  };
  if (options.type !== undefined) result.type = options.type;
  if (options.title !== undefined) result.title = options.title;
  if (options.detail !== undefined) result.detail = options.detail;
  if (options.defaultId !== undefined) result.defaultId = options.defaultId;
  if (options.cancelId !== undefined) result.cancelId = options.cancelId;
  if (options.noLink !== undefined) result.noLink = options.noLink;
  if (options.buttons !== undefined) {
    result.buttons = [...options.buttons];
  }
  return result;
}

/**
 * Default implementation of DialogBoundary using Electron's dialog module.
 */
export class DefaultDialogBoundary implements DialogBoundary {
  constructor(private readonly logger: Logger) {}

  async showDialog(options: ShowDialogOptions): Promise<ShowDialogResult> {
    const mode = options.mode ?? "open";
    this.logger.debug("Showing dialog", { mode, title: options.title ?? null });

    if (mode === "save") {
      const result = await dialog.showSaveDialog(buildSaveDialogOptions(options));
      this.logger.debug("Save dialog result", {
        canceled: result.canceled,
        hasPath: result.filePath !== undefined,
      });
      return {
        canceled: result.canceled,
        filePaths: result.filePath !== undefined ? [new Path(result.filePath)] : [],
      };
    }

    const result = await dialog.showOpenDialog(buildOpenDialogOptions(options));
    this.logger.debug("Open dialog result", {
      canceled: result.canceled,
      count: result.filePaths.length,
    });
    return {
      canceled: result.canceled,
      filePaths: result.filePaths.map((p) => new Path(p)),
    };
  }

  async showMessageBox(options: DialogMessageBoxOptions): Promise<MessageBoxResult> {
    this.logger.debug("Showing message box", {
      type: options.type ?? null,
      title: options.title ?? null,
    });

    const electronOptions = buildMessageBoxOptions(options);
    const result = await dialog.showMessageBox(electronOptions);

    this.logger.debug("Message box result", { response: result.response });

    return {
      response: result.response,
      checkboxChecked: result.checkboxChecked,
    };
  }

  showErrorBox(title: string, content: string): void {
    this.logger.error("Showing error box", { title, content });
    dialog.showErrorBox(title, content);
  }
}
