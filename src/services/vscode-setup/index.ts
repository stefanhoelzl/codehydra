/**
 * VS Code setup service exports.
 */

export { VscodeSetupService } from "./vscode-setup-service";
export { generateScript, generateScripts } from "./bin-scripts";
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
  type BinTargetPaths,
  type GeneratedScript,
  type ScriptFilename,
} from "./types";
