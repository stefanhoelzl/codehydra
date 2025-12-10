# Testing Strategy

## Overview

This document defines the testing strategy for CodeHydra. All tests use vitest.

## TDD Workflow

For unit and integration tests, follow the red-green-refactor cycle:

1. **RED**: Write a failing test first
   - Test describes the desired behavior
   - Run test → it should FAIL (no implementation yet)

2. **GREEN**: Write minimal code to pass the test
   - Only write enough code to make the test pass
   - Run test → it should PASS

3. **REFACTOR**: Improve the code while keeping tests green
   - Clean up implementation
   - Run tests → they should still PASS

Repeat for each new behavior/feature.

## Test Types

### Unit Tests

- **Purpose**: Test single modules in isolation
- **When to write**: Before implementation (TDD)
- **File pattern**: `*.test.ts`
- **What to mock**: All dependencies
- **Characteristics**:
  - Fast execution (target < 10ms per test)
  - No external system dependencies
  - Each test file covers one module

### Integration Tests

- **Purpose**: Test multiple modules working together
- **When to write**: Before implementation (TDD)
- **File pattern**: `*.integration.test.ts`
- **What to mock**: External systems only (Electron APIs, Git CLI, network, filesystem)
- **Characteristics**:
  - Tests module interactions
  - Mocks external boundaries
  - May use test fixtures (temp dirs, test git repos)
  - Target < 100ms per test

### Boundary Tests

- **Purpose**: Test interfaces to external systems with real external entities
- **When to write**: When implementing or updating an interface to an external system
- **File pattern**: `*.boundary.test.ts`
- **What to mock**: Nothing (or minimal - e.g., test HTTP server instead of real remote)
- **Characteristics**:
  - Self-contained setup and teardown (no manual test setup required)
  - Tests only the direct interface module (not higher-level consumers)
  - May be slower due to real external interactions
  - Must clean up all resources

### System Tests (TBD)

- **Purpose**: End-to-end user flow testing
- **Status**: Not yet implemented

## File Naming Conventions

| Pattern                   | Test Type        | Example                              |
| ------------------------- | ---------------- | ------------------------------------ |
| `foo.test.ts`             | Unit test        | `app-state.test.ts`                  |
| `foo.integration.test.ts` | Integration test | `handlers.integration.test.ts`       |
| `foo.boundary.test.ts`    | Boundary test    | `simple-git-client.boundary.test.ts` |

**Correct naming examples:**

- `project-store.test.ts` ✓
- `handlers.integration.test.ts` ✓
- `simple-git-client.boundary.test.ts` ✓

**Incorrect naming examples:**

- `project-store.test.integration.ts` ✗ (wrong order)
- `handlers-integration.test.ts` ✗ (missing dot separator)

## Test Commands

| Command                    | What it runs           | Use case                     |
| -------------------------- | ---------------------- | ---------------------------- |
| `npm test`                 | All tests              | Full verification            |
| `npm run test:unit`        | Unit tests only        | Quick TDD feedback           |
| `npm run test:integration` | Integration tests only | Test module interactions     |
| `npm run test:boundary`    | Boundary tests only    | Test external interfaces     |
| `npm run validate`         | Unit + integration     | Pre-commit validation (fast) |

**Why validate excludes boundary tests**: Boundary tests may be slower, require specific binaries (code-server, opencode), and are only relevant when working on external interface code.

## When to Run Tests

| Test Type       | When to Run                                           |
| --------------- | ----------------------------------------------------- |
| **Unit**        | Continuously during TDD (`npm run test:unit`)         |
| **Integration** | After unit tests pass, before commit                  |
| **Boundary**    | During development of new/updated external interfaces |

## Decision Guide

```
Code change involves external system interface?
(Git CLI, HTTP, filesystem, processes, binaries)
                    │
       ┌────────────┴────────────┐
       │ YES                     │ NO
       ▼                         ▼
┌──────────────┐     Code spans multiple modules?
│  BOUNDARY    │                 │
│    TEST      │    ┌────────────┴────────────┐
│  (direct     │    │ YES                     │ NO
│  interface)  │    ▼                         ▼
└──────────────┘ ┌──────────────┐     ┌──────────────┐
                 │ INTEGRATION  │     │  UNIT TEST   │
                 │    TEST      │     │              │
                 └──────────────┘     └──────────────┘
```

Note: A single code change may require multiple test types.

## What to Test

For each module, cover:

1. **Happy path**: Normal operation with valid inputs
2. **Error cases**: Invalid input, external failures, exceptions
3. **Edge cases**: Empty arrays, null/undefined, boundary values
4. **State transitions**: Before/after for stateful operations

Example for a function that processes arrays:

- Empty array `[]`
- Single item `[1]`
- Multiple items `[1, 2, 3]`
- Invalid input (null, undefined, non-array)

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

### Test Naming

Use descriptive names that explain the behavior:

```typescript
describe("ProjectStore", () => {
  it("should add project to store when path is valid", async () => { ... });
  it("should throw GitError when path is not a git repository", async () => { ... });
  it("should return empty array when no projects exist", async () => { ... });
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

## Mocking Strategies

### When to Use Each Mock Type

| Mock Type    | Use Case                              | Example                        |
| ------------ | ------------------------------------- | ------------------------------ |
| `vi.fn()`    | Create standalone mock function       | Callback spies                 |
| `vi.mock()`  | Replace entire module                 | External dependencies          |
| `vi.spyOn()` | Spy on existing method (partial mock) | Verify calls without replacing |

### Module Mocking

```typescript
// Mock entire module
vi.mock("../services/project/project-store");

// Mock with implementation
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
```

### Renderer API Mocking

In renderer tests, mock `$lib/api`, not `window.api`:

```typescript
vi.mock("$lib/api", () => ({
  api: {
    listProjects: vi.fn(),
    openProject: vi.fn(),
  },
}));
```

### Avoid Over-Mocking

In integration tests, only mock external system boundaries:

- Mock: Electron APIs, Git CLI, network, filesystem
- Don't mock: Internal modules being tested together

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

## Test Helpers

All helpers are in `src/services/test-utils.ts`.

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

## Examples

### Unit Test Example

Reference: `src/main/app-state.test.ts`

```typescript
// app-state.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppState } from "./app-state";

// Mock all dependencies
vi.mock("../services/project/project-store");
vi.mock("./managers/view-manager");

describe("AppState", () => {
  let appState: AppState;
  let mockProjectStore: MockProjectStore;
  let mockViewManager: MockViewManager;

  beforeEach(() => {
    mockProjectStore = createMockProjectStore();
    mockViewManager = createMockViewManager();
    appState = new AppState(mockProjectStore, mockViewManager, 8080);
  });

  it("opens project and returns project data", async () => {
    // Arrange
    mockProjectStore.addProject.mockResolvedValue(mockProject);

    // Act
    const result = await appState.openProject("/path/to/repo");

    // Assert
    expect(result.path).toBe("/path/to/repo");
    expect(mockProjectStore.addProject).toHaveBeenCalledWith("/path/to/repo");
  });
});
```

### Integration Test Example

Reference: `src/main/ipc/handlers.integration.test.ts`

```typescript
// handlers.integration.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestGitRepo, createTempDir } from "../../services/test-utils";
import { ProjectStore } from "../../services/project/project-store";
import { AppState } from "../app-state";

// Mock only Electron (external system)
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

describe("IPC Integration Tests", () => {
  let repoPath: string;
  let cleanup: () => Promise<void>;
  let appState: AppState;

  beforeEach(async () => {
    const repo = await createTestGitRepo();
    repoPath = repo.path;
    cleanup = repo.cleanup;

    // Real ProjectStore, real AppState, mocked ViewManager
    const tempDir = await createTempDir();
    const projectStore = new ProjectStore(tempDir.path);
    appState = new AppState(projectStore, mockViewManager, 8080);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("opens project and lists workspaces", async () => {
    const project = await appState.openProject(repoPath);

    expect(project.path).toBe(repoPath);
    expect(project.workspaces).toHaveLength(0);
  });
});
```

### Boundary Test Example

Reference: `src/services/git/simple-git-client.integration.test.ts` (to be renamed)

```typescript
// simple-git-client.boundary.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SimpleGitClient } from "./simple-git-client";
import { createTestGitRepo, createTempDir } from "../test-utils";

// NO MOCKS - tests against real Git CLI

describe("SimpleGitClient", () => {
  let client: SimpleGitClient;
  let repoPath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    client = new SimpleGitClient();
    const repo = await createTestGitRepo();
    repoPath = repo.path;
    cleanup = repo.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("detects git repository", async () => {
    // Tests against REAL Git CLI
    const result = await client.isGitRepository(repoPath);

    expect(result).toBe(true);
  });

  it("returns false for non-git directory", async () => {
    const tempDir = await createTempDir();
    try {
      const result = await client.isGitRepository(tempDir.path);
      expect(result).toBe(false);
    } finally {
      await tempDir.cleanup();
    }
  });
});
```
