/**
 * Test utilities for PathProvider.
 */
import type { PathProvider } from "./path-provider";
import { Path } from "./path";
import { projectDirName } from "./paths";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "../binary-download/versions";

/**
 * Options for createMockPathProvider.
 * All path properties can be overridden with Path objects or strings.
 * getProjectWorkspacesDir can be overridden with a custom function.
 */
export interface MockPathProviderOptions {
  // Bundle paths (binaries) - use bundlesRootDir
  bundlesRootDir?: Path | string;
  codeServerDir?: Path | string;
  opencodeDir?: Path | string;
  codeServerBinaryPath?: Path | string;
  opencodeBinaryPath?: Path | string;
  bundledNodePath?: Path | string;

  // Data paths - use dataRootDir
  dataRootDir?: Path | string;
  projectsDir?: Path | string;
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
  getProjectWorkspacesDir?: (projectPath: string | Path) => Path;
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
  const codeServerDir = ensurePath(
    overrides?.codeServerDir,
    `${bundlesRootDir.toString()}/code-server/${CODE_SERVER_VERSION}`
  );
  const opencodeDir = ensurePath(
    overrides?.opencodeDir,
    `${bundlesRootDir.toString()}/opencode/${OPENCODE_VERSION}`
  );

  // Data paths - use dataRootDir
  const dataRootDir = ensurePath(overrides?.dataRootDir, "/test/app-data");
  const projectsDir = ensurePath(overrides?.projectsDir, `${dataRootDir.toString()}/projects`);
  const vscodeDir = ensurePath(overrides?.vscodeDir, `${dataRootDir.toString()}/vscode`);

  const defaultGetProjectWorkspacesDir = (projectPath: string | Path): Path => {
    const pathStr = projectPath instanceof Path ? projectPath.toString() : projectPath;
    return new Path(projectsDir, projectDirName(pathStr), "workspaces");
  };

  return {
    dataRootDir,
    projectsDir,
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

    // Bundle paths
    codeServerDir,
    opencodeDir,
    codeServerBinaryPath: ensurePath(
      overrides?.codeServerBinaryPath,
      `${codeServerDir.toString()}/bin/code-server`
    ),
    opencodeBinaryPath: ensurePath(
      overrides?.opencodeBinaryPath,
      `${opencodeDir.toString()}/opencode`
    ),
    bundledNodePath: ensurePath(overrides?.bundledNodePath, `${codeServerDir.toString()}/lib/node`),

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
    getProjectWorkspacesDir: overrides?.getProjectWorkspacesDir ?? defaultGetProjectWorkspacesDir,
  };
}
