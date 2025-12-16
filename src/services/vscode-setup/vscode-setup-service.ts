/**
 * VS Code setup service for first-run configuration.
 * Installs extensions and writes configuration files.
 */

import { join } from "node:path";
import type { PathProvider } from "../platform/path-provider";
import type { FileSystemLayer } from "../platform/filesystem";
import { VscodeSetupError } from "../errors";
import {
  CURRENT_SETUP_VERSION,
  type IVscodeSetup,
  type SetupResult,
  type ProgressCallback,
  type SetupMarker,
  type ProcessRunner,
  type ExtensionsConfig,
} from "./types";

/**
 * Service for managing VS Code setup process.
 */
export class VscodeSetupService implements IVscodeSetup {
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly codeServerBinaryPath: string;
  private readonly fs: FileSystemLayer;
  private readonly assetsDir: string;

  constructor(
    processRunner: ProcessRunner,
    pathProvider: PathProvider,
    codeServerBinaryPath: string,
    fs: FileSystemLayer
  ) {
    this.processRunner = processRunner;
    this.pathProvider = pathProvider;
    this.codeServerBinaryPath = codeServerBinaryPath;
    this.fs = fs;
    this.assetsDir = pathProvider.vscodeAssetsDir;
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
   * - code-server binary exists at codeServerBinaryPath
   * - Network connectivity for extension marketplace
   * - Asset files exist in assetsDir
   *
   * Postconditions on success:
   * - All extensions installed
   * - Config files written
   * - Marker file written with version
   *
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure with error details
   */
  async setup(onProgress?: ProgressCallback): Promise<SetupResult> {
    // Step 0: Validate required assets exist
    await this.validateAssets();

    // Step 1: Install extensions (bundled and marketplace)
    const extensionsResult = await this.installExtensions(onProgress);
    if (!extensionsResult.success) {
      return extensionsResult;
    }

    // Step 2: Write config files
    await this.writeConfigFiles(onProgress);

    // Step 3: Write completion marker
    await this.writeCompletionMarker(onProgress);

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
    const requiredAssets = ["settings.json", "keybindings.json", "extensions.json"];
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
   * Write VS Code configuration files (settings.json, keybindings.json).
   * Copies files from assets directory to user data directory.
   * @param onProgress Optional callback for progress updates
   */
  async writeConfigFiles(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "config", message: "Writing configuration..." });

    const userDir = join(this.pathProvider.vscodeUserDataDir, "User");
    await this.fs.mkdir(userDir);

    // Copy settings.json from assets
    await this.fs.copyTree(join(this.assetsDir, "settings.json"), join(userDir, "settings.json"));

    // Copy keybindings.json from assets
    await this.fs.copyTree(
      join(this.assetsDir, "keybindings.json"),
      join(userDir, "keybindings.json")
    );
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
    const proc = this.processRunner.run(this.codeServerBinaryPath, [
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
