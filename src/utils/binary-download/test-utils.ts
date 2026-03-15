/**
 * Test utilities for binary download module.
 *
 * Provides helpers for creating test archives and mocking GitHub API responses.
 */

import * as tar from "tar";
import archiver from "archiver";
import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Create a test zip archive from file contents.
 *
 * @param files - Map of relative file paths to their contents
 * @returns Path to the created archive (caller must clean up)
 *
 * @example
 * const archivePath = await createTestZip({
 *   'bin/my-binary.exe': 'binary content',
 *   'lib/config.json': '{"version": "1.0.0"}'
 * });
 * // Use archivePath in tests
 * await cleanupTestArchive(archivePath);
 */
export async function createTestZip(files: Record<string, string>): Promise<string> {
  // Create temp directory for the archive
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-archive-"));
  const archivePath = path.join(tempDir, "test.zip");

  return new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(archivePath));
    output.on("error", async (err) => {
      await fs.rm(tempDir, { recursive: true, force: true });
      reject(err);
    });
    archive.on("error", async (err) => {
      await fs.rm(tempDir, { recursive: true, force: true });
      reject(err);
    });

    archive.pipe(output);

    // Add files to archive
    for (const [relativePath, content] of Object.entries(files)) {
      archive.append(content, { name: relativePath });
    }

    archive.finalize();
  });
}

/**
 * Create a test zip archive with a nested root directory (common in GitHub releases).
 *
 * @param files - Map of relative file paths to their contents
 * @param rootDirName - Name of the root directory in the archive
 * @returns Path to the created archive (caller must clean up)
 *
 * @example
 * const archivePath = await createTestZipWithRoot({
 *   'bin/my-binary.exe': 'binary content'
 * }, 'my-binary-1.0.0-win32-x64');
 * // Archive contains: my-binary-1.0.0-win32-x64/bin/my-binary.exe
 */
export async function createTestZipWithRoot(
  files: Record<string, string>,
  rootDirName: string
): Promise<string> {
  // Prefix all paths with rootDirName
  const prefixedFiles: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(files)) {
    prefixedFiles[path.join(rootDirName, relativePath)] = content;
  }
  return createTestZip(prefixedFiles);
}

/**
 * Create a test tar.gz archive from file contents.
 *
 * @param files - Map of relative file paths to their contents
 * @returns Path to the created archive (caller must clean up)
 *
 * @example
 * const archivePath = await createTestTarGz({
 *   'bin/my-binary': '#!/bin/sh\necho hello',
 *   'lib/config.json': '{"version": "1.0.0"}'
 * });
 * // Use archivePath in tests
 * await fs.rm(archivePath); // Clean up
 */
export async function createTestTarGz(files: Record<string, string>): Promise<string> {
  // Create temp directory for source files
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-archive-"));
  const sourceDir = path.join(tempDir, "source");
  const archivePath = path.join(tempDir, "test.tar.gz");

  try {
    // Create source files
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(sourceDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    // Create archive
    await tar.create(
      {
        gzip: true,
        file: archivePath,
        cwd: sourceDir,
      },
      ["."]
    );

    // Clean up source dir (keep archive)
    await fs.rm(sourceDir, { recursive: true });

    return archivePath;
  } catch (error) {
    // Clean up on error
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Create a test tar.gz archive with a nested root directory (common in GitHub releases).
 *
 * @param files - Map of relative file paths to their contents
 * @param rootDirName - Name of the root directory in the archive
 * @returns Path to the created archive (caller must clean up)
 *
 * @example
 * const archivePath = await createTestTarGzWithRoot({
 *   'bin/my-binary': '#!/bin/sh\necho hello'
 * }, 'my-binary-1.0.0-linux-amd64');
 * // Archive contains: my-binary-1.0.0-linux-amd64/bin/my-binary
 */
export async function createTestTarGzWithRoot(
  files: Record<string, string>,
  rootDirName: string
): Promise<string> {
  // Prefix all paths with rootDirName
  const prefixedFiles: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(files)) {
    prefixedFiles[path.join(rootDirName, relativePath)] = content;
  }
  return createTestTarGz(prefixedFiles);
}

/**
 * Create a mock Response for a successful binary download.
 *
 * @param body - Response body as a Buffer or string
 * @param contentLength - Optional Content-Length header value
 * @returns Response object
 */
export function createMockDownloadResponse(
  body: Buffer | string,
  contentLength?: number
): Response {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  const headers = new Headers();

  if (contentLength !== undefined) {
    headers.set("Content-Length", contentLength.toString());
  }

  // Create a ReadableStream from the buffer
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers,
  });
}

/**
 * Create a mock GitHub release asset structure.
 */
export interface MockGitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

/**
 * Create a mock GitHub release API response.
 *
 * @param tag - Release tag (e.g., "v4.106.3")
 * @param assets - Array of asset definitions
 * @returns JSON string for the response
 */
export function createMockGitHubReleaseResponse(tag: string, assets: MockGitHubAsset[]): string {
  return JSON.stringify({
    tag_name: tag,
    name: tag,
    assets: assets.map((asset) => ({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: asset.size,
      content_type: asset.content_type,
    })),
  });
}

/**
 * Clean up a test archive and its parent directory.
 *
 * @param archivePath - Path to the archive created by createTestTarGz
 */
export async function cleanupTestArchive(archivePath: string): Promise<void> {
  const parentDir = path.dirname(archivePath);
  await fs.rm(parentDir, { recursive: true, force: true });
}
