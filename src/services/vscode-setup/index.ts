/**
 * VS Code setup service exports.
 */

export {
  type ExtensionsManifest,
  type ExtensionConfig,
  type ExtensionRequirement,
  type ExtensionInstallEntry,
  type BinaryType,
  validateExtensionsManifest,
} from "./types";
export {
  parseExtensionDir,
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "./extension-utils";
