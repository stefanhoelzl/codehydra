---
status: COMPLETED
last_updated: 2025-12-27
reviewers: [review-testing, review-docs, review-arch]
---

# BEHAVIOR_DRIVEN_TESTING

## Overview

- **Problem**: Current unit tests don't catch real bugs. They heavily mock dependencies and verify implementation calls methods, not that behavior is correct. When code changes, AI agents update mocks to match - tests pass but bugs slip through.
- **Solution**: Replace unit tests with behavior-driven integration tests. Test through high-level entry points (CodeHydraApi, LifecycleApi, UI components). Mock only boundary interfaces with behavioral simulators that have in-memory state.
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
│  │  - createBehavioralGitClient()                                         │ │
│  │  - createBehavioralFileSystem()                                        │ │
│  │  - createBehavioralProcessRunner()                                     │ │
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

### What Do They Test?

| Boundary Interface             | External System        | What's Tested                                               |
| ------------------------------ | ---------------------- | ----------------------------------------------------------- |
| `IGitClient` (SimpleGitClient) | Git CLI via simple-git | Creating worktrees, listing branches, detecting dirty state |
| `FileSystemLayer`              | Node.js fs module      | Reading, writing, directory operations, error handling      |
| `ProcessRunner`                | execa process spawning | Spawning processes, capturing output, killing processes     |
| `HttpClient`                   | fetch API              | HTTP requests, status codes, error responses                |
| `PortManager`                  | Node.js net module     | Port availability checking                                  |
| `ArchiveExtractor`             | tar/unzipper libraries | Extracting zip and tar.gz archives                          |
| `SdkClientFactory`             | @opencode-ai/sdk       | SSE connections, event parsing                              |

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

| Mock                              | Replaces          | Why Mocked                        |
| --------------------------------- | ----------------- | --------------------------------- |
| `createBehavioralGitClient()`     | `IGitClient`      | Can't run real Git in fast tests  |
| `createBehavioralFileSystem()`    | `FileSystemLayer` | Need controlled file state        |
| `createBehavioralProcessRunner()` | `ProcessRunner`   | Can't spawn real processes        |
| `createBehavioralHttpClient()`    | `HttpClient`      | Can't hit real servers            |
| `createBehavioralPortManager()`   | `PortManager`     | Need controlled port availability |

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
    const gitClient = createBehavioralGitClient({
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

### Cross-Platform Behavioral Mock Requirements

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

    async writeFile(filePath, content) {
      const normalized = normalizePath(filePath);
      files.set(normalized, typeof content === "string" ? content : Buffer.from(content));
    },

    async mkdir(dirPath, options) {
      const normalized = normalizePath(dirPath);
      if (options?.recursive) {
        // Add all parent directories
        let current = normalized;
        while (current !== path.dirname(current)) {
          dirs.add(current);
          current = path.dirname(current);
        }
      }
      dirs.add(normalized);
    },

    // State inspection for assertions
    _getState: () => ({ files: new Map(files), dirs: new Set(dirs) }),
  };
}
```

**Key requirements**:

- Use `path.join()` for path construction
- Use `path.normalize()` for path comparison
- Support both `/` and `\` separators in assertions
- Throw errors with correct `code` property (ENOENT, EEXIST, etc.)

### Behavioral Mock State Inspection

For cleaner test assertions, behavioral mocks should expose state inspection utilities:

```typescript
// Mock provides state inspection
const mockFs = createBehavioralFileSystem({ files: new Map() });
await mockFs.writeFile("/data/config.json", '{"key": "value"}');

// Direct state inspection
expect(mockFs._getState().files.has("/data/config.json")).toBe(true);

// Or use helper functions for readability
function expectFileExists(mockFs: BehavioralFileSystem, path: string) {
  const state = mockFs._getState();
  expect(state.files.has(path) || state.dirs.has(path)).toBe(true);
}

expectFileExists(mockFs, "/data/config.json");
```

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

**Speed optimization techniques**:

- Create mocks once per test file, reset state in `beforeEach`
- Use shallow copies, not deep clones in mock state
- **Never add artificial delays** (`await sleep()`) in mocks
- Keep initial state minimal - only what the specific test needs
- Avoid unnecessary async operations in mocks
- Reuse mock instances when possible, just reset state

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

#### Why Entry Points Matter

Testing through `CodeHydraApi` means:

- Multiple modules work together (AppState → GitWorktreeProvider → GitClient)
- State flows correctly between modules
- Events are emitted properly
- Error handling works across layers

Testing individual modules in isolation (old unit test approach) misses these interactions.

### Common Test Fixture Helper

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

### Integration Test Example

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

Each module migration requires a **separate plan** with **user review**.

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

⚠️ **USER APPROVAL REQUIRED BEFORE IMPLEMENTATION**
```

### Important: Existing Integration Tests Also Need Migration

Current `*.integration.test.ts` files use **call-tracking mocks**, not **behavioral mocks**. They must also be migrated to the new pattern during module migration.

### Migration Priority

| Phase | Module                                     | Priority | Reason                  |
| ----- | ------------------------------------------ | -------- | ----------------------- |
| 2     | CodeHydraApi + AppState                    | High     | Core business logic     |
| 3     | LifecycleApi + VscodeSetupService          | High     | User-facing setup flow  |
| 4     | ViewManager, WindowManager, BadgeManager   | Medium   | Electron integration    |
| 5     | UI Components (Sidebar, Dialogs, etc.)     | Medium   | User interactions       |
| 6     | CodeServerManager, PluginServer, McpServer | Low      | Internal infrastructure |

## Module Migration Checklist

All modules with unit tests that need migration. Mark checkbox when that module's separate migration plan is completed.

**Phase 2: CodeHydraApi + AppState (High Priority)**

- [ ] AppState (`src/main/app-state.test.ts`)
- [ ] CodeHydraApi (`src/main/api/codehydra-api.test.ts`)
- [ ] ProjectStore (`src/services/project/project-store.test.ts`)
- [ ] GitWorktreeProvider (`src/services/git/git-worktree-provider.test.ts`)
- [ ] KeepFilesService (`src/services/keepfiles/*.test.ts`)

**Phase 3: LifecycleApi + Setup (High Priority)**

- [ ] LifecycleApi (`src/main/api/lifecycle-api.test.ts`)
- [ ] VscodeSetupService (`src/services/vscode-setup/vscode-setup-service.test.ts`)
- [ ] BinaryDownloadService (`src/services/binary-download/*.test.ts`)
- [ ] extension-utils (`src/services/vscode-setup/extension-utils.test.ts`)
- [ ] bin-scripts (`src/services/vscode-setup/bin-scripts.test.ts`)
- [ ] wrapper-script-generation-service (`src/services/vscode-setup/wrapper-script-generation-service.test.ts`)

**Phase 4: Electron Managers (Medium Priority)**

- [ ] ViewManager (`src/main/managers/view-manager.test.ts`)
- [ ] WindowManager (`src/main/managers/window-manager.test.ts`)
- [ ] BadgeManager (`src/main/managers/badge-manager.test.ts`)
- [ ] ShortcutController (`src/main/shortcut-controller.test.ts`)
- [ ] ElectronAppApi (`src/main/managers/electron-app-api.test.ts`)

**Phase 5: UI Components (Medium Priority)**

- [ ] App.svelte (`src/renderer/App.test.ts`)
- [ ] MainView (`src/renderer/lib/components/MainView.test.ts`)
- [ ] Sidebar (`src/renderer/lib/components/Sidebar.test.ts`)
- [ ] BranchDropdown (`src/renderer/lib/components/BranchDropdown.test.ts`)
- [ ] CreateWorkspaceDialog (`src/renderer/lib/components/CreateWorkspaceDialog.test.ts`)
- [ ] CloseProjectDialog (`src/renderer/lib/components/CloseProjectDialog.test.ts`)
- [ ] ProjectDropdown (`src/renderer/lib/components/ProjectDropdown.test.ts`)
- [ ] Dialog (`src/renderer/lib/components/Dialog.test.ts`)
- [ ] ShortcutOverlay (`src/renderer/lib/components/ShortcutOverlay.test.ts`)
- [ ] SetupScreen, SetupComplete, SetupError (`src/renderer/lib/components/Setup*.test.ts`)
- [ ] DeletionProgressView (`src/renderer/lib/components/DeletionProgressView.test.ts`)
- [ ] AgentStatusIndicator (`src/renderer/lib/components/AgentStatusIndicator.test.ts`)
- [ ] Stores (projects, agent-status, shortcuts, dialogs, setup, deletion, ui-mode)

**Phase 6: Internal Services (Low Priority)**

- [ ] CodeServerManager (`src/services/code-server/code-server-manager.test.ts`)
- [ ] OpenCodeServerManager (`src/services/opencode/opencode-server-manager.test.ts`)
- [ ] OpenCodeClient (`src/services/opencode/opencode-client.test.ts`)
- [ ] AgentStatusManager (`src/services/opencode/agent-status-manager.test.ts`)
- [ ] PluginServer (`src/services/plugin-server/plugin-server.test.ts`)
- [ ] startup-commands, shutdown-commands (`src/services/plugin-server/*.test.ts`)
- [ ] McpServerManager (`src/services/mcp-server/mcp-server-manager.test.ts`)
- [ ] McpServer, tools, config-generator, workspace-resolver (`src/services/mcp-server/*.test.ts`)

**Phase 7: IPC Handlers (Low Priority)**

- [ ] api-handlers (`src/main/ipc/api-handlers.test.ts`)
- [ ] lifecycle-handlers (`src/main/ipc/lifecycle-handlers.test.ts`)
- [ ] log-handlers (`src/main/ipc/log-handlers.test.ts`)

**Phase 8: Platform & Utilities (Keep as Focused Tests)**

- [ ] Review: paths, PathProvider, PlatformInfo, BuildInfo (may remain as focused tests for pure functions)
- [ ] Review: id-utils, errors (may remain as focused tests)
- [ ] Review: shared/ipc, shortcuts, plugin-protocol (may remain as focused tests)

---

## Implementation Steps

- [x] **Step 1: Rewrite docs/TESTING.md**
  - **Source material**: Use the detailed explanation sections from this plan as the basis
  - **Structure**: Overview, Test Types (Boundary/Integration/UI/Focused), Decision Guide, Behavioral Mock Pattern, Test Entry Points, Cross-Platform Requirements, Test Performance, Module Migration Process, Examples, Test Helpers
  - Document boundary tests: purpose, relationship to behavioral mocks, examples
  - Document integration tests: purpose, entry points, behavioral mock pattern, side-by-side migration example
  - Document UI test categories: API-call, UI-state, Pure-UI with examples
  - Document focused tests: when pure functions can keep simple tests
  - Document behavioral mock verification strategy (mocks must match boundary test assertions)
  - Document cross-platform requirements (path.join, path.normalize)
  - Document test entry point selection guide
  - Document test naming conventions (behavior, not implementation)
  - **Document test performance requirements** (tests MUST be fast, targets, optimization techniques)
  - Document common test fixture helper pattern
  - Mark unit tests as **deprecated** (not deleted) - they remain until migrated
  - Update test commands (keep `test:legacy` for deprecated unit tests)
  - Update decision guide for test types
  - Files affected: `docs/TESTING.md`

- [x] **Step 2: Update AGENTS.md testing section**
  - Update "Testing Requirements" quick reference - mark unit tests as deprecated
  - Update test commands table:
    - Keep `npm run test:legacy` for deprecated unit tests
    - `npm run validate` runs integration tests only (excluding boundary for speed)
  - Update "When to Run Tests" guidance for test types
  - Update code change → test type mapping table
  - Mark unit test examples as deprecated with migration note
  - **Emphasize that integration tests must be fast** for development feedback
  - Files affected: `AGENTS.md`

- [x] **Step 3: Update feature agent plan template**
  - Replace Testing Strategy section with new format
  - Add Integration Tests table with columns: #, Test Case, Entry Point, Boundary Mocks, Behavior Verified
  - Add UI Integration Tests table with columns: #, Test Case, Category, Entry Point, Behavior Verified
  - Update Boundary Tests section (only for new external interfaces)
  - Add Focused Tests section (only for pure utility functions)
  - Remove Unit Tests section (mark as deprecated in guidance)
  - Add guidance on specifying behavior verified as pseudo-assertions
  - Files affected: `.opencode/agent/feature.md`

- [x] **Step 4: Rewrite review-testing agent**
  - Remove unit test review criteria (mark as deprecated)
  - Add integration test review criteria:
    - Appropriate entry point used? (see Entry Point Selection Guide)
    - Behavioral mocks specified (not call-tracking)?
    - Behavior verified as outcomes (not implementation calls)?
    - All scenarios covered (happy path, errors, edge cases)?
    - Cross-platform considerations addressed?
    - **Tests are fast?** (no artificial delays, minimal mock state, efficient setup)
  - Add UI test review criteria:
    - Correct category (API-call, UI-state, Pure-UI)?
    - Entry point includes component + action?
  - Add boundary test review criteria:
    - Only for new/modified external interfaces?
    - No mocks in boundary tests?
    - Do behavioral mocks match boundary test assertions?
  - Add focused test review criteria:
    - Only for pure functions with no external dependencies?
  - Update severity definitions for new criteria
  - **Add "slow tests" as a Critical issue** - tests must be fast for development workflow
  - Files affected: `.opencode/agent/review-testing.md`

- [x] **Step 5: Update implementation-review agent**
  - Update verification checklist:
    - New code uses `*.integration.test.ts` or `*.boundary.test.ts` (not `*.test.ts`)
    - Behavioral mocks used (not call-tracking)
    - Tests verify outcomes (not implementation calls)
    - Correct entry points used
    - Cross-platform paths use path.join/path.normalize
    - Behavioral mock behavior matches boundary test assertions
    - **Tests run fast** (no delays, efficient mocks)
  - Remove unit test file naming checks for new code
  - Add check for behavioral mock usage
  - Files affected: `.opencode/agent/implementation-review.md`

- [x] **Step 6: Update package.json test scripts**
  - Rename `test:unit` to `test:legacy` with deprecation comment
  - Update `npm run validate` to run integration tests only (excluding boundary)
  - Ensure `npm test` still runs all tests (legacy + integration + boundary)
  - Add script comments explaining the transition
  - Files affected: `package.json`
  - **Note**: Final cleanup (removing `test:legacy` from `validate`, removing deprecated scripts) will happen AFTER all modules in the Module Migration Checklist have been migrated. Keep scripts as-is during transition to maintain CI stability.

## Testing Strategy

_No new tests in Phase 1 - this plan updates documentation and agent prompts only._

### Manual Testing Checklist

- [ ] docs/TESTING.md has correct structure (Overview, Test Types, Decision Guide, etc.)
- [ ] docs/TESTING.md accurately describes boundary test purpose and relationship to behavioral mocks
- [ ] docs/TESTING.md accurately describes integration test purpose, entry points, behavioral mocks
- [ ] docs/TESTING.md includes side-by-side migration example
- [ ] docs/TESTING.md documents cross-platform requirements
- [ ] docs/TESTING.md documents test entry point selection guide
- [ ] docs/TESTING.md includes test naming conventions
- [ ] docs/TESTING.md includes test performance requirements and optimization techniques
- [ ] docs/TESTING.md accurately describes UI test categories with examples
- [ ] AGENTS.md marks unit tests as deprecated, keeps test:legacy command
- [ ] AGENTS.md emphasizes fast integration tests
- [ ] Feature agent plan template uses new Testing Strategy format with # column
- [ ] review-testing agent reviews for behavioral mocks, outcome assertions, and test speed
- [ ] implementation-review agent checklist matches new strategy including speed check
- [ ] `npm test` runs without errors (includes legacy tests)
- [ ] `npm run validate:fix` works correctly (integration only)
- [ ] `npm run test:legacy` runs deprecated unit tests

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File                                       | Changes Required                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `docs/TESTING.md`                          | Complete rewrite - use this plan's sections as source material               |
| `AGENTS.md`                                | Mark unit tests as deprecated, update test commands, emphasize speed         |
| `.opencode/agent/feature.md`               | New Testing Strategy section with # column, entry points, behavior verified  |
| `.opencode/agent/review-testing.md`        | Complete rewrite - behavioral mock criteria, outcome assertions, speed check |
| `.opencode/agent/implementation-review.md` | Update verification checklist for integration-only new code, speed check     |
| `package.json`                             | Rename `test:unit` to `test:legacy`, update `validate` to integration only   |

### New Documentation Required

| File | Purpose                       |
| ---- | ----------------------------- |
| None | All updates to existing files |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] `npm test` passes (including legacy tests)
- [ ] Documentation accurately reflects new testing strategy
- [ ] Agent prompts updated with new review criteria including speed requirements
- [ ] Examples in TESTING.md are syntactically correct
- [ ] All module migration plans in Module Migration Checklist completed (prerequisite for final package.json cleanup)
- [ ] User acceptance testing passed
- [ ] Changes committed
