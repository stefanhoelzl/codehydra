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

| Test Type             | When to Run                                             |
| --------------------- | ------------------------------------------------------- |
| **Unit**              | Continuously during TDD (`npm run test:unit`)           |
| **Integration**       | After unit tests pass, before commit                    |
| **Boundary**          | During development of new/updated external interfaces   |
| **OpenCode Boundary** | When modifying OpenCodeClient or SDK/SSE event handling |

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

**Specific scenarios:**

- Testing OpenCodeClient changes → run `npm run test:boundary` (OpenCode boundary tests)
- Testing Git operations → run `npm run test:boundary` (Git boundary tests)
- Testing code-server manager → run `npm run test:boundary` (code-server boundary tests)

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
- **Structure**:
  - `/tmp/codehydra-test-xxx/repo/` - Working directory
  - `/tmp/codehydra-test-xxx/remote.git/` - Bare remote
- **Features**:
  - `origin` remote configured pointing to the bare repo
  - `main` branch pushed to origin
  - Single `cleanup()` removes both directories

### withTempRepoWithRemote(fn)

Convenience wrapper for repos with remotes that handles cleanup automatically.

```typescript
it("should fetch from origin", async () => {
  await withTempRepoWithRemote(async (repoPath, remotePath) => {
    // Test code here
    // Both directories cleaned up automatically
  });
});
```

### createCommitInRemote(remotePath, message)

Creates a commit directly in a bare repository. Useful for testing fetch operations.

```typescript
it("should fetch new commits", async () => {
  const { path, remotePath, cleanup } = await createTestGitRepoWithRemote();
  try {
    await createCommitInRemote(remotePath, "New remote commit");
    await client.fetch(path);
    // Verify origin/main has the new commit
  } finally {
    await cleanup();
  }
});
```

### Boundary Test Utilities

Cross-platform process spawning utilities for boundary tests. All utilities are in `src/services/platform/process.boundary-test-utils.ts`.

**Purpose**: Avoid Unix-specific shell commands (`sleep`, `echo`, `sh -c`) that don't work on Windows. Uses Node.js as the process spawner (guaranteed available in test environment).

**When to use**:

- Use these utilities when testing process spawning, signals, or process trees
- Use platform-specific commands only when testing platform-specific behavior (with `it.skipIf(isWindows)`)

#### isWindows

Platform detection constant for conditionally skipping tests.

```typescript
import { isWindows } from "../platform/process.boundary-test-utils";

it.skipIf(isWindows)("Unix signal test", async () => {
  // This test only runs on Unix
});
```

#### spawnLongRunning(runner, durationMs?)

Spawn a long-running process (no children).

```typescript
import { spawnLongRunning } from "../platform/process.boundary-test-utils";

const proc = spawnLongRunning(runner, 30_000);
// Process runs for 30 seconds, can be killed
proc.kill("SIGTERM");
await proc.wait();
```

#### spawnWithOutput(runner, stdout, stderr?)

Spawn a process that outputs to stdout and optionally stderr. Handles special characters safely.

```typescript
import { spawnWithOutput } from "../platform/process.boundary-test-utils";

const proc = spawnWithOutput(runner, "hello", "error message");
const result = await proc.wait();
// result.stdout = "hello\n"
// result.stderr = "error message\n"
```

#### spawnWithExitCode(runner, exitCode)

Spawn a process that exits with a specific code.

```typescript
import { spawnWithExitCode } from "../platform/process.boundary-test-utils";

const proc = spawnWithExitCode(runner, 42);
const result = await proc.wait();
// result.exitCode = 42
```

#### spawnWithChildren(runner, childCount)

Spawn a process that creates N child processes. Returns a handle with `waitForChildPids()` and `cleanup()` methods.

**Note**: This utility uses a temp file internally for PID communication between the parent process and the test. The temp file is cleaned up automatically by `waitForChildPids()` or `cleanup()`.

```typescript
import {
  spawnWithChildren,
  type ProcessWithChildren,
} from "../platform/process.boundary-test-utils";

let spawned: ProcessWithChildren | null = null;

afterEach(async () => {
  if (spawned) {
    await spawned.cleanup();
    spawned = null;
  }
});

it("tests process tree", async () => {
  spawned = spawnWithChildren(runner, 2);
  const childPids = await spawned.waitForChildPids();
  // childPids = [12345, 12346] (readonly array)

  const parentPid = spawned.process.pid;
  // Test process tree operations...
});
```

#### spawnIgnoringSignals(runner)

**Unix-only** - Spawn a process that ignores SIGTERM (for testing signal escalation).

```typescript
import { spawnIgnoringSignals, isWindows } from "../platform/process.boundary-test-utils";

it.skipIf(isWindows)("escalates SIGTERM to SIGKILL", async () => {
  const proc = spawnIgnoringSignals(runner);
  proc.kill("SIGTERM"); // Ignored
  // ... wait ...
  proc.kill("SIGKILL"); // Works
  await proc.wait();
});
```

**Platform Limitations**:

| Platform | SIGTERM Behavior                              | Signal Trapping |
| -------- | --------------------------------------------- | --------------- |
| Unix     | Graceful termination, can be trapped          | Supported       |
| Windows  | Calls TerminateProcess (like SIGKILL on Unix) | Not supported   |

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

### OpenCode Boundary Tests

OpenCode boundary tests verify the `OpenCodeClient` works correctly with a real `opencode serve` process. They use a mock LLM server to control responses deterministically.

**When to run**: When modifying `OpenCodeClient`, SDK integration, or SSE event handling.

#### Mock LLM Server

The mock LLM server (`src/test/fixtures/mock-llm-server.ts`) implements an OpenAI-compatible API:

| Mode          | Response Behavior                   | Use Case                    |
| ------------- | ----------------------------------- | --------------------------- |
| `instant`     | Return completion immediately       | Basic idle → busy → idle    |
| `slow-stream` | Stream with delays between chunks   | Extended busy state testing |
| `tool-call`   | Return bash tool_call               | Permission event testing    |
| `rate-limit`  | Return HTTP 429 with Retry-After    | Retry status mapping        |
| `sub-agent`   | Return text with `@general` mention | Child session filtering     |

```typescript
import { createMockLlmServer } from "../../test/fixtures/mock-llm-server";

const mockLlm = createMockLlmServer();
await mockLlm.start();

mockLlm.setMode("tool-call"); // Triggers permission request
// ... test code ...

await mockLlm.stop();
```

**Extending with new modes**: Add new response builder functions in `mock-llm-server.ts` and add a case in `handleRequest()`.

#### Test Utilities

**`startOpencode(config, runner?)`** - Start an opencode serve process:

```typescript
import { startOpencode, type OpencodeTestConfig } from "./boundary-test-utils";

const config: OpencodeTestConfig = {
  port: 14096,
  cwd: tempDir,
  config: {
    provider: { mock: { npm: "@ai-sdk/openai-compatible", ... } },
    model: "mock/test",
    permission: { bash: "ask", edit: "allow", webfetch: "allow" },
  },
};

const proc = await startOpencode(config);
// ... test code ...
await proc.stop();
```

**`waitForPort(port, timeoutMs?)`** - Wait for a port to accept connections:

```typescript
import { waitForPort, CI_TIMEOUT_MS } from "../platform/network.test-utils";

// Start server process
const proc = await startOpencode(config);

// Wait for it to be ready (uses longer timeout in CI)
const timeout = process.env.CI ? CI_TIMEOUT_MS : 5000;
await waitForPort(port, timeout);

// Now safe to connect
```

**`checkOpencodeAvailable(runner?)`** - Check if opencode binary exists:

```typescript
import { checkOpencodeAvailable } from "./boundary-test-utils";

const result = await checkOpencodeAvailable();
if (!result.available) {
  console.log(`Skipping: ${result.error}`);
  return;
}
```

#### Cleanup Patterns

OpenCode boundary tests use a cleanup-on-failure pattern with PID tracking:

```typescript
const spawnedPids: number[] = [];

beforeAll(async () => {
  // ... setup ...
  if (proc.pid) spawnedPids.push(proc.pid);
});

afterAll(async () => {
  // Primary cleanup
  await proc?.stop().catch(console.error);

  // Fallback: force-kill any remaining processes
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
});
```

### Boundary Test Example

Reference: `src/services/git/simple-git-client.boundary.test.ts`

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
