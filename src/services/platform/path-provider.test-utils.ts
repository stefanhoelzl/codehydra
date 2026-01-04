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
  dataRootDir?: Path | string;
  projectsDir?: Path | string;
  vscodeDir?: Path | string;
  vscodeExtensionsDir?: Path | string;
  vscodeUserDataDir?: Path | string;
  setupMarkerPath?: Path | string;
  electronDataDir?: Path | string;
  vscodeAssetsDir?: Path | string;
  scriptsDir?: Path | string;
  appIconPath?: Path | string;
  binDir?: Path | string;
  codeServerDir?: Path | string;
  opencodeDir?: Path | string;
  codeServerBinaryPath?: Path | string;
  opencodeBinaryPath?: Path | string;
  bundledNodePath?: Path | string;
  opencodeConfig?: Path | string;
  binAssetsDir?: Path | string;
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
 * Defaults to test paths under `/test/app-data/`.
 *
 * @param overrides - Optional overrides for PathProvider properties
 * @returns Mock PathProvider object
 */
export function createMockPathProvider(overrides?: MockPathProviderOptions): PathProvider {
  const dataRootDir = ensurePath(overrides?.dataRootDir, "/test/app-data");
  const projectsDir = ensurePath(overrides?.projectsDir, "/test/app-data/projects");
  const vscodeDir = ensurePath(overrides?.vscodeDir, "/test/app-data/vscode");

  const defaultGetProjectWorkspacesDir = (projectPath: string | Path): Path => {
    const pathStr = projectPath instanceof Path ? projectPath.toString() : projectPath;
    return new Path(projectsDir, projectDirName(pathStr), "workspaces");
  };

  const codeServerDir = ensurePath(
    overrides?.codeServerDir,
    `/test/app-data/code-server/${CODE_SERVER_VERSION}`
  );
  const opencodeDir = ensurePath(
    overrides?.opencodeDir,
    `/test/app-data/opencode/${OPENCODE_VERSION}`
  );

  return {
    dataRootDir,
    projectsDir,
    vscodeDir,
    vscodeExtensionsDir: ensurePath(
      overrides?.vscodeExtensionsDir,
      "/test/app-data/vscode/extensions"
    ),
    vscodeUserDataDir: ensurePath(overrides?.vscodeUserDataDir, "/test/app-data/vscode/user-data"),
    setupMarkerPath: ensurePath(overrides?.setupMarkerPath, "/test/app-data/.setup-completed"),
    electronDataDir: ensurePath(overrides?.electronDataDir, "/test/app-data/electron"),
    vscodeAssetsDir: ensurePath(overrides?.vscodeAssetsDir, "/mock/assets"),
    scriptsDir: ensurePath(overrides?.scriptsDir, "/mock/assets/scripts"),
    appIconPath: ensurePath(overrides?.appIconPath, "/test/resources/icon.png"),
    binDir: ensurePath(overrides?.binDir, "/test/app-data/bin"),
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
    opencodeConfig: ensurePath(
      overrides?.opencodeConfig,
      "/test/app-data/opencode/opencode.codehydra.json"
    ),
    binAssetsDir: ensurePath(overrides?.binAssetsDir, "/mock/assets/bin"),
    getProjectWorkspacesDir: overrides?.getProjectWorkspacesDir ?? defaultGetProjectWorkspacesDir,
  };
}
