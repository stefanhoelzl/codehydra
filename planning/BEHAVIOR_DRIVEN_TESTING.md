---
status: COMPLETED
last_updated: 2026-01-04
reviewers: [review-testing, review-docs, review-arch, review-typescript]
migration_status: IN_PROGRESS
---

# BEHAVIOR_DRIVEN_TESTING

## Overview

- **Problem**: Current unit tests don't catch real bugs. They heavily mock dependencies and verify implementation calls methods, not that behavior is correct. When code changes, AI agents update mocks to match - tests pass but bugs slip through.
- **Solution**: Replace unit tests with behavior-driven integration tests. Test through high-level entry points (CodeHydraApi, LifecycleApi, UI components). Mock only boundary interfaces with behavioral simulators that have in-memory state.
- **Scope**: This plan establishes the testing strategy through documentation updates only (Steps 1-6). Actual behavioral mock creation (Phase 1) and test migration (Phases 2-6) happen in separate per-module plans requiring user approval.
- **Risks**:
  - Integration tests may be slower (mitigated by fast in-memory behavioral mocks, target <2s per module)
  - Harder to pinpoint failures (mitigated by descriptive test names and small focused tests)
  - Migration effort (mitigated by phased approach with one plan per module, user approval required)
  - Loss of fast feedback for pure functions (mitigated by allowing focused tests for pure utilities)
- **Alternatives Considered**:
  - Keep unit tests + add integration tests → rejected (duplication, unit tests still don't catch bugs)
  - Only boundary tests → rejected (too slow, requires real external systems)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TEST TYPES                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                      BOUNDARY TESTS                                    │ │
│  │                    *.boundary.test.ts                                  │ │
│  │                                                                        │ │
│  │  Purpose: Verify boundary interfaces work with real external systems   │ │
│  │  Mocks: NONE - tests hit real Git, real filesystem, real HTTP          │ │
│  │  When: Only when creating/modifying boundary interface code            │ │
│  │                                                                        │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │ │
│  │  │ IMPORTANT: Boundary tests define the CONTRACT that behavioral   │  │ │
│  │  │ mocks must follow. When adding behavior to a mock, verify the   │  │ │
│  │  │ equivalent behavior is tested in the boundary test suite.       │  │ │
│  │  └─────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                        │ │
│  │  Boundaries: IGitClient, FileSystemLayer, ProcessRunner, HttpClient,   │ │
│  │              PortManager, ArchiveExtractor, SdkClientFactory           │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                    ▲                                        │
│                                    │ Boundary interfaces are mocked         │
│                                    │ with behavioral simulators             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                    INTEGRATION TESTS                                   │ │
│  │                  *.integration.test.ts                                 │ │
│  │                                                                        │ │
│  │  Purpose: Verify application behavior through entry points             │ │
│  │  Mocks: Only boundary interfaces, using behavioral simulators          │ │
│  │  When: All feature code, business logic, UI components                 │ │
│  │                                                                        │ │
│  │  ⚠️ MUST BE FAST: Integration tests run during development.            │ │
│  │  Target: <50ms per test, <2s per module. Slow tests get skipped!       │ │
│  │                                                                        │ │
│  │  Entry Points:                                                         │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐      │ │
│  │  │ CodeHydra   │ │ Lifecycle   │ │  Service    │ │     UI      │      │ │
│  │  │    Api      │ │    Api      │ │  (direct)   │ │ Components  │      │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘      │ │
│  │                                                                        │ │
│  │  Behavioral Mocks: In-memory state, realistic behavior simulation      │ │
│  │  - createGitClientMock()                                         │ │
│  │  - createFileSystemMock()                                        │ │
│  │  - createProcessRunnerMock()                                     │ │
│  │  - etc. (created during module migration)                              │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                  FOCUSED TESTS (for pure functions)                    │ │
│  │                         *.test.ts                                      │ │
│  │                                                                        │ │
│  │  Purpose: Fast feedback for pure utility functions                     │ │
│  │  When: Functions with NO external dependencies (ID generation,         │ │
│  │        path normalization, validation, parsing)                        │ │
│  │  Why allowed: Pure functions don't suffer from "tests mirror           │ │
│  │               implementation" - they're just input/output              │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                  UNIT TESTS (DEPRECATED - being migrated)              │ │
│  │                         *.test.ts                                      │ │
│  │                                                                        │ │
│  │  Status: Existing unit tests remain until migrated per-module          │ │
│  │  Command: npm run test:legacy (deprecated, will be removed)            │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Boundary Tests - Detailed Explanation

### What Are Boundary Tests?

Boundary tests verify that our **abstraction interfaces work correctly with real external systems**. They test the thin wrapper layer that isolates our application from external dependencies.

### Why Do We Need Them?

The boundary interfaces (like `IGitClient`, `FileSystemLayer`, etc.) are **contracts**. When we mock these interfaces in integration tests, we need confidence that:

1. Our interface correctly wraps the external system
2. The mock behavior matches real behavior
3. Edge cases and errors are handled correctly

### Relationship to Behavioral Mocks

**Critical**: Boundary tests define the behavior that behavioral mocks must replicate.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BOUNDARY TEST ↔ BEHAVIORAL MOCK                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Boundary Test (real Git):              Behavioral Mock (in-memory):    │
│  ─────────────────────────              ────────────────────────────    │
│  it("throws GitError for               // Must throw same error         │
│     non-existent branch")              if (!repo.branches.includes(b))  │
│                                          throw new GitError(...)        │
│                                                                         │
│  it("creates worktree with             // Must set same properties      │
│     correct branch name")              worktree.branch = name           │
│                                                                         │
│  When adding mock behavior, CHECK that boundary tests verify it!        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Boundary Test Verification Process

When modifying a behavioral mock:

1. **Check boundary tests first** - Ensure the behavior you're adding is tested in the boundary test suite
2. **Run boundary tests** - Verify the real interface behaves as you expect
3. **Match mock to tests** - Implement mock behavior to match boundary test assertions
4. **Document the relationship** - Add comments in mock code referencing relevant boundary tests

### What Do They Test?

| Boundary Interface             | External System        | What's Tested                                               | Boundary Test File                   |
| ------------------------------ | ---------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `IGitClient` (SimpleGitClient) | Git CLI via simple-git | Creating worktrees, listing branches, detecting dirty state | `simple-git-client.boundary.test.ts` |
| `FileSystemLayer`              | Node.js fs module      | Reading, writing, directory operations, error handling      | `filesystem.boundary.test.ts`        |
| `ProcessRunner`                | execa process spawning | Spawning processes, capturing output, killing processes     | `process.boundary.test.ts`           |
| `HttpClient`                   | fetch API              | HTTP requests, status codes, error responses                | `network.boundary.test.ts`           |
| `PortManager`                  | Node.js net module     | Port availability checking                                  | `network.boundary.test.ts`           |
| `ArchiveExtractor`             | tar/unzipper libraries | Extracting zip and tar.gz archives                          | `archive-extractor.boundary.test.ts` |
| `SdkClientFactory`             | @opencode-ai/sdk       | SSE connections, event parsing                              | `opencode-client.boundary.test.ts`   |

### How Are They Written?

```typescript
// simple-git-client.boundary.test.ts
// NO MOCKS - tests against real Git CLI

describe("SimpleGitClient", () => {
  let client: SimpleGitClient;
  let testRepo: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    client = new SimpleGitClient(createSilentLogger());
    testRepo = await createTestGitRepo(); // Creates REAL git repo on disk
  });

  afterEach(async () => {
    await testRepo.cleanup(); // Removes real files
  });

  it("creates worktree from branch", async () => {
    // Act against REAL git
    const worktree = await client.createWorktree(testRepo.path, "feature-1", "main");

    // Assert real filesystem state
    expect(worktree.path).toContain("feature-1");
    expect(await fs.exists(worktree.path)).toBe(true);

    // Assert real git state
    const worktrees = await client.listWorktrees(testRepo.path);
    expect(worktrees).toContainEqual(expect.objectContaining({ name: "feature-1" }));
  });

  it("throws GitError for non-existent branch", async () => {
    await expect(client.createWorktree(testRepo.path, "feature-1", "nonexistent")).rejects.toThrow(
      GitError
    );
  });
});
```

### Key Characteristics

1. **No mocks** - Tests interact with real external systems
2. **Self-contained setup/teardown** - Each test creates and cleans up its own resources
3. **Test the interface contract** - Verify inputs produce expected outputs/side effects
4. **Cover error cases** - Invalid inputs, missing resources, network failures
5. **May be slow** - Real I/O takes time, so these run separately from integration tests
6. **Cross-platform** - Use `path.join()`, handle Windows/Unix differences

### When to Write Boundary Tests

- Creating a new boundary interface
- Adding new methods to existing boundary interface
- Fixing bugs in boundary interface code
- **NOT** for business logic above the boundary layer

---

## Integration Tests - Detailed Explanation

### What Are Integration Tests?

Integration tests verify **application behavior** by testing through high-level entry points. They exercise multiple modules working together, with only boundary interfaces mocked.

### Why This Approach?

Traditional unit tests mock everything except the single module under test. This creates problems:

1. **Tests mirror implementation** - Change the code, change the mocks
2. **No behavior verification** - Tests check "did you call X?" not "does feature Y work?"
3. **False confidence** - All tests pass, but bugs exist in how modules interact

Integration tests solve this by:

1. **Testing behavior** - "When user does X, outcome is Y"
2. **Real module interaction** - AppState, ProjectStore, GitWorktreeProvider all run together
3. **Only mock boundaries** - The external system interfaces, not internal modules

### What Gets Mocked?

**ONLY boundary interfaces** - the same ones tested by boundary tests:

| Mock                        | Replaces          | Why Mocked                        |
| --------------------------- | ----------------- | --------------------------------- |
| `createGitClientMock()`     | `IGitClient`      | Can't run real Git in fast tests  |
| `createFileSystemMock()`    | `FileSystemLayer` | Need controlled file state        |
| `createProcessRunnerMock()` | `ProcessRunner`   | Can't spawn real processes        |
| `createHttpClientMock()`    | `HttpClient`      | Can't hit real servers            |
| `createPortManagerMock()`   | `PortManager`     | Need controlled port availability |

**NOT mocked** - everything else:

- `AppState`
- `ProjectStore`
- `GitWorktreeProvider`
- `CodeHydraApi`
- Business logic
- State management
- Event handling

### Entry Point Selection Guide

How to choose the right entry point for testing:

| Condition                                     | Entry Point                        | Example                                 |
| --------------------------------------------- | ---------------------------------- | --------------------------------------- |
| Module is public API                          | `CodeHydraApi` or `LifecycleApi`   | AppState, ProjectStore                  |
| Module is internal service with complex state | Direct service                     | CodeServerManager, PluginServer         |
| Module is Electron wrapper                    | Direct with mocked Electron APIs   | ViewManager, WindowManager              |
| Module is UI component                        | Component with mocked `window.api` | Sidebar, CreateWorkspaceDialog          |
| Module is pure utility function               | Focused test (no entry point)      | generateProjectId, normalizeMetadataKey |

### The Behavioral Mock Pattern

**Critical**: Mocks must simulate behavior with in-memory state, not just track calls.

#### Bad: Call-Tracking Mock

```typescript
// This tests nothing useful
const mockGit = {
  createWorktree: vi.fn().mockResolvedValue({ path: "/fake", name: "feat-1" }),
  listWorktrees: vi.fn().mockResolvedValue([]),
};

await appState.createWorkspace("/project", "feat-1", "main");

// This just checks implementation called the function
// If implementation changes to call something else, test breaks
// But actual bugs in behavior would not be caught
expect(mockGit.createWorktree).toHaveBeenCalledWith("/project", "feat-1", "main");
```

#### Good: Behavioral Mock

```typescript
// This tests actual behavior
const mockGit = createGitClientMock({
  repositories: new Map([["/project", { branches: ["main", "develop"], worktrees: [] }]]),
});

// Mock has in-memory state - createWorktree actually adds to worktrees list
await api.workspaces.create("/project", "feat-1", "main");

// Verify BEHAVIOR - the worktree exists now
const project = await api.projects.get("/project");
expect(project.workspaces).toContainEqual(expect.objectContaining({ name: "feat-1" }));

// Verify BEHAVIOR - can't create duplicate
await expect(api.workspaces.create("/project", "feat-1", "main")).rejects.toThrow();
```

### Side-by-Side Migration Example

**Before (Unit Test with Call-Tracking)**:

```typescript
// app-state.test.ts - OLD PATTERN (deprecated)
describe("AppState.createWorkspace", () => {
  it("calls gitProvider.createWorktree", async () => {
    const mockGitProvider = {
      createWorktree: vi.fn().mockResolvedValue({ path: "/fake", name: "feat-1" }),
    };
    const appState = new AppState(mockStore, mockView, mockGitProvider);

    await appState.createWorkspace("/project", "feat-1", "main");

    // Tests implementation detail, not behavior
    expect(mockGitProvider.createWorktree).toHaveBeenCalledWith("/project", "feat-1", "main");
  });
});
```

**After (Integration Test with Behavioral Mock)**:

```typescript
// codehydra-api.integration.test.ts - NEW PATTERN
describe("CodeHydraApi - workspace creation", () => {
  it("creates workspace and adds it to project", async () => {
    const gitClient = createGitClientMock({
      repositories: new Map([["/project", { branches: ["main"], worktrees: [] }]]),
    });
    const api = createCodeHydraApi({ gitClient, ...otherMocks });

    await api.projects.open("/project");
    const workspace = await api.workspaces.create("/project", "feat-1", "main");

    // Tests behavior: workspace exists and has correct properties
    expect(workspace.name).toBe("feat-1");
    const project = await api.projects.get("/project");
    expect(project.workspaces).toContainEqual(expect.objectContaining({ name: "feat-1" }));
  });
});
```

**Why the new version is better**:

- Tests actual behavior (workspace exists after creation)
- Doesn't break if implementation changes internally
- Catches real bugs (e.g., workspace added to wrong project)

### Cross-Platform Testing Requirements

Integration tests must handle platform differences correctly:

1. **Use `new Path()` for internal paths** - Matches service layer path handling
2. **Use `path.join()` for OS-specific paths** - When constructing paths for comparison
3. **Platform-specific tests** - Use `it.skipIf(isWindows)` or equivalent
4. **Temp directories** - Use proper temp directory utilities, not hardcoded "/tmp"

```typescript
// CORRECT: Cross-platform path handling
import { Path } from "../services/platform/path";

const projectPath = new Path("/projects/my-app");
expect(result.path).toBe(projectPath.toString());

// CORRECT: Platform-specific skip
it.skipIf(process.platform === "win32")("handles Unix symlinks", async () => { ... });

// WRONG: Hardcoded paths
const tempDir = "/tmp/test"; // Fails on Windows
```

### Cross-Platform Behavioral Mock Requirements

Behavioral mocks must handle platform differences:

- Use `path.join()` for path construction
- Use `path.normalize()` for path comparison
- Support both `/` and `\` separators in assertions
- Throw errors with correct `code` property (ENOENT, EEXIST, etc.)

### Behavioral Mock Base Interface

All mock states must implement the `MockState` interface:

```typescript
// src/test/mock-state.ts
import path from "path";

/**
 * Base interface for all behavioral mock state classes.
 * Provides reset capability and debugging support.
 */
export interface MockState {
  /** Restore mock to initial state (called in afterEach) */
  reset(): void;
  /** Format state for error messages and debugging (called by custom matchers) */
  toString(): string;
}

/** Normalize path for cross-platform map keys */
export const normalizePath = (p: string): string => path.normalize(p);

/** Valid filesystem error codes for type-safe error simulation */
export type FileSystemErrorCode =
  | "ENOENT"
  | "EACCES"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EIO";
```

Each mock extends this with specific setup methods only when the public API isn't sufficient.

### Public API vs $ Accessor Guidance

**Prefer public API for normal setup. Use $ only for scenarios impossible through the public API:**

```typescript
// GOOD: Use public API for normal setup
await mock.writeFile("/config.json", "{}"); // Creates file naturally
await mock.mkdir("/data"); // Creates directory naturally

// GOOD: Use $ for scenarios that can't happen through public API
mock.$.injectFile("/readonly/system.conf", "..."); // No public way to create read-only files
mock.$.simulateError("/broken", "EIO"); // Can't trigger I/O errors naturally
mock.$.emitOutput(pid, "stdout data"); // Trigger callback synchronously

// BAD: Using $ for normal operations (defeats behavioral testing)
mock.$.files.set("/config.json", "{}"); // Should use public writeFile()
```

### Async Operations in Behavioral Mocks

**State updates should be synchronous. Only use async when the interface requires it:**

```typescript
// GOOD: Synchronous state update, immediate Promise resolution
async writeFile(path: string, content: string): Promise<void> {
  this.$.files.set(normalizePath(path), content);  // Synchronous
  return Promise.resolve();                         // Immediate resolution
}

// GOOD: Synchronous error check
async readFile(path: string): Promise<string> {
  const error = this.$.errorMap.get(normalizePath(path));
  if (error) return Promise.reject(createError(path, error));  // Immediate
  const content = this.$.files.get(normalizePath(path));
  if (!content) return Promise.reject(createError(path, "ENOENT"));
  return Promise.resolve(content.toString());
}

// BAD: Unnecessary delays
async writeFile(path: string, content: string): Promise<void> {
  await sleep(10);  // Never do this - slows tests
  this.$.files.set(path, content);
}
```

### Behavioral Mock Return Pattern

Behavioral mocks return the mock directly. State is accessible via the `$` property:

```typescript
// Types for mock factory
interface FileSystemMockOptions {
  files?: Map<string, string | Buffer>;
  dirs?: Set<string>;
}

// Factory returns the mock with $ accessor
export type FileSystemMock = FileSystemLayer & { readonly $: FileSystemState };

export function createFileSystemMock(options?: FileSystemMockOptions): FileSystemMock {
  const state = new FileSystemState(options);

  return {
    $: state,
    async readFile(filePath, encoding) {
      /* uses state */
    },
    async writeFile(filePath, content) {
      /* mutates state */
    },
    // ... other FileSystemLayer methods
  };
}
```

| Property | Type               | Purpose                                                |
| -------- | ------------------ | ------------------------------------------------------ |
| `mock`   | The interface type | Drop-in replacement, exact interface match             |
| `mock.$` | State class        | Test utilities: `reset()`, `toString()`, setup methods |

### Behavioral Mock State Class

```typescript
class FileSystemState implements MockState {
  files = new Map<string, string | Buffer>();
  dirs = new Set<string>();
  private readonly initialFiles: Map<string, string | Buffer>;
  private readonly initialDirs: Set<string>;
  private errorMap = new Map<string, FileSystemErrorCode>();

  constructor(options?: FileSystemMockOptions) {
    this.initialFiles = new Map(options?.files);
    this.initialDirs = new Set(options?.dirs);
    this.files = new Map(this.initialFiles);
    this.dirs = new Set(this.initialDirs);
  }

  reset(): void {
    this.files = new Map(this.initialFiles);
    this.dirs = new Set(this.initialDirs);
    this.errorMap.clear();
  }

  toString(): string {
    const fileList = [...this.files.keys()];
    const dirList = [...this.dirs];
    return [
      "=== FileSystem Mock ===",
      `Files (${fileList.length}): ${fileList.slice(0, 10).join(", ") || "(none)"}${fileList.length > 10 ? "..." : ""}`,
      `Dirs (${dirList.length}): ${dirList.slice(0, 10).join(", ") || "(none)"}${dirList.length > 10 ? "..." : ""}`,
      this.errorMap.size > 0
        ? `Errors: ${[...this.errorMap.entries()].map(([p, c]) => `${p}:${c}`).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Setup methods - only when public API isn't sufficient
  injectFile(path: string, content: string): void {
    this.files.set(normalizePath(path), content);
  }

  simulateError(path: string, code: FileSystemErrorCode): void {
    this.errorMap.set(normalizePath(path), code);
  }

  clearError(path: string): void {
    this.errorMap.delete(normalizePath(path));
  }
}
```

**toString() Format Specification:**

- Line 1: Mock type as header
- Lines 2+: Key state summaries with counts
- Truncate large collections (show first 10, add "...")
- Include error state if any
- Keep output under 50 lines for typical state

### Event and Callback Mocking

For interfaces with event emitters or callbacks:

```typescript
class ProcessRunnerState implements MockState {
  private outputCallbacks = new Map<number, (data: string) => void>();
  private exitCallbacks = new Map<number, (code: number) => void>();

  // Store callbacks when registered
  onOutput(pid: number, callback: (data: string) => void): void {
    this.outputCallbacks.set(pid, callback);
  }

  onExit(pid: number, callback: (code: number) => void): void {
    this.exitCallbacks.set(pid, callback);
  }

  // Setup methods to trigger callbacks synchronously
  emitOutput(pid: number, data: string): void {
    this.outputCallbacks.get(pid)?.(data);
  }

  emitExit(pid: number, code: number): void {
    this.exitCallbacks.get(pid)?.(code);
  }

  reset(): void {
    this.outputCallbacks.clear();
    this.exitCallbacks.clear();
  }
}
```

### State Access and Setup

```typescript
const mock = createFileSystemMock();

// Setup via public methods (preferred)
await mock.writeFile("/config.json", "{}");
await mock.mkdir("/data", { recursive: true });

// Setup via $ when public API isn't sufficient
mock.$.injectFile("/readonly/system.conf", "root config");
mock.$.simulateError("/broken", "EIO");

// Debug - uses toString()
console.log(mock.$); // Prints formatted state

// Reset between tests
mock.$.reset();
```

### Cross-Mock State Coordination

**Behavioral mocks are independent by default.** Each mock maintains its own state. If tests need multiple mocks to agree on state (e.g., FileSystem and Git both know about `/project`), handle coordination in the test fixture helper:

```typescript
// createTestFixture handles coordination between mocks
export function createTestFixture(options?: TestFixtureOptions): TestFixture {
  const projects = options?.projects ?? [];

  // Create git repositories
  const gitClient = createGitClientMock({
    repositories: new Map(projects.map((p) => [p.path, { branches: p.branches, worktrees: [] }])),
  });

  // Create corresponding filesystem structure
  const fileSystem = createFileSystemMock({
    dirs: new Set(projects.map((p) => p.path)),
    files: new Map(projects.flatMap((p) => [[`${p.path}/.git/config`, "[core]..."]])),
  });

  // ... rest of fixture
}
```

### Type-Safe Custom Matchers

Assertions use vitest custom matchers with conditional types for full type safety:

```typescript
// src/test/matchers.d.ts
type FileSystemMatchers<T> = T extends FileSystemMock
  ? {
      toHaveFile(path: string): void;
      toHaveFileContaining(path: string, content: string): void;
      toHaveDirectory(path: string): void;
    }
  : {};

type GitClientMatchers<T> = T extends GitClientMock
  ? {
      toHaveWorktree(name: string): void;
      toHaveBranch(name: string): void;
      toBeDirty(): void;
    }
  : {};

declare module "vitest" {
  interface Matchers<T> extends FileSystemMatchers<T>, GitClientMatchers<T> {}
}
```

**Type safety in action:**

```typescript
const fsMock = createFileSystemMock();
const gitMock = createGitClientMock();

expect(fsMock).toHaveFile("/config.json"); // ✅ Works
expect(fsMock).toHaveWorktree("feature"); // ❌ TypeScript error
expect(gitMock).toHaveWorktree("feature"); // ✅ Works
expect(gitMock).toHaveFile("/config.json"); // ❌ TypeScript error
expect("string").toHaveFile("/config.json"); // ❌ TypeScript error
```

### Matcher Complexity Limits

**Matchers should verify single aspects of state.** Chain multiple simple matchers instead of creating complex ones:

```typescript
// GOOD: Simple, focused matchers
expect(fsMock).toHaveFile("/config.json");
expect(fsMock).toHaveFileContaining("/config.json", '"version"');
expect(fsMock).toHaveDirectory("/data");

// BAD: Complex matcher that does too much
expect(fsMock).toHaveCompleteProjectStructure(); // Don't do this
```

### Matcher Implementations

Each mock file exports its matcher implementations:

```typescript
// filesystem.test-utils.ts
import type { MatcherState } from "vitest";

export const fileSystemMatchers = {
  toHaveFile(this: MatcherState & { actual: unknown }, expectedPath: string) {
    // Runtime validation for clear errors
    if (!isFileSystemMock(this.actual)) {
      throw new TypeError("toHaveFile matcher can only be used with FileSystemMock");
    }
    const state = this.actual.$;
    const normalized = normalizePath(expectedPath);
    const exists = state.files.has(normalized);
    return {
      pass: exists,
      message: () =>
        exists
          ? `Expected no file at "${expectedPath}"`
          : `Expected file at "${expectedPath}"\n\nExisting files:\n${state}`,
    };
  },
  // ... other matchers
} satisfies Record<string, (...args: unknown[]) => { pass: boolean; message: () => string }>;

function isFileSystemMock(value: unknown): value is FileSystemMock {
  return (
    typeof value === "object" &&
    value !== null &&
    "$" in value &&
    value.$ instanceof FileSystemState
  );
}
```

### Specialized Mocks (Optional)

When a single mock becomes too complex, consider splitting into specialized variants.

**Split into specialized mocks when:**

1. **>8 setup methods** - Mock is trying to do too much
2. **Two distinct modes that can't coexist** - e.g., read-only vs read-write filesystem
3. **Setup methods conflict** - Setting X invalidates Y

```typescript
// Default mock - covers common cases
createFileSystemMock();

// Specialized mocks - only when complexity warrants
createFileSystemMockWithErrors(); // Complex error simulation (all ops fail)
createFileSystemMockReadonly(); // All writes throw EROFS
```

**Guidance**: Start with a single mock. Split only when the default becomes hard to understand or maintain.

### Test Naming Conventions

Integration test names should describe **behavior**, not implementation:

```typescript
// GOOD: Describes what happens (behavior)
it("creates workspace and adds it to project", ...)
it("emits workspace:created event after successful creation", ...)
it("rejects creation when branch does not exist", ...)
it("prevents duplicate workspace names in same project", ...)

// BAD: Describes implementation details
it("calls gitProvider.createWorktree", ...)
it("adds workspace to workspaces array", ...)
it("throws when createWorktree fails", ...)
```

### Test Performance Targets

**⚠️ CRITICAL: Integration tests MUST be extremely fast.**

Integration tests replace unit tests as the primary feedback mechanism during development. If they're slow, developers will skip running them, and bugs will slip through. **The entire point of behavioral mocks is to enable fast tests.**

| Scope                          | Target                   | Action if Exceeded                |
| ------------------------------ | ------------------------ | --------------------------------- |
| Single integration test        | <50ms                    | Optimize mock setup, reduce scope |
| Module test file (10-20 tests) | <2 seconds               | Split file, simplify mocks        |
| Full integration suite         | <15 seconds              | Profile bottlenecks, optimize     |
| Boundary tests                 | Excluded from `validate` | Run separately (real I/O is slow) |

**Why speed is non-negotiable**:

- Developers run `npm run validate` continuously during development
- Slow tests → skipped tests → undetected bugs → defeats the whole strategy
- Integration tests with in-memory behavioral mocks should be **nearly as fast as unit tests**
- If a test is slow, the behavioral mock is doing too much work

### Performance Guidelines

**Concrete rules for fast tests:**

1. **No artificial delays** - Never use `await sleep()`, `setTimeout`, or `waitFor` in integration tests
2. **Minimal initial state** - Only create what each specific test needs, not a full application state
3. **Efficient mock setup** - Create mock instances once in `beforeEach`, reset state between tests
4. **No unnecessary async** - Behavioral mocks should be synchronous where possible
5. **Shallow copies** - Use shallow copies in mock state, not deep clones
6. **Profile slow tests** - Any test >50ms should be profiled and optimized

**Minimal state example:**

```typescript
// GOOD: Only what this test needs
const mock = createFileSystemMock({
  files: new Map([["/config.json", "{}"]]), // Just one file
});

// BAD: Creating everything for every test
const mock = createFileSystemMock({
  files: new Map([
    ["/config.json", "{}"],
    ["/data/file1", "..."],
    ["/data/file2", "..."],
    // ... 100 more files - slows down all tests
  ]),
});
```

**Performance profiling:**

1. Use `vitest --reporter=verbose` to see individual test times
2. Add `console.time('setup')` / `console.timeEnd('setup')` around beforeEach
3. If a test is >50ms, profile the mock setup

**If tests are slow, it's a bug** - fix the mock or the test, don't accept slowness.

### Test Entry Points Reference

Integration tests go through specific entry points, not arbitrary internal modules:

#### Main Process Entry Points

| Entry Point          | What It Is               | Modules Exercised                                                                                        |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `CodeHydraApi`       | Main application facade  | AppState, ProjectStore, GitWorktreeProvider, AgentStatusManager, OpenCodeServerManager, KeepFilesService |
| `LifecycleApi`       | Setup/bootstrap facade   | VscodeSetupService, BinaryDownloadService, WrapperScriptGenerationService                                |
| `CodeServerManager`  | Direct (not via API)     | Just CodeServerManager                                                                                   |
| `PluginServer`       | Direct (not via API)     | Just PluginServer                                                                                        |
| `McpServerManager`   | Direct (not via API)     | McpServerManager, McpServer                                                                              |
| `ViewManager`        | Direct (mocked Electron) | Just ViewManager                                                                                         |
| `WindowManager`      | Direct (mocked Electron) | Just WindowManager                                                                                       |
| `BadgeManager`       | Direct (mocked Electron) | Just BadgeManager                                                                                        |
| `ShortcutController` | Direct (mocked Electron) | Just ShortcutController                                                                                  |

#### Electron Manager Mock Strategy

Electron managers (ViewManager, WindowManager, BadgeManager, ShortcutController) require mocked Electron APIs. These are tested directly (not through CodeHydraApi) because they're Electron-specific infrastructure.

**Required Electron behavioral mocks:**

| Electron API      | Mock State                                    | Example Usage            |
| ----------------- | --------------------------------------------- | ------------------------ |
| `BaseWindow`      | In-memory bounds, visibility, focus state     | WindowManager tests      |
| `WebContentsView` | In-memory URL, attached state, partition      | ViewManager tests        |
| `app`             | In-memory badge count, dock visibility        | BadgeManager tests       |
| `globalShortcut`  | In-memory registered shortcuts, enabled state | ShortcutController tests |

#### Why Entry Points Matter

Testing through `CodeHydraApi` means:

- Multiple modules work together (AppState → GitWorktreeProvider → GitClient)
- State flows correctly between modules
- Events are emitted properly
- Error handling works across layers

Testing individual modules in isolation (old unit test approach) misses these interactions.

---

## Mock Factory Organization

### Two-Level Pattern

Behavioral mocks are organized at two levels:

#### 1. Co-located Individual Mocks

Each boundary interface has its mock factory co-located with the interface:

```
src/services/platform/
├── filesystem.ts              # Interface
├── filesystem.test-utils.ts   # createFileSystemMock() + fileSystemMatchers
├── network.ts                 # Interface
├── network.test-utils.ts      # createHttpClientMock(), createPortManagerMock() + matchers
├── process.ts                 # Interface
└── process.test-utils.ts      # createProcessRunnerMock() + processRunnerMatchers

src/services/git/
├── git-client.interface.ts    # Interface
└── git-client.test-utils.ts   # createGitClientMock() + gitClientMatchers
```

**Use for**: Service-level tests that only need 1-2 behavioral mocks.

#### 2. Central Test Fixture Helper

For API-level tests that need multiple mocks composed together:

```typescript
// src/test/fixtures.ts

interface TestFixtureOptions {
  projects?: Array<{ path: string; branches: string[]; worktrees?: string[] }>;
  files?: Map<string, string>;
}

interface TestFixture {
  api: ICodeHydraApi;
  mocks: {
    gitClient: GitClientMock;
    fileSystem: FileSystemMock;
    processRunner: ProcessRunnerMock;
    httpClient: HttpClientMock;
    portManager: PortManagerMock;
  };
}

export function createTestFixture(options?: TestFixtureOptions): TestFixture {
  const gitClient = createGitClientMock({
    repositories: new Map(
      (options?.projects ?? []).map((p) => [
        p.path,
        {
          branches: p.branches,
          worktrees: (p.worktrees ?? []).map((name) => ({
            path: `${p.path}/.worktrees/${name}`,
            name,
            branch: name,
            isMain: false,
          })),
        },
      ])
    ),
  });

  const fileSystem = createFileSystemMock({
    files: options?.files ?? new Map(),
  });

  const processRunner = createProcessRunnerMock();
  const httpClient = createHttpClientMock();
  const portManager = createPortManagerMock();

  const api = createCodeHydraApi({
    gitClient,
    fileSystem,
    processRunner,
    httpClient,
    portManager,
  });

  return {
    api,
    mocks: { gitClient, fileSystem, processRunner, httpClient, portManager },
  };
}

// Usage in tests
const { api, mocks } = createTestFixture({
  projects: [{ path: "/my-app", branches: ["main", "develop"] }],
});

// Type-safe assertions
expect(mocks.gitClient).toHaveRepository("/my-app");

// Reset all mocks
Object.values(mocks).forEach((mock) => mock.$.reset());
```

**Use for**: API-level tests (CodeHydraApi, LifecycleApi) that exercise multiple modules.

### Integration Test Example

```typescript
// codehydra-api.integration.test.ts

describe("CodeHydraApi - Workspace Management", () => {
  let api: ICodeHydraApi;
  let gitMock: GitClientMock;
  let fsMock: FileSystemMock;

  beforeEach(() => {
    // Create behavioral mocks with initial state
    gitMock = createGitClientMock({
      repositories: new Map([
        ["/projects/my-app", { branches: ["main", "develop", "feature/old"], worktrees: [] }],
      ]),
    });

    fsMock = createFileSystemMock({
      files: new Map([
        ["/projects/my-app/.git/config", "[core]\n..."],
        ["/data/projects.json", "[]"],
      ]),
      directories: new Set(["/projects/my-app", "/data"]),
    });

    // Create real API with behavioral mocks injected
    api = createCodeHydraApi({
      gitClient: gitMock,
      fileSystem: fsMock,
      processRunner: createProcessRunnerMock(),
      httpClient: createHttpClientMock(),
      portManager: createPortManagerMock(),
    });
  });

  afterEach(() => {
    gitMock.$.reset();
    fsMock.$.reset();
  });

  describe("workspace creation", () => {
    it("creates workspace and adds it to project", async () => {
      await api.projects.open("/projects/my-app");
      const workspace = await api.workspaces.create("/projects/my-app", "feature-login", "main");

      expect(workspace.name).toBe("feature-login");
      expect(workspace.branch).toBe("feature-login");
      expect(workspace.baseBranch).toBe("main");

      // Type-safe mock assertions
      expect(gitMock).toHaveWorktree("feature-login");

      const project = await api.projects.get("/projects/my-app");
      expect(project.workspaces).toHaveLength(1);
      expect(project.workspaces[0].name).toBe("feature-login");
    });

    it("emits workspace:created event", async () => {
      const events: unknown[] = [];
      api.on("workspace:created", (data) => events.push(data));

      await api.projects.open("/projects/my-app");
      await api.workspaces.create("/projects/my-app", "feature-login", "main");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        projectPath: "/projects/my-app",
        workspace: expect.objectContaining({ name: "feature-login" }),
      });
    });

    it("rejects creation with non-existent base branch", async () => {
      await api.projects.open("/projects/my-app");

      await expect(
        api.workspaces.create("/projects/my-app", "feature-x", "nonexistent")
      ).rejects.toThrow(GitError);

      // Verify no worktree was created
      expect(gitMock).not.toHaveWorktree("feature-x");

      const project = await api.projects.get("/projects/my-app");
      expect(project.workspaces).toHaveLength(0);
    });

    it("rejects duplicate workspace name", async () => {
      await api.projects.open("/projects/my-app");
      await api.workspaces.create("/projects/my-app", "feature-1", "main");

      await expect(
        api.workspaces.create("/projects/my-app", "feature-1", "develop")
      ).rejects.toThrow();
    });
  });
});
```

---

## UI Integration Tests - Detailed Explanation

### Three Categories of UI Tests

#### 1. API-Call Tests

**Purpose**: Verify user interactions trigger correct API calls.

```typescript
describe("CreateWorkspaceDialog - API calls", () => {
  it("calls api.workspaces.create with form values", async () => {
    const api = createMockApi();
    render(CreateWorkspaceDialog, { props: { projectPath: "/project", api } });

    await userEvent.type(screen.getByLabelText("Name"), "feature-login");
    await userEvent.selectOptions(screen.getByLabelText("Base branch"), "main");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(api.workspaces.create).toHaveBeenCalledWith("/project", "feature-login", "main");
  });
});
```

#### 2. UI-State Tests

**Purpose**: Verify data displays correctly in UI.

```typescript
describe("Sidebar - UI state", () => {
  it("displays workspaces from project", async () => {
    const api = createMockApi({
      projects: [
        {
          path: "/project",
          workspaces: [
            { id: "ws-1", name: "feature-login", status: "ready" },
            { id: "ws-2", name: "feature-signup", status: "working" },
          ],
        },
      ],
    });

    render(Sidebar, { props: { api } });

    expect(screen.getByText("feature-login")).toBeVisible();
    expect(screen.getByText("feature-signup")).toBeVisible();
    expect(screen.getByTestId("status-ws-1")).toHaveClass("ready");
    expect(screen.getByTestId("status-ws-2")).toHaveClass("working");
  });
});
```

#### 3. Pure-UI Tests

**Purpose**: Verify UI behavior that doesn't involve API calls.

```typescript
describe("BranchDropdown - keyboard navigation", () => {
  it("ArrowDown moves focus to next option", async () => {
    render(BranchDropdown, {
      props: { branches: ["main", "develop", "feature/old"], value: "" },
    });

    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "main" })).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "develop" })).toHaveFocus();
  });

  it("typing filters options", async () => {
    render(BranchDropdown, {
      props: { branches: ["main", "develop", "feature/login", "feature/signup"], value: "" },
    });

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "feature");

    expect(screen.getByRole("option", { name: "feature/login" })).toBeVisible();
    expect(screen.getByRole("option", { name: "feature/signup" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "main" })).not.toBeInTheDocument();
  });
});
```

---

## Module Migration Process

Each module migration requires a **separate plan** with **user review**. The migration is a comprehensive audit of all tests for that module.

### Migration Plan Template

```markdown
# <MODULE_NAME>\_MIGRATION

## Module Overview

**Scope**: [Brief description of what this module does]

**Entry Point**: [CodeHydraApi / LifecycleApi / Direct Service / UI Component]

**Files Covered**:

- `src/path/to/module.ts`
- `src/path/to/related-file.ts`

---

## 1. Legacy Test Inventory

### Legacy Unit Tests (\*.test.ts)

| File              | Test Count | Description     |
| ----------------- | ---------- | --------------- |
| `module.test.ts`  | X          | [what it tests] |
| `related.test.ts` | Y          | [what it tests] |

### Legacy Integration Tests (\*.integration.test.ts)

| File                         | Test Count | Description     | Uses Behavioral Mocks? |
| ---------------------------- | ---------- | --------------- | ---------------------- |
| `module.integration.test.ts` | X          | [what it tests] | No (call-tracking)     |

---

## 2. Legacy Test Analysis

### Tests to TRANSFER to Integration Tests

These tests verify valuable behavior and should be migrated:

| Legacy Test                             | Behavior Verified          | Target Integration Test |
| --------------------------------------- | -------------------------- | ----------------------- |
| `module.test.ts: "creates workspace"`   | Workspace added to project | `#1 below`              |
| `module.test.ts: "throws on duplicate"` | Duplicate prevention       | `#2 below`              |

### Tests to DELETE (No Migration)

These tests don't provide value (test implementation, not behavior):

| Legacy Test                                          | Reason for Deletion                          |
| ---------------------------------------------------- | -------------------------------------------- |
| `module.test.ts: "calls gitProvider.createWorktree"` | Tests implementation call, not outcome       |
| `module.test.ts: "sets internal state"`              | Tests private state, not observable behavior |

---

## 3. Existing Integration/Boundary Test Review

### Existing Tests to KEEP (Already Follow Pattern)

| File                                              | Test                          | Reason |
| ------------------------------------------------- | ----------------------------- | ------ |
| `module.boundary.test.ts: "connects to real git"` | Valid boundary test, no mocks | ✓ Keep |

### Existing Tests to MODIFY

| File                                              | Test                    | Issue                                  | Required Change |
| ------------------------------------------------- | ----------------------- | -------------------------------------- | --------------- |
| `module.integration.test.ts: "creates workspace"` | Uses call-tracking mock | Convert to `{ mock, control }` pattern |

### Existing Tests to DELETE

| File                                           | Test                                       | Reason for Deletion |
| ---------------------------------------------- | ------------------------------------------ | ------------------- |
| `module.integration.test.ts: "calls provider"` | Duplicates unit test, tests implementation |

### Tests to ADD (Missing Coverage)

| #   | Test Case                          | Entry Point               | Boundary Mocks | Behavior Verified                    |
| --- | ---------------------------------- | ------------------------- | -------------- | ------------------------------------ |
| 1   | error handling on network failure  | `api.workspaces.create()` | HttpClient     | throws NetworkError, state unchanged |
| 2   | concurrent creation race condition | `api.workspaces.create()` | GitClient      | only one workspace created           |

---

## 4. Proposed Final Test Suite

### Integration Tests (\*.integration.test.ts)

| #   | Test Case                             | Entry Point               | Boundary Mocks        | Behavior Verified                  |
| --- | ------------------------------------- | ------------------------- | --------------------- | ---------------------------------- |
| 1   | creates workspace and adds to project | `api.workspaces.create()` | GitClient, FileSystem | `project.workspaces.contains(...)` |
| 2   | prevents duplicate workspace names    | `api.workspaces.create()` | GitClient             | throws error, no workspace added   |
| 3   | ...                                   | ...                       | ...                   | ...                                |

### Boundary Tests (\*.boundary.test.ts) - Only if Module Owns Boundary

| #   | Test Case | Interface | External System | Behavior Verified |
| --- | --------- | --------- | --------------- | ----------------- |
| 1   | ...       | ...       | ...             | ...               |

---

## 5. Mock Interface Review

Review all mocks used by this module's tests.

**⚠️ IMPORTANT: Mock interface changes require explicit user approval before implementation.**

**Requires approval:**

- Adding new setup methods to state classes
- Adding new custom matchers
- Changing matcher pass/fail logic
- Creating specialized mock variants

**Does NOT require approval:**

- Improving error messages
- Adding optional parameters to existing methods with defaults
- Internal refactoring that doesn't change mock API

### Existing Mocks to KEEP

| Mock                     | Interface         | State Class       | Status                     |
| ------------------------ | ----------------- | ----------------- | -------------------------- |
| `createFileSystemMock()` | `FileSystemLayer` | `FileSystemState` | ✓ Follows `mock.$` pattern |

### Existing Mocks to MODIFY

| Mock                        | Interface       | Issue                           | Required Change                         |
| --------------------------- | --------------- | ------------------------------- | --------------------------------------- |
| `createGitClientMock()`     | `IGitClient`    | Missing worktree count in state | Add `worktreeCount` to `GitClientState` |
| `createProcessRunnerMock()` | `ProcessRunner` | Uses old pattern                | Convert to `mock.$` pattern             |

### New Mocks to CREATE

| Mock                    | Interface          | State Class      | Reason                          |
| ----------------------- | ------------------ | ---------------- | ------------------------------- |
| `createSdkClientMock()` | `SdkClientFactory` | `SdkClientState` | No mock exists for OpenCode SDK |

### Mock State Class Requirements

For each mock, verify the state class includes:

| Mock                     | Required Setup Methods                  | Required Matchers                                       |
| ------------------------ | --------------------------------------- | ------------------------------------------------------- |
| `createGitClientMock()`  | `setDirty()`, `simulateMergeConflict()` | `toHaveWorktree`, `toHaveBranch`, `toBeDirty`           |
| `createFileSystemMock()` | `injectFile()`, `simulateError()`       | `toHaveFile`, `toHaveFileContaining`, `toHaveDirectory` |

### Custom Matchers to ADD

| Matcher                | Mock Type        | Purpose                                   |
| ---------------------- | ---------------- | ----------------------------------------- |
| `toHaveFile`           | `FileSystemMock` | Assert file exists                        |
| `toHaveFileContaining` | `FileSystemMock` | Assert file contains content              |
| `toHaveWorktree`       | `GitClientMock`  | Assert worktree was created               |
| `toBeDirty`            | `GitClientMock`  | Assert repository has uncommitted changes |

---

## 6. Summary

| Category                 | Count | Action                        |
| ------------------------ | ----- | ----------------------------- |
| Legacy unit tests        | X     | Delete after migration        |
| Legacy integration tests | Y     | Migrate to behavioral pattern |
| New integration tests    | Z     | Create                        |
| Existing tests to keep   | W     | No change                     |
| Existing tests to modify | V     | Update mocks                  |
| Existing tests to delete | U     | Remove                        |

---

## 7. Test Timing Review

All tests must adhere to `docs/TESTING.md`. This section reviews timing-related violations.

### Custom Timeouts

Tests should not have custom timeout configurations. Review all occurrences:

| Test                       | Current Timeout | Reason              | Action                       |
| -------------------------- | --------------- | ------------------- | ---------------------------- |
| `"long running operation"` | 10000ms         | Waits for real HTTP | REMOVE - use behavioral mock |
| `"complex calculation"`    | 5000ms          | [reason]            | ⚠️ NEEDS USER APPROVAL       |

**Rule**: Custom timeouts indicate the test is too slow. Fix the test, don't increase the timeout.

### Delays and Sleeps

Tests must not contain `sleep()`, `setTimeout`, `waitFor`, or artificial delays. Review all occurrences:

| Test                    | Delay Type   | Duration | Reason         | Action                            |
| ----------------------- | ------------ | -------- | -------------- | --------------------------------- |
| `"waits for debounce"`  | `sleep(100)` | 100ms    | Tests debounce | REMOVE - use `vi.useFakeTimers()` |
| `"waits for animation"` | `waitFor()`  | variable | [reason]       | ⚠️ NEEDS USER APPROVAL            |

**Rule**: Behavioral mocks respond instantly. Any delay indicates incorrect test structure.

**Allowed exception**: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` for testing timeout _logic_ (not waiting for real time).

### Compliance Check

- [ ] All tests reviewed for custom timeouts
- [ ] All tests reviewed for delays/sleeps
- [ ] Violations either fixed or flagged for user approval
- [ ] Any approved exceptions documented with justification

---

## Questions for User Approval

The following questions must be answered and approved by the user before implementation begins:

### Test Coverage

1. Are any valuable behaviors missing from the proposed test suite?
2. Are any proposed deletions actually testing important behavior that should be kept?
3. Are the proposed entry points at the right level of abstraction?

### Mock Interface Changes (Require Explicit Approval)

4. Are the proposed state class changes correct? (setup methods, `reset()`, `toString()`)
5. Are the proposed custom matchers appropriate? (type-safe, meaningful assertions)
6. Are any specialized mock variants needed? (complexity warrants splitting)
7. Will mock changes break other modules' tests? (List affected modules)

### Risk Assessment

8. Is there any coverage that will be temporarily lost during migration?
9. Are there any tests that are difficult to migrate and need special handling?

### Test Timing Exceptions

10. Are any custom timeouts justified? (List each with reason)
11. Are any delays/sleeps approved? (List each with reason)

**Note**: Exceptions require explicit user approval. All tests must adhere to `docs/TESTING.md` - no timeouts or delays in integration tests.

---

⚠️ **USER MUST EXPLICITLY APPROVE BEFORE IMPLEMENTATION BEGINS**

User approval means:

- User has reviewed all sections of this plan
- User has answered the questions above
- User has explicitly said "approved" or equivalent

Do NOT proceed with implementation until user approval is received.
```

### Migration Review Checklist (For Agent Use)

Before presenting a migration plan to the user for approval, verify:

**Legacy Test Analysis**:

- [ ] All legacy tests inventoried (unit + integration)
- [ ] Each legacy test categorized: transfer, delete, or already covered
- [ ] Deletion rationale provided for each removed test
- [ ] No valuable behavior lost in deletions

**Existing Test Review**:

- [ ] All existing integration/boundary tests reviewed
- [ ] Tests using call-tracking mocks identified for modification
- [ ] Redundant/low-value tests identified for deletion
- [ ] Missing coverage identified for new tests

**Proposed Suite**:

- [ ] All transferred behaviors have corresponding integration tests
- [ ] Entry points are appropriate (not too low-level)
- [ ] Behavioral mocks specified (not call-tracking)
- [ ] Behavior verified as outcomes, not implementation calls

**Mock Interface Review**:

- [ ] All mocks used by this module inventoried
- [ ] Each mock categorized: keep, modify, or create new
- [ ] Mocks using old patterns identified for conversion to `mock.$` pattern
- [ ] State classes implement `MockState` interface (`reset()`, `toString()`)
- [ ] Setup methods defined only when public API isn't sufficient
- [ ] Custom matchers defined for all assertion needs
- [ ] Cross-module impact of mock changes documented
- [ ] **Mock interface changes flagged for user approval**

**Test Timing Compliance** (must adhere to `docs/TESTING.md`):

- [ ] All custom timeouts inventoried
- [ ] All delays/sleeps (`sleep()`, `setTimeout`, `waitFor`) inventoried
- [ ] Each violation marked: REMOVE or NEEDS USER APPROVAL
- [ ] Tests verified to have no artificial waiting

### File Deletion Timing

To avoid losing test coverage during migration:

1. Create the new integration test with behavioral mocks
2. Verify all scenarios from legacy test are covered
3. Run both old and new tests in parallel for one CI run
4. If both pass, delete legacy test **in the same commit**

This ensures no coverage gap during the transition.

### Test File Size Guidance

To maintain fast, focused test files:

- **Split if >30 tests** - Large test files become slow and hard to navigate
- **Split if >1000 lines** - Consider splitting by feature area
- **One entry point per file** - Don't mix CodeHydraApi and LifecycleApi tests

### Migration Priority

| Phase | Module                                     | Priority | Reason                              | Status                                   |
| ----- | ------------------------------------------ | -------- | ----------------------------------- | ---------------------------------------- |
| 1     | Behavioral Mock Factories                  | Critical | Required before any test migration  | `[x]` Complete                           |
| 1b    | Shell/Platform Layer Tests                 | Critical | Validate layer abstractions work    | `[x]` Complete - tests exist             |
| 2     | CodeHydraApi + AppState                    | High     | Core business logic, high churn     | `[x]` Complete - integration tests exist |
| 3     | LifecycleApi + VscodeSetupService          | High     | User-facing setup flow              | `[x]` Complete - integration tests exist |
| 4     | ViewManager, WindowManager, BadgeManager   | Medium   | Electron integration                | `[x]` Complete - integration tests exist |
| 5     | UI Components (Sidebar, Dialogs, etc.)     | Medium   | User interactions                   | `[~]` Partial - some tests exist         |
| 6     | CodeServerManager, PluginServer, McpServer | Low      | Internal infrastructure, less churn | `[x]` Complete - integration tests exist |

**Progressive migration guidance**: Start with high-churn or known-brittle modules to get early feedback on whether the behavioral mock approach is working well.

**Note**: Phase 1b (Shell/Platform Layer Tests) was added after the original plan. These tests validate the Electron abstraction layers that weren't anticipated in the original architecture.

**Phase 1: Infrastructure ✅ Complete**

- [x] Mock Infrastructure - `planning/MOCK_INFRASTRUCTURE.md` (state-mock.ts, setup-matchers.ts, toBeUnchanged matcher)
- [x] All service boundary mocks (`*.state-mock.ts` files)
- [x] All Electron layer mocks (shell + platform)

**Phase 2-6: Integration Tests ✅ Mostly Complete**

28 integration test files exist covering most modules. See "Target Test Structure" section for details.

---

## Phase 1: Behavioral Mock Factory Creation

**This phase must complete before any test migration begins.**

Before migrating tests, we need behavioral mock factories for all boundary interfaces. Each mock factory requires a separate implementation plan.

### Status Markers

- `[ ]` = Not started
- `[~]` = Partial (call-tracking mock exists, needs migration to `mock.$` pattern)
- `[?]` = Review (behavioral mock exists, needs verification it follows `mock.$` pattern)
- `[x]` = Complete (verified: `mock.$` accessor, `MockState` interface, type-safe matchers)

### Step 0: Infrastructure ✅ COMPLETE

Shared infrastructure is set up and working:

| Order | File                         | Purpose                                                 | Status |
| ----- | ---------------------------- | ------------------------------------------------------- | ------ |
| 1     | `src/test/state-mock.ts`     | Base `MockState` interface (`snapshot()`, `toString()`) | `[x]`  |
| 2     | Individual mock files        | State classes implementing MockState                    | `[x]`  |
| 3     | (embedded in state-mock.ts)  | Conditional type declarations for type-safe matchers    | `[x]`  |
| 4     | `src/test/setup-matchers.ts` | Imports and registers all matcher implementations       | `[x]`  |
| 5     | `vitest.config.ts`           | `setupFiles` configured for all test projects           | `[x]`  |

**Note:** The original plan called for `mock-state.ts` but implementation uses `state-mock.ts`. Type declarations are embedded in `state-mock.ts` rather than a separate `matchers.d.ts` file.

### Architecture Evolution: Layer Abstraction Pattern

The codebase evolved to use a **two-layer abstraction** for Electron that wasn't in the original plan:

```
Shell Layers (visual containers)     Platform Layers (OS/runtime)
├── ViewLayer                        ├── AppLayer
├── WindowLayer                      ├── ImageLayer
└── SessionLayer                     ├── DialogLayer
                                     ├── IpcLayer
                                     └── MenuLayer
```

These layers provide better testability than mocking raw Electron APIs. Behavioral mocks for these layers exist and can serve as examples for the service boundary mocks that still need migration.

### Required Behavioral Mocks

#### Service Boundary Mocks ✅ ALL COMPLETE

| Mock Factory                   | Interface          | Location                                                       | Status |
| ------------------------------ | ------------------ | -------------------------------------------------------------- | ------ |
| `createMockGitClient()`        | `IGitClient`       | `src/services/git/git-client.state-mock.ts`                    | `[x]`  |
| `createFileSystemMock()`       | `FileSystemLayer`  | `src/services/platform/filesystem.state-mock.ts`               | `[x]`  |
| `createMockProcessRunner()`    | `ProcessRunner`    | `src/services/platform/process.state-mock.ts`                  | `[x]`  |
| `createMockHttpClient()`       | `HttpClient`       | `src/services/platform/http-client.state-mock.ts`              | `[x]`  |
| `createPortManagerMock()`      | `PortManager`      | `src/services/platform/port-manager.state-mock.ts`             | `[x]`  |
| `createMockArchiveExtractor()` | `ArchiveExtractor` | `src/services/binary-download/archive-extractor.state-mock.ts` | `[x]`  |
| `createMockSdkClientFactory()` | `SdkClientFactory` | `src/services/opencode/sdk-client.state-mock.ts`               | `[x]`  |

**Note:** File naming convention changed from `*.test-utils.ts` to `*.state-mock.ts` for behavioral mocks. Legacy `*.test-utils.ts` files contain deprecated call-tracking mocks with `@deprecated` annotations pointing to the new state mocks.

#### Central Test Fixture (Deferred)

| Mock Factory          | Interface     | Location               | Status                    |
| --------------------- | ------------- | ---------------------- | ------------------------- |
| `createTestFixture()` | (composition) | `src/test/fixtures.ts` | `[ ]` Deferred - see note |

**Deferred:** The central test fixture helper is deferred until patterns emerge from actual usage. As more integration tests are written, we'll identify common mock composition patterns that would benefit from a shared fixture. Design the fixture based on observed needs rather than speculating upfront.

#### Electron Layer Mocks (Shell + Platform) ✅ ALL COMPLETE

These mocks abstract Electron APIs and were added as part of the layer abstraction pattern.

| Mock Factory               | Interface      | Location                                    | Status |
| -------------------------- | -------------- | ------------------------------------------- | ------ |
| `createAppLayerMock()`     | `AppLayer`     | `src/services/platform/app.state-mock.ts`   | `[x]`  |
| `createImageLayerMock()`   | `ImageLayer`   | `src/services/platform/image.state-mock.ts` | `[x]`  |
| `createViewLayerMock()`    | `ViewLayer`    | `src/services/shell/view.state-mock.ts`     | `[x]`  |
| `createWindowLayerMock()`  | `WindowLayer`  | `src/services/shell/window.state-mock.ts`   | `[x]`  |
| `createSessionLayerMock()` | `SessionLayer` | `src/services/shell/session.state-mock.ts`  | `[x]`  |

### Mock Factory Implementation Plan Template

Each mock factory needs a separate plan specifying:

1. **State class** implementing `MockState` (`reset()`, `toString()`)
2. **Setup methods** (only when public API isn't sufficient)
3. **Custom matchers** with type declarations and runtime validation
4. **Error behaviors** (e.g., "GitError for non-existent branch")
5. **Reference to boundary tests** that define the expected behavior

**⚠️ Mock interface changes require explicit user approval before implementation.**

Detailed specs are deferred to individual mock factory implementation plans.

---

## Target Test Structure

**This section tracks the migration status of integration tests.** The checkboxes reflect which integration tests exist and follow the behavioral mock pattern.

**Status Legend:**

- `[x]` = Migrated (integration test exists with behavioral mocks)
- `[?]` = Review (integration test exists, needs verification it follows behavioral pattern)
- `[ ]` = Pending (needs migration or creation)

_Last updated: 2026-01-04_

---

### Entry Point: CodeHydraApi ✅ COMPLETE

**`src/main/app-state.integration.test.ts`** - Core app state with projects/workspaces

| Status | Integration Test                                             |
| ------ | ------------------------------------------------------------ |
| `[x]`  | `src/main/app-state.integration.test.ts`                     |
| `[x]`  | `src/services/project/project-store.integration.test.ts`     |
| `[x]`  | `src/main/modules/core/index.integration.test.ts`            |
| `[x]`  | `src/services/git/git-worktree-provider.integration.test.ts` |

---

### Entry Point: LifecycleApi ✅ COMPLETE

**`src/services/vscode-setup/vscode-setup-service.integration.test.ts`**

| Status | Integration Test                                                           |
| ------ | -------------------------------------------------------------------------- |
| `[x]`  | `src/services/vscode-setup/vscode-setup-service.integration.test.ts`       |
| `[x]`  | `src/services/binary-download/binary-download-service.integration.test.ts` |

---

### Entry Point: Direct Services ✅ COMPLETE

| Status | Integration Test                                                    |
| ------ | ------------------------------------------------------------------- |
| `[x]`  | `src/services/code-server/code-server-manager.integration.test.ts`  |
| `[x]`  | `src/services/plugin-server/plugin-server.integration.test.ts`      |
| `[x]`  | `src/services/opencode/opencode-server-manager.integration.test.ts` |
| `[x]`  | `src/services/mcp-server/mcp-server-manager.integration.test.ts`    |
| `[x]`  | `src/services/services.integration.test.ts`                         |

---

### Entry Point: Electron Managers (Direct with Mocked Layers) ✅ COMPLETE

| Status | Integration Test                                       |
| ------ | ------------------------------------------------------ |
| `[x]`  | `src/main/managers/view-manager.integration.test.ts`   |
| `[x]`  | `src/main/managers/window-manager.integration.test.ts` |
| `[x]`  | `src/main/managers/badge-manager.integration.test.ts`  |
| `[x]`  | `src/main/shortcut-controller.integration.test.ts`     |

---

### Entry Point: Shell/Platform Layers ✅ COMPLETE

| Status | Integration Test                                   |
| ------ | -------------------------------------------------- |
| `[x]`  | `src/services/shell/view.integration.test.ts`      |
| `[x]`  | `src/services/shell/window.integration.test.ts`    |
| `[x]`  | `src/services/shell/session.integration.test.ts`   |
| `[x]`  | `src/services/platform/image.integration.test.ts`  |
| `[x]`  | `src/services/platform/ipc.integration.test.ts`    |
| `[x]`  | `src/services/platform/dialog.integration.test.ts` |
| `[x]`  | `src/services/platform/menu.integration.test.ts`   |

---

### Entry Point: Bootstrap/API ✅ COMPLETE

| Status | Integration Test                                |
| ------ | ----------------------------------------------- |
| `[x]`  | `src/main/bootstrap.integration.test.ts`        |
| `[x]`  | `src/main/api/registry.integration.test.ts`     |
| `[x]`  | `src/main/ipc/api-handlers.integration.test.ts` |

---

### Entry Point: UI Components 🔄 PARTIAL

| Status | Integration Test                                                         |
| ------ | ------------------------------------------------------------------------ |
| `[x]`  | `src/renderer/lib/components/MainView.integration.test.ts`               |
| `[x]`  | `src/renderer/lib/components/OpenProjectErrorDialog.integration.test.ts` |
| `[ ]`  | `src/renderer/lib/components/Sidebar.integration.test.ts`                |
| `[ ]`  | `src/renderer/lib/components/CreateWorkspaceDialog.integration.test.ts`  |
| `[ ]`  | `src/renderer/lib/components/BranchDropdown.integration.test.ts`         |

---

### Entry Point: Extensions ✅ COMPLETE

| Status | Integration Test                                                   |
| ------ | ------------------------------------------------------------------ |
| `[x]`  | `extensions/dictation/src/DictationController.integration.test.ts` |

---

### Focused Tests (Pure Functions - No Migration Needed) ✅

These tests are already correct - they test pure functions with no external dependencies:

| Status | Test          | Path                                 |
| ------ | ------------- | ------------------------------------ |
| `[x]`  | path-utils    | `src/services/platform/path.test.ts` |
| `[x]`  | id-generation | `src/shared/id-generation.test.ts`   |
| `[x]`  | error-utils   | `src/shared/error-utils.test.ts`     |

---

### Boundary Tests (No Migration - Keep As Is) ✅

These tests verify real external system behavior and should not be modified:

| Status | Test                       | Path                                                              |
| ------ | -------------------------- | ----------------------------------------------------------------- |
| `[x]`  | simple-git-client.boundary | `src/services/git/simple-git-client.boundary.test.ts`             |
| `[x]`  | filesystem.boundary        | `src/services/platform/filesystem.boundary.test.ts`               |
| `[x]`  | process.boundary           | `src/services/platform/process.boundary.test.ts`                  |
| `[x]`  | network.boundary           | `src/services/platform/network.boundary.test.ts`                  |
| `[x]`  | archive-extractor.boundary | `src/services/binary-download/archive-extractor.boundary.test.ts` |
| `[x]`  | opencode-client.boundary   | `src/services/opencode/opencode-client.boundary.test.ts`          |

---

## Implementation Steps

**Scope**: This plan updates documentation only. Behavioral mock creation and test migration happen in separate plans.

- [x] **Step 1: Update docs/TESTING.md - Test Types Section**
  - Add "Behavioral Mock Pattern" as primary test type
  - Document `mock.$` accessor pattern
  - Document `MockState` interface requirement

- [x] **Step 2: Update docs/TESTING.md - Mock Factories Section**
  - Add mock factory organization (co-located + central fixture)
  - Document type-safe matcher pattern
  - Add matcher registration instructions

- [x] **Step 3: Update docs/TESTING.md - Migration Section**
  - Add migration plan template reference
  - Document file deletion timing rules
  - Add test file size guidance

- [x] **Step 4: Update docs/TESTING.md - Performance Section**
  - Add integration test performance targets
  - Document <50ms per test requirement
  - Add profiling guidance

- [x] **Step 5: Update AGENTS.md - Testing Requirements**
  - Add behavioral mock pattern summary
  - Reference docs/TESTING.md for details
  - Update test command table

- [x] **Step 6: Create TODO tracking section**
  - Document all changes made to docs/TESTING.md
  - Create checklist for future reviewers

---

## TODO: docs/TESTING.md Updates

The following changes have been made to `docs/TESTING.md`:

### New Sections Added

- [x] **Behavioral Mock Base Interface** - `MockState` interface with `reset()`, `toString()`
- [x] **Mock Return Pattern** - `mock.$` accessor pattern explanation
- [x] **Type-Safe Custom Matchers** - Conditional type pattern for type-safe assertions
- [x] **Matcher Registration** - Setup file and vitest config instructions (deferred to Phase 1 infrastructure)
- [x] **Mock Factory Organization** - Co-located vs central fixture pattern
- [x] **Cross-Mock State Coordination** - Guidance for tests needing multiple mocks
- [x] **Event and Callback Mocking** - Pattern for interfaces with callbacks
- [x] **Error Simulation Pattern** - `simulateError()`/`clearError()` methods
- [x] **Public API vs $ Accessor** - Guidance on when to use each
- [x] **Async Operations** - Synchronous state updates guidance

### Existing Sections Updated

- [x] **Test Types** - Integration tests emphasized as primary, unit tests marked deprecated
- [x] **Test Naming** - Behavioral naming convention already documented
- [x] **Performance Targets** - <50ms per integration test already documented
- [x] **Integration Test Example** - Updated to use `mock.$` pattern

### AGENTS.md Updates

- [x] **Behavioral Mock Pattern** - Added new section with `mock.$` example
- [x] **Quick Reference** - Already emphasizes integration tests
- [x] **Test Commands** - Already shows `test:integration` as primary

---

## Documentation Updates

### Files to Update

| File              | Changes Required                                                    |
| ----------------- | ------------------------------------------------------------------- |
| `docs/TESTING.md` | Major update - add behavioral mock patterns, type-safe matchers     |
| `AGENTS.md`       | Minor update - reference new patterns, update test command guidance |

### New Documentation Required

None - all content goes in existing files.

---

## Definition of Done

- [x] All implementation steps complete (documentation updates)
- [x] Plan approved by reviewers
- [x] `docs/TESTING.md` updated with behavioral mock patterns
- [x] `AGENTS.md` testing section updated
- [x] `pnpm validate:fix` passes
- [x] User acceptance testing passed

---

## Notes

This plan establishes the **strategy and documentation** for behavior-driven testing.

### Implementation Summary (as of 2026-01-04)

**Phase 1: Infrastructure ✅ COMPLETE**

- All behavioral mock factories implemented in `*.state-mock.ts` files
- Mock infrastructure: `src/test/state-mock.ts`, `src/test/setup-matchers.ts`
- Vitest configuration with proper `setupFiles` for all test projects

**Phase 2-6: Integration Tests ✅ MOSTLY COMPLETE**

- 28 integration test files exist covering most modules
- Remaining work: UI component integration tests (Sidebar, CreateWorkspaceDialog, BranchDropdown)

**Naming Convention Evolution:**

- Original plan: `*.test-utils.ts` for mocks
- Actual implementation: `*.state-mock.ts` for behavioral mocks
- Legacy `*.test-utils.ts` files contain deprecated call-tracking mocks with `@deprecated` annotations

**Central Fixture (`src/test/fixtures.ts`):**

- Deferred until patterns emerge from actual usage
- As more integration tests are written, common mock composition patterns will be identified
- Design based on observed needs rather than speculating upfront
