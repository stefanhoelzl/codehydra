import { join, isAbsolute } from "node:path";
import type { BuildInfo } from "./build-info";
import type { PlatformInfo } from "./platform-info";
import { projectDirName } from "./paths";
import { Path } from "./path";
import { CODE_SERVER_VERSION, OPENCODE_VERSION, BINARY_CONFIGS } from "../binary-download/versions";

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

  /** Directory for code-server binary: `<dataRoot>/code-server/<version>/` */
  readonly codeServerDir: Path;

  /** Directory for opencode binary: `<dataRoot>/opencode/<version>/` */
  readonly opencodeDir: Path;

  /** Absolute path to code-server binary executable */
  readonly codeServerBinaryPath: Path;

  /** Absolute path to opencode binary executable */
  readonly opencodeBinaryPath: Path;

  /** Absolute path to bundled Node.js executable from code-server */
  readonly bundledNodePath: Path;

  /** Path to OpenCode config file: `<dataRoot>/opencode/opencode.codehydra.json` */
  readonly opencodeConfig: Path;

  /** Directory for CLI wrapper script assets: `<appPath>/out/main/assets/bin/` */
  readonly binAssetsDir: Path;

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project (string or Path)
   * @returns `<projectsDir>/<name>-<hash>/workspaces/` as Path
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string | Path): Path;
}

/**
 * Default PathProvider implementation.
 * Computes paths based on BuildInfo (dev/prod mode) and PlatformInfo (OS/home).
 *
 * Path structure:
 * - Development: `./app-data/` (relative to process.cwd())
 * - Production Linux: `~/.local/share/codehydra/`
 * - Production macOS: `~/Library/Application Support/Codehydra/`
 * - Production Windows: `<home>/AppData/Roaming/Codehydra/`
 */
export class DefaultPathProvider implements PathProvider {
  readonly dataRootDir: Path;
  readonly projectsDir: Path;
  readonly vscodeDir: Path;
  readonly vscodeExtensionsDir: Path;
  readonly vscodeUserDataDir: Path;
  readonly setupMarkerPath: Path;
  readonly electronDataDir: Path;
  readonly vscodeAssetsDir: Path;
  readonly scriptsDir: Path;
  readonly appIconPath: Path;
  readonly binDir: Path;
  readonly codeServerDir: Path;
  readonly opencodeDir: Path;
  readonly codeServerBinaryPath: Path;
  readonly opencodeBinaryPath: Path;
  readonly bundledNodePath: Path;
  readonly opencodeConfig: Path;
  readonly binAssetsDir: Path;

  constructor(buildInfo: BuildInfo, platformInfo: PlatformInfo) {
    const dataRootDirStr = this.computeDataRootDir(buildInfo, platformInfo);
    this.dataRootDir = new Path(dataRootDirStr);
    this.projectsDir = new Path(this.dataRootDir, "projects");
    this.vscodeDir = new Path(this.dataRootDir, "vscode");
    this.vscodeExtensionsDir = new Path(this.vscodeDir, "extensions");
    this.vscodeUserDataDir = new Path(this.vscodeDir, "user-data");
    this.setupMarkerPath = new Path(this.dataRootDir, ".setup-completed");
    this.electronDataDir = new Path(this.dataRootDir, "electron");
    // Assets are bundled at out/main/assets/ (same path in dev and prod)
    this.vscodeAssetsDir = new Path(buildInfo.appPath, "out", "main", "assets");
    this.scriptsDir = new Path(buildInfo.appPath, "out", "main", "assets", "scripts");
    this.appIconPath = this.computeAppIconPath(buildInfo);
    this.binDir = new Path(this.dataRootDir, "bin");

    // Binary directories with version
    this.codeServerDir = new Path(this.dataRootDir, "code-server", CODE_SERVER_VERSION);
    this.opencodeDir = new Path(this.dataRootDir, "opencode", OPENCODE_VERSION);

    // Binary paths (platform-specific)
    const platform = platformInfo.platform as "darwin" | "linux" | "win32";
    this.codeServerBinaryPath = new Path(
      this.codeServerDir,
      BINARY_CONFIGS["code-server"].extractedBinaryPath(platform)
    );
    this.opencodeBinaryPath = new Path(
      this.opencodeDir,
      BINARY_CONFIGS.opencode.extractedBinaryPath(platform)
    );

    // Bundled Node.js from code-server distribution
    this.bundledNodePath = new Path(
      this.codeServerDir,
      "lib",
      platform === "win32" ? "node.exe" : "node"
    );

    // OpenCode config file path
    this.opencodeConfig = new Path(this.dataRootDir, "opencode", "opencode.codehydra.json");

    // Bin wrapper assets directory
    this.binAssetsDir = new Path(buildInfo.appPath, "out", "main", "assets", "bin");
  }

  /**
   * Compute the path to the application icon.
   * In development: relative to process.cwd()
   * In production: relative to __dirname (bundled resources)
   */
  private computeAppIconPath(buildInfo: BuildInfo): Path {
    if (buildInfo.isDevelopment) {
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

  /**
   * Compute the data root directory based on build mode and platform.
   */
  private computeDataRootDir(buildInfo: BuildInfo, platformInfo: PlatformInfo): string {
    if (buildInfo.isDevelopment) {
      return join(process.cwd(), "app-data");
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
}
