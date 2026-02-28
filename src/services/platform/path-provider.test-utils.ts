/**
 * Test utilities for PathProvider.
 */
import type { PathProvider, PathOptions } from "./path-provider";
import { Path } from "./path";
import { projectDirName } from "./paths";

/**
 * Options for createMockPathProvider.
 */
export interface MockPathProviderOptions {
  /** Root for bundle paths (default: /test/bundles) */
  bundlesRootDir?: Path | string;
  /** Root for data paths (default: /test/app-data) */
  dataRootDir?: Path | string;
  /** Root for runtime paths (default: /mock/runtime) */
  runtimeRootDir?: Path | string;
  /** Root for asset paths (default: /mock/assets) */
  assetsRootDir?: Path | string;
  /** App icon path (default: /test/resources/icon.png) */
  appIconPath?: Path | string;
  /** Platform for cmd option (default: "linux") */
  platform?: "darwin" | "linux" | "win32";

  /** Override getProjectWorkspacesDir */
  getProjectWorkspacesDir?: (projectPath: string | Path) => Path;
}

function ensurePath(value: Path | string | undefined, defaultValue: string): Path {
  if (value instanceof Path) {
    return value;
  }
  return new Path(value ?? defaultValue);
}

/**
 * Create a mock PathProvider with controllable behavior.
 * Defaults to test paths: bundles under `/test/bundles/`, data under `/test/app-data/`.
 */
export function createMockPathProvider(overrides?: MockPathProviderOptions): PathProvider {
  const bundlesRootDir = ensurePath(overrides?.bundlesRootDir, "/test/bundles");
  const dataRootDir = ensurePath(overrides?.dataRootDir, "/test/app-data");
  const runtimeRootDir = ensurePath(overrides?.runtimeRootDir, "/mock/runtime");
  const assetsRootDir = ensurePath(overrides?.assetsRootDir, "/mock/assets");
  const platform = overrides?.platform ?? "linux";

  const defaultGetProjectWorkspacesDir = (projectPath: string | Path): Path => {
    const pathStr = projectPath instanceof Path ? projectPath.toString() : projectPath;
    return new Path(dataRootDir, "projects", projectDirName(pathStr), "workspaces");
  };

  return {
    dataPath(subpath: string, options?: PathOptions): Path {
      const resolved = options?.cmd && platform === "win32" ? `${subpath}.cmd` : subpath;
      return new Path(dataRootDir, resolved);
    },
    bundlePath(subpath: string): Path {
      return new Path(bundlesRootDir, subpath);
    },
    runtimePath(subpath: string): Path {
      return new Path(runtimeRootDir, subpath);
    },
    assetPath(subpath: string): Path {
      return new Path(assetsRootDir, subpath);
    },
    appIconPath: ensurePath(overrides?.appIconPath, "/test/resources/icon.png"),
    getProjectWorkspacesDir: overrides?.getProjectWorkspacesDir ?? defaultGetProjectWorkspacesDir,
  };
}
