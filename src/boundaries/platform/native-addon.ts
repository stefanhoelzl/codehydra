/**
 * CodeHydra's native addon (`native/`, Rust + napi-rs): OS queries made in
 * process instead of by spawning `ps`, `lsof` or a helper exe.
 *
 * One `.node` file per platform and architecture, built by
 * `scripts/build-native.ts` into `dist/bin` and shipped in the app's `bin/`
 * next to the other bundled binaries. `ExecaProcessRunner` is its only user:
 * the addon is an implementation detail of that boundary, not one of its own.
 */

import { createRequire } from "node:module";
import type { ProcessSnapshotEntry } from "./process";

/** What the addon exports. Every call runs on the libuv thread pool. */
export interface NativeAddon {
  /**
   * Every process on the machine, as sysinfo reports it. `envVar`: an
   * environment variable to read from each one (`envValue`).
   */
  listProcessesAsync(envVar?: string | null): Promise<ProcessSnapshotEntry[]>;
}

/** The addon's file name for a platform and architecture, e.g. `codehydra-native.linux-x64.node`. */
export function nativeAddonFileName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `codehydra-native.${platform}-${arch}.node`;
}

/**
 * Load the addon from `path`. Throws when the file is missing or was built
 * for another platform: the app cannot list processes without it, and a
 * startup failure names the cause where a silent fallback would not.
 */
export function loadNativeAddon(path: string): NativeAddon {
  return createRequire(import.meta.url)(path) as NativeAddon;
}
