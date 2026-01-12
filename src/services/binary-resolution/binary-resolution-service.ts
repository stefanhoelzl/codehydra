/**
 * Binary resolution service for locating binaries.
 *
 * This service resolves binaries using the following priority:
 * 1. For pinned versions: check exact version in bundlesRoot
 * 2. For null versions (prefer system):
 *    a. Check system binary via which/where
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
  readonly platform: "darwin" | "linux" | "win32";
}

/**
 * Service for resolving binary paths.
 */
export class BinaryResolutionService {
  private readonly fileSystem: FileSystemLayer;
  private readonly processRunner: ProcessRunner;
  private readonly pathProvider: PathProvider;
  private readonly logger: Logger;
  private readonly platform: "darwin" | "linux" | "win32";

  constructor(deps: BinaryResolutionServiceDeps) {
    this.fileSystem = deps.fileSystem;
    this.processRunner = deps.processRunner;
    this.pathProvider = deps.pathProvider;
    this.logger = deps.logger;
    this.platform = deps.platform;
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
    // First check system binary
    const systemPath = await this.findSystemBinary(type);
    if (systemPath) {
      this.logger.debug("Found system binary", { type, path: systemPath.toString() });
      return {
        available: true,
        source: "system",
        path: systemPath,
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
   * Find a system-installed binary using which (Unix) or where (Windows).
   *
   * @param type - Binary type to find
   * @returns Path to binary or null if not found
   */
  async findSystemBinary(type: ResolvableBinaryType): Promise<Path | null> {
    // code-server is never system-installed
    if (type === "code-server") {
      return null;
    }

    const binaryName = type; // 'claude' or 'opencode'
    const command = this.platform === "win32" ? "where" : "which";

    const proc = this.processRunner.run(command, [binaryName]);
    const result = await proc.wait();

    // Exit code 0 means found
    if (result.exitCode === 0 && result.stdout.trim()) {
      // On Windows, 'where' can return multiple lines - use first
      const lines = result.stdout.trim().split("\n");
      const firstLine = lines[0];
      if (!firstLine) {
        return null;
      }
      const firstPath = firstLine.trim();

      // Verify the path is executable
      const isExecutable = await this.verifyExecutable(firstPath);
      if (isExecutable) {
        return new Path(firstPath);
      }
    }

    return null;
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

  /**
   * Verify that a path is an executable file.
   */
  private async verifyExecutable(pathStr: string): Promise<boolean> {
    try {
      // Try to read the file to verify it exists
      // On Unix, we could check permissions, but this is sufficient
      await this.fileSystem.readFile(new Path(pathStr));
      return true;
    } catch {
      return false;
    }
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
