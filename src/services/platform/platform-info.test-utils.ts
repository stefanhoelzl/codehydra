/**
 * Test utilities for PlatformInfo.
 */
import type { PlatformInfo, SupportedArch } from "./platform-info";

/**
 * Create a mock PlatformInfo with controllable behavior.
 * Defaults to Linux x64 platform with test home directory.
 *
 * @param overrides - Optional overrides for PlatformInfo properties
 * @returns Mock PlatformInfo object
 */
export function createMockPlatformInfo(overrides?: Partial<PlatformInfo>): PlatformInfo {
  return {
    platform: overrides?.platform ?? "linux",
    arch: (overrides?.arch as SupportedArch) ?? "x64",
    homeDir: overrides?.homeDir ?? "/home/test",
  };
}
