/**
 * Test utilities for BuildInfo.
 */
import type { BuildInfo } from "./build-info";

/**
 * Create a mock BuildInfo with controllable behavior.
 * Defaults to development mode (isDevelopment: true, gitBranch: "test-branch", appPath: "/test/app").
 *
 * @param overrides - Optional overrides for BuildInfo properties
 * @returns Mock BuildInfo object
 */
export function createMockBuildInfo(overrides?: Partial<BuildInfo>): BuildInfo {
  const isDevelopment = overrides?.isDevelopment ?? true;
  const gitBranch = overrides?.gitBranch ?? (isDevelopment ? "test-branch" : undefined);
  const appPath = overrides?.appPath ?? "/test/app";

  // Build object conditionally to satisfy exactOptionalPropertyTypes
  if (gitBranch !== undefined) {
    return { isDevelopment, gitBranch, appPath };
  }
  return { isDevelopment, appPath };
}
