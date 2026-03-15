/**
 * Platform layer exports.
 *
 * This module re-exports platform abstractions that remain in this directory.
 * Moved items are now in src/boundaries/.
 */

// Async Watcher
export { AsyncWatcher } from "./async-watcher";

// Error types
export { PlatformError, isPlatformError, isPlatformErrorWithCode } from "./errors";
export type { PlatformErrorCode } from "./errors";

// Platform types
export { createImageHandle } from "./types";
export type { ImageHandle, ImageSize } from "./types";
