/**
 * Bin directory setup - copies CLI wrapper scripts to app-data/bin/.
 *
 * Extracted from VscodeSetupService. This is a standalone utility function
 * that copies pre-built wrapper scripts from assets/bin/ to the runtime
 * bin directory, cleaning stale scripts first.
 */

import type { FileSystemLayer } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";
import { Path } from "../platform/path";

/**
 * Set up the bin directory with CLI wrapper scripts.
 * Copies pre-built scripts from assets/bin/ to <app-data>/bin/.
 *
 * Steps:
 * 1. Remove existing bin directory (cleans stale scripts)
 * 2. Create fresh bin directory
 * 3. Copy all files from assets/bin/
 * 4. Set executable permissions on Unix (non-.cmd, non-.cjs files)
 *
 * @param fileSystem - FileSystemLayer for file operations
 * @param pathProvider - PathProvider for bin directory paths
 */
export async function setupBinDirectory(
  fileSystem: FileSystemLayer,
  pathProvider: PathProvider
): Promise<void> {
  const binDir = pathProvider.binDir;
  const binAssetsDir = pathProvider.binAssetsDir;

  // Clean bin directory to remove stale scripts before copying new ones
  await fileSystem.rm(binDir, { recursive: true, force: true });

  // Create bin directory
  await fileSystem.mkdir(binDir);

  // List and copy all files from assets/bin/
  const assetEntries = await fileSystem.readdir(binAssetsDir);

  for (const entry of assetEntries) {
    // Skip directories
    if (entry.isDirectory) {
      continue;
    }

    const srcPath = new Path(binAssetsDir, entry.name);
    const destPath = new Path(binDir, entry.name);

    // Copy file
    await fileSystem.copyTree(srcPath, destPath);

    // Set executable permissions on Unix for files without .cmd extension
    if (!entry.name.endsWith(".cmd") && !entry.name.endsWith(".cjs")) {
      await fileSystem.makeExecutable(destPath);
    }
  }
}
