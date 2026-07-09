import { join, isAbsolute } from "node:path";
import type { BuildInfo } from "./build-info";
import type { PlatformInfo } from "./platform-info";
import { projectDirName } from "./paths";
import { Path } from "../../utils/path/path";

/**
 * Options for path resolution methods.
 */
export interface PathOptions {
  /** Appends `.cmd` extension on win32 */
  cmd?: boolean;
}

/**
 * Application path provider.
 * Abstracts platform-specific and build-mode-specific paths.
 *
 * All methods return `Path` objects for consistent cross-platform handling.
 * Use `path.toString()` for Map keys and comparisons.
 * Use `path.toNative()` for external process spawning.
 */
export interface PathProvider {
  /** `<dataRoot>/subpath` — app data (dev: ./app-data/, prod: platform-specific, or `_CH_ROOT_DIR`) */
  dataPath(subpath: string, options?: PathOptions): Path;

  /** `<bundlesRoot>/subpath` — binary downloads (production paths, or `_CH_ROOT_DIR`) */
  bundlePath(subpath: string): Path;

  /** `<runtimeRoot>/subpath` — external process access (prod: resourcesPath, dev: assets) */
  runtimePath(subpath: string): Path;

  /** `<assetsRoot>/subpath` — bundled assets inside ASAR (appPath/out/main/assets) */
  assetPath(subpath: string): Path;

  /** `<dataRoot>/temp/subpath` — temporary files, cleaned on startup and shutdown */
  tempPath(subpath: string): Path;

  /** Application icon (process.cwd()-based, fixed) */
  readonly appIconPath: Path;

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project (string or Path)
   * @returns `<dataRoot>/projects/<name>-<hash>/workspaces/` as Path
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string | Path): Path;
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
 *
 * `_CH_ROOT_DIR` overrides both roots at once, in either build flavor.
 */
export class DefaultPathProvider implements PathProvider {
  readonly appIconPath: Path;

  /** Data root for application data */
  private readonly dataRoot: Path;
  /** Bundles root for binary paths (always production paths) */
  private readonly bundlesRoot: Path;
  /** Assets root: appPath/out/main/assets */
  private readonly assetsRoot: Path;
  /** Runtime root: resourcesPath (prod) or assetsRoot (dev) */
  private readonly runtimeRoot: Path;
  /** Temp root for ephemeral files */
  private readonly tempRoot: Path;
  /** Platform for platform-specific path construction */
  private readonly platform: "darwin" | "linux" | "win32";

  constructor(buildInfo: BuildInfo, platformInfo: PlatformInfo) {
    this.platform = platformInfo.platform as "darwin" | "linux" | "win32";

    // Compute roots
    this.bundlesRoot = new Path(this.computeBundlesRootDir(platformInfo));
    this.dataRoot = new Path(this.computeDataRootDir(buildInfo, platformInfo));
    this.assetsRoot = new Path(buildInfo.appPath, "out", "main", "assets");
    this.runtimeRoot = buildInfo.resourcesPath
      ? new Path(buildInfo.resourcesPath)
      : this.assetsRoot;
    this.tempRoot = new Path(this.dataRoot, "temp");
    this.appIconPath = this.computeAppIconPath();
  }

  dataPath(subpath: string, options?: PathOptions): Path {
    const resolved = options?.cmd && this.platform === "win32" ? `${subpath}.cmd` : subpath;
    return new Path(this.dataRoot, resolved);
  }

  bundlePath(subpath: string): Path {
    return new Path(this.bundlesRoot, subpath);
  }

  runtimePath(subpath: string): Path {
    return new Path(this.runtimeRoot, subpath);
  }

  assetPath(subpath: string): Path {
    return new Path(this.assetsRoot, subpath);
  }

  tempPath(subpath: string): Path {
    return new Path(this.tempRoot, subpath);
  }

  getProjectWorkspacesDir(projectPath: string | Path): Path {
    const pathStr = projectPath instanceof Path ? projectPath.toString() : projectPath;
    if (!pathStr || !isAbsolute(pathStr)) {
      throw new TypeError(`projectPath must be an absolute path, got: "${pathStr}"`);
    }
    return new Path(this.dataRoot, "projects", projectDirName(pathStr), "workspaces");
  }

  private computeAppIconPath(): Path {
    return new Path(process.cwd(), "resources", "icon.png");
  }

  /**
   * Explicit root override. Relocates the data root *and* the bundles root together,
   * which is the shape a production install already has.
   */
  private static rootOverride(): string | undefined {
    return process.env._CH_ROOT_DIR || undefined;
  }

  private computeBundlesRootDir(platformInfo: PlatformInfo): string {
    const override = DefaultPathProvider.rootOverride();
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

  private computeDataRootDir(buildInfo: BuildInfo, platformInfo: PlatformInfo): string {
    // An explicit root wins over the dev/prod split: without this, a dev build (which
    // includes every non-release packaged artifact — isDevelopment comes from
    // _CH_BUILD_RELEASE at build time, not from app.isPackaged) writes its data into
    // whatever cwd it inherited, ignoring the override entirely.
    const override = DefaultPathProvider.rootOverride();
    if (override) {
      return override;
    }
    if (buildInfo.isDevelopment) {
      return join(process.cwd(), "app-data");
    }
    return this.computeBundlesRootDir(platformInfo);
  }
}
