/**
 * Barrel export for IPC modules.
 */

// Log handlers (registered early in bootstrap, before startServices)
export { registerLogHandlers } from "./log-handlers";

// Event wiring and utilities (still used by index.ts)
export { wireApiEvents, formatWindowTitle } from "./api-handlers";
