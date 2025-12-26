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
  // Use join() for all paths to ensure cross-platform compatibility
  const dataRootDir = overrides?.dataRootDir ?? join("/test", "app-data");
  const projectsDir = overrides?.projectsDir ?? join("/test", "app-data", "projects");
  const vscodeDir = overrides?.vscodeDir ?? join("/test", "app-data", "vscode");

  const defaultGetProjectWorkspacesDir = (projectPath: string): string => {
    return join(projectsDir, projectDirName(projectPath), "workspaces");
  };

  const codeServerDir =
    overrides?.codeServerDir ?? join("/test", "app-data", "code-server", CODE_SERVER_VERSION);
  const opencodeDir =
    overrides?.opencodeDir ?? join("/test", "app-data", "opencode", OPENCODE_VERSION);

  return {
    dataRootDir,
    projectsDir,
    vscodeDir,
    vscodeExtensionsDir:
      overrides?.vscodeExtensionsDir ?? join("/test", "app-data", "vscode", "extensions"),
    vscodeUserDataDir:
      overrides?.vscodeUserDataDir ?? join("/test", "app-data", "vscode", "user-data"),
    setupMarkerPath: overrides?.setupMarkerPath ?? join("/test", "app-data", ".setup-completed"),
    legacySetupMarkerPath:
      overrides?.legacySetupMarkerPath ?? join("/test", "app-data", "vscode", ".setup-completed"),
    electronDataDir: overrides?.electronDataDir ?? join("/test", "app-data", "electron"),
    vscodeAssetsDir: overrides?.vscodeAssetsDir ?? join("/mock", "assets"),
    appIconPath: overrides?.appIconPath ?? join("/test", "resources", "icon.png"),
    binDir: overrides?.binDir ?? join("/test", "app-data", "bin"),
    codeServerDir,
    opencodeDir,
    codeServerBinaryPath:
      overrides?.codeServerBinaryPath ?? join(codeServerDir, "bin", "code-server"),
    opencodeBinaryPath: overrides?.opencodeBinaryPath ?? join(opencodeDir, "opencode"),
    bundledNodePath: overrides?.bundledNodePath ?? join(codeServerDir, "lib", "node"),
    mcpConfigPath:
      overrides?.mcpConfigPath ?? join("/test", "app-data", "opencode", "codehydra-mcp.json"),
    getProjectWorkspacesDir: overrides?.getProjectWorkspacesDir ?? defaultGetProjectWorkspacesDir,
  };
}
