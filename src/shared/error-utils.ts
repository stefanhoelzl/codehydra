/**
 * Shared error utilities for CodeHydra.
 * Used by both main process (services) and renderer process.
 */

import type { SerializedError } from "../intents/contract";

/** Guard against a self-referential `cause` chain looping forever. */
const MAX_CAUSE_DEPTH = 8;

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

/**
 * Reduce a thrown value to plain, serializable data.
 *
 * An `Error` is a class instance and cannot cross a backend tunnel, so nothing on the intent
 * contract carries one. This is the conversion producers apply before putting a failure on a
 * hook context or event payload.
 *
 * Non-Error values are coerced (`String(value)` as the message) rather than rejected — a
 * `throw "boom"` still has to be reportable. The `cause` chain is followed to a bounded depth
 * so a cyclic cause can't hang the conversion.
 */
export function toSerializedError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const cause =
    depth < MAX_CAUSE_DEPTH && error.cause !== undefined && error.cause !== null
      ? toSerializedError(error.cause, depth + 1)
      : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack !== undefined && { stack: error.stack }),
    ...(cause !== undefined && { cause }),
  };
}

/**
 * Rebuild an `Error` from its serialized form, for consumers that need a real one — the
 * telemetry boundary reads `name`/`message`/`stack` off the instance to group issues.
 *
 * `name` is assigned explicitly: `new Error()` would report `"Error"`, which would file a
 * `TypeError` under a different issue than it lands in today.
 */
export function fromSerializedError(error: SerializedError): Error {
  const rebuilt = new Error(error.message, {
    ...(error.cause !== undefined && { cause: fromSerializedError(error.cause) }),
  });
  rebuilt.name = error.name;
  if (error.stack !== undefined) rebuilt.stack = error.stack;
  return rebuilt;
}
