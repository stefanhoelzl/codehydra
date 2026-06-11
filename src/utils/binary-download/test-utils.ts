/**
 * Test utilities for binary download module.
 *
 * Provides helpers for creating test archives.
 */

import * as tar from "tar";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

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
async function createTestTarGz(files: Record<string, string>): Promise<string> {
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
 * Clean up a test archive and its parent directory.
 *
 * @param archivePath - Path to the archive created by createTestTarGz
 */
export async function cleanupTestArchive(archivePath: string): Promise<void> {
  const parentDir = path.dirname(archivePath);
  await fs.rm(parentDir, { recursive: true, force: true });
}
