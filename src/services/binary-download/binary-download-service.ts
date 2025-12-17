/**
 * Binary download service for fetching code-server and opencode binaries.
 */

import * as os from "node:os";
import * as path from "node:path";
import { BinaryDownloadError } from "./errors.js";
import { BINARY_CONFIGS, CODE_SERVER_VERSION, OPENCODE_VERSION } from "./versions.js";
import type { BinaryType, DownloadProgressCallback, SupportedPlatform } from "./types.js";
import type { ArchiveExtractor } from "./archive-extractor.js";
import type { HttpClient } from "../platform/network.js";
import type { FileSystemLayer } from "../platform/filesystem.js";
import type { PathProvider } from "../platform/path-provider.js";
import type { PlatformInfo } from "../platform/platform-info.js";
import type { Logger } from "../logging/index.js";
import { FileSystemError } from "../errors.js";

/**
 * Service for downloading and managing binary distributions.
 */
export interface BinaryDownloadService {
  /**
   * Check if a binary is installed at the correct version.
   *
   * @param binary - Type of binary to check
   * @returns true if installed at correct version
   */
  isInstalled(binary: BinaryType): Promise<boolean>;

  /**
   * Download and extract a binary.
   *
   * @param binary - Type of binary to download
   * @param onProgress - Optional callback for progress updates
   * @throws BinaryDownloadError on failure
   */
  download(binary: BinaryType, onProgress?: DownloadProgressCallback): Promise<void>;

  /**
   * Get the absolute path to the binary executable.
   *
   * @param binary - Type of binary
   * @returns Absolute path to the binary executable
   */
  getBinaryPath(binary: BinaryType): string;

  /**
   * Create wrapper scripts in binDir for all installed binaries.
   */
  createWrapperScripts(): Promise<void>;
}

/**
 * Default implementation of BinaryDownloadService.
 */
export class DefaultBinaryDownloadService implements BinaryDownloadService {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly fileSystemLayer: FileSystemLayer,
    private readonly archiveExtractor: ArchiveExtractor,
    private readonly pathProvider: PathProvider,
    private readonly platformInfo: PlatformInfo,
    private readonly logger?: Logger
  ) {}

  async isInstalled(binary: BinaryType): Promise<boolean> {
    // Check if binary directory exists by attempting to read it
    // The executable permission check is redundant since we call makeExecutable() after extraction anyway
    const binaryDir = this.getBinaryDir(binary);
    try {
      await this.fileSystemLayer.readdir(binaryDir);
      this.logger?.debug("Install check", { binary, installed: true });
      return true;
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
        this.logger?.debug("Install check", { binary, installed: false });
        return false;
      }
      // Re-throw unexpected errors
      throw error;
    }
  }

  async download(binary: BinaryType, onProgress?: DownloadProgressCallback): Promise<void> {
    const config = BINARY_CONFIGS[binary];
    const platform = this.platformInfo.platform as SupportedPlatform;
    const arch = this.platformInfo.arch;

    // Validate platform
    if (!["darwin", "linux", "win32"].includes(platform)) {
      throw new BinaryDownloadError(
        `Unsupported platform: ${platform}. Supported: darwin, linux, win32`,
        "UNSUPPORTED_PLATFORM"
      );
    }

    // Get download URL (will throw for unsupported platform/arch combinations)
    let url: string;
    try {
      url = config.getUrl(platform, arch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BinaryDownloadError(message, "UNSUPPORTED_PLATFORM");
    }

    this.logger?.info("Downloading", { binary, url, platform, arch });

    // Determine destination directory
    const destDir = this.getBinaryDir(binary);

    // Preserve archive extension in temp file for extractor to detect format
    const urlPath = new URL(url).pathname;
    const urlExtension = urlPath.endsWith(".tar.gz")
      ? ".tar.gz"
      : urlPath.endsWith(".tgz")
        ? ".tgz"
        : urlPath.endsWith(".zip")
          ? ".zip"
          : ".archive";
    const tempFile = path.join(
      os.tmpdir(),
      `${binary}-${config.version}-${Date.now()}${urlExtension}`
    );

    try {
      // Download to temp file
      await this.downloadToFile(url, tempFile, onProgress);

      // Extract archive
      await this.archiveExtractor.extract(tempFile, destDir);

      // Handle nested directory structure (common in releases)
      await this.flattenExtractedDir(destDir);

      // Set executable permissions on Unix
      if (platform !== "win32") {
        await this.setExecutablePermissions(binary);
      }

      this.logger?.info("Download complete", { binary });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.warn("Download failed", { binary, error: errorMessage });
      throw error;
    } finally {
      // Clean up temp file
      try {
        await this.fileSystemLayer.unlink(tempFile);
      } catch {
        // Ignore cleanup errors (file might not exist)
      }
    }
  }

  getBinaryPath(binary: BinaryType): string {
    const config = BINARY_CONFIGS[binary];
    const platform = this.platformInfo.platform as SupportedPlatform;
    const destDir = this.getBinaryDir(binary);
    const relativePath = config.extractedBinaryPath(platform);
    return path.join(destDir, relativePath);
  }

  async createWrapperScripts(): Promise<void> {
    const binDir = this.pathProvider.binDir;
    this.logger?.debug("Creating wrapper scripts", { binDir });
    await this.fileSystemLayer.mkdir(binDir, { recursive: true });

    const platform = this.platformInfo.platform;
    const isWindows = platform === "win32";

    // Create wrapper scripts for both binaries
    for (const binary of ["code-server", "opencode"] as const) {
      const binaryPath = this.getBinaryPath(binary);
      const scriptName = binary + (isWindows ? ".cmd" : "");
      const scriptPath = path.join(binDir, scriptName);

      const content = isWindows
        ? this.createWindowsWrapper(binaryPath)
        : this.createUnixWrapper(binaryPath);

      await this.fileSystemLayer.writeFile(scriptPath, content);

      // Make executable on Unix (no-op on Windows)
      await this.fileSystemLayer.makeExecutable(scriptPath);
    }
  }

  /**
   * Get the directory where a binary is installed.
   */
  private getBinaryDir(binary: BinaryType): string {
    const version = binary === "code-server" ? CODE_SERVER_VERSION : OPENCODE_VERSION;
    return path.join(this.pathProvider.dataRootDir, binary, version);
  }

  /**
   * Download a file from URL to local path with progress reporting.
   * Buffers the download in memory and writes using FileSystemLayer.
   */
  private async downloadToFile(
    url: string,
    destPath: string,
    onProgress?: DownloadProgressCallback
  ): Promise<void> {
    let response: Response;
    try {
      // Use longer timeout for large binary downloads
      response = await this.httpClient.fetch(url, { timeout: 300000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BinaryDownloadError(
        `Network error downloading from ${url}: ${message}`,
        "NETWORK_ERROR"
      );
    }

    if (!response.ok) {
      throw new BinaryDownloadError(
        `HTTP ${response.status} downloading from ${url}`,
        "NETWORK_ERROR"
      );
    }

    const totalBytes = response.headers.get("content-length");
    const total = totalBytes ? parseInt(totalBytes, 10) : null;

    if (!response.body) {
      throw new BinaryDownloadError("Response body is null", "NETWORK_ERROR");
    }

    // Buffer download in memory with progress tracking
    const chunks: Uint8Array[] = [];
    let bytesDownloaded = 0;
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        bytesDownloaded += value.byteLength;

        if (onProgress) {
          onProgress({ bytesDownloaded, totalBytes: total });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BinaryDownloadError(
        `Failed to read download from ${url}: ${message}`,
        "NETWORK_ERROR"
      );
    }

    // Concatenate chunks into a single buffer
    const buffer = Buffer.concat(chunks);

    // Write to file using FileSystemLayer
    try {
      await this.fileSystemLayer.writeFileBuffer(destPath, buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BinaryDownloadError(
        `Failed to write download to ${destPath}: ${message}`,
        "EXTRACTION_FAILED"
      );
    }
  }

  /**
   * Handle nested directory structure common in release archives.
   * Many archives extract to a directory like "code-server-4.106.3-linux-amd64/"
   */
  private async flattenExtractedDir(destDir: string): Promise<void> {
    this.logger?.debug("Flattening directory", { dir: destDir });
    const entries = await this.fileSystemLayer.readdir(destDir);

    // If there's exactly one directory entry that looks like a release dir, move its contents up
    const firstEntry = entries[0];
    if (entries.length === 1 && firstEntry?.isDirectory) {
      const nestedDir = path.join(destDir, firstEntry.name);
      const nestedEntries = await this.fileSystemLayer.readdir(nestedDir);

      // Move all contents up using copyTree + rm (FileSystemLayer doesn't have rename)
      for (const entry of nestedEntries) {
        const src = path.join(nestedDir, entry.name);
        const dest = path.join(destDir, entry.name);

        // Copy then remove (FileSystemLayer doesn't have rename)
        await this.fileSystemLayer.copyTree(src, dest);
        await this.fileSystemLayer.rm(src, { recursive: true });
      }

      // Remove the now-empty nested directory
      await this.fileSystemLayer.rm(nestedDir, { recursive: true });
    }
  }

  /**
   * Set executable permissions on the binary.
   */
  private async setExecutablePermissions(binary: BinaryType): Promise<void> {
    const binaryPath = this.getBinaryPath(binary);
    try {
      await this.fileSystemLayer.makeExecutable(binaryPath);
    } catch {
      // Ignore permission errors - the file might already be executable
    }
  }

  /**
   * Create a Unix shell wrapper script.
   */
  private createUnixWrapper(binaryPath: string): string {
    return `#!/bin/sh
exec "${binaryPath}" "$@"
`;
  }

  /**
   * Create a Windows batch wrapper script.
   */
  private createWindowsWrapper(binaryPath: string): string {
    // Use forward slashes in Windows paths for cmd compatibility
    const normalizedPath = binaryPath.replace(/\//g, "\\");
    return `@echo off
"${normalizedPath}" %*
`;
  }
}
