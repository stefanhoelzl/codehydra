/**
 * VS Code setup service for first-run configuration.
 * Installs extensions and writes configuration files.
 */

import { readFile, rm, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { PathProvider } from "../platform/path-provider";
import { VscodeSetupError } from "../errors";
import {
  CURRENT_SETUP_VERSION,
  type IVscodeSetup,
  type SetupResult,
  type ProgressCallback,
  type SetupMarker,
  type ProcessRunner,
  type VscodeSettings,
} from "./types";

/**
 * Service for managing VS Code setup process.
 */
export class VscodeSetupService implements IVscodeSetup {
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly codeServerBinaryPath: string;

  constructor(
    processRunner: ProcessRunner,
    pathProvider: PathProvider,
    codeServerBinaryPath: string
  ) {
    this.processRunner = processRunner;
    this.pathProvider = pathProvider;
    this.codeServerBinaryPath = codeServerBinaryPath;
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

    try {
      await rm(vscodeDir, { recursive: true, force: true });
    } catch (error) {
      // Only ignore ENOENT (directory doesn't exist)
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
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

    // Check if extension already exists (idempotency)
    try {
      await access(packageJsonPath);
      // Extension already exists, skip installation
      return;
    } catch {
      // File doesn't exist, proceed with installation
    }

    await mkdir(extensionDir, { recursive: true });

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

    await writeFile(
      join(extensionDir, "package.json"),
      JSON.stringify(packageJson, null, 2),
      "utf-8"
    );
    await writeFile(join(extensionDir, "extension.js"), extensionJs, "utf-8");
  }

  /**
   * Write VS Code configuration files (settings.json, keybindings.json).
   * @param onProgress Optional callback for progress updates
   */
  async writeConfigFiles(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.({ step: "config", message: "Writing configuration..." });

    const userDir = join(this.pathProvider.vscodeUserDataDir, "User");
    await mkdir(userDir, { recursive: true });

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

    // Empty keybindings
    const keybindings: unknown[] = [];

    await writeFile(join(userDir, "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
    await writeFile(join(userDir, "keybindings.json"), JSON.stringify(keybindings), "utf-8");
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

    await writeFile(
      this.pathProvider.vscodeSetupMarkerPath,
      JSON.stringify(marker, null, 2),
      "utf-8"
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
      const content = await readFile(this.pathProvider.vscodeSetupMarkerPath, "utf-8");
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
