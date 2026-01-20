/**
 * Behavioral mock for FileSystemLayer with in-memory state.
 *
 * Provides a stateful mock that simulates real filesystem behavior:
 * - In-memory file/directory/symlink storage
 * - Proper error handling (ENOENT, EISDIR, etc.)
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const mock = createFileSystemMock({
 *   entries: {
 *     "/app": directory(),
 *     "/app/config.json": file('{"debug": true}'),
 *   },
 * });
 *
 * await mock.writeFile("/app/data.json", "{}");
 * expect(mock).toHaveFile("/app/data.json", "{}");
 */

import { expect } from "vitest";
import type { FileSystemErrorCode, FileSystemLayer, PathLike, DirEntry } from "./filesystem";
import { FileSystemError } from "../errors";
import { Path } from "./path";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// Entry Types
// =============================================================================

/**
 * File entry in the mock filesystem.
 */
export interface FileEntry {
  readonly type: "file";
  readonly content: string | Buffer;
  readonly executable?: boolean;
  /** If set, accessing this entry throws an error with this code */
  readonly error?: FileSystemErrorCode;
}

/**
 * Directory entry in the mock filesystem.
 */
export interface DirectoryEntry {
  readonly type: "directory";
  /** If set, accessing this entry throws an error with this code */
  readonly error?: FileSystemErrorCode;
}

/**
 * Symlink entry in the mock filesystem.
 */
export interface SymlinkEntry {
  readonly type: "symlink";
  /** Absolute normalized target path */
  readonly target: string;
  /** If set, accessing this entry throws an error with this code */
  readonly error?: FileSystemErrorCode;
}

/**
 * Any entry type in the mock filesystem.
 */
export type Entry = FileEntry | DirectoryEntry | SymlinkEntry;

// =============================================================================
// State Interface
// =============================================================================

/**
 * State interface for the filesystem mock.
 * Provides read access to entries and test helper methods.
 */
export interface FileSystemMockState extends MockState {
  /**
   * Read-only access to all filesystem entries.
   * Keys are normalized path strings.
   */
  readonly entries: ReadonlyMap<string, Entry>;

  /**
   * Counter for generating unique mkdtemp paths.
   * Increments with each mkdtemp call for deterministic unique paths.
   */
  readonly mkdtempCounter: number;

  /**
   * If set to true, mkdtemp will throw an error.
   * Useful for testing error handling in code that uses mkdtemp.
   */
  mkdtempShouldFail: boolean;

  /**
   * Set an entry in the filesystem.
   * Normalizes the path and auto-creates parent directories.
   * This is a test helper - it does NOT follow real filesystem semantics.
   *
   * @param path - Absolute path (string or Path object)
   * @param entry - Entry to set
   */
  setEntry(path: string | Path, entry: Entry): void;

  /**
   * Capture current state as snapshot for later comparison.
   */
  snapshot(): Snapshot;

  /**
   * Human-readable representation of filesystem state.
   * Sorted alphabetically for deterministic output.
   */
  toString(): string;
}

/**
 * FileSystemLayer with behavioral mock state access via `$` property.
 */
export type MockFileSystemLayer = FileSystemLayer & MockWithState<FileSystemMockState>;

// =============================================================================
// Entry Helper Functions
// =============================================================================

/**
 * Create a file entry.
 *
 * @example
 * file("hello world")
 * file(Buffer.from([0x89, 0x50, 0x4e, 0x47]))  // Binary
 * file("content", { executable: true })
 * file("secret", { error: "EACCES" })
 */
export function file(
  content: string | Buffer,
  options?: {
    executable?: boolean;
    error?: FileSystemErrorCode;
  }
): FileEntry {
  return {
    type: "file" as const,
    content,
    ...(options?.executable !== undefined && { executable: options.executable }),
    ...(options?.error !== undefined && { error: options.error }),
  };
}

/**
 * Create a directory entry.
 *
 * @example
 * directory()
 * directory({ error: "EACCES" })
 */
export function directory(options?: { error?: FileSystemErrorCode }): DirectoryEntry {
  return {
    type: "directory" as const,
    ...(options?.error !== undefined && { error: options.error }),
  };
}

/**
 * Create a symlink entry.
 *
 * @example
 * symlink("/app/v1")
 * symlink("/app/v1", { error: "EACCES" })
 */
export function symlink(target: string, options?: { error?: FileSystemErrorCode }): SymlinkEntry {
  return {
    type: "symlink" as const,
    target,
    ...(options?.error !== undefined && { error: options.error }),
  };
}

// =============================================================================
// DirEntry Helper (for tests using manual FileSystemLayer mocks)
// =============================================================================

/**
 * Create a DirEntry for readdir results.
 * Useful when building manual FileSystemLayer mocks with vi.fn().
 *
 * @example File entry
 * createDirEntry('config.json', { isFile: true })
 *
 * @example Directory entry
 * createDirEntry('subdir', { isDirectory: true })
 *
 * @example Symlink entry
 * createDirEntry('link', { isSymbolicLink: true })
 */
export function createDirEntry(
  name: string,
  options?: {
    isDirectory?: boolean;
    isFile?: boolean;
    isSymbolicLink?: boolean;
  }
): DirEntry {
  return {
    name,
    isDirectory: options?.isDirectory ?? false,
    // isFile defaults to true only when both isDirectory and isSymbolicLink are falsy
    isFile: options?.isFile ?? (!options?.isDirectory && !options?.isSymbolicLink),
    isSymbolicLink: options?.isSymbolicLink ?? false,
  };
}

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Normalize a path for use as a map key.
 */
function normalizePath(pathLike: PathLike): string {
  if (pathLike instanceof Path) {
    return pathLike.toString();
  }
  return new Path(pathLike).toString();
}

/**
 * Get parent path of a normalized path.
 */
function getParentPath(normalizedPath: string): string | null {
  const lastSlash = normalizedPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    return normalizedPath === "/" ? null : "/";
  }
  return normalizedPath.substring(0, lastSlash);
}

class FileSystemMockStateImpl implements FileSystemMockState {
  private readonly _entries: Map<string, Entry>;
  private _mkdtempCounter: number = 0;
  mkdtempShouldFail: boolean = false;

  constructor(initialEntries?: Map<string, Entry>) {
    this._entries = new Map(initialEntries);
  }

  get entries(): ReadonlyMap<string, Entry> {
    return this._entries;
  }

  get mkdtempCounter(): number {
    return this._mkdtempCounter;
  }

  incrementMkdtempCounter(): number {
    return this._mkdtempCounter++;
  }

  setEntry(path: string | Path, entry: Entry): void {
    const normalizedPath = normalizePath(path);

    // Auto-create parent directories (test helper convenience)
    let parent = getParentPath(normalizedPath);
    while (parent !== null) {
      if (!this._entries.has(parent)) {
        this._entries.set(parent, directory());
      }
      parent = getParentPath(parent);
    }

    this._entries.set(normalizedPath, entry);
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() } as Snapshot;
  }

  toString(): string {
    const sorted = [...this._entries.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines = sorted.map(([path, entry]) => {
      if (entry.type === "file") {
        const rawContent: string | Buffer = entry.content;
        let content: string;
        if (typeof rawContent === "string") {
          content = rawContent.length > 50 ? rawContent.substring(0, 50) + "..." : rawContent;
        } else {
          content = `<Buffer ${rawContent.length} bytes>`;
        }
        const flags = [
          entry.executable ? "exec" : null,
          entry.error ? `error:${entry.error}` : null,
        ]
          .filter(Boolean)
          .join(",");
        return `${path}: file(${JSON.stringify(content)})${flags ? ` [${flags}]` : ""}`;
      } else if (entry.type === "directory") {
        const flags = entry.error ? ` [error:${entry.error}]` : "";
        return `${path}: directory${flags}`;
      } else {
        const flags = entry.error ? ` [error:${entry.error}]` : "";
        return `${path}: symlink -> ${entry.target}${flags}`;
      }
    });
    return lines.join("\n");
  }
}

// =============================================================================
// Factory Options
// =============================================================================

/**
 * Options for creating a mock filesystem.
 */
export interface MockFileSystemOptions {
  /**
   * Initial entries in the filesystem.
   * Can be a Map or Record. Keys are normalized via Path class.
   */
  entries?: Map<string, Entry> | Record<string, Entry>;
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for FileSystemLayer.
 *
 * @example Basic setup
 * const mock = createFileSystemMock({
 *   entries: {
 *     "/app": directory(),
 *     "/app/config.json": file('{"debug": true}'),
 *   },
 * });
 *
 * @example Error simulation
 * const mock = createFileSystemMock({
 *   entries: {
 *     "/protected.txt": file("secret", { error: "EACCES" }),
 *   },
 * });
 */
export function createFileSystemMock(options?: MockFileSystemOptions): MockFileSystemLayer {
  // Normalize all entry keys
  const normalizedEntries = new Map<string, Entry>();
  if (options?.entries) {
    const entries =
      options.entries instanceof Map ? options.entries.entries() : Object.entries(options.entries);
    for (const [key, entry] of entries) {
      normalizedEntries.set(normalizePath(key), entry);
    }
  }

  const state = new FileSystemMockStateImpl(normalizedEntries);

  // Helper to throw configured error or specific error
  const throwIfError = (entry: Entry | undefined, path: string): void => {
    if (entry?.error) {
      throw new FileSystemError(entry.error, path, `Mock error: ${entry.error}`);
    }
  };

  const layer: FileSystemLayer = {
    async readFile(pathLike: PathLike): Promise<string> {
      const path = normalizePath(pathLike);
      const entry = state.entries.get(path);

      if (!entry) {
        throw new FileSystemError("ENOENT", path, `File not found: ${path}`);
      }

      throwIfError(entry, path);

      if (entry.type === "directory") {
        throw new FileSystemError("EISDIR", path, `Is a directory: ${path}`);
      }

      if (entry.type === "symlink") {
        // Mock does NOT follow symlinks - just return error for now
        throw new FileSystemError("ENOENT", path, `Symlink target not resolved: ${path}`);
      }

      // At this point entry is a FileEntry
      const fileContent: string | Buffer = entry.content;
      if (typeof fileContent === "string") {
        return fileContent;
      }
      return fileContent.toString("utf-8");
    },

    async writeFile(pathLike: PathLike, content: string): Promise<void> {
      const path = normalizePath(pathLike);
      const existing = state.entries.get(path);

      // Check if path is a directory
      if (existing?.type === "directory") {
        throw new FileSystemError("EISDIR", path, `Is a directory: ${path}`);
      }

      // Check if parent exists
      const parent = getParentPath(path);
      if (parent !== null) {
        const parentEntry = state.entries.get(parent);
        if (!parentEntry) {
          throw new FileSystemError("ENOENT", path, `Parent directory not found: ${parent}`);
        }
        if (parentEntry.type !== "directory") {
          throw new FileSystemError("ENOENT", path, `Parent is not a directory: ${parent}`);
        }
      }

      state.setEntry(path, file(content));
    },

    async mkdir(pathLike: PathLike, mkdirOptions?): Promise<void> {
      const path = normalizePath(pathLike);
      const recursive = mkdirOptions?.recursive ?? true;
      const existing = state.entries.get(path);

      // If directory already exists, no-op
      if (existing?.type === "directory") {
        return;
      }

      // If file exists at path, error
      if (existing?.type === "file" || existing?.type === "symlink") {
        throw new FileSystemError("EEXIST", path, `File exists at path: ${path}`);
      }

      if (recursive) {
        // Create all parent directories
        const segments = path.split("/").filter(Boolean);
        let current = "";
        for (const segment of segments) {
          current = current + "/" + segment;
          const entry = state.entries.get(current);
          if (!entry) {
            state.setEntry(current, directory());
          } else if (entry.type !== "directory") {
            throw new FileSystemError("EEXIST", current, `Not a directory: ${current}`);
          }
        }
      } else {
        // Check parent exists
        const parent = getParentPath(path);
        if (parent !== null) {
          const parentEntry = state.entries.get(parent);
          if (!parentEntry || parentEntry.type !== "directory") {
            throw new FileSystemError("ENOENT", path, `Parent directory not found: ${parent}`);
          }
        }
        state.setEntry(path, directory());
      }
    },

    async readdir(pathLike: PathLike) {
      const path = normalizePath(pathLike);
      const entry = state.entries.get(path);

      if (!entry) {
        throw new FileSystemError("ENOENT", path, `Directory not found: ${path}`);
      }

      throwIfError(entry, path);

      if (entry.type !== "directory") {
        throw new FileSystemError("ENOTDIR", path, `Not a directory: ${path}`);
      }

      // Find all direct children
      const prefix = path === "/" ? "/" : path + "/";
      const children: {
        name: string;
        isDirectory: boolean;
        isFile: boolean;
        isSymbolicLink: boolean;
      }[] = [];

      for (const [entryPath, e] of state.entries) {
        if (entryPath.startsWith(prefix)) {
          const relativePath = entryPath.substring(prefix.length);
          // Only direct children (no slashes in relative path)
          if (!relativePath.includes("/")) {
            children.push({
              name: relativePath,
              isDirectory: e.type === "directory",
              isFile: e.type === "file",
              isSymbolicLink: e.type === "symlink",
            });
          }
        }
      }

      return children;
    },

    async unlink(pathLike: PathLike): Promise<void> {
      const path = normalizePath(pathLike);
      const entry = state.entries.get(path);

      if (!entry) {
        throw new FileSystemError("ENOENT", path, `File not found: ${path}`);
      }

      if (entry.type === "directory") {
        throw new FileSystemError("EISDIR", path, `Is a directory: ${path}`);
      }

      (state as FileSystemMockStateImpl)["_entries"].delete(path);
    },

    async rm(pathLike: PathLike, rmOptions?): Promise<void> {
      const path = normalizePath(pathLike);
      const recursive = rmOptions?.recursive ?? false;
      const force = rmOptions?.force ?? false;
      const entry = state.entries.get(path);

      if (!entry) {
        if (force) return;
        throw new FileSystemError("ENOENT", path, `Path not found: ${path}`);
      }

      if (entry.type === "directory") {
        // Check if directory is empty
        const prefix = path === "/" ? "/" : path + "/";
        const hasChildren = [...state.entries.keys()].some((k) => k.startsWith(prefix));

        if (hasChildren && !recursive) {
          throw new FileSystemError("ENOTEMPTY", path, `Directory not empty: ${path}`);
        }

        if (recursive) {
          // Delete all children first
          for (const key of [...state.entries.keys()]) {
            if (key.startsWith(prefix)) {
              (state as FileSystemMockStateImpl)["_entries"].delete(key);
            }
          }
        }
      }

      (state as FileSystemMockStateImpl)["_entries"].delete(path);
    },

    async copyTree(src: PathLike, dest: PathLike): Promise<void> {
      const srcPath = normalizePath(src);
      const destPath = normalizePath(dest);
      const srcEntry = state.entries.get(srcPath);

      if (!srcEntry) {
        throw new FileSystemError("ENOENT", srcPath, `Source not found: ${srcPath}`);
      }

      // Create destination parent directories
      const destParent = getParentPath(destPath);
      if (destParent !== null) {
        await layer.mkdir(destParent, { recursive: true });
      }

      // Copy the entry
      if (srcEntry.type === "file") {
        state.setEntry(destPath, { ...srcEntry });
      } else if (srcEntry.type === "symlink") {
        state.setEntry(destPath, { ...srcEntry });
      } else {
        // Directory - copy recursively
        state.setEntry(destPath, directory());

        const prefix = srcPath === "/" ? "/" : srcPath + "/";
        for (const [entryPath, e] of state.entries) {
          if (entryPath.startsWith(prefix)) {
            const relativePath = entryPath.substring(prefix.length);
            const newPath = destPath + "/" + relativePath;
            if (e.type === "directory") {
              state.setEntry(newPath, directory());
            } else if (e.type === "file") {
              state.setEntry(newPath, { ...e });
            } else {
              state.setEntry(newPath, { ...e });
            }
          }
        }
      }
    },

    async makeExecutable(pathLike: PathLike): Promise<void> {
      const path = normalizePath(pathLike);
      const entry = state.entries.get(path);

      if (!entry) {
        throw new FileSystemError("ENOENT", path, `File not found: ${path}`);
      }

      // No-op on Windows
      if (process.platform === "win32") {
        return;
      }

      if (entry.type !== "file") {
        throw new FileSystemError("ENOENT", path, `Not a regular file: ${path}`);
      }

      // Update entry with executable flag
      const opts: { executable: boolean; error?: FileSystemErrorCode } = { executable: true };
      if (entry.error) {
        opts.error = entry.error;
      }
      state.setEntry(path, file(entry.content, opts));
    },

    async writeFileBuffer(pathLike: PathLike, content: Buffer): Promise<void> {
      const path = normalizePath(pathLike);
      const existing = state.entries.get(path);

      // Check if path is a directory
      if (existing?.type === "directory") {
        throw new FileSystemError("EISDIR", path, `Is a directory: ${path}`);
      }

      // Check if parent exists
      const parent = getParentPath(path);
      if (parent !== null) {
        const parentEntry = state.entries.get(parent);
        if (!parentEntry) {
          throw new FileSystemError("ENOENT", path, `Parent directory not found: ${parent}`);
        }
        if (parentEntry.type !== "directory") {
          throw new FileSystemError("ENOENT", path, `Parent is not a directory: ${parent}`);
        }
      }

      state.setEntry(path, file(content));
    },

    async symlink(target: PathLike, linkPath: PathLike): Promise<void> {
      const targetPath = normalizePath(target);
      const link = normalizePath(linkPath);

      // Check if parent exists
      const parent = getParentPath(link);
      if (parent !== null) {
        const parentEntry = state.entries.get(parent);
        if (!parentEntry) {
          throw new FileSystemError("ENOENT", link, `Parent directory not found: ${parent}`);
        }
        if (parentEntry.type !== "directory") {
          throw new FileSystemError("ENOENT", link, `Parent is not a directory: ${parent}`);
        }
      }

      // Remove existing symlink
      const existing = state.entries.get(link);
      if (existing?.type === "symlink") {
        (state as FileSystemMockStateImpl)["_entries"].delete(link);
      }

      state.setEntry(link, symlink(targetPath));
    },

    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
      const srcPath = normalizePath(oldPath);
      const destPath = normalizePath(newPath);
      const entry = state.entries.get(srcPath);

      if (!entry) {
        throw new FileSystemError("ENOENT", srcPath, `Source not found: ${srcPath}`);
      }

      // For directories, move all children too
      if (entry.type === "directory") {
        const prefix = srcPath === "/" ? "/" : srcPath + "/";
        const toMove: [string, Entry][] = [];

        for (const [entryPath, e] of state.entries) {
          if (entryPath.startsWith(prefix)) {
            const relativePath = entryPath.substring(prefix.length);
            toMove.push([destPath + "/" + relativePath, e]);
          }
        }

        // Delete old entries
        for (const [entryPath] of state.entries) {
          if (entryPath.startsWith(prefix)) {
            (state as FileSystemMockStateImpl)["_entries"].delete(entryPath);
          }
        }

        // Create new entries
        state.setEntry(destPath, entry);
        for (const [newEntryPath, e] of toMove) {
          state.setEntry(newEntryPath, e);
        }
      } else {
        state.setEntry(destPath, entry);
      }

      (state as FileSystemMockStateImpl)["_entries"].delete(srcPath);
    },

    async mkdtemp(prefix: string): Promise<Path> {
      // Check if mkdtemp should fail (for error handling tests)
      if ((state as FileSystemMockStateImpl).mkdtempShouldFail) {
        throw new FileSystemError("EACCES", "/tmp", "Mock mkdtemp failure: permission denied");
      }

      // Generate unique path using counter
      const counter = (state as FileSystemMockStateImpl).incrementMkdtempCounter();
      const tempPath = `/tmp/${prefix}${counter.toString(16).padStart(6, "0")}`;
      state.setEntry(tempPath, directory());
      return new Path(tempPath);
    },
  };

  return Object.assign(layer, { $: state });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for filesystem mock assertions.
 */
interface FileSystemMatchers {
  /**
   * Assert that a file exists with optional content check.
   * Uses Buffer.equals() for Buffer content comparison.
   *
   * @param path - Absolute path to file
   * @param content - Optional expected content (string or Buffer)
   */
  toHaveFile(path: string | Path, content?: string | Buffer): void;

  /**
   * Assert that a directory exists.
   *
   * @param path - Absolute path to directory
   */
  toHaveDirectory(path: string | Path): void;

  /**
   * Assert that a file exists and contains a pattern.
   *
   * @param path - Absolute path to file
   * @param pattern - Substring or regex to match
   */
  toHaveFileContaining(path: string | Path, pattern: string | RegExp): void;

  /**
   * Assert that a symlink exists with optional target check.
   *
   * @param path - Absolute path to symlink
   * @param target - Optional expected target path
   */
  toHaveSymlink(path: string | Path, target?: string | Path): void;

  /**
   * Assert that a file is executable.
   *
   * @param path - Absolute path to file
   */
  toBeExecutable(path: string | Path): void;
}

declare module "vitest" {
  interface Assertion<T> extends FileSystemMatchers {}
}

export const fileSystemMatchers: MatcherImplementationsFor<
  MockFileSystemLayer,
  FileSystemMatchers
> = {
  toHaveFile(received, path, content?) {
    const normalizedPath = normalizePath(path);
    const entry = received.$.entries.get(normalizedPath);

    if (!entry) {
      return {
        pass: false,
        message: () => `Expected file at ${normalizedPath} but it does not exist`,
      };
    }

    if (entry.type !== "file") {
      return {
        pass: false,
        message: () => `Expected file at ${normalizedPath} but found ${entry.type}`,
      };
    }

    if (content !== undefined) {
      const contentMatches =
        content instanceof Buffer && entry.content instanceof Buffer
          ? content.equals(entry.content)
          : content instanceof Buffer
            ? content.toString("utf-8") === entry.content
            : entry.content instanceof Buffer
              ? entry.content.toString("utf-8") === content
              : entry.content === content;

      if (!contentMatches) {
        const expected =
          content instanceof Buffer ? `<Buffer ${content.length} bytes>` : JSON.stringify(content);
        const actual =
          entry.content instanceof Buffer
            ? `<Buffer ${entry.content.length} bytes>`
            : JSON.stringify(entry.content);

        return {
          pass: false,
          message: () =>
            `Expected file ${normalizedPath} to have content ${expected} but got ${actual}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected ${normalizedPath} not to be a file`,
    };
  },

  toHaveDirectory(received, path) {
    const normalizedPath = normalizePath(path);
    const entry = received.$.entries.get(normalizedPath);

    if (!entry) {
      return {
        pass: false,
        message: () => `Expected directory at ${normalizedPath} but it does not exist`,
      };
    }

    if (entry.type !== "directory") {
      return {
        pass: false,
        message: () => `Expected directory at ${normalizedPath} but found ${entry.type}`,
      };
    }

    return {
      pass: true,
      message: () => `Expected ${normalizedPath} not to be a directory`,
    };
  },

  toHaveFileContaining(received, path, pattern) {
    const normalizedPath = normalizePath(path);
    const entry = received.$.entries.get(normalizedPath);

    if (!entry) {
      return {
        pass: false,
        message: () => `Expected file at ${normalizedPath} but it does not exist`,
      };
    }

    if (entry.type !== "file") {
      return {
        pass: false,
        message: () => `Expected file at ${normalizedPath} but found ${entry.type}`,
      };
    }

    const rawContent: string | Buffer = entry.content;
    const contentStr = typeof rawContent === "string" ? rawContent : rawContent.toString("utf-8");

    const matches =
      pattern instanceof RegExp ? pattern.test(contentStr) : contentStr.includes(pattern);

    if (!matches) {
      const patternStr = pattern instanceof RegExp ? pattern.toString() : JSON.stringify(pattern);
      return {
        pass: false,
        message: () =>
          `Expected file ${normalizedPath} to contain ${patternStr} but content was ${JSON.stringify(contentStr)}`,
      };
    }

    return {
      pass: true,
      message: () =>
        `Expected file ${normalizedPath} not to contain ${pattern instanceof RegExp ? pattern.toString() : JSON.stringify(pattern)}`,
    };
  },

  toHaveSymlink(received, path, target?) {
    const normalizedPath = normalizePath(path);
    const entry = received.$.entries.get(normalizedPath);

    if (!entry) {
      return {
        pass: false,
        message: () => `Expected symlink at ${normalizedPath} but it does not exist`,
      };
    }

    if (entry.type !== "symlink") {
      return {
        pass: false,
        message: () => `Expected symlink at ${normalizedPath} but found ${entry.type}`,
      };
    }

    if (target !== undefined) {
      const expectedTarget = normalizePath(target);
      if (entry.target !== expectedTarget) {
        return {
          pass: false,
          message: () =>
            `Expected symlink ${normalizedPath} to point to ${expectedTarget} but it points to ${entry.target}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected ${normalizedPath} not to be a symlink`,
    };
  },

  toBeExecutable(received, path) {
    const normalizedPath = normalizePath(path);
    const entry = received.$.entries.get(normalizedPath);

    if (!entry) {
      return {
        pass: false,
        message: () => `Expected file at ${normalizedPath} but it does not exist`,
      };
    }

    if (entry.type !== "file") {
      return {
        pass: false,
        message: () => `Expected file at ${normalizedPath} but found ${entry.type}`,
      };
    }

    if (!entry.executable) {
      return {
        pass: false,
        message: () => `Expected file ${normalizedPath} to be executable`,
      };
    }

    return {
      pass: true,
      message: () => `Expected file ${normalizedPath} not to be executable`,
    };
  },
};

// Register matchers with expect
expect.extend(fileSystemMatchers);

// =============================================================================
// Spy FileSystemLayer Factory
// =============================================================================

import { vi, type Mock } from "vitest";

/**
 * FileSystemLayer with vi.fn() spies for asserting on method calls.
 * Each method is a Vitest Mock that wraps the mock implementation.
 * Includes $ property for state access.
 */
export interface SpyFileSystemLayer extends FileSystemLayer {
  readFile: Mock<FileSystemLayer["readFile"]>;
  writeFile: Mock<FileSystemLayer["writeFile"]>;
  mkdir: Mock<FileSystemLayer["mkdir"]>;
  readdir: Mock<FileSystemLayer["readdir"]>;
  unlink: Mock<FileSystemLayer["unlink"]>;
  rm: Mock<FileSystemLayer["rm"]>;
  copyTree: Mock<FileSystemLayer["copyTree"]>;
  makeExecutable: Mock<FileSystemLayer["makeExecutable"]>;
  writeFileBuffer: Mock<FileSystemLayer["writeFileBuffer"]>;
  symlink: Mock<FileSystemLayer["symlink"]>;
  rename: Mock<FileSystemLayer["rename"]>;
  mkdtemp: Mock<FileSystemLayer["mkdtemp"]>;
  /** State access for behavioral mock */
  $: FileSystemMockState;
}

/**
 * Create a FileSystemLayer with vi.fn() spies for testing.
 * Use when you need to assert on method calls.
 *
 * @example Basic usage - assert on calls
 * ```typescript
 * const fs = createSpyFileSystemLayer();
 * await service.doSomething(fs);
 * expect(fs.writeFile).toHaveBeenCalledWith('/path', 'content');
 * ```
 *
 * @example With initial state
 * ```typescript
 * const fs = createSpyFileSystemLayer({
 *   entries: { "/data": directory() }
 * });
 * ```
 */
export function createSpyFileSystemLayer(options?: MockFileSystemOptions): SpyFileSystemLayer {
  const mock = createFileSystemMock(options);
  return {
    readFile: vi.fn(mock.readFile.bind(mock)),
    writeFile: vi.fn(mock.writeFile.bind(mock)),
    mkdir: vi.fn(mock.mkdir.bind(mock)),
    readdir: vi.fn(mock.readdir.bind(mock)),
    unlink: vi.fn(mock.unlink.bind(mock)),
    rm: vi.fn(mock.rm.bind(mock)),
    copyTree: vi.fn(mock.copyTree.bind(mock)),
    makeExecutable: vi.fn(mock.makeExecutable.bind(mock)),
    writeFileBuffer: vi.fn(mock.writeFileBuffer.bind(mock)),
    symlink: vi.fn(mock.symlink.bind(mock)),
    rename: vi.fn(mock.rename.bind(mock)),
    mkdtemp: vi.fn(mock.mkdtemp.bind(mock)),
    $: mock.$,
  } as SpyFileSystemLayer;
}
