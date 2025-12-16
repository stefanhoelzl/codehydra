/**
 * Types for VS Code setup service.
 */

// Re-export ProcessRunner from platform/process.
// VscodeSetupService now uses the SpawnedProcess pattern via .wait().
export type { ProcessRunner, ProcessResult } from "../platform/process";

/**
 * Current version of the setup process.
 * Increment when setup steps change to force re-setup on existing installs.
 */
export const CURRENT_SETUP_VERSION = 4;

/**
 * Setup steps for progress tracking.
 */
export type SetupStep = "extensions" | "config" | "finalize";

/**
 * Progress information for setup UI updates.
 */
export interface SetupProgress {
  readonly step: SetupStep;
  readonly message: string;
}

/**
 * Callback for receiving setup progress updates.
 */
export type ProgressCallback = (progress: SetupProgress) => void;

/**
 * Marker file content indicating setup completion.
 */
export interface SetupMarker {
  readonly version: number;
  readonly completedAt: string;
}

/**
 * Error types for setup failures.
 */
export type SetupErrorType =
  | "network"
  | "binary-not-found"
  | "permission"
  | "disk-full"
  | "missing-assets"
  | "unknown";

/**
 * Error information for failed setup.
 */
export interface SetupError {
  readonly type: SetupErrorType;
  readonly message: string;
  readonly code?: string;
}

/**
 * Result of a setup operation (discriminated union).
 */
export type SetupResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: SetupError };

/**
 * Structure of extensions.json asset file.
 */
export interface ExtensionsConfig {
  /** Marketplace extension IDs (e.g., "sst-dev.opencode") */
  readonly marketplace: readonly string[];
  /** Bundled .vsix filenames (e.g., "codehydra.vscode-0.0.1.vsix") */
  readonly bundled: readonly string[];
}

/**
 * Interface for VS Code setup service.
 */
export interface IVscodeSetup {
  /**
   * Check if setup has been completed with the current version.
   * @returns true if setup is complete and version matches
   */
  isSetupComplete(): Promise<boolean>;

  /**
   * Run the full setup process.
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure with error details
   */
  setup(onProgress?: ProgressCallback): Promise<SetupResult>;

  /**
   * Remove the vscode directory to prepare for fresh setup.
   * Safe to call if directory doesn't exist.
   */
  cleanVscodeDir(): Promise<void>;
}

// ============================================================================
// Bin Script Types
// ============================================================================

/** Paths to target binaries for wrapper script generation */
export interface BinTargetPaths {
  /** Path to code-server's remote-cli script (code command) */
  readonly codeRemoteCli: string;
  /** Path to opencode binary, or null if not installed */
  readonly opencodeBinary: string | null;
}

/** Branded type for script filenames */
export type ScriptFilename = string & { readonly __brand: "ScriptFilename" };

/** A generated wrapper script ready to write to disk */
export interface GeneratedScript {
  /** Filename without path (e.g., "code", "code.cmd") */
  readonly filename: ScriptFilename;
  /** Full script content */
  readonly content: string;
  /** Whether script needs executable permission (Unix only) */
  readonly needsExecutable: boolean;
}
