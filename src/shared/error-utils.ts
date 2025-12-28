/**
 * Shared error utilities for CodeHydra.
 * Used by both main process (services) and renderer process.
 */

/**
 * Extract a message string from an unknown error.
 * Handles Error instances, strings, and other types.
 *
 * @param error - The error to extract a message from
 * @returns The error message as a string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
