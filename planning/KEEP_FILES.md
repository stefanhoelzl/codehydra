---
status: COMPLETED
last_updated: 2025-12-15
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# KEEP_FILES

## Overview

- **Problem**: When creating a new git worktree, gitignored files (`.env`, local configs, IDE settings) don't exist in the new workspace. Users must manually copy these files every time.
- **Solution**: Add a `.keepfiles` config in project root with gitignore-like syntax (inverted semantics). When creating a workspace, copy matching files/directories from project root to the new workspace.
- **Risks**:
  - Binary file handling - `copyTree` uses `fs.copyFile()` internally for correct binary handling
  - Large directory copying (e.g., `node_modules`) could be slow - document this as user's choice
  - Pattern parsing edge cases - rely on battle-tested `ignore` package
  - Path traversal attacks - validate all destination paths stay within target directory
- **Alternatives Considered**:
  - YAML config (like workbush) - rejected for simplicity; gitignore syntax is familiar
  - Auto-detect untracked files - rejected; explicit config is more predictable
  - Git hooks - rejected; CodeHydra controls workspace creation, hooks are fragile

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Services Layer                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     IKeepFilesService                                 │   │
│  │  copyToWorkspace(projectRoot, targetPath): Promise<CopyResult>       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                               │
│                              │ uses                                          │
│                              ▼                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     KeepFilesService                                  │   │
│  │  - FileSystemLayer (readFile, readdir, copyTree)                     │   │
│  │  - ignore package (pattern matching) - pure library, no I/O          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                               │
│                              │ injected into                                 │
│                              ▼                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     GitWorktreeProvider                               │   │
│  │  createWorkspace(name, baseBranch)                                    │   │
│  │    └─► keepFilesService.copyToWorkspace() [after git worktree add]   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

Data Flow:
──────────
1. User creates workspace via UI
2. GitWorktreeProvider.createWorkspace() called
3. Git worktree created successfully
4. KeepFilesService.copyToWorkspace(projectRoot, worktreePath) called
5. Service reads .keepfiles from projectRoot (if exists)
6. Parses patterns with `ignore` package (inverted semantics - see below)
7. Iteratively scans projectRoot for matching files (queue-based, not recursive)
8. Validates each destination path stays within targetPath (path traversal protection)
9. Copies matched items to worktreePath preserving structure
10. Returns CopyResult (success count, skipped, errors)
```

**Note on `ignore` package**: Direct usage is acceptable because it's a pure pattern-matching library with no I/O or side effects. This is documented as an exception to the "use interfaces for external systems" rule.

## Type Definitions

```typescript
// src/services/keepfiles/types.ts

export interface IKeepFilesService {
  /**
   * Copy files matching .keepfiles patterns from projectRoot to targetPath.
   *
   * @param projectRoot - Source directory containing .keepfiles
   * @param targetPath - Destination directory for copied files
   * @returns Result with counts and any errors encountered
   */
  copyToWorkspace(projectRoot: string, targetPath: string): Promise<CopyResult>;
}

export interface CopyResult {
  /** Whether .keepfiles config file exists in projectRoot */
  readonly configExists: boolean;
  /** Number of files/directories successfully copied */
  readonly copiedCount: number;
  /** Number of items skipped (symlinks, excluded by negation) */
  readonly skippedCount: number;
  /** Errors encountered during copying (doesn't stop other copies) */
  readonly errors: readonly CopyError[];
}

export interface CopyError {
  /** Relative path that failed to copy */
  readonly path: string;
  /** Error message describing the failure */
  readonly message: string;
}

// src/services/platform/filesystem.ts (addition)

export interface CopyTreeResult {
  /** Number of files copied */
  readonly copiedCount: number;
  /** Paths of symlinks that were skipped (security) */
  readonly skippedSymlinks: readonly string[];
}
```

## .keepfiles Format

```gitignore
# Comments start with #
# Blank lines are ignored

# Individual files
.env
.env.local
.env.development

# Directories (trailing slash optional)
# When a directory matches, the ENTIRE directory tree is copied
.vscode/
secrets/

# Glob patterns
.env.*
config/*.local.json

# Negation - exclude specific files from a matched directory
secrets/
!secrets/README.md

# All patterns are relative to project root
# Absolute paths (starting with /) are rejected
# Parent references (../) are rejected for security
```

**Semantics (inverted gitignore):**

- Listed patterns = files/directories TO COPY (not ignore)
- `!` prefix = EXCLUDE from copying (even if parent dir matched)
- Patterns matched against paths relative to project root
- Both files and directories supported
- For matched directories: copy entire directory tree recursively
- For matched files: copy individual file

**Pattern matching with `ignore` package:**

```typescript
import ignore from "ignore";

const ig = ignore().add(patterns);

// INVERTED SEMANTICS:
// ig.ignores(relativePath) returns true if path matches any pattern
// In normal gitignore: true = exclude the file
// In .keepfiles: true = INCLUDE the file (copy it)
const shouldCopy = ig.ignores(relativePath);
```

## Implementation Steps

### Phase 1: FileSystemLayer Extension (TDD)

- [x] **Step 1: Write failing unit tests for copyTree**
  - Add tests to `src/services/platform/filesystem.test.ts`
  - Test criteria (all should fail initially):
    - Copies single file preserving content
    - Copies directory recursively
    - Creates destination parent directories
    - Throws ENOENT if source doesn't exist
    - Returns `CopyTreeResult` with `skippedSymlinks` for symlinks
    - Overwrites existing destination files (document this behavior)
  - Files affected:
    - `src/services/platform/filesystem.test.ts`

- [x] **Step 2: Implement copyTree in FileSystemLayer**
  - Add `copyTree(src: string, dest: string): Promise<CopyTreeResult>` to interface
  - Implement in `DefaultFileSystemLayer`:
    - Use `fs.copyFile()` for individual files (handles binary correctly)
    - Use `fs.stat()` or `fs.lstat()` to detect symlinks before copying
    - If src is file: copy to dest, create parent dirs with `mkdir`
    - If src is directory: iterate entries, recursively copy (using queue, not recursion)
    - Symlinks: skip and add to `skippedSymlinks` array (security - prevents symlink attacks)
    - Overwrite behavior: overwrite existing files (document in JSDoc)
    - Preserve basic permissions (read/write/execute bits via `fs.copyFile` mode)
  - Files affected:
    - `src/services/platform/filesystem.ts`
  - Test criteria:
    - All Step 1 tests pass

- [x] **Step 3: Add copyTree boundary tests**
  - Create boundary tests against real filesystem
  - Files affected:
    - `src/services/platform/filesystem.boundary.test.ts`
  - Test criteria:
    - Copy text file with content verification
    - Copy binary file (small PNG) with byte-for-byte verification
    - Copy binary file with null bytes (e.g., create test file with Buffer)
    - Copy nested directory structure (3+ levels deep)
    - Copy preserves file permissions (basic chmod check)
    - Actual symlink is skipped and reported in result
    - ENOENT when source doesn't exist
    - Large directory performance baseline (<5s for 1000 small files)

- [x] **Step 4: Update FileSystemLayer test utils**
  - Add `copyTree` mock support to `createMockFileSystemLayer()`
  - Files affected:
    - `src/services/platform/filesystem.test-utils.ts`
  - Test criteria:
    - Mock can be configured with success result
    - Mock can be configured to throw FileSystemError
    - Mock tracks calls for verification (`toHaveBeenCalledWith`)
    - Custom implementation support for complex test scenarios

### Phase 2: KeepFilesService (TDD)

- [x] **Step 5: Add KeepFilesError to errors.ts**
  - Add domain-specific error type for consistent IPC serialization
  - Files affected:
    - `src/services/errors.ts`
  - Changes:
    - Add `KeepFilesError` class extending `ServiceError`
    - Add `"keepfiles"` to `SerializedError['type']` union
    - Add case to `ServiceError.fromJSON()` switch statement

- [x] **Step 6: Create IKeepFilesService interface and types**
  - Define interface and types as specified in Type Definitions section above
  - Files affected:
    - `src/services/keepfiles/types.ts` (new)
    - `src/services/keepfiles/index.ts` (new)
  - Test criteria:
    - Types compile correctly
    - Interface exported from index

- [x] **Step 7: Write failing unit tests for KeepFilesService**
  - TDD approach with mocked FileSystemLayer
  - Files affected:
    - `src/services/keepfiles/keepfiles-service.test.ts` (new)
  - Test criteria (all should fail initially):
    - No .keepfiles = returns `{ configExists: false, copiedCount: 0, ... }`
    - Empty .keepfiles = returns `{ configExists: true, copiedCount: 0, ... }`
    - .keepfiles with only comments = returns empty result
    - Single file pattern matches and copies
    - Directory pattern copies entire directory tree
    - Glob patterns work (`.env.*` matches `.env.local`)
    - Negation excludes files (`!secrets/README.md`)
    - Comments and blank lines ignored
    - Whitespace-only lines ignored
    - Errors during copy don't stop other copies (collect in errors array)
    - Absolute paths rejected (starting with `/`)
    - Parent references rejected (`../` patterns)
    - Path traversal in destination detected and rejected
    - Symlinks skipped and counted in skippedCount
    - .keepfiles with UTF-8 BOM handled correctly

- [x] **Step 8: Implement KeepFilesService**
  - Constructor takes FileSystemLayer
  - `copyToWorkspace(projectRoot, targetPath)` implementation:
    1. Read `.keepfiles` from projectRoot
       - If ENOENT: return `{ configExists: false, copiedCount: 0, skippedCount: 0, errors: [] }`
       - If other error: throw KeepFilesError
    2. Strip UTF-8 BOM if present
    3. Parse patterns, validate each:
       - Reject absolute paths (throw KeepFilesError)
       - Reject `../` parent references (throw KeepFilesError)
    4. Create `ignore` instance with patterns
    5. Iteratively scan projectRoot using queue (not recursive functions):
       ```typescript
       const queue: string[] = [projectRoot];
       while (queue.length > 0) {
         const current = queue.shift()!;
         const entries = await fs.readdir(current);
         for (const entry of entries) {
           // Process entry, add directories to queue
         }
       }
       ```
    6. For each file, check `ig.ignores(relativePath)`:
       - true = pattern matches = COPY this file
       - false = no match = skip
    7. Before copying, validate destination path:
       ```typescript
       const normalizedTarget = path.normalize(targetPath);
       const normalizedDest = path.normalize(destPath);
       if (!normalizedDest.startsWith(normalizedTarget + path.sep)) {
         errors.push({ path: relativePath, message: "Path traversal detected" });
         continue;
       }
       ```
    8. Copy using `copyTree`, aggregate results
    9. Return CopyResult with all counts and errors
  - Files affected:
    - `src/services/keepfiles/keepfiles-service.ts` (new)
  - Test criteria:
    - All Step 7 tests pass

- [x] **Step 9: Add KeepFilesService boundary tests**
  - Test real `.keepfiles` file parsing with `ignore` package
  - Files affected:
    - `src/services/keepfiles/keepfiles-service.boundary.test.ts` (new)
  - Test criteria:
    - Real `.keepfiles` file parsed correctly
    - Glob patterns work as expected with real ignore package
    - Negation syntax works correctly
    - Edge case: `secrets/` vs `secrets` (trailing slash handling)
    - Edge case: `**/*.env` recursive glob

### Phase 3: GitWorktreeProvider Integration (TDD)

- [x] **Step 10: Write failing tests for provider integration**
  - Add tests for keep-files integration
  - Files affected:
    - `src/services/git/git-worktree-provider.test.ts`
  - Test criteria (should fail initially):
    - When service provided via options: calls copyToWorkspace after worktree created
    - When service not provided (options undefined): no-op, backward compatible
    - When service not provided (options.keepFilesService undefined): no-op
    - Copy errors logged but don't throw (workspace creation succeeds)
    - Correct arguments passed: (projectRoot, worktreePath)
    - CopyResult logged at info level (success counts)
    - CopyResult.errors logged at warn level

- [x] **Step 11: Integrate into GitWorktreeProvider**
  - Add optional `IKeepFilesService` via options pattern
  - Call after successful worktree creation
  - Log copy result (info level for success, warn for errors)
  - Files affected:
    - `src/services/git/git-worktree-provider.ts`
  - Changes:

    ```typescript
    interface GitWorktreeProviderOptions {
      readonly keepFilesService?: IKeepFilesService;
    }

    // In factory method:
    static async create(
      projectRoot: string,
      gitClient: IGitClient,
      workspacesDir: string,
      fileSystemLayer: FileSystemLayer,
      options?: GitWorktreeProviderOptions
    ): Promise<GitWorktreeProvider>
    ```

  - Test criteria:
    - All Step 10 tests pass

- [x] **Step 12: Create integration test**
  - Full flow test: GitWorktreeProvider → KeepFilesService → FileSystemLayer
  - Files affected:
    - `src/services/git/git-worktree-provider.integration.test.ts` (create if doesn't exist)
  - Test criteria:
    - `.keepfiles` read from correct location (project root)
    - Files copied to correct location (worktree path)
    - Timing verified (after worktree creation succeeds)
    - Error handling doesn't fail workspace creation
    - Concurrent workspace creation doesn't interfere (create 2 workspaces in parallel)

### Phase 4: Wiring and Dependencies

- [x] **Step 13: Install ignore package**
  - Add `ignore` package as production dependency
  - Command: `npm add ignore`
  - Files affected:
    - `package.json`
    - `package-lock.json`
  - Test criteria:
    - Package installed
    - Types available (included in package)

- [x] **Step 14: Update factory function**
  - Update `createGitWorktreeProvider()` to accept and pass through options
  - Files affected:
    - `src/services/index.ts`
  - Test criteria:
    - Factory accepts optional `GitWorktreeProviderOptions`
    - Options passed to `GitWorktreeProvider.create()`

- [x] **Step 15: Wire up in main process**
  - Create KeepFilesService instance
  - Pass to GitWorktreeProvider via options
  - Files affected:
    - `src/main/app-state.ts`
  - Test criteria:
    - KeepFilesService created with DefaultFileSystemLayer
    - Provider receives service instance via options

### Phase 5: Documentation

- [x] **Step 16: Update documentation**
  - Files affected:
    - `docs/ARCHITECTURE.md`
    - `AGENTS.md`
  - Changes for ARCHITECTURE.md:
    - Add KeepFilesService row to services table
    - Update FileSystemLayer section to document `copyTree` method
  - Changes for AGENTS.md:
    - Add `.keepfiles` to Key Concepts table with format explanation
    - Document that `.keepfiles` uses inverted gitignore semantics
    - Add example `.keepfiles` content

## Testing Strategy

### Unit Tests (vitest)

| Test Case              | Description                                               | File                          |
| ---------------------- | --------------------------------------------------------- | ----------------------------- |
| copyTree file          | Copies single file with content verification              | filesystem.test.ts            |
| copyTree directory     | Copies nested directory structure                         | filesystem.test.ts            |
| copyTree symlink       | Skips symlinks, returns in skippedSymlinks                | filesystem.test.ts            |
| copyTree errors        | Handles ENOENT, EACCES correctly                          | filesystem.test.ts            |
| copyTree overwrite     | Overwrites existing destination files                     | filesystem.test.ts            |
| no keepfiles           | Returns `{ configExists: false, ... }` when no .keepfiles | keepfiles-service.test.ts     |
| empty keepfiles        | Returns empty result with `configExists: true`            | keepfiles-service.test.ts     |
| only comments          | .keepfiles with only comments returns empty               | keepfiles-service.test.ts     |
| single pattern         | Matches and copies single file                            | keepfiles-service.test.ts     |
| directory pattern      | Copies entire directory tree                              | keepfiles-service.test.ts     |
| glob pattern           | Matches `.env.*` pattern                                  | keepfiles-service.test.ts     |
| negation               | `!file` excludes from parent dir match                    | keepfiles-service.test.ts     |
| absolute path          | Rejects patterns starting with `/`                        | keepfiles-service.test.ts     |
| parent ref             | Rejects patterns with `../`                               | keepfiles-service.test.ts     |
| path traversal         | Detects and rejects traversal in destination              | keepfiles-service.test.ts     |
| UTF-8 BOM              | Handles .keepfiles with BOM                               | keepfiles-service.test.ts     |
| whitespace lines       | Ignores whitespace-only lines                             | keepfiles-service.test.ts     |
| provider integration   | Calls service after worktree creation                     | git-worktree-provider.test.ts |
| provider no service    | Works without service (backward compat)                   | git-worktree-provider.test.ts |
| provider errors logged | Copy errors logged but don't throw                        | git-worktree-provider.test.ts |

### Boundary Tests

| Test Case             | Description                            | File                               |
| --------------------- | -------------------------------------- | ---------------------------------- |
| copyTree real file    | Copy actual text file on disk          | filesystem.boundary.test.ts        |
| copyTree binary       | Copy binary file (PNG) byte-for-byte   | filesystem.boundary.test.ts        |
| copyTree null bytes   | Copy binary with null bytes            | filesystem.boundary.test.ts        |
| copyTree real dir     | Copy actual directory tree (3+ levels) | filesystem.boundary.test.ts        |
| copyTree permissions  | Verify chmod bits preserved            | filesystem.boundary.test.ts        |
| copyTree symlink      | Real symlink skipped and reported      | filesystem.boundary.test.ts        |
| copyTree performance  | 1000 files in <5s                      | filesystem.boundary.test.ts        |
| ignore glob patterns  | Real ignore package glob matching      | keepfiles-service.boundary.test.ts |
| ignore negation       | Real ignore package negation           | keepfiles-service.boundary.test.ts |
| ignore trailing slash | `secrets/` vs `secrets` handling       | keepfiles-service.boundary.test.ts |
| ignore recursive glob | `**/*.env` pattern                     | keepfiles-service.boundary.test.ts |

### Integration Tests

| Test Case           | Description                                                | File                                      |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| full flow           | Create workspace with .keepfiles, verify files copied      | git-worktree-provider.integration.test.ts |
| concurrent creation | Two workspaces created in parallel, both get correct files | git-worktree-provider.integration.test.ts |
| error isolation     | Copy error doesn't fail workspace creation                 | git-worktree-provider.integration.test.ts |

### Manual Testing Checklist

- [ ] Create project with .keepfiles containing `.env` pattern
- [ ] Create .env file in project root with test content
- [ ] Create new workspace via UI
- [ ] Verify .env exists in new workspace with correct content
- [ ] Test directory copy (.vscode/ pattern)
- [ ] Test negation (copy dir but exclude specific file)
- [ ] Test without .keepfiles (no errors, normal workspace creation)
- [ ] Test with symlink in project (should be skipped, no error)

## Dependencies

| Package | Purpose                                     | Approved |
| ------- | ------------------------------------------- | -------- |
| ignore  | Gitignore-style pattern matching (inverted) | [x]      |

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `npm add <package>` to use the latest versions.**

## Documentation Updates

### Files to Update

| File                 | Changes Required                                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs/ARCHITECTURE.md | Add KeepFilesService row to services table (around line 169-177). Update FileSystemLayer section to document `copyTree(src, dest): Promise<CopyTreeResult>` method signature, behavior (uses fs.copyFile for binary safety), symlink handling, and overwrite behavior. |
| AGENTS.md            | Add `.keepfiles` entry to Key Concepts table explaining: config file location (project root), gitignore-like syntax with inverted semantics, example patterns. Add note about `ignore` package being acceptable direct usage (pure library).                           |

### New Documentation Required

| File   | Purpose                         |
| ------ | ------------------------------- |
| (none) | Feature documented in AGENTS.md |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
