/**
 * Test utilities for BuildInfo.
 */
import type { BuildInfo } from "./build-info";

/**
 * Create a mock BuildInfo with controllable behavior.
 * Defaults to development mode (isDevelopment: true, isPackaged: false, gitBranch: "test-branch",
 * appPath: "/test/app", version: "1.0.0-test").
 * When packaged (isPackaged: true), resourcesPath defaults to "/test/resources".
 *
 * @param overrides - Optional overrides for BuildInfo properties
 * @returns Mock BuildInfo object
 */
export function createMockBuildInfo(overrides?: Partial<BuildInfo>): BuildInfo {
  const version = overrides?.version ?? "1.0.0-test";
  const isDevelopment = overrides?.isDevelopment ?? true;
  const isPackaged = overrides?.isPackaged ?? false;
  const gitBranch = overrides?.gitBranch ?? (isPackaged ? undefined : "test-branch");
  const appPath = overrides?.appPath ?? "/test/app";
  // resourcesPath is only set when packaged (mirrors ElectronBuildInfo behavior)
  const resourcesPath = overrides?.resourcesPath ?? (isPackaged ? "/test/resources" : undefined);

  // Build object conditionally to satisfy exactOptionalPropertyTypes
  const result: BuildInfo = { version, isDevelopment, isPackaged, appPath };

  if (gitBranch !== undefined) {
    (result as { gitBranch: string }).gitBranch = gitBranch;
  }
  if (resourcesPath !== undefined) {
    (result as { resourcesPath: string }).resourcesPath = resourcesPath;
  }

  return result;
}
