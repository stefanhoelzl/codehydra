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
}

// ============================================================================
// Helper Functions
// ============================================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileSystemError } from "../errors";

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
  async readFile(path: string): Promise<string> {
    try {
      return await fs.readFile(path, "utf-8");
    } catch (error) {
      throw mapError(error, path);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      await fs.writeFile(path, content, "utf-8");
    } catch (error) {
      throw mapError(error, path);
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const recursive = options?.recursive ?? true;
    try {
      await fs.mkdir(path, { recursive });
    } catch (error) {
      throw mapError(error, path);
    }
  }

  async readdir(path: string): Promise<readonly DirEntry[]> {
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    } catch (error) {
      throw mapError(error, path);
    }
  }

  async unlink(path: string): Promise<void> {
    try {
      await fs.unlink(path);
    } catch (error) {
      throw mapError(error, path);
    }
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const recursive = options?.recursive ?? false;
    const force = options?.force ?? false;
    try {
      if (recursive) {
        // Use fs.rm for recursive deletion
        await fs.rm(path, { recursive, force });
      } else {
        // For non-recursive: check if directory or file
        const stat = await fs.stat(path);
        if (stat.isDirectory()) {
          // Use rmdir for directories - fails with ENOTEMPTY if not empty
          await fs.rmdir(path);
        } else {
          // Use rm for files
          await fs.rm(path, { force });
        }
      }
    } catch (error) {
      // Handle ENOENT when force is true
      const nodeError = error as NodeJS.ErrnoException;
      if (force && nodeError.code === "ENOENT") {
        return;
      }
      throw mapError(error, path);
    }
  }

  async copyTree(src: string, dest: string): Promise<CopyTreeResult> {
    // Check if source exists and get its type using lstat (doesn't follow symlinks)
    let srcStat;
    try {
      srcStat = await fs.lstat(src);
    } catch (error) {
      throw mapError(error, src);
    }

    // Handle symlink at root level
    if (srcStat.isSymbolicLink()) {
      return { copiedCount: 0, skippedSymlinks: [src] };
    }

    // If source is a file, copy it directly
    if (srcStat.isFile()) {
      // Create parent directories
      const destDir = path.dirname(dest);
      await this.mkdir(destDir);

      try {
        await fs.copyFile(src, dest);
      } catch (error) {
        throw mapError(error, dest);
      }

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
        throw mapError(error, current.srcPath);
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
            throw mapError(error, entryDestPath);
          }
        }
        // Skip other entry types (sockets, FIFOs, etc.)
      }
    }

    return { copiedCount, skippedSymlinks };
  }
}
