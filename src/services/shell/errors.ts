/**
 * Shell layer error definitions.
 *
 * These errors are thrown by shell layer implementations (WindowBoundary, ViewBoundary,
 * SessionBoundary) to provide consistent error handling for window/view management.
 */

/**
 * Error codes for shell operations.
 */
export type ShellErrorCode =
  // Window errors
  | "WINDOW_NOT_FOUND"
  | "WINDOW_DESTROYED"
  | "WINDOW_HAS_ATTACHED_VIEWS"
  // View errors
  | "VIEW_NOT_FOUND"
  | "VIEW_DESTROYED"
  // Session errors
  | "SESSION_NOT_FOUND"
  // Navigation errors
  | "NAVIGATION_FAILED";

/**
 * Error from shell layer operations.
 *
 * Used by WindowBoundary, ViewBoundary, and SessionBoundary to report errors with
 * consistent typing. Includes a `handle` property for error context.
 *
 * @example
 * ```typescript
 * throw new ShellError("WINDOW_NOT_FOUND", "Window window-1 not found", "window-1");
 * ```
 */
export class ShellError extends Error {
  readonly name = "ShellError";

  constructor(
    /** Error code identifying the type of error */
    readonly code: ShellErrorCode,
    message: string,
    /** The handle ID associated with this error (for context) */
    readonly handle?: string
  ) {
    super(message);
    // Fix prototype chain for instanceof to work
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Type guard to check if an error is a ShellError.
 */
export function isShellError(error: unknown): error is ShellError {
  return error instanceof ShellError;
}

/**
 * Type guard to check if an error is a ShellError with a specific code.
 */
export function isShellErrorWithCode(error: unknown, code: ShellErrorCode): error is ShellError {
  return isShellError(error) && error.code === code;
}
