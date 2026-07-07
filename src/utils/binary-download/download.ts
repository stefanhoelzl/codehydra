/**
 * Binary download and extraction utility.
 *
 * Takes I/O dependencies as parameters — does no direct I/O itself.
 */

import * as os from "node:os";
import * as path from "node:path";
import { BinaryDownloadError, getErrorMessage } from "../../shared/errors/service-errors.js";
import { FileSystemError } from "../../shared/errors/service-errors.js";
import type { DownloadRequest, DownloadProgressCallback } from "./types.js";
import type { ArchiveExtractor } from "../../boundaries/platform/archive-extractor.js";
import type { HttpClient } from "../../boundaries/platform/network.js";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem.js";
import type { Logger } from "../../boundaries/platform/logging-types.js";
import { Path } from "../path/path.js";

/**
 * Dependencies for binary download operations.
 */
export interface DownloadDeps {
  readonly httpClient: Pick<HttpClient, "fetch">;
  readonly fileSystemLayer: Pick<
    FileSystemBoundary,
    "readdir" | "writeFileBuffer" | "unlink" | "rename" | "rm" | "makeExecutable"
  >;
  readonly archiveExtractor: ArchiveExtractor;
  readonly logger?: Logger | undefined;
}

/**
 * Check if a binary is installed at the given destination directory.
 *
 * @param destDir - Directory to check
 * @param deps - I/O dependencies
 * @returns true if installed
 */
export async function isBinaryInstalled(
  destDir: string,
  deps: Pick<DownloadDeps, "fileSystemLayer" | "logger">
): Promise<boolean> {
  try {
    await deps.fileSystemLayer.readdir(destDir);
    deps.logger?.debug("Install check", { destDir, installed: true });
    return true;
  } catch (error) {
    if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
      deps.logger?.debug("Install check", { destDir, installed: false });
      return false;
    }
    // Re-throw unexpected errors
    throw error;
  }
}

/**
 * Download and extract a binary.
 *
 * @param request - Download request with URL, destination, etc.
 * @param deps - I/O dependencies
 * @param onProgress - Optional callback for progress updates
 * @throws BinaryDownloadError on failure
 */
export async function downloadBinary(
  request: DownloadRequest,
  deps: DownloadDeps,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const { name, url, destDir, executablePath, archiveExtension } = request;

  deps.logger?.info("Downloading", { name, url });

  const tempFile = path.join(os.tmpdir(), `${name}-${Date.now()}${archiveExtension}`);

  try {
    // Download to temp file
    await downloadToFile(url, tempFile, deps, onProgress);

    // Signal extraction phase before starting so the UI flips to "Extracting..."
    // immediately, even before the first progress callback arrives.
    if (onProgress) {
      onProgress({ phase: "extracting", bytesDownloaded: 0, totalBytes: null });
    }

    // Extract archive, forwarding extraction progress (unit-agnostic:
    // compressed bytes for tar, entry counts for zip).
    await deps.archiveExtractor.extract(tempFile, new Path(destDir), (processed, total) => {
      onProgress?.({ phase: "extracting", bytesDownloaded: processed, totalBytes: total });
    });

    // Promote subPath contents to destDir root if specified
    await extractSubPath(destDir, request.subPath ?? "", deps);

    // Set executable permissions on Unix
    if (executablePath && process.platform !== "win32") {
      await setExecutablePermissions(path.join(destDir, executablePath), deps);
    }

    deps.logger?.info("Download complete", { name });
  } catch (error) {
    deps.logger?.warn("Download failed", { name, error: getErrorMessage(error) });
    throw error;
  } finally {
    // Clean up temp file
    try {
      await deps.fileSystemLayer.unlink(tempFile);
    } catch {
      // Ignore cleanup errors (file might not exist)
    }
  }
}

/**
 * Download a file from URL to local path with progress reporting.
 * Buffers the download in memory and writes using FileSystemBoundary.
 */
async function downloadToFile(
  url: string,
  destPath: string,
  deps: DownloadDeps,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  let response: Response;
  try {
    // Use longer timeout for large binary downloads
    response = await deps.httpClient.fetch(url, { timeout: 300000 });
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

  // Write to file using FileSystemBoundary
  try {
    await deps.fileSystemLayer.writeFileBuffer(destPath, buffer);
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
async function extractSubPath(destDir: string, subPath: string, deps: DownloadDeps): Promise<void> {
  if (!subPath) {
    return;
  }

  deps.logger?.debug("Promoting subPath", { destDir, subPath });
  const nestedDir = path.join(destDir, subPath);

  let nestedEntries;
  try {
    nestedEntries = await deps.fileSystemLayer.readdir(nestedDir);
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
    await deps.fileSystemLayer.rename(src, dest);
  }

  // Remove the now-empty nested directory
  await deps.fileSystemLayer.rm(nestedDir, { recursive: true, force: true });
}

/**
 * Set executable permissions on the binary.
 */
async function setExecutablePermissions(binaryPath: string, deps: DownloadDeps): Promise<void> {
  try {
    await deps.fileSystemLayer.makeExecutable(binaryPath);
  } catch {
    // Ignore permission errors - the file might already be executable
  }
}
