/**
 * DialogLayer - Abstraction over Electron's dialog module.
 *
 * Provides an injectable interface for dialog operations, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron dialog
 * - Normalized path handling via Path class
 */

import { Path } from "./path";
import type { Logger } from "../logging";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for open file/directory dialogs.
 */
export interface OpenDialogOptions {
  /** Title of the dialog window */
  readonly title?: string;
  /** Default path to open dialog at */
  readonly defaultPath?: string;
  /** Button label for the confirm button */
  readonly buttonLabel?: string;
  /** Filter files by type */
  readonly filters?: readonly DialogFileFilter[];
  /** Dialog behavior properties */
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
 * Result from an open dialog.
 */
export interface OpenDialogResult {
  /** Whether the dialog was canceled */
  readonly canceled: boolean;
  /** Selected file paths (as Path objects for normalized handling) */
  readonly filePaths: readonly Path[];
}

/**
 * Options for save file dialogs.
 */
export interface SaveDialogOptions {
  /** Title of the dialog window */
  readonly title?: string;
  /** Default path/filename to save as */
  readonly defaultPath?: string;
  /** Button label for the confirm button */
  readonly buttonLabel?: string;
  /** Filter files by type */
  readonly filters?: readonly DialogFileFilter[];
  /** Message to show above input boxes (macOS only) */
  readonly message?: string;
  /** Custom label for file name text box (macOS only) */
  readonly nameFieldLabel?: string;
  /** Show tags input box (macOS only) */
  readonly showsTagField?: boolean;
  /** Dialog behavior properties */
  readonly properties?: readonly SaveDialogProperty[];
}

/**
 * Properties that control save dialog behavior.
 */
export type SaveDialogProperty =
  | "showHiddenFiles"
  | "createDirectory"
  | "treatPackageAsDirectory"
  | "showOverwriteConfirmation"
  | "dontAddToRecent";

/**
 * Result from a save dialog.
 */
export interface SaveDialogResult {
  /** Whether the dialog was canceled */
  readonly canceled: boolean;
  /** Selected file path (as Path object), undefined if canceled */
  readonly filePath: Path | undefined;
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
export interface DialogLayer {
  /**
   * Show an open file/directory dialog.
   *
   * @param options - Dialog options
   * @returns Result with selected paths as Path objects
   */
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;

  /**
   * Show a save file dialog.
   *
   * @param options - Dialog options
   * @returns Result with selected path as Path object
   */
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;

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
function buildOpenDialogOptions(options: OpenDialogOptions): Electron.OpenDialogOptions {
  const result: Electron.OpenDialogOptions = {};
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
  if (options.properties !== undefined) {
    result.properties = [...options.properties];
  }
  return result;
}

function buildSaveDialogOptions(options: SaveDialogOptions): Electron.SaveDialogOptions {
  const result: Electron.SaveDialogOptions = {};
  if (options.title !== undefined) result.title = options.title;
  if (options.defaultPath !== undefined) result.defaultPath = options.defaultPath;
  if (options.buttonLabel !== undefined) result.buttonLabel = options.buttonLabel;
  if (options.message !== undefined) result.message = options.message;
  if (options.nameFieldLabel !== undefined) result.nameFieldLabel = options.nameFieldLabel;
  if (options.showsTagField !== undefined) result.showsTagField = options.showsTagField;
  if (options.filters !== undefined) {
    result.filters = options.filters.map((f) => ({
      name: f.name,
      extensions: [...f.extensions],
    }));
  }
  if (options.properties !== undefined) {
    result.properties = [...options.properties];
  }
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
 * Default implementation of DialogLayer using Electron's dialog module.
 */
export class DefaultDialogLayer implements DialogLayer {
  constructor(private readonly logger: Logger) {}

  async showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult> {
    this.logger.debug("Showing open dialog", { title: options.title ?? null });

    const electronOptions = buildOpenDialogOptions(options);
    const result = await dialog.showOpenDialog(electronOptions);

    this.logger.debug("Open dialog result", {
      canceled: result.canceled,
      count: result.filePaths.length,
    });

    return {
      canceled: result.canceled,
      filePaths: result.filePaths.map((p) => new Path(p)),
    };
  }

  async showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult> {
    this.logger.debug("Showing save dialog", { title: options.title ?? null });

    const electronOptions = buildSaveDialogOptions(options);
    const result = await dialog.showSaveDialog(electronOptions);

    this.logger.debug("Save dialog result", {
      canceled: result.canceled,
      hasPath: !!result.filePath,
    });

    return {
      canceled: result.canceled,
      filePath: result.filePath ? new Path(result.filePath) : undefined,
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
