/**
 * Binary download and extraction utility.
 *
 * Takes I/O dependencies as parameters — does no direct I/O itself.
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { BinaryDownloadError, getErrorMessage } from "../../shared/errors/service-errors.js";
import { FileSystemError } from "../../shared/errors/service-errors.js";
import type { ArchiveDownloadRequest, DownloadRequest, DownloadProgressCallback } from "./types.js";
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
    "readdir" | "writeFileBuffer" | "unlink" | "rename" | "rm" | "makeExecutable" | "mkdir"
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
 * Download a binary: extract an archive, or save a single executable file.
 *
 * On failure `destDir` is removed, so a half-written install never looks
 * installed to the next check. Callers only download into a directory that is
 * not installed yet.
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
  const { name, url, destDir } = request;

  deps.logger?.info("Downloading", { name, url });

  try {
    const buffer = await downloadToBuffer(url, deps, onProgress);
    if (request.sha256 !== undefined) {
      verifySha256(buffer, request.sha256, url);
    }

    if (request.archiveExtension === undefined) {
      await saveExecutable(buffer, destDir, request.executablePath, deps);
    } else {
      await extractArchive(buffer, request, deps, onProgress);
    }

    deps.logger?.info("Download complete", { name });
  } catch (error) {
    deps.logger?.warn("Download failed", { name, error: getErrorMessage(error) });
    try {
      await deps.fileSystemLayer.rm(destDir, { recursive: true, force: true });
    } catch {
      // Best effort: the original error is what the caller needs
    }
    throw error;
  }
}

/**
 * Write the archive to a temp file and extract it into `destDir`.
 */
async function extractArchive(
  buffer: Buffer,
  request: ArchiveDownloadRequest,
  deps: DownloadDeps,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const { name, destDir, executablePath, archiveExtension } = request;
  const tempFile = path.join(os.tmpdir(), `${name}-${Date.now()}${archiveExtension}`);

  try {
    await writeBuffer(tempFile, buffer, deps);

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
 * Save a single executable as `destDir/executablePath`. Written under a temp
 * name in the same directory and renamed, so the final name only ever holds a
 * complete file.
 */
async function saveExecutable(
  buffer: Buffer,
  destDir: string,
  executablePath: string,
  deps: DownloadDeps
): Promise<void> {
  const finalPath = path.join(destDir, executablePath);
  const partialPath = `${finalPath}.partial`;

  try {
    await deps.fileSystemLayer.mkdir(destDir);
  } catch (error) {
    throw new BinaryDownloadError(
      `Failed to create ${destDir}: ${getErrorMessage(error)}`,
      "EXTRACTION_FAILED"
    );
  }
  await writeBuffer(partialPath, buffer, deps);
  if (process.platform !== "win32") {
    await setExecutablePermissions(partialPath, deps);
  }
  await deps.fileSystemLayer.rename(partialPath, finalPath);
}

/**
 * Fail unless `buffer` hashes to `expected` (hex, case-insensitive).
 */
function verifySha256(buffer: Buffer, expected: string, url: string): void {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected.toLowerCase()) {
    // NETWORK_ERROR: the bytes that arrived are not the bytes that were published.
    throw new BinaryDownloadError(
      `Checksum mismatch downloading from ${url}: expected sha256 ${expected}, got ${actual}`,
      "NETWORK_ERROR"
    );
  }
}

/**
 * Download a URL into memory with progress reporting.
 */
async function downloadToBuffer(
  url: string,
  deps: DownloadDeps,
  onProgress?: DownloadProgressCallback
): Promise<Buffer> {
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

  return Buffer.concat(chunks);
}

/**
 * Write downloaded bytes through FileSystemBoundary.
 */
async function writeBuffer(destPath: string, buffer: Buffer, deps: DownloadDeps): Promise<void> {
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
