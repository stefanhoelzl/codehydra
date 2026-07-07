/**
 * Shared error utilities for CodeHydra.
 * Used by both main process (services) and renderer process.
 */

/**
 * Extract a message string from an unknown error.
 * Handles Error instances, strings, and other types.
 *
 * @param error - The error to extract a message from
 * @param fallback - Message to use when `error` is not an Error instance.
 *   Defaults to `String(error)`.
 * @returns The error message as a string
 */
export function getErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback ?? String(error);
}

/**
 * True when `error` is a Node "no such file or directory" (ENOENT) error.
 * Used to distinguish "file doesn't exist yet" from real read failures.
 */
export function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
