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
   * environment variable to read from each one (`envValue`). On Linux the
   * working directory and environment are read only where they can be (not
   * kernel threads, not other users' processes unless root), and the command
   * line and environment once per process — elsewhere too.
   */
  listProcessesAsync(envVar?: string | null): Promise<ProcessSnapshotEntry[]>;
  /**
   * Every listening TCP socket (IPv4 and IPv6) with the pid that owns it
   * (listeners crate). `pids`: only theirs — on Linux read from those
   * processes' fds alone, not from every process on the machine.
   */
  listeningSocketsAsync(pids?: number[] | null): Promise<{ pid: number; port: number }[]>;
  /**
   * The processes Restart Manager says hold a file under `dir` (up to 1000 of
   * its files registered). Windows only; empty elsewhere.
   */
  restartManagerHoldersAsync(dir: string): Promise<{ pid: number; name: string }[]>;
  /**
   * The files under `dir` that `pids` hold open, as absolute paths, from the
   * system handle table. Windows only; empty elsewhere. Bounded: names that do
   * not resolve within a few seconds are left out.
   */
  openFilesUnderAsync(dir: string, pids: number[]): Promise<{ pid: number; path: string }[]>;
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
