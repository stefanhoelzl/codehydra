/**
 * Test utilities for BuildInfo.
 */
import type { BuildInfo } from "./build-info";

/**
 * Create a mock BuildInfo with controllable behavior.
 * Defaults to development mode (isDevelopment: true, gitBranch: "test-branch", appPath: "/test/app", version: "1.0.0-test").
 * In production mode (isDevelopment: false), resourcesPath defaults to "/test/resources".
 *
 * @param overrides - Optional overrides for BuildInfo properties
 * @returns Mock BuildInfo object
 */
export function createMockBuildInfo(overrides?: Partial<BuildInfo>): BuildInfo {
  const version = overrides?.version ?? "1.0.0-test";
  const isDevelopment = overrides?.isDevelopment ?? true;
  const gitBranch = overrides?.gitBranch ?? (isDevelopment ? "test-branch" : undefined);
  const appPath = overrides?.appPath ?? "/test/app";
  // resourcesPath is only set in production mode (mirrors ElectronBuildInfo behavior)
  const resourcesPath = overrides?.resourcesPath ?? (isDevelopment ? undefined : "/test/resources");

  // Build object conditionally to satisfy exactOptionalPropertyTypes
  const result: BuildInfo = { version, isDevelopment, appPath };

  if (gitBranch !== undefined) {
    (result as { gitBranch: string }).gitBranch = gitBranch;
  }
  if (resourcesPath !== undefined) {
    (result as { resourcesPath: string }).resourcesPath = resourcesPath;
  }

  return result;
}
