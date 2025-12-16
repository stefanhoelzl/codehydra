/**
 * Barrel export for IPC modules.
 */

// Lifecycle handlers (registered early in bootstrap, before startServices)
export { registerLifecycleHandlers } from "./lifecycle-handlers";

// API handlers (registered in startServices via CodeHydraApiImpl)
export { registerApiHandlers, wireApiEvents, formatWindowTitle } from "./api-handlers";

// Types
export type { TitleConfig } from "./api-handlers";
