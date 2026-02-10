/**
 * VS Code setup service exports.
 */

export {
  type ExtensionsManifest,
  type ExtensionConfig,
  type BinaryType,
  validateExtensionsManifest,
} from "./types";
export {
  parseExtensionDir,
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "./extension-utils";

// Extension manager
export type {
  ExtensionPreflightResult,
  ExtensionPreflightError,
  ExtensionProgressCallback,
} from "./extension-manager";
export { ExtensionManager } from "./extension-manager";
