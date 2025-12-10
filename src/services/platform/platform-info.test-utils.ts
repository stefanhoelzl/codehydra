/**
 * Test utilities for PlatformInfo.
 */
import type { PlatformInfo } from "./platform-info";

/**
 * Create a mock PlatformInfo with controllable behavior.
 * Defaults to Linux platform with test home directory.
 *
 * @param overrides - Optional overrides for PlatformInfo properties
 * @returns Mock PlatformInfo object
 */
export function createMockPlatformInfo(overrides?: Partial<PlatformInfo>): PlatformInfo {
  return {
    platform: overrides?.platform ?? "linux",
    homeDir: overrides?.homeDir ?? "/home/test",
  };
}
