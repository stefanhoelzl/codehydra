/**
 * Bin directory setup - copies CLI wrapper scripts to app-data/bin/.
 *
 * Extracted from VscodeSetupService. This is a standalone utility function
 * that copies declared wrapper scripts from assets/bin/ to the runtime
 * bin directory, cleaning stale scripts first.
 */

import type { FileSystemLayer } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";
import { Path } from "../platform/path";

/**
 * Set up the bin directory with CLI wrapper scripts.
 * Copies declared scripts from assets/bin/ to <app-data>/bin/.
 *
 * Steps:
 * 1. Remove existing bin directory (cleans stale scripts)
 * 2. Create fresh bin directory
 * 3. Copy each declared script from assets/bin/
 * 4. Set executable permissions on Unix (non-.cmd, non-.cjs files)
 *
 * @param fileSystem - FileSystemLayer for file operations
 * @param pathProvider - PathProvider for bin directory paths
 * @param scripts - File names to copy (collected from module configure hooks)
 */
export async function setupBinDirectory(
  fileSystem: FileSystemLayer,
  pathProvider: PathProvider,
  scripts: readonly string[]
): Promise<void> {
  const binDir = pathProvider.binDir;
  const binAssetsDir = pathProvider.binAssetsDir;

  // Clean bin directory to remove stale scripts before copying new ones
  await fileSystem.rm(binDir, { recursive: true, force: true });

  // Create bin directory
  await fileSystem.mkdir(binDir);

  // Copy declared scripts
  for (const name of scripts) {
    const srcPath = new Path(binAssetsDir, name);
    const destPath = new Path(binDir, name);

    await fileSystem.copyTree(srcPath, destPath);

    if (!name.endsWith(".cmd") && !name.endsWith(".cjs")) {
      await fileSystem.makeExecutable(destPath);
    }
  }
}
