/**
 * Binary resolution service for locating binaries.
 *
 * This service resolves binaries using the following priority:
 * 1. For pinned versions: check exact version in bundlesRoot
 * 2. For null versions (prefer system):
 *    a. Check system binary via --version (confirms it's executable)
 *    b. Check downloaded versions (use highest version)
 *    c. Return not-found if neither available
 */

import type { FileSystemLayer } from "../platform/filesystem";
import type { ProcessRunner } from "../platform/process";
import type { PathProvider } from "../platform/path-provider";
import type { Logger } from "../logging";
import { Path } from "../platform/path";
import type { BinaryResolution, ResolutionOptions, ResolvableBinaryType } from "./types";

/**
 * Dependencies for BinaryResolutionService.
 */
export interface BinaryResolutionServiceDeps {
  readonly fileSystem: FileSystemLayer;
  readonly processRunner: ProcessRunner;
  readonly pathProvider: PathProvider;
  readonly logger: Logger;
}

/**
 * Service for resolving binary paths.
 */
export class BinaryResolutionService {
  private readonly fileSystem: FileSystemLayer;
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly logger: Logger;

  constructor(deps: BinaryResolutionServiceDeps) {
    this.fileSystem = deps.fileSystem;
    this.processRunner = deps.processRunner;
    this.pathProvider = deps.pathProvider;
    this.logger = deps.logger;
  }

  /**
   * Resolve a binary to a path.
   *
   * @param type - Binary type to resolve
   * @param options - Resolution options
   * @returns Resolution result
   */
  async resolve(
    type: ResolvableBinaryType,
    options?: ResolutionOptions
  ): Promise<BinaryResolution> {
    const pinnedVersion = options?.pinnedVersion;

    if (pinnedVersion) {
      // Pinned version: skip system check, look for exact version
      return this.resolveExactVersion(type, pinnedVersion);
    }

    // Null version: prefer system, fall back to downloaded
    // First check system binary (--version confirms it's executable)
    const systemAvailable = await this.findSystemBinary(type);
    if (systemAvailable) {
      this.logger.debug("Found system binary", { type });
      return {
        available: true,
        source: "system",
        // path is undefined for system binaries - spawn by name
      };
    }

    // Check downloaded versions
    const downloaded = await this.findLatestDownloaded(type);
    if (downloaded) {
      this.logger.debug("Found downloaded binary", {
        type,
        version: downloaded.version,
        path: downloaded.path.toString(),
      });
      return {
        available: true,
        source: "downloaded",
        path: downloaded.path,
        version: downloaded.version,
      };
    }

    // Not found
    this.logger.debug("Binary not found", { type });
    return {
      available: false,
      source: "not-found",
    };
  }

  /**
   * Check if a system-installed binary is available using --version.
   * This confirms the binary is both found and executable.
   *
   * @param type - Binary type to find
   * @returns true if binary is available, false otherwise
   */
  async findSystemBinary(type: ResolvableBinaryType): Promise<boolean> {
    // code-server is never system-installed
    if (type === "code-server") {
      return false;
    }

    const binaryName = type; // 'claude' or 'opencode'

    // Verify binary works with --version
    const proc = this.processRunner.run(binaryName, ["--version"]);
    const result = await proc.wait();

    return result.exitCode === 0;
  }

  /**
   * Find the latest downloaded version of a binary.
   *
   * @param type - Binary type to find
   * @returns Path and version or null if not found
   */
  async findLatestDownloaded(
    type: ResolvableBinaryType
  ): Promise<{ path: Path; version: string } | null> {
    const baseDir = this.getBinaryBaseDir(type);

    try {
      const entries = await this.fileSystem.readdir(baseDir);
      const versionDirs = entries.filter((e) => e.isDirectory).map((e) => e.name);

      if (versionDirs.length === 0) {
        return null;
      }

      // Sort versions and get highest
      const sortedVersions = versionDirs.sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true })
      );
      const latestVersion = sortedVersions[0];
      if (!latestVersion) {
        return null;
      }

      // Get binary path for this version
      const binaryPath = this.getBinaryPath(type, latestVersion);

      // Verify binary exists
      try {
        await this.fileSystem.readFile(binaryPath);
        return { path: binaryPath, version: latestVersion };
      } catch {
        // Binary doesn't exist in this version dir
        return null;
      }
    } catch {
      // Base directory doesn't exist
      return null;
    }
  }

  /**
   * Resolve an exact pinned version.
   */
  private async resolveExactVersion(
    type: ResolvableBinaryType,
    version: string
  ): Promise<BinaryResolution> {
    const binaryPath = this.getBinaryPath(type, version);

    try {
      await this.fileSystem.readFile(binaryPath);
      return {
        available: true,
        source: "downloaded",
        path: binaryPath,
        version,
      };
    } catch {
      return {
        available: false,
        source: "not-found",
      };
    }
  }

  /**
   * Get the base directory for a binary type.
   */
  private getBinaryBaseDir(type: ResolvableBinaryType): Path {
    return this.pathProvider.getBinaryBaseDir(type);
  }

  /**
   * Get the binary path for a specific version.
   */
  private getBinaryPath(type: ResolvableBinaryType, version: string): Path {
    return this.pathProvider.getBinaryPath(type, version);
  }
}

/**
 * Create a BinaryResolutionService instance.
 */
export function createBinaryResolutionService(
  deps: BinaryResolutionServiceDeps
): BinaryResolutionService {
  return new BinaryResolutionService(deps);
}
