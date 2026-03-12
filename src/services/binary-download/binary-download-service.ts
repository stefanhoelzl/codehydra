/**
 * Binary download service for fetching and extracting binaries.
 */

import * as os from "node:os";
import * as path from "node:path";
import { BinaryDownloadError, getErrorMessage } from "./errors.js";
import type { DownloadRequest, DownloadProgressCallback } from "./types.js";
import type { ArchiveExtractor } from "./archive-extractor.js";
import type { HttpClient } from "../platform/network.js";
import type { FileSystemLayer } from "../platform/filesystem.js";
import type { Logger } from "../logging/index.js";
import { FileSystemError } from "../errors.js";
import { Path } from "../platform/path.js";

/**
 * Service for downloading and managing binary distributions.
 */
export interface BinaryDownloadService {
  /**
   * Check if a binary is installed at the given destination directory.
   *
   * @param destDir - Directory to check
   * @returns true if installed
   */
  isInstalled(destDir: string): Promise<boolean>;

  /**
   * Download and extract a binary.
   *
   * @param request - Download request with URL, destination, etc.
   * @param onProgress - Optional callback for progress updates
   * @throws BinaryDownloadError on failure
   */
  download(request: DownloadRequest, onProgress?: DownloadProgressCallback): Promise<void>;
}

/**
 * Default implementation of BinaryDownloadService.
 */
export class DefaultBinaryDownloadService implements BinaryDownloadService {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly fileSystemLayer: FileSystemLayer,
    private readonly archiveExtractor: ArchiveExtractor,
    private readonly logger?: Logger
  ) {}

  async isInstalled(destDir: string): Promise<boolean> {
    try {
      await this.fileSystemLayer.readdir(destDir);
      this.logger?.debug("Install check", { destDir, installed: true });
      return true;
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
        this.logger?.debug("Install check", { destDir, installed: false });
        return false;
      }
      // Re-throw unexpected errors
      throw error;
    }
  }

  async download(request: DownloadRequest, onProgress?: DownloadProgressCallback): Promise<void> {
    const { name, url, destDir, executablePath } = request;

    this.logger?.info("Downloading", { name, url });

    // Preserve archive extension in temp file for extractor to detect format
    const urlPath = new URL(url).pathname;
    const urlExtension = urlPath.endsWith(".tar.gz")
      ? ".tar.gz"
      : urlPath.endsWith(".tgz")
        ? ".tgz"
        : urlPath.endsWith(".zip")
          ? ".zip"
          : ".archive";
    const tempFile = path.join(os.tmpdir(), `${name}-${Date.now()}${urlExtension}`);

    try {
      // Download to temp file
      await this.downloadToFile(url, tempFile, onProgress);

      // Signal extraction phase before starting
      if (onProgress) {
        onProgress({ phase: "extracting", bytesDownloaded: 0, totalBytes: null });
      }

      // Extract archive
      await this.archiveExtractor.extract(tempFile, new Path(destDir));

      // Promote subPath contents to destDir root if specified
      await this.extractSubPath(destDir, request.subPath ?? "");

      // Set executable permissions on Unix
      if (executablePath && process.platform !== "win32") {
        await this.setExecutablePermissions(path.join(destDir, executablePath));
      }

      this.logger?.info("Download complete", { name });
    } catch (error) {
      this.logger?.warn("Download failed", { name, error: getErrorMessage(error) });
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
      throw new BinaryDownloadError(
        `Network error downloading from ${url}: ${getErrorMessage(error)}`,
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
          onProgress({ phase: "downloading", bytesDownloaded, totalBytes: total });
        }
      }
    } catch (error) {
      throw new BinaryDownloadError(
        `Failed to read download from ${url}: ${getErrorMessage(error)}`,
        "NETWORK_ERROR"
      );
    }

    // Concatenate chunks into a single buffer
    const buffer = Buffer.concat(chunks);

    // Write to file using FileSystemLayer
    try {
      await this.fileSystemLayer.writeFileBuffer(destPath, buffer);
    } catch (error) {
      throw new BinaryDownloadError(
        `Failed to write download to ${destPath}: ${getErrorMessage(error)}`,
        "EXTRACTION_FAILED"
      );
    }
  }

  /**
   * Promote contents of destDir/subPath to destDir root.
   * If subPath is empty, content is already at root — nothing to do.
   */
  private async extractSubPath(destDir: string, subPath: string): Promise<void> {
    if (!subPath) {
      return;
    }

    this.logger?.debug("Promoting subPath", { destDir, subPath });
    const nestedDir = path.join(destDir, subPath);

    let nestedEntries;
    try {
      nestedEntries = await this.fileSystemLayer.readdir(nestedDir);
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
        throw new BinaryDownloadError(
          `Expected subPath "${subPath}" not found in extracted archive at ${nestedDir}`,
          "EXTRACTION_FAILED"
        );
      }
      throw error;
    }

    // Use rename (atomic move) instead of copy+delete
    for (const entry of nestedEntries) {
      const src = path.join(nestedDir, entry.name);
      const dest = path.join(destDir, entry.name);
      await this.fileSystemLayer.rename(src, dest);
    }

    // Remove the now-empty nested directory
    await this.fileSystemLayer.rm(nestedDir, { recursive: true, force: true });
  }

  /**
   * Set executable permissions on the binary.
   */
  private async setExecutablePermissions(binaryPath: string): Promise<void> {
    try {
      await this.fileSystemLayer.makeExecutable(binaryPath);
    } catch {
      // Ignore permission errors - the file might already be executable
    }
  }
}
