# Testing Strategy

## Overview

CodeHydra uses behavior-driven testing with vitest. Tests verify **behavior** through high-level entry points, not implementation details. External system access is mocked using **behavioral simulators** with in-memory state.

## Quick Reference

| Task                      | Command                          | Section                                             |
| ------------------------- | -------------------------------- | --------------------------------------------------- |
| Run all tests             | `pnpm test`                      | [Test Commands](#test-commands)                     |
| Run targeted tests        | `pnpm test:related -- <pattern>` | [Targeted Testing](#targeted-testing)               |
| Run integration tests     | `pnpm test:integration`          | [Test Commands](#test-commands)                     |
| Run boundary tests        | `pnpm test:boundary`             | [Test Commands](#test-commands)                     |
| Run deprecated unit tests | `pnpm test:legacy`               | [Test Commands](#test-commands)                     |
| Quick validation          | `pnpm validate:quick`            | [Targeted Testing](#targeted-testing)               |
| Pre-commit validation     | `pnpm validate`                  | [Test Commands](#test-commands)                     |
| Decide which test type    | See decision guide               | [Decision Guide](#decision-guide)                   |
| Create test git repo      | `createTestGitRepo()`            | [Test Helpers](#test-helpers)                       |
| Create behavioral mock    | `createXMock()`                  | [Behavioral Mock Pattern](#behavioral-mock-pattern) |

---

## Test Types

### Boundary Tests (\*.boundary.test.ts)

**Purpose**: Verify boundary interfaces work correctly with real external systems.

**When to write**: When creating or modifying a boundary interface (external system wrapper).

**What to mock**: NOTHING - tests hit real Git, real filesystem, real HTTP.

**Boundaries**:

- Node.js: `FileSystemLayer`, `ProcessRunner`, `HttpClient`, `PortManager`, `ArchiveExtractor`
- Git: `IGitClient`
- OpenCode: `SdkClientFactory`
- Electron Shell: `WindowLayer`, `ViewLayer`, `SessionLayer`
- Electron Platform: `IpcLayer`, `DialogLayer`, `ImageLayer`, `AppLayer`, `MenuLayer`

**Key characteristics**:

- Self-contained setup/teardown (no manual test setup required)
- Tests only the direct interface module
- May be slower due to real external interactions
- Must clean up all resources
- Cross-platform (use `path.join()`, handle Windows/Unix differences)

**Relationship to behavioral mocks**: Boundary tests define the **contract** that behavioral mocks must follow. When adding behavior to a mock, verify the equivalent behavior is tested in the boundary test suite.

```
Boundary Test (real Git):              Behavioral Mock (in-memory):
─────────────────────────              ────────────────────────────
it("throws GitError for               // Must throw same error
   non-existent branch")              if (!repo.branches.includes(b))
                                        throw new GitError(...)

it("creates worktree with             // Must set same properties
   correct branch name")              worktree.branch = name
```

**Example**:

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
  });

  it("throws GitError for non-existent branch", async () => {
    await expect(client.createWorktree(testRepo.path, "feature-1", "nonexistent")).rejects.toThrow(
      GitError
    );
  });
});
```

### Integration Tests (\*.integration.test.ts)

**Purpose**: Verify application behavior through high-level entry points.

**When to write**: All feature code, business logic, UI components.

**What to mock**: Only boundary interfaces, using **behavioral simulators**.

**Entry points**: CodeHydraApi, LifecycleApi, service classes (direct), UI components.

**Key characteristics**:

- Tests behavior, not implementation ("when user does X, outcome is Y")
- Real module interaction (modules, ProjectStore, GitWorktreeProvider all run together)
- Only mock boundaries (same interfaces tested by boundary tests)
- **MUST be fast** - target <50ms per test, <2s per module

#### Why This Approach?

Traditional unit tests mock everything except the single module under test. This creates problems:

1. **Tests mirror implementation** - Change the code, change the mocks
2. **No behavior verification** - Tests check "did you call X?" not "does feature Y work?"
3. **False confidence** - All tests pass, but bugs exist in how modules interact

Integration tests solve this by:

1. **Testing behavior** - "When user does X, outcome is Y"
2. **Real module interaction** - Modules, ProjectStore, GitWorktreeProvider all run together
3. **Only mock boundaries** - The external system interfaces, not internal modules

---

### UI Integration Tests

UI tests fall into three categories:

#### 1. API-Call Tests

Verify user interactions trigger correct API calls.

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

Verify data displays correctly in UI.

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
  });
});
```

#### 3. Pure-UI Tests

Verify UI behavior that doesn't involve API calls.

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
});
```

---

### Focused Tests (\*.test.ts - for pure functions)

**Purpose**: Fast feedback for pure utility functions.

**When to write**: Functions with NO external dependencies (ID generation, path normalization, validation, parsing).

**Why allowed**: Pure functions don't suffer from "tests mirror implementation" - they're just input/output.

```typescript
describe("generateProjectId", () => {
  it("creates deterministic ID from path", () => {
    expect(generateProjectId("/path/to/repo")).toBe("repo-a1b2c3d4");
    expect(generateProjectId("/path/to/repo")).toBe("repo-a1b2c3d4"); // Same input = same output
  });

  it("handles paths with special characters", () => {
    expect(generateProjectId("/path/to/my-repo")).toBe("my-repo-e5f6g7h8");
  });
});
```

---

### Unit Tests (\*.test.ts) - DEPRECATED

**Status**: Existing unit tests remain until migrated per-module.

**Command**: `pnpm test:legacy`

Unit tests that mock dependencies and verify implementation calls are being replaced by integration tests with behavioral mocks. Existing unit tests will be migrated to integration tests on a per-module basis. Each migration requires a separate plan with user approval.

---

## Decision Guide

```
Code change involves external system interface?
(Git CLI, HTTP, filesystem, processes, binaries)
                    │
       ┌────────────┴────────────┐
       │ YES                     │ NO
       ▼                         ▼
┌──────────────┐     Is it a pure utility function?
│  BOUNDARY    │     (no deps, input → output)
│    TEST      │                 │
│              │    ┌────────────┴────────────┐
└──────────────┘    │ YES                     │ NO
                    ▼                         ▼
             ┌──────────────┐         ┌──────────────┐
             │   FOCUSED    │         │ INTEGRATION  │
             │    TEST      │         │    TEST      │
             └──────────────┘         └──────────────┘
```

### Entry Point Selection Guide

| Condition                                     | Entry Point                        | Example                                 |
| --------------------------------------------- | ---------------------------------- | --------------------------------------- |
| Module is public API                          | `CodeHydraApi` or `LifecycleApi`   | ProjectStore, AgentModule               |
| Module is internal service with complex state | Direct service                     | CodeServerManager, PluginServer         |
| Module is Electron wrapper                    | Direct with mocked Electron APIs   | ViewManager, WindowManager              |
| Module is UI component                        | Component with mocked `window.api` | Sidebar, CreateWorkspaceDialog          |
| Module is pure utility function               | Focused test (no entry point)      | generateProjectId, normalizeMetadataKey |

---

## Behavioral Mock Pattern

**Critical**: Mocks must simulate behavior with in-memory state, not just track calls.

### Bad: Call-Tracking Mock

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

### Good: Behavioral Mock

```typescript
import { createMockGitClient } from "./git/git-client.state-mock";

// This tests actual behavior
const gitMock = createGitClientMock({
  repositories: new Map([["/project", { branches: ["main", "develop"], worktrees: [] }]]),
});

// Mock has in-memory state - createBranch actually adds to branches set
await gitMock.createBranch(new Path("/project"), "feat-1", "main");

// Verify BEHAVIOR - the branch exists now
expect(gitMock).toHaveBranch("/project", "feat-1");

// Verify BEHAVIOR - can't create duplicate
await expect(gitMock.createBranch(new Path("/project"), "feat-1", "main")).rejects.toThrow();

// Type-safe custom matchers for readable assertions
expect(gitMock).toHaveWorktree("feat-1");
```

### Mock Return Pattern

Behavioral mocks return the mock interface directly with a `$` accessor for state operations:

```typescript
// Factory returns mock with $ accessor
export type FileSystemMock = FileSystemLayer & { readonly $: FileSystemState };

// Usage
const mock = createFileSystemMock();

// Use public API for normal setup (preferred)
await mock.writeFile("/config.json", "{}");
await mock.mkdir("/data");

// Use $ for operations not possible through public API
mock.$.simulateError("/broken", "EIO"); // Simulate I/O error
mock.$.reset(); // Restore to initial state
console.log(mock.$.toString()); // Debug state
```

| Property | Type               | Purpose                                                |
| -------- | ------------------ | ------------------------------------------------------ |
| `mock`   | The interface type | Drop-in replacement, exact interface match             |
| `mock.$` | State class        | Test utilities: `reset()`, `toString()`, setup methods |

### MockState Interface

All mock state classes implement the `MockState` interface:

```typescript
// src/test/mock-state.ts

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
```

**State class example:**

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
    return [
      "=== FileSystem Mock ===",
      `Files (${this.files.size}): ${[...this.files.keys()].slice(0, 10).join(", ") || "(none)"}`,
      `Dirs (${this.dirs.size}): ${[...this.dirs].slice(0, 10).join(", ") || "(none)"}`,
    ].join("\n");
  }

  // Setup methods - only when public API isn't sufficient
  simulateError(path: string, code: FileSystemErrorCode): void {
    this.errorMap.set(normalizePath(path), code);
  }

  clearError(path: string): void {
    this.errorMap.delete(normalizePath(path));
  }
}
```

### Public API vs $ Accessor

**Prefer public API for normal setup. Use $ only for scenarios impossible through the public API:**

```typescript
// GOOD: Use public API for normal setup
await mock.writeFile("/config.json", "{}"); // Creates file naturally
await mock.mkdir("/data"); // Creates directory naturally

// GOOD: Use $ for scenarios that can't happen through public API
mock.$.simulateError("/broken", "EIO"); // Can't trigger I/O errors naturally
mock.$.emitOutput(pid, "stdout data"); // Trigger callback synchronously

// BAD: Using $ for normal operations (defeats behavioral testing)
mock.$.files.set("/config.json", "{}"); // Should use public writeFile()
```

### Error Simulation Pattern

Mocks provide type-safe error simulation:

```typescript
/** Valid filesystem error codes for type-safe error simulation */
export type FileSystemErrorCode =
  | "ENOENT" // File not found
  | "EACCES" // Permission denied
  | "EEXIST" // File already exists
  | "ENOTDIR" // Not a directory
  | "EISDIR" // Is a directory
  | "ENOTEMPTY" // Directory not empty
  | "EIO"; // I/O error

// Usage
mock.$.simulateError("/broken/path", "EIO");
await expect(mock.readFile("/broken/path")).rejects.toThrow(); // Throws with code: "EIO"
mock.$.clearError("/broken/path"); // Remove error simulation
```

### Event and Callback Mocking

For interfaces with event emitters or callbacks:

```typescript
class ProcessRunnerState implements MockState {
  private outputCallbacks = new Map<number, (data: string) => void>();

  // Store callbacks when registered
  onOutput(pid: number, callback: (data: string) => void): void {
    this.outputCallbacks.set(pid, callback);
  }

  // Setup method to trigger callbacks synchronously
  emitOutput(pid: number, data: string): void {
    this.outputCallbacks.get(pid)?.(data);
  }
}

// Usage in tests
const mock = createProcessRunnerMock();
const output: string[] = [];
mock.spawn("node", ["script.js"], { onOutput: (data) => output.push(data) });
mock.$.emitOutput(1, "Hello from process");
expect(output).toEqual(["Hello from process"]);
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
```

**Matcher implementation:**

```typescript
// filesystem.test-utils.ts
export const fileSystemMatchers = {
  toHaveFile(this: MatcherState, expectedPath: string) {
    if (!isFileSystemMock(this.actual)) {
      throw new TypeError("toHaveFile matcher can only be used with FileSystemMock");
    }
    const state = this.actual.$;
    const exists = state.files.has(normalizePath(expectedPath));
    return {
      pass: exists,
      message: () =>
        exists
          ? `Expected no file at "${expectedPath}"`
          : `Expected file at "${expectedPath}"\n\nCurrent state:\n${state}`,
    };
  },
};
```

### Cross-Platform Requirements

Behavioral mocks must handle platform differences:

- Use `path.join()` for path construction
- Use `path.normalize()` for path comparison
- Support both `/` and `\` separators in assertions
- Throw errors with correct `code` property (ENOENT, EEXIST, etc.)

```typescript
import path from "path";

/** Normalize path for cross-platform map keys */
export const normalizePath = (p: string): string => path.normalize(p);
```

### Async Operations in Behavioral Mocks

**State updates should be synchronous. Only use async when the interface requires it:**

```typescript
// GOOD: Synchronous state update, immediate Promise resolution
async writeFile(path: string, content: string): Promise<void> {
  this.$.files.set(normalizePath(path), content);  // Synchronous
  return Promise.resolve();                         // Immediate resolution
}

// BAD: Unnecessary delays
async writeFile(path: string, content: string): Promise<void> {
  await sleep(10);  // Never do this - slows tests
  this.$.files.set(path, content);
}
```

---

## State Mock Pattern

State mocks provide a standardized interface for behavioral mocks with type-safe matchers. This formalizes the existing `_getState()` pattern into a consistent API.

### File Naming Convention

State mock files use the `*.state-mock.ts` suffix:

- `src/services/platform/filesystem.state-mock.ts`
- `src/services/git/git-client.state-mock.ts`

### Core Interfaces

All state mocks implement these interfaces from `src/test/state-mock.ts`:

```typescript
// Base interface for mock state - pure data, logic belongs in matchers
interface MockState {
  snapshot(): Snapshot; // Capture state for comparison
  toString(): string; // Human-readable state for error messages
}

// Mock with inspectable state via the `$` property
interface MockWithState<TState extends MockState> {
  readonly $: TState;
}
```

### Snapshot and `toBeUnchanged()` Matcher

The base `toBeUnchanged(snapshot)` matcher compares state before and after an action:

```typescript
it("does not modify state when branch does not exist", async () => {
  const gitMock = createMockGitClient({
    repositories: new Map([["/project", { branches: ["main"] }]]),
  });

  // Capture state before action
  const snapshot = gitMock.$.snapshot();

  // Action should fail
  await expect(gitMock.addWorktree(/* ... */)).rejects.toThrow();

  // State should be unchanged
  expect(gitMock).toBeUnchanged(snapshot);
});

it("creates worktree when branch exists", async () => {
  const gitMock = createMockGitClient(/* ... */);
  const snapshot = gitMock.$.snapshot();

  await gitMock.addWorktree(/* ... */);

  // Assert state changed
  expect(gitMock).not.toBeUnchanged(snapshot);
});
```

### Custom Matchers Pattern

Each state mock file can define custom matchers for domain-specific assertions:

```typescript
// In *.state-mock.ts files:

// 1. State interface (pure data, extends MockState)
export interface FileSystemMockState extends MockState {
  readonly files: ReadonlyMap<string, string | Buffer>;
  readonly directories: ReadonlySet<string>;
}

// 2. Mock type (Layer & MockWithState<State>)
export type MockFileSystemLayer = FileSystemLayer & MockWithState<FileSystemMockState>;

// 3. Matchers interface
interface FileSystemMatchers {
  toHaveFile(path: string | Path): void;
  toHaveDirectory(path: string | Path): void;
}

// 4. Vitest augmentation
declare module "vitest" {
  interface Assertion<T> extends MatchersFor<T, MockFileSystemLayer, FileSystemMatchers> {}
}

// 5. Matcher implementations (type-safe via MatcherImplementationsFor)
export const fileSystemMatchers: MatcherImplementationsFor<
  MockFileSystemLayer,
  FileSystemMatchers
> = {
  toHaveFile(received, path) {
    const normalized = new Path(path).toString();
    const pass = received.$.files.has(normalized);
    return {
      pass,
      message: () =>
        pass
          ? `Expected mock not to have file "${normalized}"`
          : `Expected mock to have file "${normalized}"`,
    };
  },
  // ... other matchers
};

// 6. Factory function
export function createMockFileSystem(options?: MockFileSystemOptions): MockFileSystemLayer {
  // ... implementation
}
```

### ViewLayer State Mock Example

The ViewLayer mock demonstrates the same pattern with custom matchers for view-specific assertions:

```typescript
import { createViewLayerMock } from "../shell/view.state-mock";

const mock = createViewLayerMock();

// Create views and interact with them
const handle = mock.createView({ backgroundColor: "#1e1e1e" });
await mock.loadURL(handle, "http://127.0.0.1:8080");

// Custom matchers for view assertions
expect(mock).toHaveView(handle.id);
expect(mock).toHaveView(handle.id, {
  url: "http://127.0.0.1:8080",
  backgroundColor: "#1e1e1e",
  attachedTo: null,
});

// Assert exact set of views
expect(mock).toHaveViews([handle.id]);

// Trigger simulated events
mock.onDidFinishLoad(handle, () => console.log("loaded"));
mock.$.triggerDidFinishLoad(handle);

// Snapshot for unchanged assertions
const snapshot = mock.$.snapshot();
// ... action that should not change state ...
expect(mock).toBeUnchanged(snapshot);
```

### Matcher Registration

Matchers are registered in `src/test/setup-matchers.ts`:

```typescript
// Base matchers (toBeUnchanged) auto-registered via import
import "./state-mock";

// Filesystem matchers (auto-registered via import side effect)
import "../services/platform/filesystem.state-mock";

// ProcessRunner matchers (auto-registered via import side effect)
import "../services/platform/process.state-mock";

// ViewLayer matchers (auto-registered via import side effect)
import "../services/shell/view.state-mock";
```

Note: Each `*.state-mock.ts` file calls `expect.extend(matchers)` when imported, so matchers are automatically available in tests.

### ProcessRunner Mock Example

The ProcessRunner state mock provides behavioral simulation for process spawning:

```typescript
// Factory with per-spawn configuration
const runner = createMockProcessRunner({
  onSpawn: (command, args, cwd) => {
    if (command.includes("code-server")) {
      return { pid: 12345, exitCode: 0 };
    }
    return { pid: undefined, stderr: "spawn ENOENT" }; // Spawn failure
  },
});

// Use in tests
const manager = new CodeServerManager(runner, ...);
await manager.ensureRunning();

// Custom matchers for verification
expect(runner).toHaveSpawned([
  { command: expect.stringContaining("code-server"), cwd: "/workspace" },
]);

// Stop and verify kill was called
await manager.stop();
expect(runner.$.spawned(0)).toHaveBeenKilled();
expect(runner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
```

**Custom Matchers:**

| Matcher                            | Target             | Description                      |
| ---------------------------------- | ------------------ | -------------------------------- |
| `toHaveSpawned(records[])`         | MockProcessRunner  | Verify spawned processes         |
| `toHaveBeenKilled()`               | MockSpawnedProcess | Verify kill() was called         |
| `toHaveBeenKilledWith(term, kill)` | MockSpawnedProcess | Verify kill() with specific args |

### SDK Client Mock

The OpenCode SDK client mock provides behavioral simulation for `@opencode-ai/sdk` integration testing.

**Factory Function**:

```typescript
import {
  createSdkClientMock,
  createSdkFactoryMock,
  createTestSession,
  type SdkClientFactory,
  type MockSdkClient,
} from "src/services/opencode/sdk-client.state-mock";

// Create mock with initial sessions
const mock = createSdkClientMock({
  sessions: [
    { id: "ses-0001", directory: "/test", status: { type: "idle" } },
    { id: "ses-0002", directory: "/test", status: { type: "busy" } },
  ],
});

// Create factory for dependency injection
const factory = createSdkFactoryMock(mock);
```

**State Interface** (`SdkClientMockState`):

| Property              | Type                               | Description                       |
| --------------------- | ---------------------------------- | --------------------------------- |
| `sessions`            | `ReadonlyMap<string, MockSession>` | Session ID → session with status  |
| `connected`           | `boolean`                          | Whether event stream is connected |
| `prompts`             | `readonly PromptRecord[]`          | History of prompts sent           |
| `emittedEvents`       | `readonly SdkEvent[]`              | History of emitted events         |
| `permissionResponses` | `readonly PermissionResponse[]`    | History of permission responses   |
| `emitEvent(event)`    | `(event: SdkEvent) => void`        | Push event synchronously          |
| `completeStream()`    | `() => void`                       | End the event stream              |
| `errorStream(error)`  | `(error: Error) => void`           | Error the event stream            |
| `setConnectionError`  | `(error: Error \| null) => void`   | Make subscribe() reject           |

**Custom Matchers**:

```typescript
// Assert a prompt was sent to a session
expect(mock).toHaveSentPrompt("ses-0001"); // Any prompt
expect(mock).toHaveSentPrompt("ses-0001", "Hello"); // Exact match
expect(mock).toHaveSentPrompt("ses-0001", /implement.*feature/); // RegExp

// Assert session exists
expect(mock).toHaveSession("ses-0001");
```

**Event Emission** (synchronous for test predictability):

```typescript
import { createSessionStatusEvent } from "./sdk-client.state-mock";

// Emit events via state - immediately resolves pending iterator reads
mock.$.emitEvent(createSessionStatusEvent("ses-0001", { type: "busy" }));

// Assertions can be made immediately (no await needed)
expect(client.currentStatus).toBe("busy");
expect(listener).toHaveBeenCalledWith("busy");
```

**Helper Functions**:

| Function                         | Returns       | Description                  |
| -------------------------------- | ------------- | ---------------------------- |
| `createTestSession(overrides)`   | `MockSession` | Create session with defaults |
| `createSessionStatusEvent()`     | `SdkEvent`    | session.status event         |
| `createSessionCreatedEvent()`    | `SdkEvent`    | session.created event        |
| `createSessionIdleEvent()`       | `SdkEvent`    | session.idle event           |
| `createSessionDeletedEvent()`    | `SdkEvent`    | session.deleted event        |
| `createPermissionUpdatedEvent()` | `SdkEvent`    | permission.updated event     |
| `createPermissionRepliedEvent()` | `SdkEvent`    | permission.replied event     |

---

## Test Performance Requirements

**Integration tests MUST be extremely fast.**

Integration tests replace unit tests as the primary feedback mechanism during development. If they're slow, developers will skip running them, and bugs will slip through. The entire point of behavioral mocks is to enable fast tests.

| Scope                          | Target                   | Action if Exceeded                |
| ------------------------------ | ------------------------ | --------------------------------- |
| Single integration test        | <50ms                    | Optimize mock setup, reduce scope |
| Module test file (10-20 tests) | <2 seconds               | Split file, simplify mocks        |
| Full integration suite         | <15 seconds              | Profile bottlenecks, optimize     |
| Boundary tests                 | Excluded from `validate` | Run separately (real I/O is slow) |

**Why speed is non-negotiable**:

- Developers run `pnpm validate` continuously during development
- Slow tests → skipped tests → undetected bugs → defeats the whole strategy
- Integration tests with in-memory behavioral mocks should be **nearly as fast as unit tests**
- If a test is slow, the behavioral mock is doing too much work

**Speed optimization techniques**:

- Create mocks once per test file, reset state in `beforeEach`
- Use shallow copies, not deep clones in mock state
- Keep initial state minimal - only what the specific test needs
- Avoid unnecessary async operations in mocks
- Reuse mock instances when possible, just reset state

**If tests are slow, it's a bug** - fix the mock or the test, don't accept slowness.

### No Timeouts or Delays in Integration Tests

**Integration tests MUST NOT contain timeouts, delays, or artificial waiting.**

Integration tests use behavioral mocks that respond instantly - there are no real systems to wait for. Any timeout or delay indicates the test or mock is incorrectly structured.

**Forbidden patterns**:

```typescript
// ❌ WRONG: Artificial delays
await sleep(100);
await new Promise(resolve => setTimeout(resolve, 100));

// ❌ WRONG: Timeout configurations
it("should work", { timeout: 5000 }, async () => { ... });

// ❌ WRONG: Polling/waiting for state
await waitFor(() => expect(state.ready).toBe(true));
```

**Correct patterns**:

```typescript
// ✅ CORRECT: Behavioral mocks respond immediately
const result = await api.workspaces.create("/project", "feature-1", "main");
expect(result.name).toBe("feature-1");

// ✅ CORRECT: State changes are synchronous in mocks
mockGit.setBranchDirty("/project", "feature-1", true);
const status = await api.workspaces.getStatus("/project", "feature-1");
expect(status.dirty).toBe(true);

// ✅ CORRECT: Events fire immediately in tests
const events: unknown[] = [];
api.on("workspace:created", (data) => events.push(data));
await api.workspaces.create("/project", "feature-1", "main");
expect(events).toHaveLength(1); // No waiting needed
```

**Exception - Fake timers for timeout logic**:

When testing code that has timeout _behavior_ (e.g., "retry after 5 seconds"), use `vi.useFakeTimers()` to test the logic instantly:

```typescript
// ✅ CORRECT: Testing timeout logic with fake timers
it("retries connection after delay", async () => {
  vi.useFakeTimers();
  const connectPromise = client.connectWithRetry();
  await vi.advanceTimersByTimeAsync(5000); // Instant, no real delay
  await connectPromise;
  expect(client.connected).toBe(true);
  vi.useRealTimers();
});
```

Fake timers test timeout _logic_ instantly - real delays test nothing useful.

---

## Test Naming Conventions

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

---

## Targeted Testing

For efficient development feedback, especially when multiple agents are working in parallel, use targeted testing instead of running the full test suite after every change.

### Commands

| Command                          | Purpose                      | Speed   |
| -------------------------------- | ---------------------------- | ------- |
| `pnpm test:related -- <pattern>` | Run tests matching pattern   | ~1-5s   |
| `pnpm validate:quick`            | Format, lint, and type check | ~15s    |
| `pnpm test`                      | Full test suite              | ~30-60s |
| `pnpm build`                     | Build verification           | ~30s    |

### Pattern Examples

```bash
# Single module
pnpm test:related -- src/services/git/

# Component by name
pnpm test:related -- CreateWorkspaceDialog

# Multiple modules
pnpm test:related -- src/services/git/ src/services/platform/

# Specific test file pattern
pnpm test:related -- workspace.integration
```

The `--passWithNoTests` flag ensures the command succeeds even when no tests match (useful for non-test files).

### Tiered Validation Strategy

Use this approach to minimize CPU usage while maintaining quality:

1. **During implementation**: Run `pnpm test:related -- <module>` after each change for fast feedback
2. **After all changes**: Run `pnpm validate:quick` to check format, lint, and types
3. **Before review**: Run `pnpm test` followed by `pnpm build` for complete verification

This is especially important when multiple agents run concurrently, as running `pnpm validate:fix` (which includes the full test suite and build) in parallel causes CPU spikes.

---

## Test Commands

| Command                 | What it runs                | Use case                      |
| ----------------------- | --------------------------- | ----------------------------- |
| `pnpm test`             | All tests                   | Full verification             |
| `pnpm test:related`     | Tests matching pattern      | Fast feedback during dev      |
| `pnpm test:integration` | Integration tests only      | Primary development feedback  |
| `pnpm test:boundary`    | Boundary tests only         | Test external interfaces      |
| `pnpm test:legacy`      | Deprecated unit tests       | Until migrated to integration |
| `pnpm validate:quick`   | Format + lint + types       | Quick validation (~15s)       |
| `pnpm validate`         | Integration + check + build | Pre-commit validation (fast)  |

**Why validate excludes boundary tests**: Boundary tests may be slower, require specific binaries (code-server, opencode), and are only relevant when working on external interface code.

---

## When to Run Tests

| Test Type       | When to Run                                       |
| --------------- | ------------------------------------------------- |
| **Integration** | Continuously during development (`pnpm validate`) |
| **Boundary**    | When developing new/updated external interfaces   |
| **Focused**     | Part of integration suite (fast, pure functions)  |
| **Legacy**      | Temporary - until module is migrated              |

---

## Test Entry Points Reference

Integration tests go through specific entry points, not arbitrary internal modules:

### Main Process Entry Points

| Entry Point          | What It Is               | Modules Exercised                                                                              |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `CodeHydraApi`       | Main application facade  | ProjectStore, GitWorktreeProvider, AgentStatusManager, OpenCodeServerManager, KeepFilesService |
| `LifecycleApi`       | Setup/bootstrap facade   | VscodeSetupService, BinaryDownloadService, WrapperScriptGenerationService                      |
| `CodeServerManager`  | Direct (not via API)     | Just CodeServerManager                                                                         |
| `PluginServer`       | Direct (not via API)     | Just PluginServer                                                                              |
| `McpServerManager`   | Direct (not via API)     | McpServerManager, McpServer                                                                    |
| `ViewManager`        | Direct (mocked Electron) | Just ViewManager                                                                               |
| `WindowManager`      | Direct (mocked Electron) | Just WindowManager                                                                             |
| `BadgeManager`       | Direct (mocked Electron) | Just BadgeManager                                                                              |
| `ShortcutController` | Direct (mocked Electron) | Just ShortcutController                                                                        |

### Why Entry Points Matter

Testing through `CodeHydraApi` means:

- Multiple modules work together (ProjectStore → GitWorktreeProvider → GitClient)
- State flows correctly between modules
- Events are emitted properly
- Error handling works across layers

Testing individual modules in isolation (old unit test approach) misses these interactions.

---

## Test File Organization

Tests are organized by **entry point**, with subgroups for large entry points.

### Main Process Tests

| Entry Point           | Test Location          | Subgroups                    |
| --------------------- | ---------------------- | ---------------------------- |
| **CodeHydraApi**      | `src/main/api/`        | `project`, `workspace`, `ui` |
| **LifecycleApi**      | `src/main/api/`        | `lifecycle` (single file)    |
| **Direct Services**   | `src/services/<name>/` | Per service                  |
| **Electron Managers** | `src/main/managers/`   | Per manager                  |

**CodeHydraApi subgroups** (large API with multiple namespaces):

| File                            | Namespace     | Modules Exercised                     |
| ------------------------------- | ------------- | ------------------------------------- |
| `project.integration.test.ts`   | IProjectApi   | ProjectStore                          |
| `workspace.integration.test.ts` | IWorkspaceApi | GitWorktreeProvider, KeepFilesService |
| `ui.integration.test.ts`        | IUIApi        | ViewManager                           |

### Renderer Tests

| Entry Point    | Test Location                                                | Strategy                       |
| -------------- | ------------------------------------------------------------ | ------------------------------ |
| **App**        | `src/renderer/App.integration.test.ts`                       | Top-level routing, mode switch |
| **MainView**   | `src/renderer/lib/components/MainView.integration.test.ts`   | Main view after setup          |
| **Sidebar**    | `src/renderer/lib/components/Sidebar.integration.test.ts`    | Project/workspace list         |
| **Dialogs**    | `src/renderer/lib/components/dialogs.integration.test.ts`    | All dialog components          |
| **Dropdowns**  | `src/renderer/lib/components/dropdowns.integration.test.ts`  | Branch, project dropdowns      |
| **Setup**      | `src/renderer/lib/components/setup.integration.test.ts`      | Setup flow components          |
| **Indicators** | `src/renderer/lib/components/indicators.integration.test.ts` | Status indicators, overlays    |
| **Primitives** | `src/renderer/lib/components/primitives.integration.test.ts` | Icon, Logo, EmptyState         |

---

## Renderer Testing Strategy

### Stores: Test Through Components

Stores exist to serve components. Testing stores in isolation often leads to "tests mirror implementation". Instead, test the **behavior the user sees** through component integration tests.

| Store               | Test Through     | Rationale                             |
| ------------------- | ---------------- | ------------------------------------- |
| `projects`          | Sidebar          | Sidebar displays projects/workspaces  |
| `agent-status`      | Sidebar          | Sidebar shows agent status indicators |
| `shortcuts`         | App              | App handles shortcut mode             |
| `dialogs`           | Dialog tests     | Each dialog manages its own state     |
| `setup`             | Setup components | Setup screen shows progress           |
| `deletion`          | MainView         | MainView handles deletion flow        |
| `ui-mode`           | App              | App switches between setup/normal     |
| `workspace-loading` | MainView         | MainView shows loading overlay        |

### Utils: Split by Purity

| Category                 | Test Type                  | Examples                                                     |
| ------------------------ | -------------------------- | ------------------------------------------------------------ |
| **Pure utils** (no deps) | Focused test (`*.test.ts`) | focus-trap, sidebar-utils, domain-events                     |
| **Utils that wire API**  | Component integration test | initialize-app → App, setup-domain-event-bindings → MainView |

### Component Grouping

Group related components into single integration test files to reduce boilerplate:

| Test File                        | Components                                                               |
| -------------------------------- | ------------------------------------------------------------------------ |
| `dialogs.integration.test.ts`    | CreateWorkspaceDialog, CloseProjectDialog, RemoveWorkspaceDialog, Dialog |
| `dropdowns.integration.test.ts`  | BranchDropdown, ProjectDropdown, FilterableDropdown                      |
| `setup.integration.test.ts`      | SetupScreen, SetupComplete, SetupError                                   |
| `indicators.integration.test.ts` | AgentStatusIndicator, WorkspaceLoadingOverlay, ShortcutOverlay           |
| `primitives.integration.test.ts` | Icon, Logo, EmptyState, DeletionProgressView                             |

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
```

**Use for**: API-level tests (CodeHydraApi, LifecycleApi) that exercise multiple modules.

### Usage in Tests

```typescript
// API-level test using fixture
const { api, mocks } = createTestFixture({
  projects: [{ path: "/my-app", branches: ["main", "develop"] }],
});

// Type-safe assertions on mocks
expect(mocks.gitClient).toHaveWorktree("feature-1");

// Reset all mocks between tests
afterEach(() => {
  Object.values(mocks).forEach((mock) => mock.$.reset());
});
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

---

## Integration Test Example

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
      dirs: new Set(["/projects/my-app", "/data"]),
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

      // Type-safe mock assertion
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

## Module Migration Process

Each module migration from unit tests to integration tests requires a **separate plan** with **user review**.

### Migration Plan Template

```markdown
# <MODULE_NAME>\_MIGRATION

## Module Overview

**Current State**:

- Unit test file(s): `module.test.ts` (X tests)
- Integration test file(s): `module.integration.test.ts` (if exists - also needs migration!)
- What it tests: [description]
- Entry point for integration: [CodeHydraApi / LifecycleApi / Direct / Component]

## Proposed Integration Tests

| #   | Test Case | Entry Point                        | Boundary Mocks        | Behavior Verified                  |
| --- | --------- | ---------------------------------- | --------------------- | ---------------------------------- |
| 1   | ...       | `CodeHydraApi.workspaces.create()` | GitClient, FileSystem | `project.workspaces.contains(...)` |
| 2   | ...       | ...                                | ...                   | ...                                |

## Boundary Mock Requirements

| Interface       | Exists? | Changes Needed               |
| --------------- | ------- | ---------------------------- |
| IGitClient      | Yes     | Add `setDirtyState()` method |
| FileSystemLayer | Yes     | None                         |

## Unit Tests to Delete

(All unit tests have been migrated to integration tests and deleted.)

## Questions for User Review

1. Are these integration tests sufficient to cover the module behavior?
2. Any edge cases or error scenarios missing?
3. Do any boundary mocks need refactoring?

**USER APPROVAL REQUIRED BEFORE IMPLEMENTATION**
```

### Important: Existing Integration Tests Also Need Migration

Current `*.integration.test.ts` files use **call-tracking mocks**, not **behavioral mocks**. They must also be migrated to the new pattern during module migration.

---

## Test Helpers

### General Helpers

All general helpers are in `src/services/test-utils.ts`.

### createTestGitRepo(options?)

Creates a temporary git repository for testing.

- **Returns**: `{ path: string, cleanup: () => Promise<void> }`
- **Options**:
  - `detached?: boolean` - Create in detached HEAD state
  - `dirty?: boolean` - Add uncommitted changes

### createTempDir()

Creates a temporary directory for testing.

- **Returns**: `{ path: string, cleanup: () => Promise<void> }`

### withTempRepo(fn)

Convenience wrapper that handles cleanup automatically, even on test failure.

```typescript
it("should work with repo", async () => {
  await withTempRepo(async (repoPath) => {
    // Test code here
    // Cleanup happens automatically
  });
});
```

### withTempDir(fn)

Convenience wrapper for temporary directories with automatic cleanup.

### createTestGitRepoWithRemote()

Creates a git repository with a local bare remote configured as `origin`.

- **Returns**: `{ path: string, remotePath: string, cleanup: () => Promise<void> }`

### withTempRepoWithRemote(fn)

Convenience wrapper for repos with remotes that handles cleanup automatically.

### Boundary Test Utilities

Cross-platform process spawning utilities for boundary tests. All utilities are in `src/services/platform/process.boundary-test-utils.ts`.

See [AGENTS.md Boundary Test Utilities](#boundary-test-utilities) for detailed documentation.

---

## Async Testing Patterns

### Always Return Promises

```typescript
it("should load projects", async () => {
  const result = await store.listProjects();
  expect(result).toHaveLength(2);
});
```

### Use Fake Timers for Timeouts

```typescript
it("should retry after delay", async () => {
  vi.useFakeTimers();

  const promise = client.connectWithRetry();
  await vi.advanceTimersByTimeAsync(1000);

  await promise;
  vi.useRealTimers();
});
```

---

## Test Quality Guidelines

### Arrange-Act-Assert (AAA) Pattern

```typescript
it("should return sum of numbers", () => {
  // Arrange
  const numbers = [1, 2, 3];

  // Act
  const result = sum(numbers);

  // Assert
  expect(result).toBe(6);
});
```

### Test Isolation

- No shared mutable state between tests
- Each test sets up its own fixtures
- Use `beforeEach` for common setup, not shared variables
- Always clean up resources in `afterEach`

### One Logical Assertion Per Test

```typescript
// Good: focused assertion
it("should set workspace as active", async () => {
  await manager.switchWorkspace(workspacePath);
  expect(manager.activeWorkspace).toBe(workspacePath);
});

// Avoid: multiple unrelated assertions
it("should switch workspace", async () => {
  await manager.switchWorkspace(workspacePath);
  expect(manager.activeWorkspace).toBe(workspacePath);
  expect(manager.views.size).toBe(1); // Separate concern
  expect(emitSpy).toHaveBeenCalled(); // Separate concern
});
```

---

## Test Anti-Patterns

These patterns lead to fragile tests, unclear failures, or maintenance burden. Avoid them.

### Rule 1: No Reset → beforeEach Creates

**Current pattern (problematic):**

```typescript
const { mockGit } = vi.hoisted(() => ({
  mockGit: { createWorktree: vi.fn() }
}));

beforeEach(() => {
  vi.clearAllMocks();  // Reset shared mocks
  mockGit.createWorktree.mockResolvedValue({...});
});
```

**New pattern:**

```typescript
beforeEach(() => {
  // Create fresh mocks each test - no reset needed
  gitClient = createMockGitClient({
    repositories: { "/project": { branches: ["main"] } },
  });
});
```

**Rationale:** Fresh mocks per test eliminate state leakage and make tests more predictable. If you need to reset, you're sharing state.

---

### Rule 2: No Direct State Access for Assertions

**Current pattern (problematic):**

```typescript
expect(mock.$.entries.has("/data/config.json")).toBe(true);
expect(mock.$.sessions.size).toBe(2);
```

**New pattern:**

```typescript
expect(mock).toHaveFile("/data/config.json");
expect(mock).toHaveSession("ses-0001");
expect(mock).toHaveSession("ses-0002");
```

**Rationale:** Custom matchers provide better error messages, encapsulate state structure, and are more resilient to mock implementation changes. The `$` property is for triggering actions (like `$.emitEvent()`), not for assertions.

---

### Rule 3: No Tests for Test Infrastructure

**Rule:** Do not write tests specifically for mock implementations, test helpers, or test utilities.

**Rationale:**

- Mocks are validated indirectly through the integration tests that use them
- Boundary tests define the contracts mocks must follow
- Testing test infrastructure is self-referential and adds maintenance burden

**Exception:** If a helper function has complex logic (like `createTestGitRepo`), it may warrant focused tests.

---

### Rule 4: Use Factory Functions, Not Setup Methods

**Current pattern (problematic):**

```typescript
let mock: MockGitClient;

beforeEach(() => {
  mock = createMockGitClient();
  mock.addRepository("/project"); // Setup method
  mock.setBranches(["main", "dev"]); // Setup method
  mock.setCurrentBranch("main"); // Setup method
});
```

**New pattern:**

```typescript
beforeEach(() => {
  mock = createMockGitClient({
    repositories: {
      "/project": {
        branches: ["main", "dev"],
        currentBranch: "main",
      },
    },
  });
});
```

**Rationale:** Factory functions with configuration objects are:

- Declarative (describe desired state, not steps to reach it)
- Immutable (can't accidentally modify after creation)
- Self-documenting (all config visible at once)
- Easier to compose (spread options, merge configs)

---

### Rule 5: Explicit Expectations, Not Call Counts

**Current pattern (problematic):**

```typescript
expect(mockServer.stop).toHaveBeenCalledTimes(1);
expect(mockApi.fetch).toHaveBeenCalledTimes(3);
```

**New pattern:**

```typescript
expect(mockServer).toBeStopped();
expect(runner).toHaveSpawned([{ command: "code-server", cwd: "/workspace" }]);
```

**Rationale:**

- Call counts verify implementation, not behavior
- "Called 3 times" doesn't explain _why_ 3 times
- Explicit matchers verify the actual outcome
- Tests are more resilient to refactoring (e.g., batching calls)

---

## Efficient Coverage Workflow

For AI agent implementation work, use efficient coverage instead of strict TDD.

### For New Features/Code

1. **IMPLEMENT**: Write implementation code and corresponding tests together
2. **VALIDATE**: After completing all implementation steps, run `pnpm validate:fix`
3. **FIX**: Address any failures from batch validation

### For Bug Fixes (Cleanup Phase)

1. **FIX**: Apply the code fix
2. **COVER**: Ensure a test covers the fixed behavior (add if missing)
3. **VALIDATE**: Run `pnpm validate:fix`
