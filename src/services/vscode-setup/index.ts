/**
 * VS Code setup service exports.
 */

export { VscodeSetupService } from "./vscode-setup-service";
export { generateOpencodeConfigContent } from "./bin-scripts";
export {
  CURRENT_SETUP_VERSION,
  type IVscodeSetup,
  type SetupResult,
  type SetupError,
  type SetupStep,
  type SetupProgress,
  type ProgressCallback,
  type SetupMarker,
  type ProcessRunner,
  type ProcessResult,
  type ExtensionsManifest,
  type ExtensionConfig,
  type PreflightResult,
  type PreflightError,
  type PreflightErrorType,
  type BinaryType,
  validateExtensionsManifest,
} from "./types";
export {
  parseExtensionDir,
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "./extension-utils";
