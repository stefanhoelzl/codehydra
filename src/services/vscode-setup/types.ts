/**
 * Types for VS Code setup service.
 */

// Re-export ProcessRunner from platform/process.
// VscodeSetupService now uses the SpawnedProcess pattern via .wait().
export type { ProcessRunner, ProcessResult } from "../platform/process";

/**
 * Current version of the setup process.
 * Increment when setup steps change to force re-setup on existing installs.
 *
 * Version history:
 * - v6: Added binary download phase (code-server + opencode) before extension installation
 */
export const CURRENT_SETUP_VERSION = 6;

/**
 * Setup steps for progress tracking.
 */
export type SetupStep = "binary-download" | "extensions" | "config" | "finalize";

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
 * New marker file content indicating setup completion (schemaVersion 1+).
 */
export interface SetupMarker {
  /** Schema version of the marker file. Only changes for marker format changes. */
  readonly schemaVersion: number;
  /** ISO timestamp when setup completed */
  readonly completedAt: string;
}

/**
 * Error information for failed setup.
 */
export interface SetupError {
  readonly type:
    | "network"
    | "binary-not-found"
    | "permission"
    | "disk-full"
    | "missing-assets"
    | "unknown";
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
 * Configuration for a bundled extension in extensions.json.
 */
export interface BundledExtensionConfig {
  /** Extension ID in publisher.name format (e.g., "codehydra.codehydra") */
  readonly id: string;
  /** Extension version (e.g., "0.0.1") */
  readonly version: string;
  /** VSIX filename (e.g., "codehydra-0.0.1.vsix") */
  readonly vsix: string;
}

/**
 * Structure of extensions.json asset file.
 */
export interface ExtensionsConfig {
  /** Marketplace extension IDs (e.g., "sst-dev.opencode") */
  readonly marketplace: readonly string[];
  /** Bundled extensions with version info for preflight checks */
  readonly bundled: readonly BundledExtensionConfig[];
}

/** Validation result for ExtensionsConfig - success case with strongly typed config */
export interface ExtensionsConfigValidationSuccess {
  readonly isValid: true;
  readonly config: ExtensionsConfig;
}

/** Validation result for ExtensionsConfig - failure case with error message */
export interface ExtensionsConfigValidationFailure {
  readonly isValid: false;
  readonly error: string;
}

/** Discriminated union for ExtensionsConfig validation result */
export type ExtensionsConfigValidationResult =
  | ExtensionsConfigValidationSuccess
  | ExtensionsConfigValidationFailure;

/**
 * Type guard to validate ExtensionsConfig format.
 * @param value Value to validate
 * @returns Discriminated union with isValid flag - success includes typed config, failure includes error message
 */
export function validateExtensionsConfig(value: unknown): ExtensionsConfigValidationResult {
  if (typeof value !== "object" || value === null) {
    return { isValid: false, error: "extensions.json must be an object" };
  }

  const obj = value as Record<string, unknown>;

  // Validate marketplace field
  if (!Array.isArray(obj.marketplace)) {
    return { isValid: false, error: "extensions.json must have a 'marketplace' array" };
  }
  const marketplace: string[] = [];
  for (const item of obj.marketplace) {
    if (typeof item !== "string") {
      return { isValid: false, error: "marketplace items must be strings" };
    }
    marketplace.push(item);
  }

  // Validate bundled field
  if (!Array.isArray(obj.bundled)) {
    return { isValid: false, error: "extensions.json must have a 'bundled' array" };
  }
  const bundled: BundledExtensionConfig[] = [];
  for (let i = 0; i < obj.bundled.length; i++) {
    const item = obj.bundled[i];
    if (typeof item === "string") {
      return {
        isValid: false,
        error:
          `bundled[${i}] is a string but should be an object with { id, version, vsix }. ` +
          `Found: "${item}". ` +
          `Please update extensions.json to use the new format.`,
      };
    }
    if (typeof item !== "object" || item === null) {
      return {
        isValid: false,
        error: `bundled[${i}] must be an object with { id, version, vsix }`,
      };
    }
    const ext = item as Record<string, unknown>;
    if (typeof ext.id !== "string" || !ext.id) {
      return { isValid: false, error: `bundled[${i}].id must be a non-empty string` };
    }
    if (typeof ext.version !== "string" || !ext.version) {
      return { isValid: false, error: `bundled[${i}].version must be a non-empty string` };
    }
    if (typeof ext.vsix !== "string" || !ext.vsix) {
      return { isValid: false, error: `bundled[${i}].vsix must be a non-empty string` };
    }
    bundled.push({ id: ext.id, version: ext.version, vsix: ext.vsix });
  }

  // Return validated config with properly typed arrays (no type assertion needed)
  return { isValid: true, config: { marketplace, bundled } };
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
   * Run preflight checks to determine what needs to be installed/updated.
   *
   * This is a read-only operation that checks:
   * - Binary versions (code-server, opencode)
   * - Installed extension versions
   * - Setup marker validity
   *
   * @returns PreflightResult indicating what components need setup
   */
  preflight(): Promise<PreflightResult>;

  /**
   * Run the full setup process.
   * @param preflightResult Preflight result indicating what components need setup
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure with error details
   */
  setup(preflightResult: PreflightResult, onProgress?: ProgressCallback): Promise<SetupResult>;

  /**
   * Remove the vscode directory to prepare for fresh setup.
   * Safe to call if directory doesn't exist.
   */
  cleanVscodeDir(): Promise<void>;

  /**
   * Remove specific extension directories before reinstallation.
   * @param extensionIds Extension IDs to clean (e.g., "codehydra.codehydra")
   */
  cleanComponents(extensionIds: readonly string[]): Promise<void>;
}

// ============================================================================
// Preflight Types
// ============================================================================

/** Binary types that can be checked by preflight */
export type BinaryType = "code-server" | "opencode";

/** Error types for preflight failures */
export type PreflightErrorType = "filesystem-unreadable" | "unknown";

/** Error information for preflight failures */
export interface PreflightError {
  readonly type: PreflightErrorType;
  readonly message: string;
}

/**
 * Result of preflight checks.
 *
 * Discriminated union that indicates either:
 * - Success: All checks completed, may or may not need setup
 * - Failure: Checks could not be completed due to an error
 */
export type PreflightResult =
  | {
      readonly success: true;
      /** True if any component needs installation/update */
      readonly needsSetup: boolean;
      /** Binary types that are missing or at wrong version */
      readonly missingBinaries: readonly BinaryType[];
      /** Extension IDs that are not installed (any version) */
      readonly missingExtensions: readonly string[];
      /** Extension IDs installed but at wrong version */
      readonly outdatedExtensions: readonly string[];
    }
  | {
      readonly success: false;
      readonly error: PreflightError;
    };

// ============================================================================
// Bin Script Types
// ============================================================================

/** Paths to target binaries for wrapper script generation */
export interface BinTargetPaths {
  /** Path to code-server's remote-cli script (code command) */
  readonly codeRemoteCli: string;
  /** Path to opencode binary, or null if not installed */
  readonly opencodeBinary: string | null;
  /** Path to bundled Node.js from code-server */
  readonly bundledNodePath: string;
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
