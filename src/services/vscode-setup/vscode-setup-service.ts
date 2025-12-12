/**
 * VS Code setup service for first-run configuration.
 * Installs extensions and writes configuration files.
 */

import { join } from "node:path";
import type { PathProvider } from "../platform/path-provider";
import type { FileSystemLayer } from "../platform/filesystem";
import { VscodeSetupError, FileSystemError } from "../errors";
import {
  CURRENT_SETUP_VERSION,
  type IVscodeSetup,
  type SetupResult,
  type ProgressCallback,
  type SetupMarker,
  type ProcessRunner,
  type VscodeSettings,
  type VscodeKeybinding,
} from "./types";

/**
 * Service for managing VS Code setup process.
 */
export class VscodeSetupService implements IVscodeSetup {
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly codeServerBinaryPath: string;
  private readonly fs: FileSystemLayer;

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
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure with error details
   */
  /**
   * Run the full setup process.
   *
   * Preconditions:
   * - code-server binary exists at codeServerBinaryPath
   * - Network connectivity for extension marketplace
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
    // Step 1: Install custom extensions (codehydra)
    await this.installCustomExtensions(onProgress);

    // Step 2: Install marketplace extensions (OpenCode)
    const marketplaceResult = await this.installMarketplaceExtensions(onProgress);
    if (!marketplaceResult.success) {
      return marketplaceResult;
    }

    // Step 3: Write config files
    await this.writeConfigFiles(onProgress);

    // Step 4: Write completion marker
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
        "path-validation",
        `Invalid vscode directory path: ${vscodeDir} is not under ${appDataRoot}`
      );
    }

    // rm with force: true ignores ENOENT
    await this.fs.rm(vscodeDir, { recursive: true, force: true });
  }

  /**
   * Install custom extensions (codehydra extension).
   * @param onProgress Optional callback for progress updates
   */
  async installCustomExtensions(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "extensions", message: "Installing codehydra extension..." });

    const extensionDir = join(
      this.pathProvider.vscodeExtensionsDir,
      "codehydra.vscode-0.0.1-universal"
    );
    const packageJsonPath = join(extensionDir, "package.json");

    // Check if extension already exists (idempotency) by trying to read the file
    try {
      await this.fs.readFile(packageJsonPath);
      // Extension already exists, skip installation
      return;
    } catch (error) {
      // File doesn't exist (ENOENT), proceed with installation
      // Any other error is also fine to ignore - we'll just reinstall
      if (error instanceof FileSystemError && error.fsCode !== "ENOENT") {
        // Unexpected error reading file - log but proceed anyway
      }
    }

    await this.fs.mkdir(extensionDir);

    // package.json content
    const packageJson = {
      name: "codehydra",
      displayName: "Codehydra",
      description: "Codehydra integration for VS Code",
      version: "0.0.1",
      publisher: "codehydra",
      engines: {
        vscode: "^1.74.0",
      },
      activationEvents: ["onStartupFinished"],
      main: "./extension.js",
      contributes: {},
    };

    // extension.js content
    const extensionJs = `const vscode = require("vscode");

async function activate(context) {
  // Wait briefly for VS Code UI to stabilize
  setTimeout(async () => {
    try {
      // Hide sidebars to maximize editor space
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      // Open OpenCode terminal automatically for AI workflow
      await vscode.commands.executeCommand("opencode.openTerminal");
      // Unlock the editor group so files open in the same tab group
      await vscode.commands.executeCommand("workbench.action.unlockEditorGroup");
      // Clean up empty editor groups created by terminal opening
      await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
    } catch (err) {
      console.error("codehydra extension error:", err);
    }
  }, 100);
}

function deactivate() {}

module.exports = { activate, deactivate };
`;

    await this.fs.writeFile(
      join(extensionDir, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );
    await this.fs.writeFile(join(extensionDir, "extension.js"), extensionJs);
  }

  /**
   * Write VS Code configuration files (settings.json, keybindings.json).
   * @param onProgress Optional callback for progress updates
   */
  async writeConfigFiles(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "config", message: "Writing configuration..." });

    const userDir = join(this.pathProvider.vscodeUserDataDir, "User");
    await this.fs.mkdir(userDir);

    // VS Code settings
    // Auto-detect system theme so VS Code matches the UI layer's prefers-color-scheme
    const settings: VscodeSettings = {
      "workbench.startupEditor": "none",
      "workbench.colorTheme": "Default Dark+",
      "window.autoDetectColorScheme": true,
      "workbench.preferredDarkColorTheme": "Default Dark+",
      "workbench.preferredLightColorTheme": "Default Light+",
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "window.menuBarVisibility": "hidden",
      "terminal.integrated.gpuAcceleration": "off",
    };

    // Keybindings: Remap Ctrl+J (Toggle Panel) to Alt+T
    const keybindings: VscodeKeybinding[] = [
      { key: "ctrl+j", command: "-workbench.action.togglePanel" },
      { key: "alt+t", command: "workbench.action.togglePanel" },
    ];

    await this.fs.writeFile(join(userDir, "settings.json"), JSON.stringify(settings, null, 2));
    await this.fs.writeFile(
      join(userDir, "keybindings.json"),
      JSON.stringify(keybindings, null, 2)
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
   * Install marketplace extensions (OpenCode).
   * @param onProgress Optional callback for progress updates
   * @returns Result indicating success or failure
   */
  async installMarketplaceExtensions(onProgress?: ProgressCallback): Promise<SetupResult> {
    onProgress?.({ step: "extensions", message: "Installing OpenCode extension..." });

    const proc = this.processRunner.run(this.codeServerBinaryPath, [
      "--install-extension",
      "sst-dev.opencode",
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
          message: "Failed to install OpenCode extension",
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
