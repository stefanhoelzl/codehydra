/**
 * Test utilities for FileSystemLayer mocking.
 *
 * Provides mock factory for FileSystemLayer to enable easy unit testing of consumers.
 */

import type {
  FileSystemLayer,
  DirEntry,
  MkdirOptions,
  RmOptions,
  CopyTreeResult,
} from "./filesystem";
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
  readonly implementation?: (path: string) => Promise<string>;
}

/**
 * Options for mock writeFile method.
 */
export interface MockWriteFileOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: string, content: string) => Promise<void>;
}

/**
 * Options for mock mkdir method.
 */
export interface MockMkdirOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: string, options?: MkdirOptions) => Promise<void>;
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
  readonly implementation?: (path: string) => Promise<readonly DirEntry[]>;
}

/**
 * Options for mock unlink method.
 */
export interface MockUnlinkOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: string) => Promise<void>;
}

/**
 * Options for mock rm method.
 */
export interface MockRmOptions {
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (path: string, options?: RmOptions) => Promise<void>;
}

/**
 * Options for mock copyTree method.
 */
export interface MockCopyTreeOptions {
  /** Result to return */
  readonly result?: CopyTreeResult;
  /** Error to throw */
  readonly error?: FileSystemError;
  /** Custom implementation */
  readonly implementation?: (src: string, dest: string) => Promise<CopyTreeResult>;
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
    async readFile(path: string): Promise<string> {
      if (options?.readFile?.implementation) {
        return options.readFile.implementation(path);
      }
      if (options?.readFile?.error) {
        throw options.readFile.error;
      }
      return options?.readFile?.content ?? "";
    },

    async writeFile(path: string, content: string): Promise<void> {
      if (options?.writeFile?.implementation) {
        return options.writeFile.implementation(path, content);
      }
      if (options?.writeFile?.error) {
        throw options.writeFile.error;
      }
      // Default: succeed silently
    },

    async mkdir(path: string, mkdirOptions?: MkdirOptions): Promise<void> {
      if (options?.mkdir?.implementation) {
        return options.mkdir.implementation(path, mkdirOptions);
      }
      if (options?.mkdir?.error) {
        throw options.mkdir.error;
      }
      // Default: succeed silently
    },

    async readdir(path: string): Promise<readonly DirEntry[]> {
      if (options?.readdir?.implementation) {
        return options.readdir.implementation(path);
      }
      if (options?.readdir?.error) {
        throw options.readdir.error;
      }
      return options?.readdir?.entries ?? [];
    },

    async unlink(path: string): Promise<void> {
      if (options?.unlink?.implementation) {
        return options.unlink.implementation(path);
      }
      if (options?.unlink?.error) {
        throw options.unlink.error;
      }
      // Default: succeed silently
    },

    async rm(path: string, rmOptions?: RmOptions): Promise<void> {
      if (options?.rm?.implementation) {
        return options.rm.implementation(path, rmOptions);
      }
      if (options?.rm?.error) {
        throw options.rm.error;
      }
      // Default: succeed silently
    },

    async copyTree(src: string, dest: string): Promise<CopyTreeResult> {
      if (options?.copyTree?.implementation) {
        return options.copyTree.implementation(src, dest);
      }
      if (options?.copyTree?.error) {
        throw options.copyTree.error;
      }
      return options?.copyTree?.result ?? { copiedCount: 0, skippedSymlinks: [] };
    },
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
