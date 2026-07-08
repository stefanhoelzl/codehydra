/**
 * FileSystemBoundary - Abstraction over filesystem operations.
 *
 * Provides an injectable interface for filesystem access, enabling:
 * - Unit testing of services with mock FileSystemBoundary
 * - Boundary testing of DefaultFileSystemBoundary against real filesystem
 * - Consistent error handling via FileSystemError
 *
 * Path handling:
 * - All methods accept Path objects or strings
 * - Internally converts paths to native format using path.toNative()
 * - This enables gradual migration to Path objects while maintaining backward compatibility
 */

import { tmpdir } from "node:os";
import { Path } from "../../utils/path/path";

/** Type for paths accepted by FileSystemBoundary (Path object or string) */
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
 * Options for rm operation.
 */
export interface RmOptions {
  /** Remove directories and their contents recursively (default: false) */
  readonly recursive?: boolean;
  /** Ignore errors if path doesn't exist (default: false) */
  readonly force?: boolean;
  /** Max retry count for EBUSY/ENOTEMPTY on Windows (default: 0). Only applies when recursive is true. */
  readonly maxRetries?: number;
  /** Delay in ms between retries (default: 100). Only applies when maxRetries > 0. */
  readonly retryDelay?: number;
  /** Timeout in ms. If rm doesn't complete within this time, throws FileSystemError (UNKNOWN, originalCode: ETIMEDOUT). */
  readonly timeout?: number;
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
export interface FileSystemBoundary {
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
   * Write content to file. Overwrites existing file by default.
   *
   * Pass `{ exclusive: true }` for an atomic create-if-absent write (the `wx`
   * flag): it throws FileSystemError with code EEXIST when the file already
   * exists instead of overwriting. This lets callers seed a file only when it is
   * new without a separate (TOCTOU-prone) existence check.
   *
   * @param path - Absolute path to file (Path object or string)
   * @param content - String content to write (UTF-8)
   * @param options.exclusive - Fail with EEXIST if the file already exists
   * @throws FileSystemError with code ENOENT if parent directory doesn't exist
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   * @throws FileSystemError with code EEXIST if exclusive and the file exists
   *
   * @example
   * await fs.writeFile('/path/to/config.json', JSON.stringify(data, null, 2));
   * await fs.writeFile('/path/to/new.txt', tpl, { exclusive: true }); // create-only
   */
  writeFile(path: PathLike, content: string, options?: { exclusive?: boolean }): Promise<void>;

  /**
   * Create directory. Creates parent directories as needed.
   * No-op if directory already exists.
   *
   * @param path - Absolute path to directory (Path object or string)
   * @throws FileSystemError with code EEXIST if path exists as a file
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example
   * await fs.mkdir('/path/to/new/directory');
   */
  mkdir(path: PathLike): Promise<void>;

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
   * Read binary content from file.
   *
   * @param path - Absolute path to file (Path object or string)
   * @throws FileSystemError with code ENOENT if file not found
   * @throws FileSystemError with code EACCES if permission denied
   * @throws FileSystemError with code EISDIR if path is a directory
   *
   * @example Read binary data
   * const png = await fs.readFileBuffer('/path/to/image.png');
   */
  readFileBuffer(path: PathLike): Promise<Buffer>;

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

  /**
   * Create a unique temporary directory.
   * The directory is created inside the system temp directory.
   *
   * @param prefix - Prefix string to use for the directory name
   * @returns Path to the newly created temporary directory
   * @throws FileSystemError with code EACCES if permission denied
   *
   * @example Create temp dir for initial prompt
   * const tempDir = await fs.mkdtemp('initial-prompt-');
   * // tempDir might be /tmp/initial-prompt-abc123
   */
  mkdtemp(prefix: string): Promise<Path>;
}

// ============================================================================
// Helper Functions
// ============================================================================

import { createRequire } from "node:module";
import * as nodeFsPromises from "node:fs/promises";
import { FileSystemError } from "../../shared/errors/service-errors";

// In the packaged Electron main process, node:fs is asar-patched: any op on a path
// containing a *.asar treats it as a virtual directory and caches the archive fd for
// the process lifetime, so recursive rm/readdir over a workspace's node_modules opens
// and locks an embedded electron default_app.asar — which made orphaned-workspace
// cleanup fail with ENOTEMPTY in packaged builds (process.noAsar is intentionally left
// off there so the app can load its own asar). original-fs is Electron's un-patched fs,
// present ONLY in the Electron runtime; fall back to node:fs/promises everywhere else
// (Vitest, tsx-run build/install scripts, plain Node) where it does not resolve.
function resolveFsPromises(): typeof nodeFsPromises {
  try {
    return (createRequire(import.meta.url)("original-fs") as { promises: typeof nodeFsPromises })
      .promises;
  } catch {
    return nodeFsPromises;
  }
}
const fs = resolveFsPromises();
import type { Logger } from "./logging";

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
// DefaultFileSystemBoundary Implementation
// ============================================================================

/**
 * Default implementation of FileSystemBoundary using node:fs/promises.
 * Maps Node.js errors to FileSystemError for consistent error handling.
 * Accepts both Path objects and strings, converting to native format internally.
 */
export class DefaultFileSystemBoundary implements FileSystemBoundary {
  constructor(private readonly logger: Logger) {}

  async readFile(filePath: PathLike): Promise<string> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("Read", { path: nativePath });
    try {
      return await fs.readFile(nativePath, "utf-8");
    } catch (error) {
      throw mapError(error, nativePath);
    }
  }

  async writeFile(
    filePath: PathLike,
    content: string,
    options?: { exclusive?: boolean }
  ): Promise<void> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("Write", { path: nativePath, exclusive: options?.exclusive ?? false });
    try {
      await fs.writeFile(nativePath, content, {
        encoding: "utf-8",
        ...(options?.exclusive === true && { flag: "wx" }),
      });
    } catch (error) {
      throw mapError(error, nativePath);
    }
  }

  async mkdir(dirPath: PathLike): Promise<void> {
    const nativePath = toNativePath(dirPath);
    this.logger.debug("Mkdir", { path: nativePath });
    try {
      await fs.mkdir(nativePath, { recursive: true });
    } catch (error) {
      throw mapError(error, nativePath);
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
      throw mapError(error, nativePath);
    }
  }

  async unlink(filePath: PathLike): Promise<void> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("Unlink", { path: nativePath });
    try {
      await fs.unlink(nativePath);
    } catch (error) {
      throw mapError(error, nativePath);
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
        // maxRetries/retryDelay handle EBUSY/ENOTEMPTY on Windows (lingering file handles)
        const rmPromise = fs.rm(nativePath, {
          recursive,
          force,
          ...(options?.maxRetries !== undefined && { maxRetries: options.maxRetries }),
          ...(options?.retryDelay !== undefined && { retryDelay: options.retryDelay }),
        });

        if (options?.timeout !== undefined) {
          let timer: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error(`rm timed out after ${options.timeout}ms`), {
                    code: "ETIMEDOUT",
                  })
                ),
              options.timeout
            );
          });
          try {
            await Promise.race([rmPromise, timeoutPromise]);
          } finally {
            clearTimeout(timer!);
          }
        } else {
          await rmPromise;
        }
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
      throw mapError(error, nativePath);
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
      throw mapError(error, nativeSrc);
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
      throw mapError(error, nativePath);
    }
  }

  async readFileBuffer(filePath: PathLike): Promise<Buffer> {
    const nativePath = toNativePath(filePath);
    this.logger.debug("ReadBuffer", { path: nativePath });
    try {
      return await fs.readFile(nativePath);
    } catch (error) {
      throw mapError(error, nativePath);
    }
  }

  async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    const nativeOldPath = toNativePath(oldPath);
    const nativeNewPath = toNativePath(newPath);
    this.logger.debug("Rename", { oldPath: nativeOldPath, newPath: nativeNewPath });
    try {
      await fs.rename(nativeOldPath, nativeNewPath);
    } catch (error) {
      throw mapError(error, nativeOldPath);
    }
  }

  async mkdtemp(prefix: string): Promise<Path> {
    this.logger.debug("Mkdtemp", { prefix });
    try {
      const tmpDir = tmpdir();
      const created = await fs.mkdtemp(`${tmpDir}/${prefix}`);
      this.logger.debug("Mkdtemp created", { path: created });
      return new Path(created);
    } catch (error) {
      throw mapError(error, prefix);
    }
  }
}
