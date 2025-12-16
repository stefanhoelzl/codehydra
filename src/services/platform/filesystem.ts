/**
 * FileSystemLayer - Abstraction over filesystem operations.
 *
 * Provides an injectable interface for filesystem access, enabling:
 * - Unit testing of services with mock FileSystemLayer
 * - Boundary testing of DefaultFileSystemLayer against real filesystem
 * - Consistent error handling via FileSystemError
 */

/**
 * Directory entry returned by readdir.
 */
export interface DirEntry {
  /** Entry name (not full path) */
  readonly name: string;
  /** True if entry is a directory */
  readonly isDirectory: boolean;
  /** True if entry is a regular file */
  readonly isFile: boolean;
  /** True if entry is a symbolic link */
  readonly isSymbolicLink: boolean;
}

/**
 * Options for mkdir operation.
 */
export interface MkdirOptions {
  /** Create parent directories if they don't exist (default: true) */
  readonly recursive?: boolean;
}

/**
 * Options for rm operation.
 */
export interface RmOptions {
  /** Remove directories and their contents recursively (default: false) */
  readonly recursive?: boolean;
  /** Ignore errors if path doesn't exist (default: false) */
  readonly force?: boolean;
}

/**
 * Result of a copyTree operation.
 */
export interface CopyTreeResult {
  /** Number of files copied */
  readonly copiedCount: number;
  /** Paths of symlinks that were skipped (security - prevents symlink attacks) */
  readonly skippedSymlinks: readonly string[];
}

/**
 * Error codes for filesystem operations.
 */
export type FileSystemErrorCode =
  | "ENOENT" // File/directory not found
  | "EACCES" // Permission denied
  | "EEXIST" // File/directory already exists
  | "ENOTDIR" // Not a directory
  | "EISDIR" // Is a directory (when file expected)
  | "ENOTEMPTY" // Directory not empty
  | "UNKNOWN"; // Other errors (check originalCode)

/**
 * Abstraction over filesystem operations.
 * Enables unit testing of services that need filesystem access.
 *
 * All paths are absolute. All text operations use UTF-8 encoding.
 * Methods throw FileSystemError on failures.
 *
 * NOTE: No exists() method - use try/catch on actual operations to avoid TOCTOU races.
 */
export interface FileSystemLayer {
  /**
   * Read entire file as UTF-8 string.
   *
   * @param path - Absolute path to file
   * @returns File contents as string
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   *
   * @example
   * const content = await fs.readFile('/path/to/config.json');
   * const config = JSON.parse(content);
   */
  readFile(path: string): Promise<string>;

  /**
   * Write content to file. Overwrites existing file.
   *
   * @param path - Absolute path to file
   * @param content - String content to write (UTF-8)
   * @throws FileSystemError with code ENOENT if parent directory doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   *
   * @example
   * await fs.writeFile('/path/to/config.json', JSON.stringify(data, null, 2));
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Create directory. Creates parent directories by default.
   * No-op if directory already exists.
   *
   * @param path - Absolute path to directory
   * @param options - mkdir options (recursive defaults to true)
   * @throws FileSystemError with code EEXIST if path exists as a file
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example
   * await fs.mkdir('/path/to/new/directory');
   */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;

  /**
   * List directory contents.
   *
   * @param path - Absolute path to directory
   * @returns Array of directory entries with type information
   * @throws FileSystemError with code ENOENT if directory not found
   * @throws FileSystemError with code ENOTDIR if path is not a directory
   *
   * @example
   * const entries = await fs.readdir('/path/to/dir');
   * const subdirs = entries.filter(e => e.isDirectory);
   */
  readdir(path: string): Promise<readonly DirEntry[]>;

  /**
   * Delete a file.
   *
   * @param path - Absolute path to file
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EISDIR if path is a directory
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example
   * await fs.unlink('/path/to/file.txt');
   */
  unlink(path: string): Promise<void>;

  /**
   * Delete file or directory.
   *
   * @param path - Absolute path to file or directory
   * @param options - rm options
   * @param options.recursive - If true, remove directory contents (default: false)
   * @param options.force - If true, ignore ENOENT errors (default: false)
   * @throws FileSystemError with code ENOENT if path not found (unless force: true)
   * @throws FileSystemError with code ENOTEMPTY if directory not empty (unless recursive: true)
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Remove file
   * await fs.rm('/path/to/file.txt');
   *
   * @example Remove directory tree
   * await fs.rm('/path/to/dir', { recursive: true });
   *
   * @example Remove if exists (no error if missing)
   * await fs.rm('/path/to/maybe', { force: true });
   *
   * @example Remove empty directory only
   * await fs.rm('/path/to/empty-dir');
   */
  rm(path: string, options?: RmOptions): Promise<void>;

  /**
   * Copy a file or directory tree to a new location.
   *
   * Uses fs.copyFile() internally for correct binary file handling.
   * Symlinks are skipped for security reasons and reported in the result.
   * Overwrites existing files at destination.
   * Creates destination parent directories if they don't exist.
   *
   * @param src - Absolute path to source file or directory
   * @param dest - Absolute path to destination
   * @returns Result with copy count and skipped symlinks
   * @throws FileSystemError with code ENOENT if source doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Copy single file
   * const result = await fs.copyTree('/src/config.json', '/dest/config.json');
   *
   * @example Copy directory
   * const result = await fs.copyTree('/src/configs', '/dest/configs');
   * console.log(`Copied ${result.copiedCount} files`);
   */
  copyTree(src: string, dest: string): Promise<CopyTreeResult>;

  /**
   * Make a file executable (sets mode 0o755).
   * On Windows, this is a no-op since executability is determined by file extension.
   *
   * @param path - Absolute path to file
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Make script executable
   * await fs.makeExecutable('/path/to/script.sh');
   */
  makeExecutable(path: string): Promise<void>;
}

// ============================================================================
// Helper Functions
// ============================================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileSystemError } from "../errors";
import type { Logger } from "../logging";

/**
 * Known error codes that map to FileSystemErrorCode.
 */
const KNOWN_ERROR_CODES = new Set(["ENOENT", "EACCES", "EEXIST", "ENOTDIR", "EISDIR", "ENOTEMPTY"]);

/**
 * SystemError info structure for fs.rm() errors.
 * Node.js rm() returns errors with ERR_FS_* codes and info.code containing POSIX code.
 */
interface SystemErrorInfo {
  readonly code?: string;
  readonly message?: string;
  readonly path?: string;
  readonly syscall?: string;
}

/**
 * Extract the POSIX error code from a Node.js error.
 * Handles both ErrnoException (regular fs errors) and SystemError (rm errors).
 *
 * @param error - The Node.js error object
 * @returns The POSIX error code (e.g., "ENOENT") or undefined
 */
function extractErrorCode(error: Error): string | undefined {
  const nodeError = error as NodeJS.ErrnoException & { info?: SystemErrorInfo };

  // First check if it's a SystemError from fs.rm() with info.code
  // These have codes like ERR_FS_EISDIR but info.code contains "EISDIR"
  if (nodeError.info?.code) {
    return nodeError.info.code;
  }

  // Otherwise use the standard error.code property
  return nodeError.code;
}

/**
 * Map a Node.js filesystem error to a FileSystemError.
 *
 * @param error - The original Node.js error
 * @param path - The filesystem path that caused the error
 * @returns A FileSystemError with mapped error code
 */
function mapError(error: unknown, path: string): FileSystemError {
  if (!(error instanceof Error)) {
    return new FileSystemError("UNKNOWN", path, String(error));
  }

  const code = extractErrorCode(error);

  if (code && KNOWN_ERROR_CODES.has(code)) {
    return new FileSystemError(code as FileSystemErrorCode, path, error.message, error);
  }

  // Unknown error code - preserve original code
  return new FileSystemError("UNKNOWN", path, error.message, error, code);
}

// ============================================================================
// DefaultFileSystemLayer Implementation
// ============================================================================

/**
 * Default implementation of FileSystemLayer using node:fs/promises.
 * Maps Node.js errors to FileSystemError for consistent error handling.
 */
export class DefaultFileSystemLayer implements FileSystemLayer {
  constructor(private readonly logger: Logger) {}

  async readFile(filePath: string): Promise<string> {
    this.logger.debug("Read", { path: filePath });
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (error) {
      const fsError = mapError(error, filePath);
      this.logger.warn("Read failed", {
        path: filePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.logger.debug("Write", { path: filePath });
    try {
      await fs.writeFile(filePath, content, "utf-8");
    } catch (error) {
      const fsError = mapError(error, filePath);
      this.logger.warn("Write failed", {
        path: filePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async mkdir(dirPath: string, options?: MkdirOptions): Promise<void> {
    const recursive = options?.recursive ?? true;
    this.logger.debug("Mkdir", { path: dirPath });
    try {
      await fs.mkdir(dirPath, { recursive });
    } catch (error) {
      const fsError = mapError(error, dirPath);
      this.logger.warn("Mkdir failed", {
        path: dirPath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async readdir(dirPath: string): Promise<readonly DirEntry[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const result = entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
      this.logger.debug("Readdir", { path: dirPath, count: result.length });
      return result;
    } catch (error) {
      const fsError = mapError(error, dirPath);
      this.logger.warn("Readdir failed", {
        path: dirPath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async unlink(filePath: string): Promise<void> {
    this.logger.debug("Unlink", { path: filePath });
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const fsError = mapError(error, filePath);
      this.logger.warn("Unlink failed", {
        path: filePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async rm(targetPath: string, options?: RmOptions): Promise<void> {
    const recursive = options?.recursive ?? false;
    const force = options?.force ?? false;
    this.logger.debug("Rm", { path: targetPath, recursive });
    try {
      if (recursive) {
        // Use fs.rm for recursive deletion
        await fs.rm(targetPath, { recursive, force });
      } else {
        // For non-recursive: check if directory or file
        const stat = await fs.stat(targetPath);
        if (stat.isDirectory()) {
          // Use rmdir for directories - fails with ENOTEMPTY if not empty
          await fs.rmdir(targetPath);
        } else {
          // Use rm for files
          await fs.rm(targetPath, { force });
        }
      }
    } catch (error) {
      // Handle ENOENT when force is true
      const nodeError = error as NodeJS.ErrnoException;
      if (force && nodeError.code === "ENOENT") {
        return;
      }
      const fsError = mapError(error, targetPath);
      this.logger.warn("Rm failed", {
        path: targetPath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async copyTree(src: string, dest: string): Promise<CopyTreeResult> {
    this.logger.debug("CopyTree", { src, dest });

    // Check if source exists and get its type using lstat (doesn't follow symlinks)
    let srcStat;
    try {
      srcStat = await fs.lstat(src);
    } catch (error) {
      const fsError = mapError(error, src);
      this.logger.warn("CopyTree failed", {
        path: src,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }

    // Handle symlink at root level
    if (srcStat.isSymbolicLink()) {
      const result = { copiedCount: 0, skippedSymlinks: [src] };
      this.logger.debug("CopyTree complete", { copied: 0, skippedSymlinks: 1 });
      return result;
    }

    // If source is a file, copy it directly
    if (srcStat.isFile()) {
      // Create parent directories
      const destDir = path.dirname(dest);
      await this.mkdir(destDir);

      try {
        await fs.copyFile(src, dest);
      } catch (error) {
        const fsError = mapError(error, dest);
        this.logger.warn("CopyTree failed", {
          path: dest,
          code: fsError.fsCode,
          error: fsError.message,
        });
        throw fsError;
      }

      this.logger.debug("CopyTree complete", { copied: 1, skippedSymlinks: 0 });
      return { copiedCount: 1, skippedSymlinks: [] };
    }

    // Source is a directory - use iterative queue-based approach
    let copiedCount = 0;
    const skippedSymlinks: string[] = [];

    // Queue contains [srcPath, destPath] pairs
    const queue: Array<{ srcPath: string; destPath: string }> = [{ srcPath: src, destPath: dest }];

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Create destination directory
      await this.mkdir(current.destPath);

      // Read source directory entries
      let entries;
      try {
        entries = await fs.readdir(current.srcPath, { withFileTypes: true });
      } catch (error) {
        const fsError = mapError(error, current.srcPath);
        this.logger.warn("CopyTree failed", {
          path: current.srcPath,
          code: fsError.fsCode,
          error: fsError.message,
        });
        throw fsError;
      }

      for (const entry of entries) {
        const entrySrcPath = path.join(current.srcPath, entry.name);
        const entryDestPath = path.join(current.destPath, entry.name);

        if (entry.isSymbolicLink()) {
          // Skip symlinks for security
          skippedSymlinks.push(entrySrcPath);
        } else if (entry.isDirectory()) {
          // Add to queue for processing
          queue.push({ srcPath: entrySrcPath, destPath: entryDestPath });
        } else if (entry.isFile()) {
          // Copy file
          try {
            await fs.copyFile(entrySrcPath, entryDestPath);
            copiedCount++;
          } catch (error) {
            const fsError = mapError(error, entryDestPath);
            this.logger.warn("CopyTree failed", {
              path: entryDestPath,
              code: fsError.fsCode,
              error: fsError.message,
            });
            throw fsError;
          }
        }
        // Skip other entry types (sockets, FIFOs, etc.)
      }
    }

    this.logger.debug("CopyTree complete", {
      copied: copiedCount,
      skippedSymlinks: skippedSymlinks.length,
    });
    return { copiedCount, skippedSymlinks };
  }

  async makeExecutable(filePath: string): Promise<void> {
    // On Windows, executability is determined by file extension, not permissions
    if (process.platform === "win32") {
      return;
    }

    try {
      await fs.chmod(filePath, 0o755);
    } catch (error) {
      throw mapError(error, filePath);
    }
  }
}
