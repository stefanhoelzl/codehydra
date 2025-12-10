/**
 * Node.js implementation of PlatformInfo.
 * Uses process.platform and os.homedir() for platform detection.
 */

import os from "node:os";
import type { PlatformInfo } from "../services/platform/platform-info";

/**
 * PlatformInfo implementation using Node.js APIs.
 *
 * Values are cached at construction time for consistency.
 */
export class NodePlatformInfo implements PlatformInfo {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;

  constructor() {
    // Cache at construction time for consistency
    this.platform = process.platform;
    this.homeDir = os.homedir();
  }
}
