/**
 * Platform layer exports.
 *
 * This module re-exports all platform abstractions for convenient importing.
 * Platform layers abstract OS/runtime-specific operations (IPC, Dialog, Image, App, Menu).
 */

// Error types
export { PlatformError, isPlatformError, isPlatformErrorWithCode } from "./errors";
export type { PlatformErrorCode } from "./errors";

// IPC Layer
export { DefaultIpcLayer } from "./ipc";
export type { IpcLayer, IpcHandler } from "./ipc";

// Image Layer
export { DefaultImageLayer } from "./image";
export type { ImageLayer } from "./image";

// App Layer
export { DefaultAppLayer } from "./app";
export type { AppLayer, AppDock, AppPathName } from "./app";

// Dialog Layer
export { DefaultDialogLayer } from "./dialog";
export type {
  DialogLayer,
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult,
  DialogMessageBoxOptions,
  MessageBoxResult,
  DialogFileFilter,
  OpenDialogProperty,
  SaveDialogProperty,
} from "./dialog";

// Menu Layer
export { DefaultMenuLayer, createMenuHandle } from "./menu";
export type {
  MenuLayer,
  MenuHandle,
  MenuTemplate,
  MenuItemOptions,
  MenuItemRole,
  MenuItemType,
  MenuAccelerator,
} from "./menu";

// Platform types
export { createImageHandle } from "./types";
export type { ImageHandle, ImageSize } from "./types";
