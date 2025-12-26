import { join, isAbsolute } from "node:path";
import type { BuildInfo } from "./build-info";
import type { PlatformInfo } from "./platform-info";
import { projectDirName } from "./paths";
import { CODE_SERVER_VERSION, OPENCODE_VERSION, BINARY_CONFIGS } from "../binary-download/versions";

/**
 * Application path provider.
 * Abstracts platform-specific and build-mode-specific paths.
 */
export interface PathProvider {
  /** Root directory for all application data */
  readonly dataRootDir: string;

  /** Directory for project data: `<dataRoot>/projects/` */
  readonly projectsDir: string;

  /** Directory for VS Code config: `<dataRoot>/vscode/` */
  readonly vscodeDir: string;

  /** Directory for VS Code extensions: `<dataRoot>/vscode/extensions/` */
  readonly vscodeExtensionsDir: string;

  /** Directory for VS Code user data: `<dataRoot>/vscode/user-data/` */
  readonly vscodeUserDataDir: string;

  /** Path to setup marker: `<dataRoot>/.setup-completed` */
  readonly setupMarkerPath: string;

  /** @deprecated Use setupMarkerPath. Legacy location for migration detection. */
  readonly legacySetupMarkerPath: string;

  /** Directory for Electron data: `<dataRoot>/electron/` */
  readonly electronDataDir: string;

  /** Directory for VS Code assets bundled with the app: `<appPath>/out/main/assets/` */
  readonly vscodeAssetsDir: string;

  /** Path to the application icon: `resources/icon.png` */
  readonly appIconPath: string;

  /** Directory for CLI wrapper scripts: `<dataRoot>/bin/` */
  readonly binDir: string;

  /** Directory for code-server binary: `<dataRoot>/code-server/<version>/` */
  readonly codeServerDir: string;

  /** Directory for opencode binary: `<dataRoot>/opencode/<version>/` */
  readonly opencodeDir: string;

  /** Absolute path to code-server binary executable */
  readonly codeServerBinaryPath: string;

  /** Absolute path to opencode binary executable */
  readonly opencodeBinaryPath: string;

  /** Absolute path to bundled Node.js executable from code-server */
  readonly bundledNodePath: string;

  /** Path to MCP config file: `<dataRoot>/opencode/codehydra-mcp.json` */
  readonly mcpConfigPath: string;

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project
   * @returns `<projectsDir>/<name>-<hash>/workspaces/`
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string): string;
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
  readonly dataRootDir: string;
  readonly projectsDir: string;
  readonly vscodeDir: string;
  readonly vscodeExtensionsDir: string;
  readonly vscodeUserDataDir: string;
  readonly setupMarkerPath: string;
  readonly legacySetupMarkerPath: string;
  readonly electronDataDir: string;
  readonly vscodeAssetsDir: string;
  readonly appIconPath: string;
  readonly binDir: string;
  readonly codeServerDir: string;
  readonly opencodeDir: string;
  readonly codeServerBinaryPath: string;
  readonly opencodeBinaryPath: string;
  readonly bundledNodePath: string;
  readonly mcpConfigPath: string;

  constructor(buildInfo: BuildInfo, platformInfo: PlatformInfo) {
    this.dataRootDir = this.computeDataRootDir(buildInfo, platformInfo);
    this.projectsDir = join(this.dataRootDir, "projects");
    this.vscodeDir = join(this.dataRootDir, "vscode");
    this.vscodeExtensionsDir = join(this.vscodeDir, "extensions");
    this.vscodeUserDataDir = join(this.vscodeDir, "user-data");
    this.setupMarkerPath = join(this.dataRootDir, ".setup-completed");
    this.legacySetupMarkerPath = join(this.vscodeDir, ".setup-completed");
    this.electronDataDir = join(this.dataRootDir, "electron");
    // Assets are bundled at out/main/assets/ (same path in dev and prod)
    this.vscodeAssetsDir = join(buildInfo.appPath, "out", "main", "assets");
    this.appIconPath = this.computeAppIconPath(buildInfo);
    this.binDir = join(this.dataRootDir, "bin");

    // Binary directories with version
    this.codeServerDir = join(this.dataRootDir, "code-server", CODE_SERVER_VERSION);
    this.opencodeDir = join(this.dataRootDir, "opencode", OPENCODE_VERSION);

    // Binary paths (platform-specific)
    const platform = platformInfo.platform as "darwin" | "linux" | "win32";
    this.codeServerBinaryPath = join(
      this.codeServerDir,
      BINARY_CONFIGS["code-server"].extractedBinaryPath(platform)
    );
    this.opencodeBinaryPath = join(
      this.opencodeDir,
      BINARY_CONFIGS.opencode.extractedBinaryPath(platform)
    );

    // Bundled Node.js from code-server distribution
    this.bundledNodePath = join(
      this.codeServerDir,
      "lib",
      platform === "win32" ? "node.exe" : "node"
    );

    // MCP config file path
    this.mcpConfigPath = join(this.dataRootDir, "opencode", "codehydra-mcp.json");
  }

  /**
   * Compute the path to the application icon.
   * In development: relative to process.cwd()
   * In production: relative to __dirname (bundled resources)
   */
  private computeAppIconPath(buildInfo: BuildInfo): string {
    if (buildInfo.isDevelopment) {
      return join(process.cwd(), "resources", "icon.png");
    }
    // In production, resources are in the app.asar or extracted resources folder
    // electron-vite places resources at the root level next to the app
    return join(process.cwd(), "resources", "icon.png");
  }

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project
   * @returns `<projectsDir>/<name>-<hash>/workspaces/`
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string): string {
    if (!projectPath || !isAbsolute(projectPath)) {
      throw new TypeError(`projectPath must be an absolute path, got: "${projectPath}"`);
    }
    return join(this.projectsDir, projectDirName(projectPath), "workspaces");
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
