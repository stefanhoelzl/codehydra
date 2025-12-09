/**
 * VS Code setup service exports.
 */

export { VscodeSetupService } from "./vscode-setup-service";
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
} from "./types";
