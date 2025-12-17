/**
 * Test utilities for PathProvider.
 */
import { join } from "node:path";
import type { PathProvider } from "./path-provider";
import { projectDirName } from "./paths";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "../binary-download/versions";

/**
 * Options for createMockPathProvider.
 * All path properties can be overridden.
 * getProjectWorkspacesDir can be overridden with a custom function.
 */
export interface MockPathProviderOptions extends Partial<
  Omit<PathProvider, "getProjectWorkspacesDir">
> {
  getProjectWorkspacesDir?: (projectPath: string) => string;
}

/**
 * Create a mock PathProvider with controllable behavior.
 * Defaults to test paths under `/test/app-data/`.
 *
 * @param overrides - Optional overrides for PathProvider properties
 * @returns Mock PathProvider object
 */
export function createMockPathProvider(overrides?: MockPathProviderOptions): PathProvider {
  const dataRootDir = overrides?.dataRootDir ?? "/test/app-data";
  const projectsDir = overrides?.projectsDir ?? "/test/app-data/projects";
  const vscodeDir = overrides?.vscodeDir ?? "/test/app-data/vscode";

  const defaultGetProjectWorkspacesDir = (projectPath: string): string => {
    return join(projectsDir, projectDirName(projectPath), "workspaces");
  };

  const codeServerDir =
    overrides?.codeServerDir ?? `/test/app-data/code-server/${CODE_SERVER_VERSION}`;
  const opencodeDir = overrides?.opencodeDir ?? `/test/app-data/opencode/${OPENCODE_VERSION}`;

  return {
    dataRootDir,
    projectsDir,
    vscodeDir,
    vscodeExtensionsDir: overrides?.vscodeExtensionsDir ?? "/test/app-data/vscode/extensions",
    vscodeUserDataDir: overrides?.vscodeUserDataDir ?? "/test/app-data/vscode/user-data",
    vscodeSetupMarkerPath:
      overrides?.vscodeSetupMarkerPath ?? "/test/app-data/vscode/.setup-completed",
    electronDataDir: overrides?.electronDataDir ?? "/test/app-data/electron",
    vscodeAssetsDir: overrides?.vscodeAssetsDir ?? "/mock/assets",
    appIconPath: overrides?.appIconPath ?? "/test/resources/icon.png",
    binDir: overrides?.binDir ?? "/test/app-data/bin",
    codeServerDir,
    opencodeDir,
    codeServerBinaryPath: overrides?.codeServerBinaryPath ?? `${codeServerDir}/bin/code-server`,
    opencodeBinaryPath: overrides?.opencodeBinaryPath ?? `${opencodeDir}/opencode`,
    getProjectWorkspacesDir: overrides?.getProjectWorkspacesDir ?? defaultGetProjectWorkspacesDir,
  };
}
