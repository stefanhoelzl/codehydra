/**
 * Node.js implementation of PlatformInfo.
 * Uses process.platform, process.arch, os.homedir() and os.cpus() for platform detection.
 */

import os from "node:os";
import type { PlatformInfo, SupportedArch } from "./platform-info";

/**
 * Map Node.js arch to supported arch, throwing for unsupported architectures.
 */
function mapArchitecture(nodeArch: string): SupportedArch {
  if (nodeArch === "x64" || nodeArch === "arm64") {
    return nodeArch;
  }
  throw new Error(`Unsupported architecture: ${nodeArch}. CodeHydra requires x64 or arm64.`);
}

/**
 * PlatformInfo implementation using Node.js APIs.
 *
 * Values are cached at construction time for consistency.
 */
export class NodePlatformInfo implements PlatformInfo {
  readonly platform: NodeJS.Platform;
  readonly posix: boolean;
  readonly arch: SupportedArch;
  readonly homeDir: string;
  readonly cpuCount: number;

  constructor() {
    // Cache at construction time for consistency
    this.platform = process.platform;
    this.posix = this.platform !== "win32";
    this.arch = mapArchitecture(process.arch);
    this.homeDir = os.homedir();
    // os.cpus() is empty where the CPU list is unreadable (e.g. no /proc).
    this.cpuCount = Math.max(1, os.cpus().length || os.availableParallelism());
  }
}
