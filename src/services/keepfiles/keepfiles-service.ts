/**
 * KeepFilesService - copies gitignored files to new workspaces.
 *
 * Uses .keepfiles config with inverted gitignore semantics:
 * - Listed patterns = files/directories TO COPY (not ignore)
 * - `!` prefix = EXCLUDE from copying
 */

import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileSystemLayer } from "../platform/filesystem";
import type { IKeepFilesService, CopyResult, CopyError } from "./types";
import type { Logger } from "../logging";
import { getErrorMessage } from "../errors";
import type { Path } from "../platform/path";

/**
 * Configuration file name for keep files patterns.
 */
const KEEPFILES_CONFIG = ".keepfiles";

/**
 * UTF-8 BOM character to strip from config file.
 */
const UTF8_BOM = "\ufeff";

/**
 * Service that copies files matching .keepfiles patterns from project root
 * to new workspaces.
 *
 * The `ignore` package is a pure pattern-matching library with no I/O,
 * so direct usage is acceptable (documented exception to interface rule).
 */
export class KeepFilesService implements IKeepFilesService {
  constructor(
    private readonly fileSystem: FileSystemLayer,
    private readonly logger: Logger
  ) {}

  async copyToWorkspace(projectRoot: Path, targetPath: Path): Promise<CopyResult> {
    // Convert Path objects to strings at entry for internal node:path operations
    const projectRootStr = projectRoot.toString();
    const targetPathStr = targetPath.toString();

    // Try to read .keepfiles config
    const configPath = path.join(projectRootStr, KEEPFILES_CONFIG);
    let configContent: string;

    try {
      configContent = await this.fileSystem.readFile(configPath);
    } catch (error) {
      // Check if it's ENOENT (file not found)
      if (error instanceof Error && "fsCode" in error && error.fsCode === "ENOENT") {
        this.logger.debug("No .keepfiles found", { path: projectRootStr });
        return {
          configExists: false,
          copiedCount: 0,
          skippedCount: 0,
          errors: [],
        };
      }
      throw error;
    }

    // Strip UTF-8 BOM if present
    if (configContent.startsWith(UTF8_BOM)) {
      configContent = configContent.slice(1);
    }

    // Parse patterns and validate
    const patterns = this.parsePatterns(configContent);
    this.logger.debug("Parsed .keepfiles", { patterns: patterns.length });

    // If no patterns, nothing to copy
    if (patterns.length === 0) {
      return {
        configExists: true,
        copiedCount: 0,
        skippedCount: 0,
        errors: [],
      };
    }

    // Create ignore instance with patterns
    // INVERTED SEMANTICS: ig.ignores(path) === true means COPY the file
    const ig = ignore().add(patterns);

    // Create a second ignore instance with only positive patterns
    // Used to detect files that were excluded by negation
    const positivePatterns = patterns.filter((p) => !p.startsWith("!"));
    const igPositive = ignore().add(positivePatterns);

    this.logger.debug("CopyKeepFiles", { src: projectRootStr, dest: targetPathStr });

    // Scan and copy matching files
    const result = await this.scanAndCopy(projectRootStr, targetPathStr, ig, igPositive);

    // Log completion or errors
    if (result.errors.length > 0) {
      this.logger.warn("CopyKeepFiles failed", { error: `${result.errors.length} errors` });
    } else {
      this.logger.debug("CopyKeepFiles complete", {
        copied: result.copiedCount,
        skipped: result.skippedCount,
      });
    }

    return result;
  }

  /**
   * Parse patterns from config content.
   * Skips empty lines and comments.
   */
  private parsePatterns(content: string): string[] {
    const lines = content.split(/\r?\n/);
    const patterns: string[] = [];

    for (const line of lines) {
      // Skip empty lines and whitespace-only lines
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }

      // Skip comments
      if (trimmed.startsWith("#")) {
        continue;
      }

      patterns.push(trimmed);
    }

    return patterns;
  }

  /**
   * Scan project root and copy matching files to target.
   * Uses queue-based iteration (not recursion).
   *
   * @param ig - Ignore instance with all patterns (including negation)
   * @param igPositive - Ignore instance with only positive patterns (for skip counting)
   */
  private async scanAndCopy(
    projectRoot: string,
    targetPath: string,
    ig: Ignore,
    igPositive: Ignore
  ): Promise<CopyResult> {
    let copiedCount = 0;
    let skippedCount = 0;
    const errors: CopyError[] = [];

    // Normalize target path for traversal validation
    const normalizedTarget = path.normalize(targetPath);

    // Queue contains relative paths to scan
    const queue: string[] = [""];

    while (queue.length > 0) {
      const relativePath = queue.shift()!;
      const absolutePath = path.join(projectRoot, relativePath);

      // Read directory entries
      let entries;
      try {
        entries = await this.fileSystem.readdir(absolutePath);
      } catch (error) {
        errors.push({ path: relativePath || ".", message: getErrorMessage(error) });
        continue;
      }

      for (const entry of entries) {
        const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
        const entrySrcPath = path.join(projectRoot, entryRelativePath);
        const entryDestPath = path.join(targetPath, entryRelativePath);

        // Security: validate destination path stays within target
        const normalizedDest = path.normalize(entryDestPath);
        if (
          !normalizedDest.startsWith(normalizedTarget + path.sep) &&
          normalizedDest !== normalizedTarget
        ) {
          errors.push({ path: entryRelativePath, message: "Path traversal detected" });
          continue;
        }

        // Skip symlinks for security
        if (entry.isSymbolicLink) {
          // Only count if it would have matched
          // For symlinks, check both with and without trailing slash
          const pathToCheck = entry.isDirectory ? entryRelativePath + "/" : entryRelativePath;
          if (ig.ignores(pathToCheck)) {
            skippedCount++;
          }
          continue;
        }

        // Check if path matches patterns (inverted semantics)
        // For directories, append "/" to match patterns like "dir/"
        const pathToCheck = entry.isDirectory ? entryRelativePath + "/" : entryRelativePath;
        const shouldCopy = ig.ignores(pathToCheck);

        if (entry.isDirectory) {
          // Always add directories to queue for scanning
          // This allows negation patterns within directories to work correctly
          queue.push(entryRelativePath);
        } else if (entry.isFile) {
          // For files, check if pattern matches (considering negation)
          if (shouldCopy) {
            // Copy matching file
            const result = await this.tryCopyTree(entrySrcPath, entryDestPath);
            if (result.success) {
              copiedCount += 1;
            } else {
              errors.push({ path: entryRelativePath, message: result.error! });
            }
          } else {
            // File was excluded - check if it was due to negation pattern
            // (Would have matched a positive pattern but was negated)
            if (igPositive.ignores(pathToCheck)) {
              skippedCount++;
            }
          }
        }
      }
    }

    return {
      configExists: true,
      copiedCount,
      skippedCount,
      errors,
    };
  }

  /**
   * Try to copy a file or directory tree, catching errors.
   */
  private async tryCopyTree(
    src: string,
    dest: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.fileSystem.copyTree(src, dest);
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }
}
