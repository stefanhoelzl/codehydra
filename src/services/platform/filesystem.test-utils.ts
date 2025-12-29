/**
 * Test utilities for FileSystemLayer mocking.
 *
 * Provides mock factory for FileSystemLayer to enable easy unit testing of consumers.
 */

import type { FileSystemLayer, DirEntry, MkdirOptions, RmOptions, PathLike } from "./filesystem";
import { FileSystemError } from "../errors";

// ============================================================================
// Mock Option Types
// ============================================================================

/**
 * Options for mock readFile method.
 */
export interface MockReadFileOptions {
  /** Content to return */
  readonly content?: string;
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike) => Promise<string>;
}

/**
 * Options for mock writeFile method.
 */
export interface MockWriteFileOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike, content: string) => Promise<void>;
}

/**
 * Options for mock mkdir method.
 */
export interface MockMkdirOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike, options?: MkdirOptions) => Promise<void>;
}

/**
 * Options for mock readdir method.
 */
export interface MockReaddirOptions {
  /** Entries to return */
  readonly entries?: readonly DirEntry[];
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike) => Promise<readonly DirEntry[]>;
}

/**
 * Options for mock unlink method.
 */
export interface MockUnlinkOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike) => Promise<void>;
}

/**
 * Options for mock rm method.
 */
export interface MockRmOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike, options?: RmOptions) => Promise<void>;
}

/**
 * Options for mock copyTree method.
 */
export interface MockCopyTreeOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (src: PathLike, dest: PathLike) => Promise<void>;
}

/**
 * Options for mock makeExecutable method.
 */
export interface MockMakeExecutableOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike) => Promise<void>;
}

/**
 * Options for mock writeFileBuffer method.
 */
export interface MockWriteFileBufferOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: PathLike, content: Buffer) => Promise<void>;
}

/**
 * Options for mock symlink method.
 */
export interface MockSymlinkOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (target: PathLike, linkPath: PathLike) => Promise<void>;
}

/**
 * Options for mock rename method.
 */
export interface MockRenameOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (oldPath: PathLike, newPath: PathLike) => Promise<void>;
}

/**
 * Options for creating a mock FileSystemLayer.
 */
export interface MockFileSystemLayerOptions {
  /** Mock readFile: return content or throw error */
  readonly readFile?: MockReadFileOptions;
  /** Mock writeFile: succeed or throw error */
  readonly writeFile?: MockWriteFileOptions;
  /** Mock mkdir: succeed or throw error */
  readonly mkdir?: MockMkdirOptions;
  /** Mock readdir: return entries or throw error */
  readonly readdir?: MockReaddirOptions;
  /** Mock unlink: succeed or throw error */
  readonly unlink?: MockUnlinkOptions;
  /** Mock rm: succeed or throw error */
  readonly rm?: MockRmOptions;
  /** Mock copyTree: return result or throw error */
  readonly copyTree?: MockCopyTreeOptions;
  /** Mock makeExecutable: succeed or throw error */
  readonly makeExecutable?: MockMakeExecutableOptions;
  /** Mock writeFileBuffer: succeed or throw error */
  readonly writeFileBuffer?: MockWriteFileBufferOptions;
  /** Mock symlink: succeed or throw error */
  readonly symlink?: MockSymlinkOptions;
  /** Mock rename: succeed or throw error */
  readonly rename?: MockRenameOptions;
}

// ============================================================================
// Mock FileSystemLayer Factory
// ============================================================================

/**
 * Create mock FileSystemLayer for testing.
 *
 * @example Basic usage - all operations succeed
 * const mockFs = createMockFileSystemLayer();
 *
 * @example Return specific file content
 * const mockFs = createMockFileSystemLayer({
 *   readFile: { content: '{"key": "value"}' }
 * });
 *
 * @example Throw specific error
 * const mockFs = createMockFileSystemLayer({
 *   readFile: { error: new FileSystemError('ENOENT', '/path', 'Not found') }
 * });
 *
 * @example Custom implementation
 * const mockFs = createMockFileSystemLayer({
 *   readFile: {
 *     implementation: async (path) => {
 *       if (path === '/config.json') return '{}';
 *       throw new FileSystemError('ENOENT', path, 'Not found');
 *     }
 *   }
 * });
 */
export function createMockFileSystemLayer(options?: MockFileSystemLayerOptions): FileSystemLayer {
  return {
    async readFile(path: PathLike): Promise<string> {
      if (options?.readFile?.implementation) {
        return options.readFile.implementation(path);
      }
      if (options?.readFile?.error) {
        throw options.readFile.error;
      }
      return options?.readFile?.content ?? "";
    },

    async writeFile(path: PathLike, content: string): Promise<void> {
      if (options?.writeFile?.implementation) {
        return options.writeFile.implementation(path, content);
      }
      if (options?.writeFile?.error) {
        throw options.writeFile.error;
      }
      // Default: succeed silently
    },

    async mkdir(path: PathLike, mkdirOptions?: MkdirOptions): Promise<void> {
      if (options?.mkdir?.implementation) {
        return options.mkdir.implementation(path, mkdirOptions);
      }
      if (options?.mkdir?.error) {
        throw options.mkdir.error;
      }
      // Default: succeed silently
    },

    async readdir(path: PathLike): Promise<readonly DirEntry[]> {
      if (options?.readdir?.implementation) {
        return options.readdir.implementation(path);
      }
      if (options?.readdir?.error) {
        throw options.readdir.error;
      }
      return options?.readdir?.entries ?? [];
    },

    async unlink(path: PathLike): Promise<void> {
      if (options?.unlink?.implementation) {
        return options.unlink.implementation(path);
      }
      if (options?.unlink?.error) {
        throw options.unlink.error;
      }
      // Default: succeed silently
    },

    async rm(path: PathLike, rmOptions?: RmOptions): Promise<void> {
      if (options?.rm?.implementation) {
        return options.rm.implementation(path, rmOptions);
      }
      if (options?.rm?.error) {
        throw options.rm.error;
      }
      // Default: succeed silently
    },

    async copyTree(src: PathLike, dest: PathLike): Promise<void> {
      if (options?.copyTree?.implementation) {
        return options.copyTree.implementation(src, dest);
      }
      if (options?.copyTree?.error) {
        throw options.copyTree.error;
      }
      // Default: succeed silently
    },

    async makeExecutable(path: PathLike): Promise<void> {
      if (options?.makeExecutable?.implementation) {
        return options.makeExecutable.implementation(path);
      }
      if (options?.makeExecutable?.error) {
        throw options.makeExecutable.error;
      }
      // Default: succeed silently
    },

    async writeFileBuffer(path: PathLike, content: Buffer): Promise<void> {
      if (options?.writeFileBuffer?.implementation) {
        return options.writeFileBuffer.implementation(path, content);
      }
      if (options?.writeFileBuffer?.error) {
        throw options.writeFileBuffer.error;
      }
      // Default: succeed silently
    },

    async symlink(target: PathLike, linkPath: PathLike): Promise<void> {
      if (options?.symlink?.implementation) {
        return options.symlink.implementation(target, linkPath);
      }
      if (options?.symlink?.error) {
        throw options.symlink.error;
      }
      // Default: succeed silently
    },

    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
      if (options?.rename?.implementation) {
        return options.rename.implementation(oldPath, newPath);
      }
      if (options?.rename?.error) {
        throw options.rename.error;
      }
      // Default: succeed silently
    },
  };
}

// ============================================================================
// Spy FileSystemLayer Factory
// ============================================================================

import { vi, type Mock } from "vitest";

/**
 * FileSystemLayer with vi.fn() spies for asserting on method calls.
 * Each method is a Vitest Mock that wraps the mock implementation.
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
 * @example With custom behavior
 * ```typescript
 * const fs = createSpyFileSystemLayer({
 *   readdir: { entries: [createDirEntry('file.txt', { isFile: true })] }
 * });
 * ```
 */
export function createSpyFileSystemLayer(options?: MockFileSystemLayerOptions): SpyFileSystemLayer {
  const mock = createMockFileSystemLayer(options);
  return {
    readFile: vi.fn(mock.readFile),
    writeFile: vi.fn(mock.writeFile),
    mkdir: vi.fn(mock.mkdir),
    readdir: vi.fn(mock.readdir),
    unlink: vi.fn(mock.unlink),
    rm: vi.fn(mock.rm),
    copyTree: vi.fn(mock.copyTree),
    makeExecutable: vi.fn(mock.makeExecutable),
    writeFileBuffer: vi.fn(mock.writeFileBuffer),
    symlink: vi.fn(mock.symlink),
    rename: vi.fn(mock.rename),
  };
}

// ============================================================================
// Helper Functions for Creating Common Test Scenarios
// ============================================================================

/**
 * Create a DirEntry for testing.
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
