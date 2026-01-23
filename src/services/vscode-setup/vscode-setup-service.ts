/**
 * VS Code setup service for first-run configuration.
 * Installs extensions and writes configuration files.
 */

// join import removed - no longer needed for bin script generation
import type { PathProvider } from "../platform/path-provider";
import mcpConfigTemplate from "../../agents/opencode/opencode.codehydra.json";
import type { FileSystemLayer } from "../platform/filesystem";
import type { PlatformInfo } from "../platform/platform-info";
import type { Logger } from "../logging/index";
import { Path } from "../platform/path";
import { VscodeSetupError, getErrorMessage } from "../errors";
import {
  type IVscodeSetup,
  type SetupResult,
  type ProgressCallback,
  type SetupMarker,
  type ProcessRunner,
  type PreflightResult,
  type BinaryType,
  validateExtensionsManifest,
} from "./types";

import { listInstalledExtensions, removeFromExtensionsJson } from "./extension-utils";
import type { BinaryDownloadService } from "../binary-download/binary-download-service";
import { CODE_SERVER_VERSION, BINARY_CONFIGS } from "../binary-download/versions";

/**
 * Agent binary type for download operations.
 * Excludes "code-server" since that's handled separately.
 */
type AgentBinaryType = Exclude<BinaryType, "code-server">;

/**
 * Service for managing VS Code setup process.
 */
export class VscodeSetupService implements IVscodeSetup {
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly fs: FileSystemLayer;
  private readonly assetsDir: Path;
  private readonly binaryDownloadService: BinaryDownloadService | null;
  private readonly logger: Logger | undefined;
  private readonly agentBinaryType: AgentBinaryType;

  constructor(
    processRunner: ProcessRunner,
    pathProvider: PathProvider,
    fs: FileSystemLayer,
    _platformInfo?: PlatformInfo, // Kept for backward compatibility, no longer used
    binaryDownloadService?: BinaryDownloadService,
    logger?: Logger,
    _agentExtensionId?: string, // Kept for backward compatibility, no longer used
    agentBinaryType: AgentBinaryType = "opencode"
  ) {
    this.processRunner = processRunner;
    this.pathProvider = pathProvider;
    this.fs = fs;
    this.assetsDir = pathProvider.vscodeAssetsDir;
    this.binaryDownloadService = binaryDownloadService ?? null;
    this.logger = logger;
    this.agentBinaryType = agentBinaryType;
  }

  /**
   * Check if setup has been completed with the current schema version.
   * @returns true if setup is complete and schema version matches
   */
  async isSetupComplete(): Promise<boolean> {
    const marker = await this.readMarker();
    // schemaVersion 2 is the current version; 0 indicates legacy format, 1 was pre-bin-fix
    return marker !== null && marker.schemaVersion === 2;
  }

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
  async preflight(): Promise<PreflightResult> {
    const missingBinaries: BinaryType[] = [];
    const missingExtensions: string[] = [];
    const outdatedExtensions: string[] = [];

    try {
      // Check binaries
      if (this.binaryDownloadService) {
        const codeServerInstalled = await this.binaryDownloadService.isInstalled("code-server");
        if (!codeServerInstalled) {
          missingBinaries.push("code-server");
        }
        // Check for the configured agent binary type (opencode or claude)
        // Skip check for binaries without pinned versions (version: null) - they prefer system binary
        const agentConfig = BINARY_CONFIGS[this.agentBinaryType];
        if (agentConfig.version !== null) {
          const agentInstalled = await this.binaryDownloadService.isInstalled(this.agentBinaryType);
          if (!agentInstalled) {
            missingBinaries.push(this.agentBinaryType);
          }
        }
        // Note: When version is null, the agent prefers system binary.
        // The BinaryResolutionService handles this at runtime.
      }

      // Load extensions manifest
      const configPath = new Path(this.assetsDir, "manifest.json");
      const configContent = await this.fs.readFile(configPath);
      const parsed = JSON.parse(configContent) as unknown;
      const validation = validateExtensionsManifest(parsed);
      if (!validation.isValid) {
        return {
          success: false,
          error: { type: "unknown", message: validation.error },
        };
      }
      const manifest = validation.manifest;

      // List installed extensions
      const installedExtensions = await listInstalledExtensions(
        this.fs,
        this.pathProvider.vscodeExtensionsDir
      );

      // Check all bundled extensions (exact version required)
      for (const ext of manifest) {
        const installedVersion = installedExtensions.get(ext.id);
        if (!installedVersion) {
          missingExtensions.push(ext.id);
        } else if (installedVersion !== ext.version) {
          outdatedExtensions.push(ext.id);
        }
      }

      // Check marker file
      const marker = await this.readMarker();
      const hasValidMarker = marker !== null && marker.schemaVersion === 2;

      const needsSetup =
        missingBinaries.length > 0 ||
        missingExtensions.length > 0 ||
        outdatedExtensions.length > 0 ||
        !hasValidMarker;

      this.logger?.debug("Preflight completed", {
        needsSetup,
        missingBinaries: missingBinaries.join(",") || "none",
        missingExtensions: missingExtensions.join(",") || "none",
        outdatedExtensions: outdatedExtensions.join(",") || "none",
        hasValidMarker,
        markerSchemaVersion: marker?.schemaVersion ?? "none",
      });

      return {
        success: true,
        needsSetup,
        missingBinaries,
        missingExtensions,
        outdatedExtensions,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.warn("Preflight failed", { error: message });
      return {
        success: false,
        error: { type: "filesystem-unreadable", message },
      };
    }
  }

  /**
   * Remove specific extension directories before reinstallation.
   * @param extensionIds Extension IDs to clean (e.g., "codehydra.codehydra")
   */
  async cleanComponents(extensionIds: readonly string[]): Promise<void> {
    const extensionsDir = this.pathProvider.vscodeExtensionsDir;
    const installedExtensions = await listInstalledExtensions(this.fs, extensionsDir);

    for (const extId of extensionIds) {
      const version = installedExtensions.get(extId);
      if (version) {
        const extDirName = `${extId}-${version}`;
        const extPath = new Path(extensionsDir, extDirName);
        this.logger?.debug("Cleaning extension", { extId, path: extPath.toString() });
        await this.fs.rm(extPath, { recursive: true, force: true });
      }
    }
  }

  /**
   * Run the full setup process.
   *
   * Preconditions:
   * - Network connectivity for binary downloads and extension marketplace
   * - Asset files exist in assetsDir
   *
   * Postconditions on success:
   * - Binaries downloaded (code-server, opencode)
   * - All extensions installed
   * - Config files written
   * - CLI wrapper scripts created in bin directory
   * - Marker file written with version
   *
   * @param preflightResult Preflight result indicating what components need setup
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure with error details
   */
  async setup(
    preflightResult: PreflightResult,
    onProgress?: ProgressCallback
  ): Promise<SetupResult> {
    // Step 0: Validate required assets exist
    await this.validateAssets();

    // Use preflight result for selective setup if successful
    const preflight = preflightResult.success ? preflightResult : undefined;

    // Clean outdated extensions before reinstalling
    if (preflight && preflight.outdatedExtensions.length > 0) {
      await this.cleanComponents(preflight.outdatedExtensions);
    }

    // Step 1: Download binaries (if BinaryDownloadService is provided)
    // Use preflight result to determine which binaries to download
    const binaryResult = await this.downloadBinaries(onProgress, preflight?.missingBinaries);
    if (!binaryResult.success) {
      return binaryResult;
    }

    // Step 2: Install extensions (bundled and marketplace)
    // Use preflight result to determine which extensions to install
    const extensionsToInstall = preflight
      ? [...preflight.missingExtensions, ...preflight.outdatedExtensions]
      : undefined;

    // Clean stale entries from extensions.json before installing
    // This prevents "restart required" errors when VS Code thinks an extension
    // is still registered even though its folder is missing
    if (extensionsToInstall && extensionsToInstall.length > 0) {
      await removeFromExtensionsJson(
        this.fs,
        this.pathProvider.vscodeExtensionsDir,
        extensionsToInstall
      );
    }

    const extensionsResult = await this.installExtensions(onProgress, extensionsToInstall);
    if (!extensionsResult.success) {
      return extensionsResult;
    }

    // Step 3: Create CLI wrapper scripts
    await this.setupBinDirectory(onProgress);

    // Step 4: Write MCP config file
    await this.writeMcpConfig(onProgress);

    // Step 5: Write completion marker
    await this.writeCompletionMarker(onProgress);

    return { success: true };
  }

  /**
   * Download code-server and agent binaries in parallel if not already installed.
   * @param onProgress Optional callback for progress updates
   * @param missingBinaries Optional list of binaries to download (from preflight)
   * @returns Result indicating success or failure
   */
  private async downloadBinaries(
    onProgress?: ProgressCallback,
    missingBinaries?: readonly BinaryType[]
  ): Promise<SetupResult> {
    if (!this.binaryDownloadService) {
      // No binary download service - skip (for backward compatibility)
      return { success: true };
    }

    // Determine which binaries to download
    // If missingBinaries is provided, only download those
    // Otherwise, check and download both (full setup)
    const shouldDownloadCodeServer =
      missingBinaries === undefined
        ? !(await this.binaryDownloadService.isInstalled("code-server"))
        : missingBinaries.includes("code-server");

    // For agent binary, skip download if version is null (prefers system binary)
    const agentConfig = BINARY_CONFIGS[this.agentBinaryType];
    const shouldDownloadAgent =
      agentConfig.version === null
        ? false // Skip download - agent prefers system binary
        : missingBinaries === undefined
          ? !(await this.binaryDownloadService.isInstalled(this.agentBinaryType))
          : missingBinaries.includes(this.agentBinaryType);

    // Collect download tasks for parallel execution
    const downloadTasks: Array<{
      binary: BinaryType;
      promise: () => Promise<void>;
    }> = [];

    // Helper to create progress callback for a specific binary
    const createProgressCallback = (binary: BinaryType) => {
      return (downloadProgress: {
        phase: "downloading" | "extracting";
        bytesDownloaded: number;
        totalBytes: number | null;
      }) => {
        // Handle extracting phase - show indeterminate progress
        if (downloadProgress.phase === "extracting") {
          onProgress?.({
            step: "binary-download",
            message: `Extracting ${binary}...`,
            binaryType: binary,
            // No percent = indeterminate progress bar
          });
          return;
        }

        // Downloading phase - show percentage if available
        const percent =
          downloadProgress.totalBytes !== null
            ? Math.round((downloadProgress.bytesDownloaded / downloadProgress.totalBytes) * 100)
            : undefined;
        const message =
          percent !== undefined
            ? `Downloading ${binary}... ${percent}%`
            : `Downloading ${binary}...`;
        onProgress?.({
          step: "binary-download",
          message,
          binaryType: binary,
          ...(percent !== undefined && { percent }),
        });
      };
    };

    if (shouldDownloadCodeServer) {
      this.logger?.info("Downloading binary", { binary: "code-server" });
      onProgress?.({
        step: "binary-download",
        message: "Downloading code-server...",
        binaryType: "code-server",
        percent: 0,
      });
      downloadTasks.push({
        binary: "code-server",
        promise: () =>
          this.binaryDownloadService!.download(
            "code-server",
            createProgressCallback("code-server")
          ),
      });
    }

    if (shouldDownloadAgent) {
      this.logger?.info("Downloading binary", { binary: this.agentBinaryType });
      onProgress?.({
        step: "binary-download",
        message: `Downloading ${this.agentBinaryType}...`,
        binaryType: this.agentBinaryType,
        percent: 0,
      });
      downloadTasks.push({
        binary: this.agentBinaryType,
        promise: () =>
          this.binaryDownloadService!.download(
            this.agentBinaryType,
            createProgressCallback(this.agentBinaryType)
          ),
      });
    }

    // If no downloads needed, return success immediately
    if (downloadTasks.length === 0) {
      return { success: true };
    }

    // Download all binaries in parallel
    const results = await Promise.allSettled(downloadTasks.map((task) => task.promise()));

    // Check for failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const task = downloadTasks[i];
      if (result && result.status === "rejected") {
        const errorMessage = getErrorMessage(result.reason);
        this.logger?.warn("Binary download failed", {
          binary: task?.binary ?? "unknown",
          error: errorMessage,
        });
        return {
          success: false,
          error: {
            type: "network",
            message: `Failed to download ${task?.binary ?? "binary"}: ${errorMessage}`,
            code: "BINARY_DOWNLOAD_FAILED",
          },
        };
      } else if (result && result.status === "fulfilled") {
        this.logger?.info("Binary download complete", { binary: task?.binary ?? "unknown" });
      }
    }

    return { success: true };
  }

  /**
   * Remove the vscode directory to prepare for fresh setup.
   * Safe to call if directory doesn't exist.
   * @throws VscodeSetupError if path is not under app data directory (security validation)
   */
  async cleanVscodeDir(): Promise<void> {
    const vscodeDir = this.pathProvider.vscodeDir;
    const appDataRoot = this.pathProvider.dataRootDir;

    // Security: Validate path is under app data directory using Path.isChildOf
    if (!vscodeDir.isChildOf(appDataRoot)) {
      throw new VscodeSetupError(
        `Invalid vscode directory path: ${vscodeDir} is not under ${appDataRoot}`,
        "path-validation"
      );
    }

    // rm with force: true ignores ENOENT
    await this.fs.rm(vscodeDir, { recursive: true, force: true });
  }

  /**
   * Validate that required asset files exist.
   * @throws VscodeSetupError with type "missing-assets" if any asset is missing
   */
  async validateAssets(): Promise<void> {
    const requiredAssets = ["manifest.json"];
    const missingAssets: string[] = [];

    for (const asset of requiredAssets) {
      try {
        const assetPath = new Path(this.assetsDir, asset);
        await this.fs.readFile(assetPath);
      } catch {
        missingAssets.push(asset);
      }
    }

    if (missingAssets.length > 0) {
      throw new VscodeSetupError(
        `Required asset files not found: ${missingAssets.join(", ")}. ` +
          `Expected at: ${this.assetsDir}`,
        "missing-assets"
      );
    }
  }

  /**
   * Write the completion marker file.
   * @param onProgress Optional callback for progress updates
   */
  async writeCompletionMarker(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "finalize", message: "Finalizing setup..." });

    const marker: SetupMarker = {
      schemaVersion: 2, // Current marker schema version (v2 adds bin script cleanup)
      completedAt: new Date().toISOString(),
    };

    await this.fs.writeFile(this.pathProvider.setupMarkerPath, JSON.stringify(marker, null, 2));
  }

  /**
   * Write the MCP config file for OpenCode integration.
   * The config uses environment variable substitution for port and workspace path.
   *
   * @param onProgress Optional callback for progress updates
   */
  async writeMcpConfig(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "config", message: "Writing OpenCode config..." });

    const configPath = this.pathProvider.opencodeConfig;
    const configDir = configPath.dirname;

    // Ensure directory exists
    await this.fs.mkdir(configDir);

    // Write config from imported template
    await this.fs.writeFile(configPath, JSON.stringify(mcpConfigTemplate, null, 2));
  }

  /**
   * Remove the bin directory to ensure stale scripts are cleaned up.
   * Called before setupBinDirectory to remove any outdated scripts.
   */
  private async cleanBinDir(): Promise<void> {
    const binDir = this.pathProvider.binDir;
    await this.fs.rm(binDir, { recursive: true, force: true });
  }

  /**
   * Set up the bin directory with CLI wrapper scripts.
   * Copies pre-built scripts from assets/bin/ to <app-data>/bin/.
   *
   * @param onProgress Optional callback for progress updates
   */
  async setupBinDirectory(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "config", message: "Creating CLI wrapper scripts..." });

    // Clean bin directory to remove stale scripts before copying new ones
    await this.cleanBinDir();

    const binDir = this.pathProvider.binDir;
    const binAssetsDir = this.pathProvider.binAssetsDir;

    // Create bin directory
    await this.fs.mkdir(binDir);

    // List and copy all files from assets/bin/
    const assetEntries = await this.fs.readdir(binAssetsDir);

    for (const entry of assetEntries) {
      // Skip directories
      if (entry.isDirectory) {
        continue;
      }

      const srcPath = new Path(binAssetsDir, entry.name);
      const destPath = new Path(binDir, entry.name);

      // Copy file
      await this.fs.copyTree(srcPath, destPath);

      // Set executable permissions on Unix for files without .cmd extension
      if (!entry.name.endsWith(".cmd") && !entry.name.endsWith(".cjs")) {
        await this.fs.makeExecutable(destPath);
      }
    }
  }

  /**
   * Install extensions: bundled from vsix files and agent extension from marketplace.
   * @param onProgress Optional callback for progress updates
   * @param extensionsToInstall Optional list of extension IDs to install (for selective setup)
   * @returns Result indicating success or failure
   */
  async installExtensions(
    onProgress?: ProgressCallback,
    extensionsToInstall?: readonly string[]
  ): Promise<SetupResult> {
    // Load extensions manifest from assets
    const configPath = new Path(this.assetsDir, "manifest.json");
    const configContent = await this.fs.readFile(configPath);
    const parsed = JSON.parse(configContent) as unknown;

    // Validate manifest format
    const validation = validateExtensionsManifest(parsed);
    if (!validation.isValid) {
      return {
        success: false,
        error: {
          type: "missing-assets",
          message: validation.error,
          code: "INVALID_EXTENSIONS_MANIFEST",
        },
      };
    }
    const manifest = validation.manifest;

    // If extensionsToInstall is provided, filter to only those extensions
    // Otherwise, install all extensions (full setup)
    const shouldInstall = (extId: string) =>
      extensionsToInstall === undefined || extensionsToInstall.includes(extId);

    // Ensure vscode extensions directory exists before code-server tries to use it
    await this.fs.mkdir(this.pathProvider.vscodeExtensionsDir);

    // Install bundled extensions from vsix files
    // In production, vsix files are in extensionsRuntimeDir (extraResources)
    // In development, extensionsRuntimeDir falls back to vscodeAssetsDir
    for (const ext of manifest) {
      if (!shouldInstall(ext.id)) {
        continue;
      }

      onProgress?.({ step: "extensions", message: `Installing ${ext.id}...` });

      // Get vsix path from runtime directory (outside ASAR in production)
      const vsixPath = new Path(this.pathProvider.extensionsRuntimeDir, ext.vsix);
      try {
        await this.fs.readFile(vsixPath);
      } catch {
        return {
          success: false,
          error: {
            type: "missing-assets",
            message: `Bundled extension vsix not found: ${ext.vsix}. Expected at: ${vsixPath}`,
            code: "VSIX_NOT_FOUND",
          },
        };
      }

      // Install the extension directly from runtime directory
      // No copy needed - code-server can read from the runtime path
      const result = await this.runInstallExtension(vsixPath.toNative());
      if (!result.success) {
        return result;
      }
    }

    return { success: true };
  }

  /**
   * Run code-server to install an extension.
   * @param extensionIdOrPath Extension ID (marketplace) or path to vsix file
   * @returns Result indicating success or failure
   */
  private async runInstallExtension(extensionIdOrPath: string): Promise<SetupResult> {
    const codeServerPath = this.pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION);
    const proc = this.processRunner.run(codeServerPath.toNative(), [
      "--install-extension",
      extensionIdOrPath,
      "--extensions-dir",
      this.pathProvider.vscodeExtensionsDir.toNative(),
    ]);
    const result = await proc.wait();

    if (result.exitCode !== 0) {
      // Check for binary-not-found errors (ENOENT in stderr)
      if (result.stderr.includes("ENOENT") || result.stderr.includes("spawn")) {
        return {
          success: false,
          error: {
            type: "binary-not-found",
            message: result.stderr || "Failed to run code-server",
            code: "BINARY_ERROR",
          },
        };
      }

      return {
        success: false,
        error: {
          type: "network",
          message: `Failed to install extension: ${extensionIdOrPath}`,
          code: "EXTENSION_INSTALL_FAILED",
        },
      };
    }

    return { success: true };
  }

  /**
   * Read and parse the setup marker file from the new location.
   * @returns Parsed marker or null if missing/invalid
   */
  private async readMarker(): Promise<SetupMarker | null> {
    try {
      const content = await this.fs.readFile(this.pathProvider.setupMarkerPath);
      const marker = JSON.parse(content) as unknown;
      // Validate marker structure - accept both old and new formats
      if (typeof marker !== "object" || marker === null) {
        return null;
      }
      const obj = marker as Record<string, unknown>;
      // Check for new format (schemaVersion)
      if (typeof obj.schemaVersion === "number" && typeof obj.completedAt === "string") {
        return { schemaVersion: obj.schemaVersion, completedAt: obj.completedAt };
      }
      // Check for old format (version) - return it with version as schemaVersion for compatibility
      if (typeof obj.version === "number" && typeof obj.completedAt === "string") {
        return { schemaVersion: 0, completedAt: obj.completedAt }; // schemaVersion 0 indicates legacy
      }
      return null;
    } catch {
      // File doesn't exist or is invalid
      return null;
    }
  }
}
