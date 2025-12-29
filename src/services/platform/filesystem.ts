/**
 * FileSystemLayer - Abstraction over filesystem operations.
 *
 * Provides an injectable interface for filesystem access, enabling:
 * - Unit testing of services with mock FileSystemLayer
 * - Boundary testing of DefaultFileSystemLayer against real filesystem
 * - Consistent error handling via FileSystemError
 *
 * Path handling:
 * - All methods accept Path objects or strings
 * - Internally converts paths to native format using path.toNative()
 * - This enables gradual migration to Path objects while maintaining backward compatibility
 */

import { Path } from "./path";

/** Type for paths accepted by FileSystemLayer (Path object or string) */
export type PathLike = Path | string;

/**
 * Convert a PathLike to a native path string for node:fs operations.
 * @internal
 */
function toNativePath(pathLike: PathLike): string {
  if (pathLike instanceof Path) {
    return pathLike.toNative();
  }
  return pathLike;
}

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
 * All paths are absolute. Paths can be Path objects or strings.
 * All text operations use UTF-8 encoding.
 * Methods throw FileSystemError on failures.
 *
 * NOTE: No exists() method - use try/catch on actual operations to avoid TOCTOU races.
 */
export interface FileSystemLayer {
  /**
   * Read entire file as UTF-8 string.
   *
   * @param path - Absolute path to file (Path object or string)
   * @returns File contents as string
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   *
   * @example
   * const content = await fs.readFile('/path/to/config.json');
   * const config = JSON.parse(content);
   */
  readFile(path: PathLike): Promise<string>;

  /**
   * Write content to file. Overwrites existing file.
   *
   * @param path - Absolute path to file (Path object or string)
   * @param content - String content to write (UTF-8)
   * @throws FileSystemError with code ENOENT if parent directory doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   *
   * @example
   * await fs.writeFile('/path/to/config.json', JSON.stringify(data, null, 2));
   */
  writeFile(path: PathLike, content: string): Promise<void>;

  /**
   * Create directory. Creates parent directories by default.
   * No-op if directory already exists.
   *
   * @param path - Absolute path to directory (Path object or string)
   * @param options - mkdir options (recursive defaults to true)
   * @throws FileSystemError with code EEXIST if path exists as a file
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example
   * await fs.mkdir('/path/to/new/directory');
   */
  mkdir(path: PathLike, options?: MkdirOptions): Promise<void>;

  /**
   * List directory contents.
   *
   * @param path - Absolute path to directory (Path object or string)
   * @returns Array of directory entries with type information
   * @throws FileSystemError with code ENOENT if directory not found
   * @throws FileSystemError with code ENOTDIR if path is not a directory
   *
   * @example
   * const entries = await fs.readdir('/path/to/dir');
   * const subdirs = entries.filter(e => e.isDirectory);
   */
  readdir(path: PathLike): Promise<readonly DirEntry[]>;

  /**
   * Delete a file.
   *
   * @param path - Absolute path to file (Path object or string)
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EISDIR if path is a directory
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example
   * await fs.unlink('/path/to/file.txt');
   */
  unlink(path: PathLike): Promise<void>;

  /**
   * Delete file or directory.
   *
   * @param path - Absolute path to file or directory (Path object or string)
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
  rm(path: PathLike, options?: RmOptions): Promise<void>;

  /**
   * Copy a file or directory tree to a new location.
   *
   * Uses native fs.cp() for performance. Symlinks are copied as symlinks.
   * Overwrites existing files at destination.
   * Creates destination parent directories if they don't exist.
   *
   * @param src - Absolute path to source file or directory (Path object or string)
   * @param dest - Absolute path to destination (Path object or string)
   * @throws FileSystemError with code ENOENT if source doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Copy single file
   * await fs.copyTree('/src/config.json', '/dest/config.json');
   *
   * @example Copy directory
   * await fs.copyTree('/src/configs', '/dest/configs');
   */
  copyTree(src: PathLike, dest: PathLike): Promise<void>;

  /**
   * Make a file executable (sets mode 0o755).
   * On Windows, this is a no-op since executability is determined by file extension.
   *
   * @param path - Absolute path to file (Path object or string)
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Make script executable
   * await fs.makeExecutable('/path/to/script.sh');
   */
  makeExecutable(path: PathLike): Promise<void>;

  /**
   * Write binary content to file. Overwrites existing file.
   *
   * @param path - Absolute path to file (Path object or string)
   * @param content - Buffer content to write
   * @throws FileSystemError with code ENOENT if parent directory doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   *
   * @example Write binary data
   * const buffer = await fetchBinaryData();
   * await fs.writeFileBuffer('/path/to/binary', buffer);
   */
  writeFileBuffer(path: PathLike, content: Buffer): Promise<void>;

  /**
   * Create a symbolic link.
   * Removes existing symlink at linkPath before creating new one.
   *
   * @param target - Path the symlink should point to (Path object or string)
   * @param linkPath - Path where the symlink will be created (Path object or string)
   * @throws FileSystemError with code ENOENT if parent directory of linkPath doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Create symlink to versioned directory
   * await fs.symlink('/app/opencode/1.0.0', '/app/opencode/current');
   */
  symlink(target: PathLike, linkPath: PathLike): Promise<void>;

  /**
   * Rename (move) a file or directory atomically.
   * This is the standard pattern for atomic file writes:
   * 1. Write to a temp file
   * 2. Rename temp file to target (atomic on most filesystems)
   *
   * @param oldPath - Current path of the file/directory (Path object or string)
   * @param newPath - New path for the file/directory (Path object or string)
   * @throws FileSystemError with code ENOENT if oldPath doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Atomic write pattern
   * await fs.writeFile('/path/to/file.tmp', content);
   * await fs.rename('/path/to/file.tmp', '/path/to/file');
   */
  rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
}

// ============================================================================
// Helper Functions
// ============================================================================

import * as fs from "node:fs/promises";
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
 * Accepts both Path objects and strings, converting to native format internally.
 */
export class DefaultFileSystemLayer implements FileSystemLayer {
  constructor(private readonly logger: Logger) {}

  async readFile(filePath: PathLike): Promise<string> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("Read", { path: nativePath });
    try {
      return await fs.readFile(nativePath, "utf-8");
    } catch (error) {
      const fsError = mapError(error, nativePath);
      this.logger.warn("Read failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async writeFile(filePath: PathLike, content: string): Promise<void> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("Write", { path: nativePath });
    try {
      await fs.writeFile(nativePath, content, "utf-8");
    } catch (error) {
      const fsError = mapError(error, nativePath);
      this.logger.warn("Write failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async mkdir(dirPath: PathLike, options?: MkdirOptions): Promise<void> {
    const nativePath = toNativePath(dirPath);
    const recursive = options?.recursive ?? true;
    this.logger.debug("Mkdir", { path: nativePath });
    try {
      await fs.mkdir(nativePath, { recursive });
    } catch (error) {
      const fsError = mapError(error, nativePath);
      this.logger.warn("Mkdir failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async readdir(dirPath: PathLike): Promise<readonly DirEntry[]> {
    const nativePath = toNativePath(dirPath);
    try {
      const entries = await fs.readdir(nativePath, { withFileTypes: true });
      const result = entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
      this.logger.debug("Readdir", { path: nativePath, count: result.length });
      return result;
    } catch (error) {
      const fsError = mapError(error, nativePath);
      this.logger.warn("Readdir failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async unlink(filePath: PathLike): Promise<void> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("Unlink", { path: nativePath });
    try {
      await fs.unlink(nativePath);
    } catch (error) {
      const fsError = mapError(error, nativePath);
      this.logger.warn("Unlink failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async rm(targetPath: PathLike, options?: RmOptions): Promise<void> {
    const nativePath = toNativePath(targetPath);
    const recursive = options?.recursive ?? false;
    const force = options?.force ?? false;
    this.logger.debug("Rm", { path: nativePath, recursive });
    try {
      if (recursive) {
        // Use fs.rm for recursive deletion
        await fs.rm(nativePath, { recursive, force });
      } else {
        // For non-recursive: check if directory or file
        const stat = await fs.stat(nativePath);
        if (stat.isDirectory()) {
          // Use rmdir for directories - fails with ENOTEMPTY if not empty
          await fs.rmdir(nativePath);
        } else {
          // Use rm for files
          await fs.rm(nativePath, { force });
        }
      }
    } catch (error) {
      // Handle ENOENT when force is true
      const nodeError = error as NodeJS.ErrnoException;
      if (force && nodeError.code === "ENOENT") {
        return;
      }
      const fsError = mapError(error, nativePath);
      this.logger.warn("Rm failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async copyTree(src: PathLike, dest: PathLike): Promise<void> {
    const nativeSrc = toNativePath(src);
    const nativeDest = toNativePath(dest);
    this.logger.debug("CopyTree", { src: nativeSrc, dest: nativeDest });
    try {
      await fs.cp(nativeSrc, nativeDest, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });
    } catch (error) {
      const fsError = mapError(error, nativeSrc);
      this.logger.warn("CopyTree failed", {
        src: nativeSrc,
        dest: nativeDest,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
    this.logger.debug("CopyTree complete", { src: nativeSrc, dest: nativeDest });
  }

  async makeExecutable(filePath: PathLike): Promise<void> {
    const nativePath = toNativePath(filePath);
    // On Windows, executability is determined by file extension, not permissions
    if (process.platform === "win32") {
      return;
    }

    try {
      await fs.chmod(nativePath, 0o755);
    } catch (error) {
      throw mapError(error, nativePath);
    }
  }

  async writeFileBuffer(filePath: PathLike, content: Buffer): Promise<void> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("WriteBuffer", { path: nativePath, size: content.length });
    try {
      await fs.writeFile(nativePath, content);
    } catch (error) {
      const fsError = mapError(error, nativePath);
      this.logger.warn("WriteBuffer failed", {
        path: nativePath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async symlink(target: PathLike, linkPath: PathLike): Promise<void> {
    const nativeTarget = toNativePath(target);
    const nativeLinkPath = toNativePath(linkPath);
    this.logger.debug("Symlink", { target: nativeTarget, linkPath: nativeLinkPath });
    try {
      // Remove existing symlink if present
      try {
        const stat = await fs.lstat(nativeLinkPath);
        if (stat.isSymbolicLink()) {
          await fs.unlink(nativeLinkPath);
        }
      } catch (error) {
        // Ignore ENOENT - file doesn't exist, which is fine
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "ENOENT") {
          throw error;
        }
      }

      // Create symlink
      // On Windows, use 'junction' for directories (doesn't require admin)
      const type = process.platform === "win32" ? "junction" : undefined;
      await fs.symlink(nativeTarget, nativeLinkPath, type);
    } catch (error) {
      const fsError = mapError(error, nativeLinkPath);
      this.logger.warn("Symlink failed", {
        target: nativeTarget,
        linkPath: nativeLinkPath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }

  async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    const nativeOldPath = toNativePath(oldPath);
    const nativeNewPath = toNativePath(newPath);
    this.logger.debug("Rename", { oldPath: nativeOldPath, newPath: nativeNewPath });
    try {
      await fs.rename(nativeOldPath, nativeNewPath);
    } catch (error) {
      const fsError = mapError(error, nativeOldPath);
      this.logger.warn("Rename failed", {
        oldPath: nativeOldPath,
        newPath: nativeNewPath,
        code: fsError.fsCode,
        error: fsError.message,
      });
      throw fsError;
    }
  }
}
