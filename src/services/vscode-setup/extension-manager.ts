/**
 * ExtensionManager - Manages VS Code extension preflight and installation.
 *
 * Extracted from VscodeSetupService to separate extension management
 * from binary download concerns. Uses code-server to install extensions
 * from bundled VSIX files.
 */

import type { FileSystemLayer } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";
import type { ProcessRunner } from "../platform/process";
import type { Logger } from "../logging";
import type { ExtensionsManifest } from "./types";
import { validateExtensionsManifest } from "./types";
import { listInstalledExtensions, removeFromExtensionsJson } from "./extension-utils";
import { Path } from "../platform/path";
import { ExtensionError, getErrorMessage } from "../errors";
import { CODE_SERVER_VERSION } from "../binary-download/versions";

/**
 * Preflight result for extension check.
 */
export interface ExtensionPreflightResult {
  /** True if the preflight check succeeded */
  readonly success: true;
  /** True if any extensions need install/update */
  readonly needsInstall: boolean;
  /** Extensions that are not installed */
  readonly missingExtensions: readonly string[];
  /** Extensions installed at wrong version */
  readonly outdatedExtensions: readonly string[];
}

/**
 * Preflight error result.
 */
export interface ExtensionPreflightError {
  readonly success: false;
  readonly error: {
    readonly type: string;
    readonly message: string;
  };
}

/**
 * Progress callback for extension installation.
 */
export type ExtensionProgressCallback = (message: string) => void;

/**
 * Manager for extension preflight and installation operations.
 */
export class ExtensionManager {
  private readonly assetsDir: Path;

  constructor(
    private readonly pathProvider: PathProvider,
    private readonly fileSystem: FileSystemLayer,
    private readonly processRunner: ProcessRunner,
    private readonly logger?: Logger
  ) {
    this.assetsDir = pathProvider.vscodeAssetsDir;
  }

  /**
   * Check which extensions need to be installed or updated.
   *
   * @returns Preflight result indicating which extensions need install
   */
  async preflight(): Promise<ExtensionPreflightResult | ExtensionPreflightError> {
    const missingExtensions: string[] = [];
    const outdatedExtensions: string[] = [];

    try {
      // Load extensions manifest
      const configPath = new Path(this.assetsDir, "manifest.json");
      const configContent = await this.fileSystem.readFile(configPath);
      const parsed = JSON.parse(configContent) as unknown;
      const validation = validateExtensionsManifest(parsed);
      if (!validation.isValid) {
        return {
          success: false,
          error: { type: "invalid-manifest", message: validation.error },
        };
      }
      const manifest = validation.manifest;

      // List installed extensions
      const installedExtensions = await listInstalledExtensions(
        this.fileSystem,
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

      const needsInstall = missingExtensions.length > 0 || outdatedExtensions.length > 0;

      this.logger?.debug("Extension preflight completed", {
        needsInstall,
        missingExtensions: missingExtensions.join(",") || "none",
        outdatedExtensions: outdatedExtensions.join(",") || "none",
      });

      return {
        success: true,
        needsInstall,
        missingExtensions,
        outdatedExtensions,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.warn("Extension preflight failed", { error: message });
      return {
        success: false,
        error: { type: "preflight-failed", message },
      };
    }
  }

  /**
   * Install extensions that need to be installed or updated.
   *
   * @param extensionsToInstall List of extension IDs to install (from preflight)
   * @param onProgress Optional callback for progress updates
   * @throws ExtensionError if installation fails
   */
  async install(
    extensionsToInstall: readonly string[],
    onProgress?: ExtensionProgressCallback
  ): Promise<void> {
    if (extensionsToInstall.length === 0) {
      this.logger?.debug("No extensions to install");
      return;
    }

    // Load manifest to get VSIX paths
    const manifest = await this.loadManifest();

    // Clean stale entries from extensions.json before installing
    await removeFromExtensionsJson(
      this.fileSystem,
      this.pathProvider.vscodeExtensionsDir,
      extensionsToInstall
    );

    // Ensure extensions directory exists
    await this.fileSystem.mkdir(this.pathProvider.vscodeExtensionsDir);

    // Install each extension
    for (const extId of extensionsToInstall) {
      const extConfig = manifest.find((e) => e.id === extId);
      if (!extConfig) {
        throw new ExtensionError(`Extension not found in manifest: ${extId}`);
      }

      onProgress?.(`Installing ${extId}...`);

      // Get vsix path from runtime directory (outside ASAR in production)
      const vsixPath = new Path(this.pathProvider.extensionsRuntimeDir, extConfig.vsix);

      // Verify VSIX exists
      try {
        await this.fileSystem.readFile(vsixPath);
      } catch {
        throw new ExtensionError(
          `Bundled extension vsix not found: ${extConfig.vsix}. Expected at: ${vsixPath}`
        );
      }

      // Install via code-server
      await this.runInstallExtension(vsixPath.toNative());
      this.logger?.info("Extension installed", { extId });
    }
  }

  /**
   * Clean outdated extension directories before reinstallation.
   *
   * @param extensionIds Extension IDs to clean
   */
  async cleanOutdated(extensionIds: readonly string[]): Promise<void> {
    const extensionsDir = this.pathProvider.vscodeExtensionsDir;
    const installedExtensions = await listInstalledExtensions(this.fileSystem, extensionsDir);

    for (const extId of extensionIds) {
      const version = installedExtensions.get(extId);
      if (version) {
        const extDirName = `${extId}-${version}`;
        const extPath = new Path(extensionsDir, extDirName);
        this.logger?.debug("Cleaning extension", { extId, path: extPath.toString() });
        await this.fileSystem.rm(extPath, { recursive: true, force: true });
      }
    }
  }

  /**
   * Load and validate the extensions manifest.
   */
  private async loadManifest(): Promise<ExtensionsManifest> {
    const configPath = new Path(this.assetsDir, "manifest.json");
    const configContent = await this.fileSystem.readFile(configPath);
    const parsed = JSON.parse(configContent) as unknown;
    const validation = validateExtensionsManifest(parsed);
    if (!validation.isValid) {
      throw new ExtensionError(`Invalid extensions manifest: ${validation.error}`);
    }
    return validation.manifest;
  }

  /**
   * Run code-server to install an extension.
   */
  private async runInstallExtension(vsixPath: string): Promise<void> {
    const codeServerPath = this.pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION);
    const proc = this.processRunner.run(codeServerPath.toNative(), [
      "--install-extension",
      vsixPath,
      "--extensions-dir",
      this.pathProvider.vscodeExtensionsDir.toNative(),
    ]);
    const result = await proc.wait();

    if (result.exitCode !== 0) {
      // Check for binary-not-found errors (ENOENT in stderr)
      if (result.stderr.includes("ENOENT") || result.stderr.includes("spawn")) {
        throw new ExtensionError(
          `Failed to run code-server: ${result.stderr || "Binary not found"}`
        );
      }
      throw new ExtensionError(`Failed to install extension: ${vsixPath}`);
    }
  }
}
