/**
 * Shell layer exports.
 *
 * This module re-exports shell abstractions that remain in this directory.
 * Moved items (Window, View, Session layers) are now in src/boundaries/shell/.
 */

// Errors
export { ShellError, isShellError, isShellErrorWithCode, type ShellErrorCode } from "./errors";

// Types
export {
  type WindowHandle,
  type ViewHandle,
  type SessionHandle,
  type Rectangle,
  type WebPreferences,
  createWindowHandle,
  createViewHandle,
  createSessionHandle,
} from "./types";
