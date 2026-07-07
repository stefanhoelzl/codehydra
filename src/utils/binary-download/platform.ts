/**
 * Shared platform guards for binary download URL builders.
 */

import type { SupportedArch, SupportedPlatform } from "../../boundaries/platform/platform-info";

/**
 * Assert that a Windows download is only ever requested for x64 — every binary
 * we ship (Claude, OpenCode, code-server) provides Windows builds for x64 only.
 *
 * @param label - Human-readable binary name for the error message.
 * @throws Error when `platform` is win32 and `arch` is not x64.
 */
export function assertWindowsX64(
  platform: SupportedPlatform,
  arch: SupportedArch,
  label: string
): void {
  if (platform === "win32" && arch !== "x64") {
    throw new Error(`Windows ${label} builds only support x64, got: ${arch}`);
  }
}
