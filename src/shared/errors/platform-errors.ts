/**
 * Platform layer error definitions.
 *
 * These errors are thrown by platform layer implementations (IpcBoundary, DialogBoundary,
 * ImageBoundary, AppBoundary, MenuBoundary) to provide consistent error handling.
 */

/**
 * Error codes for platform operations.
 */
export type PlatformErrorCode =
  // IPC errors
  | "IPC_HANDLER_EXISTS"
  | "IPC_HANDLER_NOT_FOUND"
  // Dialog errors
  | "DIALOG_CANCELLED"
  // Image errors
  | "IMAGE_NOT_FOUND"
  | "IMAGE_LOAD_FAILED"
  // App errors
  | "APP_NOT_READY";

/**
 * Error from platform layer operations.
 *
 * Used by IpcBoundary, DialogBoundary, ImageBoundary, AppBoundary, and MenuBoundary
 * to report errors with consistent typing.
 *
 * @example
 * ```typescript
 * throw new PlatformError("IPC_HANDLER_EXISTS", "Handler already exists for channel: api:test");
 * ```
 */
export class PlatformError extends Error {
  readonly name = "PlatformError";

  constructor(
    /** Error code identifying the type of error */
    readonly code: PlatformErrorCode,
    message: string
  ) {
    super(message);
    // Fix prototype chain for instanceof to work
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
