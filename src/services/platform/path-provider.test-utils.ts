/**
 * Test utilities for PathProvider.
 */
import type { PathProvider } from "./path-provider";
import { Path } from "./path";
import { projectDirName } from "./paths";

/**
 * Options for createMockPathProvider.
 * All path properties can be overridden with Path objects or strings.
 * getProjectWorkspacesDir can be overridden with a custom function.
 */
export interface MockPathProviderOptions {
  // Bundle paths (binaries) - use bundlesRootDir
  bundlesRootDir?: Path | string;

  // Data paths - use dataRootDir
  dataRootDir?: Path | string;
  projectsDir?: Path | string;
  remotesDir?: Path | string;
  vscodeDir?: Path | string;
  vscodeExtensionsDir?: Path | string;
  vscodeUserDataDir?: Path | string;
  setupMarkerPath?: Path | string;
  electronDataDir?: Path | string;
  binDir?: Path | string;
  opencodeConfig?: Path | string;

  // Shared paths
  vscodeAssetsDir?: Path | string;
  scriptsDir?: Path | string;
  appIconPath?: Path | string;
  binAssetsDir?: Path | string;
  binRuntimeDir?: Path | string;
  scriptsRuntimeDir?: Path | string;
  extensionsRuntimeDir?: Path | string;
  claudeCodeConfigDir?: Path | string;
  claudeCodeHookHandlerPath?: Path | string;
  claudeCodeWrapperPath?: Path | string;
  configPath?: Path | string;

  // Method overrides
  getProjectWorkspacesDir?: (projectPath: string | Path) => Path;
  getBinaryBaseDir?: (type: "code-server" | "opencode" | "claude") => Path;
  getBinaryDir?: (type: "code-server" | "opencode" | "claude", version: string) => Path;
  getBinaryPath?: (type: "code-server" | "opencode" | "claude", version: string) => Path;
  getBundledNodePath?: (codeServerVersion: string) => Path;

  // Platform for binary path construction (defaults to "linux")
  platform?: "darwin" | "linux" | "win32";
}

/**
 * Helper to ensure a value is a Path object.
 */
function ensurePath(value: Path | string | undefined, defaultValue: string): Path {
  if (value instanceof Path) {
    return value;
  }
  return new Path(value ?? defaultValue);
}

/**
 * Create a mock PathProvider with controllable behavior.
 * Defaults to test paths: bundles under `/test/bundles/`, data under `/test/app-data/`.
 *
 * @param overrides - Optional overrides for PathProvider properties
 * @returns Mock PathProvider object
 */
export function createMockPathProvider(overrides?: MockPathProviderOptions): PathProvider {
  // Bundle paths (binaries) - use bundlesRootDir
  const bundlesRootDir = ensurePath(overrides?.bundlesRootDir, "/test/bundles");
  const platform = overrides?.platform ?? "linux";

  // Data paths - use dataRootDir
  const dataRootDir = ensurePath(overrides?.dataRootDir, "/test/app-data");
  const projectsDir = ensurePath(overrides?.projectsDir, `${dataRootDir.toString()}/projects`);
  const remotesDir = ensurePath(overrides?.remotesDir, `${dataRootDir.toString()}/remotes`);
  const vscodeDir = ensurePath(overrides?.vscodeDir, `${dataRootDir.toString()}/vscode`);

  const defaultGetProjectWorkspacesDir = (projectPath: string | Path): Path => {
    const pathStr = projectPath instanceof Path ? projectPath.toString() : projectPath;
    return new Path(projectsDir, projectDirName(pathStr), "workspaces");
  };

  const defaultGetBinaryBaseDir = (type: "code-server" | "opencode" | "claude"): Path => {
    return new Path(bundlesRootDir, type);
  };

  const defaultGetBinaryDir = (
    type: "code-server" | "opencode" | "claude",
    version: string
  ): Path => {
    return new Path(bundlesRootDir, type, version);
  };

  const defaultGetBinaryPath = (
    type: "code-server" | "opencode" | "claude",
    version: string
  ): Path => {
    const versionDir = defaultGetBinaryDir(type, version);
    const isWindows = platform === "win32";
    let binaryRelPath: string;

    switch (type) {
      case "code-server":
        binaryRelPath = isWindows ? "bin/code-server.cmd" : "bin/code-server";
        break;
      case "opencode":
        binaryRelPath = isWindows ? "opencode.exe" : "opencode";
        break;
      case "claude":
        binaryRelPath = isWindows ? "claude.exe" : "claude";
        break;
    }

    return new Path(versionDir, binaryRelPath);
  };

  const defaultGetBundledNodePath = (codeServerVersion: string): Path => {
    const codeServerDir = defaultGetBinaryDir("code-server", codeServerVersion);
    return new Path(codeServerDir, "lib", platform === "win32" ? "node.exe" : "node");
  };

  return {
    dataRootDir,
    projectsDir,
    remotesDir,
    vscodeDir,
    vscodeExtensionsDir: ensurePath(
      overrides?.vscodeExtensionsDir,
      `${vscodeDir.toString()}/extensions`
    ),
    vscodeUserDataDir: ensurePath(
      overrides?.vscodeUserDataDir,
      `${vscodeDir.toString()}/user-data`
    ),
    setupMarkerPath: ensurePath(
      overrides?.setupMarkerPath,
      `${dataRootDir.toString()}/.setup-completed`
    ),
    electronDataDir: ensurePath(overrides?.electronDataDir, `${dataRootDir.toString()}/electron`),
    binDir: ensurePath(overrides?.binDir, `${dataRootDir.toString()}/bin`),
    opencodeConfig: ensurePath(
      overrides?.opencodeConfig,
      `${dataRootDir.toString()}/opencode/opencode.codehydra.json`
    ),

    // Shared paths
    vscodeAssetsDir: ensurePath(overrides?.vscodeAssetsDir, "/mock/assets"),
    scriptsDir: ensurePath(overrides?.scriptsDir, "/mock/assets/scripts"),
    appIconPath: ensurePath(overrides?.appIconPath, "/test/resources/icon.png"),
    binAssetsDir: ensurePath(overrides?.binAssetsDir, "/mock/assets/bin"),

    // Runtime paths (same as assets in dev mode, resourcesPath in prod)
    binRuntimeDir: ensurePath(overrides?.binRuntimeDir, "/mock/assets/bin"),
    scriptsRuntimeDir: ensurePath(overrides?.scriptsRuntimeDir, "/mock/assets/scripts"),
    extensionsRuntimeDir: ensurePath(overrides?.extensionsRuntimeDir, "/mock/assets"),

    claudeCodeConfigDir: ensurePath(overrides?.claudeCodeConfigDir, "/test/app-data/claude-code"),
    claudeCodeHookHandlerPath: ensurePath(
      overrides?.claudeCodeHookHandlerPath,
      "/mock/assets/bin/claude-code-hook-handler.cjs"
    ),
    claudeCodeWrapperPath: ensurePath(
      overrides?.claudeCodeWrapperPath,
      "/test/app-data/bin/claude"
    ),
    configPath: ensurePath(overrides?.configPath, `${dataRootDir.toString()}/config.json`),

    // Methods
    getProjectWorkspacesDir: overrides?.getProjectWorkspacesDir ?? defaultGetProjectWorkspacesDir,
    getBinaryBaseDir: overrides?.getBinaryBaseDir ?? defaultGetBinaryBaseDir,
    getBinaryDir: overrides?.getBinaryDir ?? defaultGetBinaryDir,
    getBinaryPath: overrides?.getBinaryPath ?? defaultGetBinaryPath,
    getBundledNodePath: overrides?.getBundledNodePath ?? defaultGetBundledNodePath,
  };
}
