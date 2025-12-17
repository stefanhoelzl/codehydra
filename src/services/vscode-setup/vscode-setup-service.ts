/**
 * VS Code setup service for first-run configuration.
 * Installs extensions and writes configuration files.
 */

import { join } from "node:path";
import type { PathProvider } from "../platform/path-provider";
import type { FileSystemLayer } from "../platform/filesystem";
import type { PlatformInfo } from "../platform/platform-info";
import type { Logger } from "../logging/index";
import { VscodeSetupError } from "../errors";
import {
  CURRENT_SETUP_VERSION,
  type IVscodeSetup,
  type SetupResult,
  type ProgressCallback,
  type SetupMarker,
  type ProcessRunner,
  type ExtensionsConfig,
  type BinTargetPaths,
} from "./types";
import { generateScripts } from "./bin-scripts";
import type { BinaryDownloadService } from "../binary-download/binary-download-service";

/**
 * Service for managing VS Code setup process.
 */
export class VscodeSetupService implements IVscodeSetup {
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly fs: FileSystemLayer;
  private readonly assetsDir: string;
  private readonly platformInfo: PlatformInfo;
  private readonly binaryDownloadService: BinaryDownloadService | null;
  private readonly logger: Logger | undefined;

  constructor(
    processRunner: ProcessRunner,
    pathProvider: PathProvider,
    fs: FileSystemLayer,
    platformInfo?: PlatformInfo,
    binaryDownloadService?: BinaryDownloadService,
    logger?: Logger
  ) {
    this.processRunner = processRunner;
    this.pathProvider = pathProvider;
    this.fs = fs;
    this.assetsDir = pathProvider.vscodeAssetsDir;
    // Default to node process values if not provided
    this.platformInfo = platformInfo ?? {
      platform: process.platform,
      arch: process.arch === "arm64" ? "arm64" : "x64",
      homeDir: process.env.HOME ?? process.env.USERPROFILE ?? "",
    };
    this.binaryDownloadService = binaryDownloadService ?? null;
    this.logger = logger;
  }

  /**
   * Check if setup has been completed with the current version.
   * @returns true if setup is complete and version matches
   */
  async isSetupComplete(): Promise<boolean> {
    const marker = await this.readMarker();
    return marker !== null && marker.version === CURRENT_SETUP_VERSION;
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
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure with error details
   */
  async setup(onProgress?: ProgressCallback): Promise<SetupResult> {
    // Step 0: Validate required assets exist
    await this.validateAssets();

    // Step 1: Download binaries (if BinaryDownloadService is provided)
    const binaryResult = await this.downloadBinaries(onProgress);
    if (!binaryResult.success) {
      return binaryResult;
    }

    // Step 2: Install extensions (bundled and marketplace)
    const extensionsResult = await this.installExtensions(onProgress);
    if (!extensionsResult.success) {
      return extensionsResult;
    }

    // Step 3: Create CLI wrapper scripts
    await this.setupBinDirectory(onProgress);

    // Step 4: Write completion marker
    await this.writeCompletionMarker(onProgress);

    return { success: true };
  }

  /**
   * Download code-server and opencode binaries if not already installed.
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure
   */
  private async downloadBinaries(onProgress?: ProgressCallback): Promise<SetupResult> {
    if (!this.binaryDownloadService) {
      // No binary download service - skip (for backward compatibility)
      return { success: true };
    }

    // Download code-server
    const codeServerInstalled = await this.binaryDownloadService.isInstalled("code-server");
    if (!codeServerInstalled) {
      this.logger?.info("Downloading binary", { binary: "code-server" });
      onProgress?.({ step: "binary-download", message: "Setting up code-server..." });
      try {
        await this.binaryDownloadService.download("code-server");
        this.logger?.info("Binary download complete", { binary: "code-server" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: {
            type: "network",
            message: `Failed to download code-server: ${message}`,
            code: "BINARY_DOWNLOAD_FAILED",
          },
        };
      }
    }

    // Download opencode
    const opencodeInstalled = await this.binaryDownloadService.isInstalled("opencode");
    if (!opencodeInstalled) {
      this.logger?.info("Downloading binary", { binary: "opencode" });
      onProgress?.({ step: "binary-download", message: "Setting up opencode..." });
      try {
        await this.binaryDownloadService.download("opencode");
        this.logger?.info("Binary download complete", { binary: "opencode" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: {
            type: "network",
            message: `Failed to download opencode: ${message}`,
            code: "BINARY_DOWNLOAD_FAILED",
          },
        };
      }
    }

    // Create wrapper scripts for the binaries
    this.logger?.debug("Creating wrapper scripts", {});
    await this.binaryDownloadService.createWrapperScripts();

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

    // Security: Validate path is under app data directory
    if (!vscodeDir.startsWith(appDataRoot)) {
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
    const requiredAssets = ["extensions.json"];
    const missingAssets: string[] = [];

    for (const asset of requiredAssets) {
      try {
        await this.fs.readFile(join(this.assetsDir, asset));
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
      version: CURRENT_SETUP_VERSION,
      completedAt: new Date().toISOString(),
    };

    await this.fs.writeFile(
      this.pathProvider.vscodeSetupMarkerPath,
      JSON.stringify(marker, null, 2)
    );
  }

  /**
   * Set up the bin directory with CLI wrapper scripts.
   * Creates scripts for: code, and optionally opencode.
   *
   * Note: code-server wrapper is not generated because we launch code-server
   * directly with an absolute path.
   *
   * @param onProgress Optional callback for progress updates
   */
  async setupBinDirectory(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "config", message: "Creating CLI wrapper scripts..." });

    const binDir = this.pathProvider.binDir;

    // Create bin directory
    await this.fs.mkdir(binDir);

    // Resolve target binary paths
    const targetPaths = this.resolveTargetPaths();

    // Generate scripts for this platform
    const scripts = generateScripts(this.platformInfo, targetPaths);

    // Write each script
    for (const script of scripts) {
      const scriptPath = join(binDir, script.filename);
      await this.fs.writeFile(scriptPath, script.content);

      // Make executable on Unix
      if (script.needsExecutable) {
        await this.fs.makeExecutable(scriptPath);
      }
    }
  }

  /**
   * Resolve paths to target binaries for wrapper script generation.
   *
   * The code-server path resolution:
   * - Uses the codeServerBinaryPath provided at construction
   * - Derives the remote-cli path from code-server's installation directory
   *
   * The opencode path resolution:
   * - Attempts to find opencode in common locations
   * - Returns null if not found (wrapper script not generated)
   *
   * Note: code-server wrapper is not generated because we launch code-server
   * directly with an absolute path.
   *
   * @returns Target paths for script generation
   */
  private resolveTargetPaths(): BinTargetPaths {
    // For the code command, we need the remote-cli script that code-server provides
    // This is at <code-server>/lib/vscode/bin/remote-cli/code-<platform>.sh (Unix)
    // or <code-server>/lib/vscode/bin/remote-cli/code.cmd (Windows)
    const codeServerDir = this.resolveCodeServerDirectory();
    const remoteCli = this.resolveRemoteCliPath(codeServerDir);

    return {
      codeRemoteCli: remoteCli,
      opencodeBinary: this.resolveOpencodePath(),
    };
  }

  /**
   * Resolve the code-server installation directory.
   * For "code-server" command, we need to find the actual installation.
   */
  private resolveCodeServerDirectory(): string {
    // If codeServerBinaryPath is just "code-server", try to resolve via require
    // For now, we assume it's resolvable from node_modules in dev
    // or bundled at a known location in production
    try {
      // In dev: node_modules/code-server/out/node/entry.js
      // The package.json "bin" points to out/node/entry.js
      const codeServerEntry = require.resolve("code-server");
      // Navigate from entry.js to the root: code-server/out/node/entry.js -> code-server/
      const codeServerRoot = join(codeServerEntry, "..", "..", "..");
      return codeServerRoot;
    } catch {
      // require.resolve failed (bundled Electron context)
      // Use pathProvider.codeServerDir directly since we know the binary location
      return this.pathProvider.codeServerDir;
    }
  }

  /**
   * Resolve the path to the remote-cli script for the `code` command.
   */
  private resolveRemoteCliPath(codeServerDir: string): string {
    if (!codeServerDir) {
      // If we couldn't find the code-server directory, use the binary path from pathProvider
      return this.pathProvider.codeServerBinaryPath;
    }

    const isWindows = this.platformInfo.platform === "win32";

    if (isWindows) {
      return join(codeServerDir, "lib", "vscode", "bin", "remote-cli", "code.cmd");
    }

    // Unix: the script is named based on platform
    const platform = this.platformInfo.platform === "darwin" ? "darwin" : "linux";
    return join(codeServerDir, "lib", "vscode", "bin", "remote-cli", `code-${platform}.sh`);
  }

  /**
   * Get the path to the opencode binary from PathProvider.
   * Returns the absolute path to the downloaded opencode binary.
   */
  private resolveOpencodePath(): string | null {
    // Return the opencode binary path from PathProvider
    // The binary is downloaded during setup by BinaryDownloadService
    return this.pathProvider.opencodeBinaryPath;
  }

  /**
   * Install all extensions (bundled vsix and marketplace).
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure
   */
  async installExtensions(onProgress?: ProgressCallback): Promise<SetupResult> {
    // Load extensions config from assets
    const configContent = await this.fs.readFile(join(this.assetsDir, "extensions.json"));
    const config = JSON.parse(configContent) as ExtensionsConfig;

    // Install bundled extensions (vsix files)
    for (const vsixFilename of config.bundled) {
      onProgress?.({ step: "extensions", message: `Installing ${vsixFilename}...` });

      // Copy vsix from assets to vscode directory for installation
      const srcPath = join(this.assetsDir, vsixFilename);
      const destPath = join(this.pathProvider.vscodeDir, vsixFilename);
      await this.fs.mkdir(this.pathProvider.vscodeDir);
      await this.fs.copyTree(srcPath, destPath);

      // Install the extension using code-server
      const result = await this.runInstallExtension(destPath);
      if (!result.success) {
        return result;
      }
    }

    // Install marketplace extensions
    for (const extensionId of config.marketplace) {
      onProgress?.({ step: "extensions", message: `Installing ${extensionId}...` });

      const result = await this.runInstallExtension(extensionId);
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
    const proc = this.processRunner.run(this.pathProvider.codeServerBinaryPath, [
      "--install-extension",
      extensionIdOrPath,
      "--extensions-dir",
      this.pathProvider.vscodeExtensionsDir,
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
   * Read and parse the setup marker file.
   * @returns Parsed marker or null if missing/invalid
   */
  private async readMarker(): Promise<SetupMarker | null> {
    try {
      const content = await this.fs.readFile(this.pathProvider.vscodeSetupMarkerPath);
      const marker = JSON.parse(content) as SetupMarker;
      // Validate marker structure
      if (typeof marker.version === "number" && typeof marker.completedAt === "string") {
        return marker;
      }
      return null;
    } catch {
      // File doesn't exist or is invalid
      return null;
    }
  }
}
