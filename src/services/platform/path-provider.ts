import { join, isAbsolute } from "node:path";
import type { BuildInfo } from "./build-info";
import type { PlatformInfo } from "./platform-info";
import { projectDirName } from "./paths";
import { Path } from "./path";
import { BINARY_CONFIGS } from "../binary-download/versions";

/**
 * Application path provider.
 * Abstracts platform-specific and build-mode-specific paths.
 *
 * All path properties return `Path` objects for consistent cross-platform handling.
 * Use `path.toString()` for Map keys and comparisons.
 * Use `path.toNative()` for external process spawning (handled internally by FileSystemLayer/ProcessRunner).
 */
export interface PathProvider {
  /** Root directory for all application data */
  readonly dataRootDir: Path;

  /** Directory for project data: `<dataRoot>/projects/` */
  readonly projectsDir: Path;

  /** Directory for cloned remote repositories: `<dataRoot>/remotes/` */
  readonly remotesDir: Path;

  /** Directory for VS Code config: `<dataRoot>/vscode/` */
  readonly vscodeDir: Path;

  /** Directory for VS Code extensions: `<dataRoot>/vscode/extensions/` */
  readonly vscodeExtensionsDir: Path;

  /** Directory for VS Code user data: `<dataRoot>/vscode/user-data/` */
  readonly vscodeUserDataDir: Path;

  /** Path to setup marker: `<dataRoot>/.setup-completed` */
  readonly setupMarkerPath: Path;

  /** Directory for Electron data: `<dataRoot>/electron/` */
  readonly electronDataDir: Path;

  /** Directory for VS Code assets bundled with the app: `<appPath>/out/main/assets/` */
  readonly vscodeAssetsDir: Path;

  /** Directory for script assets: `<appPath>/out/main/assets/scripts/` */
  readonly scriptsDir: Path;

  /** Path to the application icon: `resources/icon.png` */
  readonly appIconPath: Path;

  /** Directory for CLI wrapper scripts: `<dataRoot>/bin/` */
  readonly binDir: Path;

  /** Directory for CLI wrapper script assets: `<appPath>/out/main/assets/bin/` */
  readonly binAssetsDir: Path;

  /**
   * Directory for runtime bin scripts (external execution).
   * - Dev: same as binAssetsDir (files accessible directly)
   * - Prod: `<resourcesPath>/bin/` (extraResources destination)
   */
  readonly binRuntimeDir: Path;

  /**
   * Directory for runtime scripts (external execution).
   * - Dev: same as scriptsDir (files accessible directly)
   * - Prod: `<resourcesPath>/scripts/` (extraResources destination)
   */
  readonly scriptsRuntimeDir: Path;

  /**
   * Directory for runtime extensions (external access by code-server).
   * - Dev: same as vscodeAssetsDir (files accessible directly)
   * - Prod: `<resourcesPath>/extensions/` (extraResources destination)
   */
  readonly extensionsRuntimeDir: Path;

  /** Directory for Claude Code configs: `<dataRoot>/claude-code/` */
  readonly claudeCodeConfigDir: Path;

  /** Path to Claude Code hook handler script: `<binRuntimeDir>/claude-code-hook-handler.cjs` */
  readonly claudeCodeHookHandlerPath: Path;

  /** Path to Claude Code wrapper script: `<binDir>/claude` (or `claude.cmd` on Windows) */
  readonly claudeCodeWrapperPath: Path;

  /** Path to application config file: `<dataRoot>/config.json` */
  readonly configPath: Path;

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project (string or Path)
   * @returns `<projectsDir>/<name>-<hash>/workspaces/` as Path
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string | Path): Path;

  /**
   * Get the base directory for a binary type (without version).
   * @param type - Binary type ("code-server" | "opencode" | "claude")
   * @returns `<bundlesRoot>/<type>/` as Path
   */
  getBinaryBaseDir(type: "code-server" | "opencode" | "claude"): Path;

  /**
   * Get the version directory for a binary.
   * @param type - Binary type ("code-server" | "opencode" | "claude")
   * @param version - Version string (e.g., "4.107.0")
   * @returns `<bundlesRoot>/<type>/<version>/` as Path
   */
  getBinaryDir(type: "code-server" | "opencode" | "claude", version: string): Path;

  /**
   * Get the binary executable path for a specific version.
   * @param type - Binary type ("code-server" | "opencode" | "claude")
   * @param version - Version string (e.g., "4.107.0")
   * @returns Path to the binary executable
   */
  getBinaryPath(type: "code-server" | "opencode" | "claude", version: string): Path;

  /**
   * Get the bundled Node.js path from a specific code-server version.
   * @param codeServerVersion - Version of code-server
   * @returns Path to the bundled node executable
   */
  getBundledNodePath(codeServerVersion: string): Path;
}

/**
 * Default PathProvider implementation.
 * Computes paths based on BuildInfo (dev/prod mode) and PlatformInfo (OS/home).
 *
 * Path structure:
 * - Development (isDevelopment=true): `./app-data/` (relative to process.cwd())
 * - Production Linux: `~/.local/share/codehydra/`
 * - Production macOS: `~/Library/Application Support/Codehydra/`
 * - Production Windows: `<home>/AppData/Roaming/Codehydra/`
 */
export class DefaultPathProvider implements PathProvider {
  readonly dataRootDir: Path;
  readonly projectsDir: Path;
  readonly remotesDir: Path;
  readonly vscodeDir: Path;
  readonly vscodeExtensionsDir: Path;
  readonly vscodeUserDataDir: Path;
  readonly setupMarkerPath: Path;
  readonly electronDataDir: Path;
  readonly vscodeAssetsDir: Path;
  readonly scriptsDir: Path;
  readonly appIconPath: Path;
  readonly binDir: Path;
  readonly binAssetsDir: Path;
  readonly binRuntimeDir: Path;
  readonly scriptsRuntimeDir: Path;
  readonly extensionsRuntimeDir: Path;
  readonly claudeCodeConfigDir: Path;
  readonly claudeCodeHookHandlerPath: Path;
  readonly claudeCodeWrapperPath: Path;
  readonly configPath: Path;

  /** Bundles root for binary paths */
  private readonly bundlesRoot: Path;
  /** Platform for binary path construction */
  private readonly platform: "darwin" | "linux" | "win32";

  constructor(buildInfo: BuildInfo, platformInfo: PlatformInfo) {
    // Compute different roots for different types of data
    const bundlesRootDirStr = this.computeBundlesRootDir(platformInfo);
    const dataRootDirStr = this.computeDataRootDir(buildInfo, platformInfo);

    // Store platform for dynamic path methods
    this.platform = platformInfo.platform as "darwin" | "linux" | "win32";

    // Bundles root for binary paths (always production paths)
    this.bundlesRoot = new Path(bundlesRootDirStr);

    // Data root for everything else (dev/prod logic)
    this.dataRootDir = new Path(dataRootDirStr);

    // Data paths - use dataRoot
    this.projectsDir = new Path(this.dataRootDir, "projects");
    this.remotesDir = new Path(this.dataRootDir, "remotes");
    this.vscodeDir = new Path(this.dataRootDir, "vscode");
    this.vscodeExtensionsDir = new Path(this.vscodeDir, "extensions");
    this.vscodeUserDataDir = new Path(this.vscodeDir, "user-data");
    this.setupMarkerPath = new Path(this.dataRootDir, ".setup-completed");
    this.electronDataDir = new Path(this.dataRootDir, "electron");
    this.binDir = new Path(this.dataRootDir, "bin");

    // Assets are bundled at out/main/assets/ (inside ASAR in production)
    this.vscodeAssetsDir = new Path(buildInfo.appPath, "out", "main", "assets");
    this.scriptsDir = new Path(buildInfo.appPath, "out", "main", "assets", "scripts");
    this.appIconPath = this.computeAppIconPath(buildInfo);
    this.binAssetsDir = new Path(buildInfo.appPath, "out", "main", "assets", "bin");

    // Runtime paths for external process access (outside ASAR via extraResources)
    // In dev mode, use assets paths directly (no ASAR)
    // In prod mode, use resourcesPath (extraResources destination)
    this.binRuntimeDir = buildInfo.resourcesPath
      ? new Path(buildInfo.resourcesPath, "bin")
      : this.binAssetsDir;
    this.scriptsRuntimeDir = buildInfo.resourcesPath
      ? new Path(buildInfo.resourcesPath, "scripts")
      : this.scriptsDir;
    this.extensionsRuntimeDir = buildInfo.resourcesPath
      ? new Path(buildInfo.resourcesPath, "extensions")
      : this.vscodeAssetsDir;

    // Claude Code paths
    this.claudeCodeConfigDir = new Path(this.dataRootDir, "claude-code");
    this.claudeCodeHookHandlerPath = new Path(this.binRuntimeDir, "claude-code-hook-handler.cjs");
    this.claudeCodeWrapperPath = new Path(
      this.binDir,
      this.platform === "win32" ? "ch-claude.cmd" : "ch-claude"
    );

    // Application config
    this.configPath = new Path(this.dataRootDir, "config.json");
  }

  /**
   * Compute the path to the application icon.
   * In development: relative to process.cwd()
   * In production: relative to __dirname (bundled resources)
   */
  private computeAppIconPath(buildInfo: BuildInfo): Path {
    if (!buildInfo.isPackaged) {
      return new Path(process.cwd(), "resources", "icon.png");
    }
    // In production, resources are in the app.asar or extracted resources folder
    // electron-vite places resources at the root level next to the app
    return new Path(process.cwd(), "resources", "icon.png");
  }

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project (string or Path)
   * @returns `<projectsDir>/<name>-<hash>/workspaces/` as Path
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string | Path): Path {
    const pathStr = projectPath instanceof Path ? projectPath.toString() : projectPath;
    if (!pathStr || !isAbsolute(pathStr)) {
      throw new TypeError(`projectPath must be an absolute path, got: "${pathStr}"`);
    }
    return new Path(this.projectsDir, projectDirName(pathStr), "workspaces");
  }

  getBinaryBaseDir(type: "code-server" | "opencode" | "claude"): Path {
    return new Path(this.bundlesRoot, type);
  }

  getBinaryDir(type: "code-server" | "opencode" | "claude", version: string): Path {
    return new Path(this.bundlesRoot, type, version);
  }

  getBinaryPath(type: "code-server" | "opencode" | "claude", version: string): Path {
    const versionDir = this.getBinaryDir(type, version);
    // Get binary relative path based on type
    // code-server and opencode use BINARY_CONFIGS, claude uses direct path
    let binaryRelPath: string;
    if (type === "claude") {
      binaryRelPath = this.platform === "win32" ? "claude.exe" : "claude";
    } else {
      binaryRelPath = BINARY_CONFIGS[type].extractedBinaryPath(this.platform);
    }
    return new Path(versionDir, binaryRelPath);
  }

  getBundledNodePath(codeServerVersion: string): Path {
    const codeServerDir = this.getBinaryDir("code-server", codeServerVersion);
    return new Path(codeServerDir, "lib", this.platform === "win32" ? "node.exe" : "node");
  }

  /**
   * Compute the bundles root directory (always production paths for binaries).
   */
  private computeBundlesRootDir(platformInfo: PlatformInfo): string {
    // Allow override via environment variable (for CI/testing)
    const override = process.env.CODEHYDRA_BUNDLE_DIR;
    if (override) {
      return override;
    }

    const { platform, homeDir } = platformInfo;

    switch (platform) {
      case "darwin":
        return join(homeDir, "Library", "Application Support", "Codehydra");
      case "win32":
        return join(homeDir, "AppData", "Roaming", "Codehydra");
      case "linux":
      default:
        return join(homeDir, ".local", "share", "codehydra");
    }
  }

  /**
   * Compute the data root directory based on build mode and platform.
   */
  private computeDataRootDir(buildInfo: BuildInfo, platformInfo: PlatformInfo): string {
    if (buildInfo.isDevelopment) {
      return join(process.cwd(), "app-data");
    }

    // In production, use the same bundles root for consistency
    return this.computeBundlesRootDir(platformInfo);
  }
}
