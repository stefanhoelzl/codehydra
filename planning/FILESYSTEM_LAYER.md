---
status: COMPLETED
last_updated: 2025-12-12
reviewers: [review-typescript, review-arch, review-senior, review-testing, review-docs]
---

# FILESYSTEM_LAYER

## Overview

- **Problem**: `ProjectStore` and `VscodeSetupService` have direct filesystem dependencies, making them hard to unit test. `ProjectStore` boundary tests cover both business logic and filesystem access. `VscodeSetupService` uses fragile module-level mocking (`vi.mock("node:fs/promises")`).

- **Solution**: Extract filesystem operations into a `FileSystemLayer` abstraction. This enables:
  - Unit testing business logic with mock `FileSystemLayer`
  - Boundary tests only for `DefaultFileSystemLayer` against real filesystem
  - Consistent error handling via `FileSystemError` (extends `ServiceError` for IPC)
  - Reusable abstraction for future services

- **Risks**:
  - Risk: Abstraction overhead for simple operations
    - Mitigation: Keep interface minimal, only what's needed
  - Risk: Error mapping may lose details
    - Mitigation: Preserve original error as `cause` AND `originalCode` for unmapped codes

- **Alternatives Considered**:
  1. **Keep module mocking**: Rejected - fragile, hard to understand, doesn't work well with ESM
  2. **Dependency injection of fs module**: Rejected - still requires mocking entire module API
  3. **Abstract only ProjectStore**: Rejected - VscodeSetupService has same problem
  4. **Add `exists()` method**: Rejected - creates TOCTOU race conditions; use try/catch instead
  5. **Add separate `rmdir()` method**: Rejected - redundant with `rm()`; use `rm()` for all deletion

- **Future Considerations**:
  - `stat()` method for file metadata if needed
  - Encoding parameter for non-UTF-8 files if needed

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Service Layer                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────┐         ┌─────────────────────────────┐    │
│  │    ProjectStore     │         │    VscodeSetupService       │    │
│  │  ───────────────    │         │    ───────────────────      │    │
│  │  - saveProject()    │         │    - isSetupComplete()      │    │
│  │  - loadAllProjects()│         │    - setup()                │    │
│  │  - removeProject()  │         │    - cleanVscodeDir()       │    │
│  │                     │         │    - installCustomExts()    │    │
│  │  [unit tests with   │         │    - writeConfigFiles()     │    │
│  │   mock FSLayer]     │         │    - writeCompletionMarker()│    │
│  └──────────┬──────────┘         └──────────────┬──────────────┘    │
│             │                                    │                   │
│             │         FileSystemLayer            │                   │
│             │           (interface)              │                   │
│             └───────────────┬────────────────────┘                   │
│                             │                                        │
└─────────────────────────────┼────────────────────────────────────────┘
                              │
┌─────────────────────────────┼────────────────────────────────────────┐
│                         Platform Layer                               │
├─────────────────────────────┼────────────────────────────────────────┤
│                             ▼                                        │
│             ┌───────────────────────────────┐                        │
│             │   DefaultFileSystemLayer      │                        │
│             │   ───────────────────────     │                        │
│             │   Wraps Node.js fs/promises   │                        │
│             │   Maps errors to FSError      │                        │
│             │                               │                        │
│             │   [boundary tests with        │                        │
│             │    real filesystem]           │                        │
│             └───────────────────────────────┘                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Interface Design

### Type Definitions

```typescript
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
```

### FileSystemError (extends ServiceError)

```typescript
// In errors.ts - add "filesystem" to SerializedError type:
export interface SerializedError {
  readonly type:
    | "git"
    | "workspace"
    | "code-server"
    | "project-store"
    | "opencode"
    | "vscode-setup"
    | "filesystem"; // NEW
  readonly message: string;
  readonly code?: string;
  readonly path?: string; // NEW - for filesystem errors
}

// In errors.ts - add FileSystemError class:
export class FileSystemError extends ServiceError {
  readonly type = "filesystem" as const;

  constructor(
    /** Mapped error code */
    readonly fsCode: FileSystemErrorCode,
    /** Path that caused the error */
    readonly path: string,
    message: string,
    /** Original error for debugging */
    readonly cause?: Error,
    /** Original Node.js error code (e.g., "EMFILE", "ENOSPC") */
    readonly originalCode?: string
  ) {
    super(message, fsCode);
    this.name = "FileSystemError";
  }

  override toJSON(): SerializedError {
    const result: SerializedError = {
      type: this.type,
      message: this.message,
      path: this.path,
    };
    if (this.fsCode) {
      return { ...result, code: this.fsCode };
    }
    return result;
  }
}

// Update ServiceError.fromJSON() to handle "filesystem" type
```

### FileSystemLayer Interface

```typescript
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
}
```

### Mock Factory API

```typescript
/**
 * Options for creating a mock FileSystemLayer.
 */
export interface MockFileSystemLayerOptions {
  /** Mock readFile: return content or throw error */
  readonly readFile?: {
    readonly content?: string;
    readonly error?: FileSystemError;
    readonly implementation?: (path: string) => Promise<string>;
  };
  /** Mock writeFile: succeed or throw error */
  readonly writeFile?: {
    readonly error?: FileSystemError;
    readonly implementation?: (path: string, content: string) => Promise<void>;
  };
  /** Mock mkdir: succeed or throw error */
  readonly mkdir?: {
    readonly error?: FileSystemError;
    readonly implementation?: (path: string, options?: MkdirOptions) => Promise<void>;
  };
  /** Mock readdir: return entries or throw error */
  readonly readdir?: {
    readonly entries?: readonly DirEntry[];
    readonly error?: FileSystemError;
    readonly implementation?: (path: string) => Promise<readonly DirEntry[]>;
  };
  /** Mock unlink: succeed or throw error */
  readonly unlink?: {
    readonly error?: FileSystemError;
    readonly implementation?: (path: string) => Promise<void>;
  };
  /** Mock rm: succeed or throw error */
  readonly rm?: {
    readonly error?: FileSystemError;
    readonly implementation?: (path: string, options?: RmOptions) => Promise<void>;
  };
}

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
export function createMockFileSystemLayer(options?: MockFileSystemLayerOptions): FileSystemLayer;
```

## Implementation Steps

- [x] **Step 1: Create FileSystemLayer interface and error types**
  - Create `src/services/platform/filesystem.ts` with:
    - `DirEntry`, `MkdirOptions`, `RmOptions` interfaces
    - `FileSystemErrorCode` type
    - `FileSystemLayer` interface with full JSDoc
  - Update `src/services/errors.ts`:
    - Add `"filesystem"` to `SerializedError.type` union
    - Add optional `path?: string` to `SerializedError`
    - Add `FileSystemError` class extending `ServiceError`
    - Update `ServiceError.fromJSON()` to handle `"filesystem"` type
  - Files affected:
    - `src/services/platform/filesystem.ts` (new)
    - `src/services/errors.ts`
  - Test criteria:
    - Types compile correctly
    - `FileSystemError` can be instantiated with all error codes
    - `FileSystemError.toJSON()` returns correct structure
    - `ServiceError.fromJSON()` reconstructs `FileSystemError`

- [x] **Step 2: Implement DefaultFileSystemLayer**
  - Implement all interface methods using `node:fs/promises`
  - Map Node.js error codes to `FileSystemErrorCode`:
    - ENOENT, EACCES, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY → mapped codes
    - Other codes (EMFILE, ENOSPC, etc.) → UNKNOWN with `originalCode` preserved
  - Default `mkdir` to `{ recursive: true }`
  - Files affected:
    - `src/services/platform/filesystem.ts`
  - Test criteria:
    - All methods implemented
    - Error mapping works for known codes
    - Unknown error codes preserved in `originalCode`

- [x] **Step 3: Write boundary tests for DefaultFileSystemLayer (TDD)**
  - **Write failing tests first**, then implement to make them pass
  - Test all operations against real filesystem using temp directories
  - Use `createTempDir()` from existing test utilities with automatic cleanup
  - Each test gets isolated temp directory to avoid pollution
  - Files affected:
    - `src/services/platform/filesystem.boundary.test.ts` (new)
  - Test cases:
    - `readFile` - success, ENOENT, EISDIR
    - `writeFile` - success, overwrite, ENOENT (no parent), EACCES (if testable)
    - `mkdir` - success, nested, already exists, EEXIST (file at path)
    - `readdir` - success with files/dirs/symlinks, ENOENT, ENOTDIR
    - `unlink` - success, ENOENT, EISDIR
    - `rm` - file, empty dir, non-empty dir (no recursive), recursive, force, ENOENT
    - `rm` - ENOTEMPTY when not recursive
  - Test criteria:
    - All methods have coverage for success and error paths
    - Error codes verified (ENOENT, ENOTEMPTY, EISDIR, etc.)
    - Cleanup runs even on test failure

- [x] **Step 4: Create mock factory for FileSystemLayer**
  - Create `createMockFileSystemLayer()` factory function
  - Support per-method configuration: content, error, or implementation
  - Follow pattern from `network.test-utils.ts`
  - Files affected:
    - `src/services/platform/filesystem.test-utils.ts` (new)
  - Test criteria:
    - Mock can simulate success responses with specific content
    - Mock can simulate specific errors
    - Custom implementations can be provided
    - Signature consistent with `createMockHttpClient`, `createMockProcessRunner`

- [x] **Step 5: Write unit tests for ProjectStore (TDD)**
  - **Write failing tests first** with mock `FileSystemLayer`
  - Test business logic: JSON serialization, path building, error handling
  - Files affected:
    - `src/services/project/project-store.test.ts` (new)
  - Test cases:
    - `saveProject` - correct JSON structure, correct path, error wrapping
    - `loadAllProjects` - parsing, filtering invalid entries, empty dir, no dir
    - `removeProject` - file deletion, empty dir cleanup, not found (no error)
    - Edge cases: empty path handling, paths with special characters
  - Test criteria:
    - All public methods tested
    - Error scenarios covered
    - No real filesystem access
    - Tests fail initially (TDD red phase)

- [x] **Step 6: Refactor ProjectStore to use FileSystemLayer**
  - Add `FileSystemLayer` as constructor parameter
  - Replace direct `fs` calls with `FileSystemLayer` methods
  - `FileSystemLayer` methods throw `FileSystemError` - handle appropriately:
    - Let errors propagate for unexpected failures
    - Catch and handle expected errors (e.g., ENOENT in `loadAllProjects`)
  - Keep `projectDirName` as-is (pure function, no fs)
  - Files affected:
    - `src/services/project/project-store.ts`
  - Test criteria:
    - No direct `fs` imports remain (verify with grep)
    - Constructor accepts `FileSystemLayer`
    - Unit tests pass (TDD green phase)

- [x] **Step 7: Simplify ProjectStore boundary tests**
  - Rename to `project-store.integration.test.ts` (tests ProjectStore + DefaultFileSystemLayer)
  - Remove tests that duplicate unit test coverage
  - Keep only end-to-end tests (full save/load/remove cycle)
  - Move `projectDirName` tests to `paths.test.ts` if not already there
  - Files affected:
    - `src/services/project/project-store.boundary.test.ts` → `project-store.integration.test.ts`
    - `src/services/platform/paths.test.ts` (if needed)
  - Test criteria:
    - Tests focus on end-to-end behavior with real filesystem
    - No business logic assertions (moved to unit tests)
    - File renamed to reflect integration test nature

- [x] **Step 8: Write unit tests for VscodeSetupService with mock FileSystemLayer (TDD)**
  - **Write new tests first** using `createMockFileSystemLayer()`
  - Replicate existing test coverage but with explicit mocks instead of `vi.mock`
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.test.ts`
  - Test cases:
    - `isSetupComplete` - marker exists, missing, wrong version, corrupted, empty
    - `setup` - all steps succeed, extension install fails, fs error handling
    - `cleanVscodeDir` - success, path validation, ENOENT handling
    - `installCustomExtensions` - creates files, idempotent
    - `writeConfigFiles` - correct content, correct paths
  - Test criteria:
    - Tests written with mock FileSystemLayer
    - No `vi.mock("node:fs/promises")` in new tests
    - Tests fail initially (TDD red phase)

- [x] **Step 9: Refactor VscodeSetupService to use FileSystemLayer**
  - Add `FileSystemLayer` as constructor parameter
  - Replace direct `fs` calls with `FileSystemLayer` methods
  - Remove `vi.mock("node:fs/promises")` from test file
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.ts`
    - `src/services/vscode-setup/vscode-setup-service.test.ts`
  - Test criteria:
    - No direct `fs` imports remain (verify with grep)
    - Constructor accepts `FileSystemLayer`
    - No `vi.mock("node:fs/promises")` in test file
    - Unit tests pass (TDD green phase)

- [x] **Step 10: Update VscodeSetupService integration tests**
  - Inject `DefaultFileSystemLayer` in integration tests
  - Tests continue to use real filesystem
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.integration.test.ts`
  - Test criteria:
    - Tests still use real filesystem
    - `DefaultFileSystemLayer` injected explicitly
    - All existing test cases still pass

- [x] **Step 11: Update service wiring in main process**
  - Create `DefaultFileSystemLayer` instance at module level
  - Inject into `ProjectStore` and `VscodeSetupService`
  - Files affected:
    - `src/main/index.ts`
  - Test criteria:
    - App starts without errors
    - Project save/load works
    - VS Code setup works
  - Manual verification:
    - Run `npm run dev` and verify app starts
    - Open a project, close app, reopen - project persists

- [x] **Step 12: Update documentation**
  - Update `AGENTS.md` with FileSystemLayer pattern section
  - Update `docs/ARCHITECTURE.md` with platform layer abstraction
  - Files affected:
    - `AGENTS.md`
    - `docs/ARCHITECTURE.md`
  - See Documentation Updates section for details

## Testing Strategy

### Unit Tests (vitest)

| Test Case                               | Description                               | File                           |
| --------------------------------------- | ----------------------------------------- | ------------------------------ |
| FileSystemError construction            | Error codes, message, cause, originalCode | `errors.test.ts`               |
| FileSystemError.toJSON                  | Serialization for IPC                     | `errors.test.ts`               |
| ServiceError.fromJSON filesystem        | Deserialization from IPC                  | `errors.test.ts`               |
| ProjectStore.saveProject                | JSON structure, path building             | `project-store.test.ts`        |
| ProjectStore.saveProject errors         | Error wrapping with context               | `project-store.test.ts`        |
| ProjectStore.loadAllProjects            | Parsing, filtering invalid, empty         | `project-store.test.ts`        |
| ProjectStore.loadAllProjects errors     | Graceful error handling                   | `project-store.test.ts`        |
| ProjectStore.removeProject              | File deletion, empty dir cleanup          | `project-store.test.ts`        |
| ProjectStore edge cases                 | Empty path, special characters            | `project-store.test.ts`        |
| VscodeSetupService.isSetupComplete      | Marker parsing, version check             | `vscode-setup-service.test.ts` |
| VscodeSetupService.isSetupComplete edge | Wrong version, corrupted, empty           | `vscode-setup-service.test.ts` |
| VscodeSetupService.setup                | Step ordering, error handling             | `vscode-setup-service.test.ts` |

### Boundary Tests (vitest)

| Test Case           | Description                   | File                          |
| ------------------- | ----------------------------- | ----------------------------- |
| readFile success    | Read existing file            | `filesystem.boundary.test.ts` |
| readFile ENOENT     | Read non-existent file        | `filesystem.boundary.test.ts` |
| readFile EISDIR     | Read directory as file        | `filesystem.boundary.test.ts` |
| writeFile success   | Write new file                | `filesystem.boundary.test.ts` |
| writeFile overwrite | Overwrite existing file       | `filesystem.boundary.test.ts` |
| writeFile ENOENT    | Write to non-existent parent  | `filesystem.boundary.test.ts` |
| mkdir success       | Create directory              | `filesystem.boundary.test.ts` |
| mkdir nested        | Create nested directories     | `filesystem.boundary.test.ts` |
| mkdir exists        | No-op if exists               | `filesystem.boundary.test.ts` |
| mkdir EEXIST        | File exists at path           | `filesystem.boundary.test.ts` |
| readdir success     | List with files/dirs/symlinks | `filesystem.boundary.test.ts` |
| readdir ENOENT      | Non-existent directory        | `filesystem.boundary.test.ts` |
| readdir ENOTDIR     | File instead of directory     | `filesystem.boundary.test.ts` |
| unlink success      | Delete file                   | `filesystem.boundary.test.ts` |
| unlink ENOENT       | Delete non-existent           | `filesystem.boundary.test.ts` |
| unlink EISDIR       | Delete directory with unlink  | `filesystem.boundary.test.ts` |
| rm file             | Delete file                   | `filesystem.boundary.test.ts` |
| rm empty dir        | Delete empty directory        | `filesystem.boundary.test.ts` |
| rm ENOTEMPTY        | Non-empty without recursive   | `filesystem.boundary.test.ts` |
| rm recursive        | Delete directory tree         | `filesystem.boundary.test.ts` |
| rm force            | No error if missing           | `filesystem.boundary.test.ts` |

### Integration Tests (vitest)

| Test Case                     | Description                  | File                                       |
| ----------------------------- | ---------------------------- | ------------------------------------------ |
| ProjectStore full cycle       | Save, load, remove project   | `project-store.integration.test.ts`        |
| VscodeSetupService full setup | All setup steps with real fs | `vscode-setup-service.integration.test.ts` |

### Manual Testing Checklist

Run after Step 11 is complete:

- [ ] Start app fresh (`npm run dev`), verify VS Code setup completes
- [ ] Open a project, close app, reopen - project persists
- [ ] Remove project, verify it's gone after restart

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Add new "### FileSystemLayer Pattern" section after ProcessRunner Pattern section (~line 436). Include: interface table showing all methods, DI example showing injection pattern, testing example with `createMockFileSystemLayer()`. Follow same format as NetworkLayer and ProcessRunner sections. |
| `docs/ARCHITECTURE.md` | Add FileSystemLayer to platform layer abstractions in "Build Mode and Path Abstraction" section or new subsection. Document the interface, DefaultFileSystemLayer implementation, and DI pattern.                                                                                                     |

### New Documentation Required

| File   | Purpose                                 |
| ------ | --------------------------------------- |
| (none) | Interface is self-documenting via TSDoc |

## Definition of Done

- [ ] All implementation steps complete (Steps 1-12)
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (AGENTS.md, ARCHITECTURE.md)
- [ ] User acceptance testing passed (manual checklist)
- [ ] Changes committed
