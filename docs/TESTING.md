# Testing Strategy

## Overview

CodeHydra uses behavior-driven testing with vitest. Tests verify **behavior** through high-level entry points, not implementation details. External system access is mocked using **behavioral simulators** with in-memory state.

## Quick Reference

| Task                      | Command                    | Section                                             |
| ------------------------- | -------------------------- | --------------------------------------------------- |
| Run all tests             | `npm test`                 | [Test Commands](#test-commands)                     |
| Run integration tests     | `npm run test:integration` | [Test Commands](#test-commands)                     |
| Run boundary tests        | `npm run test:boundary`    | [Test Commands](#test-commands)                     |
| Run deprecated unit tests | `npm run test:legacy`      | [Test Commands](#test-commands)                     |
| Pre-commit validation     | `npm run validate`         | [Test Commands](#test-commands)                     |
| Decide which test type    | See decision guide         | [Decision Guide](#decision-guide)                   |
| Create test git repo      | `createTestGitRepo()`      | [Test Helpers](#test-helpers)                       |
| Create behavioral mock    | `createBehavioralX()`      | [Behavioral Mock Pattern](#behavioral-mock-pattern) |

---

## Test Types

### Boundary Tests (\*.boundary.test.ts)

**Purpose**: Verify boundary interfaces work correctly with real external systems.

**When to write**: When creating or modifying a boundary interface (external system wrapper).

**What to mock**: NOTHING - tests hit real Git, real filesystem, real HTTP.

**Boundaries**: IGitClient, FileSystemLayer, ProcessRunner, HttpClient, PortManager, ArchiveExtractor, SdkClientFactory

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

---

### Integration Tests (\*.integration.test.ts)

**Purpose**: Verify application behavior through high-level entry points.

**When to write**: All feature code, business logic, UI components.

**What to mock**: Only boundary interfaces, using **behavioral simulators**.

**Entry points**: CodeHydraApi, LifecycleApi, service classes (direct), UI components.

**Key characteristics**:

- Tests behavior, not implementation ("when user does X, outcome is Y")
- Real module interaction (AppState, ProjectStore, GitWorktreeProvider all run together)
- Only mock boundaries (same interfaces tested by boundary tests)
- **MUST be fast** - target <50ms per test, <2s per module

#### Why This Approach?

Traditional unit tests mock everything except the single module under test. This creates problems:

1. **Tests mirror implementation** - Change the code, change the mocks
2. **No behavior verification** - Tests check "did you call X?" not "does feature Y work?"
3. **False confidence** - All tests pass, but bugs exist in how modules interact

Integration tests solve this by:

1. **Testing behavior** - "When user does X, outcome is Y"
2. **Real module interaction** - AppState, ProjectStore, GitWorktreeProvider all run together
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

**Command**: `npm run test:legacy`

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
| Module is public API                          | `CodeHydraApi` or `LifecycleApi`   | AppState, ProjectStore                  |
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
// This tests actual behavior
const mockGit = createBehavioralGitClient({
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

### State Inspection

Behavioral mocks should expose state inspection utilities:

```typescript
const mockFs = createBehavioralFileSystem({ files: new Map() });
await mockFs.writeFile("/data/config.json", '{"key": "value"}');

// Direct state inspection
expect(mockFs._getState().files.has("/data/config.json")).toBe(true);
```

### Cross-Platform Requirements

Behavioral mocks must handle platform differences:

```typescript
function createBehavioralFileSystem(options?: {
  files?: Map<string, string | Buffer>;
  directories?: Set<string>;
}): FileSystemLayer {
  const files = new Map(options?.files ?? []);
  const dirs = new Set(options?.directories ?? []);

  // Normalize paths for cross-platform compatibility
  const normalizePath = (p: string) => path.normalize(p);

  return {
    async readFile(filePath, encoding) {
      const normalized = normalizePath(filePath);
      const content = files.get(normalized);
      if (!content) {
        const error = new Error(`ENOENT: no such file: ${filePath}`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return encoding ? content.toString() : content;
    },
    // ... other methods with path normalization
    _getState: () => ({ files: new Map(files), dirs: new Set(dirs) }),
  };
}
```

**Key requirements**:

- Use `path.join()` for path construction
- Use `path.normalize()` for path comparison
- Throw errors with correct `code` property (ENOENT, EEXIST, etc.)

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

- Developers run `npm run validate` continuously during development
- Slow tests → skipped tests → undetected bugs → defeats the whole strategy
- Integration tests with in-memory behavioral mocks should be **nearly as fast as unit tests**
- If a test is slow, the behavioral mock is doing too much work

**Speed optimization techniques**:

- Create mocks once per test file, reset state in `beforeEach`
- Use shallow copies, not deep clones in mock state
- **Never add artificial delays** (`await sleep()`) in mocks
- Keep initial state minimal - only what the specific test needs
- Avoid unnecessary async operations in mocks
- Reuse mock instances when possible, just reset state

**If tests are slow, it's a bug** - fix the mock or the test, don't accept slowness.

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

## Test Commands

| Command                    | What it runs                | Use case                      |
| -------------------------- | --------------------------- | ----------------------------- |
| `npm test`                 | All tests                   | Full verification             |
| `npm run test:integration` | Integration tests only      | Primary development feedback  |
| `npm run test:boundary`    | Boundary tests only         | Test external interfaces      |
| `npm run test:legacy`      | Deprecated unit tests       | Until migrated to integration |
| `npm run validate`         | Integration + check + build | Pre-commit validation (fast)  |

**Why validate excludes boundary tests**: Boundary tests may be slower, require specific binaries (code-server, opencode), and are only relevant when working on external interface code.

---

## When to Run Tests

| Test Type       | When to Run                                          |
| --------------- | ---------------------------------------------------- |
| **Integration** | Continuously during development (`npm run validate`) |
| **Boundary**    | When developing new/updated external interfaces      |
| **Focused**     | Part of integration suite (fast, pure functions)     |
| **Legacy**      | Temporary - until module is migrated                 |

---

## Test Entry Points Reference

Integration tests go through specific entry points, not arbitrary internal modules:

### Main Process Entry Points

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

### Why Entry Points Matter

Testing through `CodeHydraApi` means:

- Multiple modules work together (AppState → GitWorktreeProvider → GitClient)
- State flows correctly between modules
- Events are emitted properly
- Error handling works across layers

Testing individual modules in isolation (old unit test approach) misses these interactions.

---

## Common Test Fixture Helper

For reducing boilerplate, use a shared fixture helper:

```typescript
// test-fixtures.ts
export function createTestFixture(options?: {
  projects?: Array<{ path: string; branches: string[]; worktrees?: string[] }>;
  files?: Map<string, string>;
}) {
  const gitClient = createBehavioralGitClient({
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

  const fileSystem = createBehavioralFileSystem({
    files: options?.files ?? new Map(),
  });

  const api = createCodeHydraApi({
    gitClient,
    fileSystem,
    processRunner: createBehavioralProcessRunner(),
    httpClient: createBehavioralHttpClient(),
    portManager: createBehavioralPortManager(),
  });

  return { api, gitClient, fileSystem };
}

// Usage in tests
const { api } = createTestFixture({
  projects: [{ path: "/my-app", branches: ["main", "develop"] }],
});
```

---

## Integration Test Example

```typescript
// codehydra-api.integration.test.ts

describe("CodeHydraApi - Workspace Management", () => {
  let api: ICodeHydraApi;
  let gitClient: IGitClient;
  let fileSystem: FileSystemLayer;

  beforeEach(() => {
    // Create behavioral mocks with initial state
    gitClient = createBehavioralGitClient({
      repositories: new Map([
        ["/projects/my-app", { branches: ["main", "develop", "feature/old"], worktrees: [] }],
      ]),
    });

    fileSystem = createBehavioralFileSystem({
      files: new Map([
        ["/projects/my-app/.git/config", "[core]\n..."],
        ["/data/projects.json", "[]"],
      ]),
      directories: new Set(["/projects/my-app", "/data"]),
    });

    // Create real API with behavioral mocks injected
    api = createCodeHydraApi({
      gitClient,
      fileSystem,
      processRunner: createBehavioralProcessRunner(),
      httpClient: createBehavioralHttpClient(),
      portManager: createBehavioralPortManager(),
    });
  });

  describe("workspace creation", () => {
    it("creates workspace and adds it to project", async () => {
      await api.projects.open("/projects/my-app");
      const workspace = await api.workspaces.create("/projects/my-app", "feature-login", "main");

      expect(workspace.name).toBe("feature-login");
      expect(workspace.branch).toBe("feature-login");
      expect(workspace.baseBranch).toBe("main");

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

| File                | Test Count | Coverage Moved To       |
| ------------------- | ---------- | ----------------------- |
| `app-state.test.ts` | 25         | Integration tests #1-10 |

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

## Efficient Coverage Workflow

For AI agent implementation work, use efficient coverage instead of strict TDD.

### For New Features/Code

1. **IMPLEMENT**: Write implementation code and corresponding tests together
2. **VALIDATE**: After completing all implementation steps, run `npm run validate:fix`
3. **FIX**: Address any failures from batch validation

### For Bug Fixes (Cleanup Phase)

1. **FIX**: Apply the code fix
2. **COVER**: Ensure a test covers the fixed behavior (add if missing)
3. **VALIDATE**: Run `npm run validate:fix`
