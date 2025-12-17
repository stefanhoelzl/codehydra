/**
 * Node.js implementation of PlatformInfo.
 * Uses process.platform, process.arch, and os.homedir() for platform detection.
 */

import os from "node:os";
import type { PlatformInfo, SupportedArch } from "../services/platform/platform-info";

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
  readonly arch: SupportedArch;
  readonly homeDir: string;

  constructor() {
    // Cache at construction time for consistency
    this.platform = process.platform;
    this.arch = mapArchitecture(process.arch);
    this.homeDir = os.homedir();
  }
}
