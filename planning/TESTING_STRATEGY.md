---
status: COMPLETED
last_updated: 2025-12-10
reviewers: [review-testing, review-docs, review-senior]
---

# TESTING_STRATEGY

## Overview

- **Problem**: The codebase lacks a formal testing strategy document. Test types are not clearly defined, naming conventions are inconsistent, and there's no guidance on when to write each type of test.
- **Solution**: Create comprehensive testing documentation, configure vitest for separate test runs, and update the review-testing agent to enforce the strategy.
- **Risks**:
  - Existing tests may not follow the new conventions (addressed in Phase 2 of BOUNDARY_TESTS plan)
  - Developers need to learn the new conventions
- **Alternatives Considered**:
  - Minimal documentation: Rejected - leads to inconsistent testing practices
  - Complex test framework: Rejected - vitest is sufficient with proper configuration

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     TESTING INFRASTRUCTURE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Documentation                             │   │
│  │                                                              │   │
│  │   docs/TESTING.md ◄──────── Single source of truth          │   │
│  │         │                                                    │   │
│  │         ▼                                                    │   │
│  │   AGENTS.md ◄──────────── References testing docs           │   │
│  │         │                                                    │   │
│  │         ▼                                                    │   │
│  │   review-testing.md ◄───── Enforces strategy in reviews     │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    npm Scripts                               │   │
│  │                                                              │   │
│  │   npm test ──────────────► all tests                        │   │
│  │   npm run test:unit ─────► unit tests only                  │   │
│  │   npm run test:integration► integration tests only          │   │
│  │   npm run test:boundary ──► boundary tests only             │   │
│  │   npm run validate ──────► unit + integration (not boundary)│   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Test Type Definitions

| Test Type       | When to Write                                    | Scope                     | What's Real         | What's Mocked        | File Pattern            |
| --------------- | ------------------------------------------------ | ------------------------- | ------------------- | -------------------- | ----------------------- |
| **Unit**        | Before implementation (TDD: red-green-refactor)  | Single module             | Module under test   | All dependencies     | `*.test.ts`             |
| **Integration** | Before implementation (TDD: red-green-refactor)  | Multiple internal modules | All modules in test | External systems     | `*.integration.test.ts` |
| **Boundary**    | When implementing/updating interface to external | Module ↔ external entity  | External system     | Nothing (or minimal) | `*.boundary.test.ts`    |
| **System**      | TBD (future)                                     | Full application          | Everything          | Nothing              | TBD                     |

### TDD Workflow (Unit & Integration Tests)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    RED → GREEN → REFACTOR                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   1. RED: Write a failing test first                                │
│      - Test describes the desired behavior                          │
│      - Run test → it should FAIL (no implementation yet)            │
│                                                                     │
│   2. GREEN: Write minimal code to pass the test                     │
│      - Only write enough code to make the test pass                 │
│      - Run test → it should PASS                                    │
│                                                                     │
│   3. REFACTOR: Improve the code while keeping tests green           │
│      - Clean up implementation                                      │
│      - Run tests → they should still PASS                           │
│                                                                     │
│   Repeat for each new behavior/feature                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### When to Run Each Test Type

| Test Type       | When to Run                                           | Included in validate? |
| --------------- | ----------------------------------------------------- | --------------------- |
| **Unit**        | Continuously during TDD (`npm run test:unit`)         | Yes                   |
| **Integration** | After unit tests pass, before commit                  | Yes                   |
| **Boundary**    | During development of new/updated external interfaces | No (run manually)     |
| **System**      | TBD                                                   | TBD                   |

**Why boundary tests are excluded from validate**: Boundary tests may be slower (real external systems), may require specific binaries (code-server, opencode), and are only relevant when working on external interface code. Run them manually with `npm run test:boundary` when developing interfaces to external systems.

### Test Type Decision Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    WHICH TEST TYPE TO WRITE?                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Code change involves external system interface?                   │
│   (Git CLI, HTTP, filesystem, processes, binaries)                  │
│                           │                                         │
│              ┌────────────┴────────────┐                            │
│              │ YES                     │ NO                         │
│              ▼                         ▼                            │
│   ┌──────────────────┐     Code change spans multiple modules?      │
│   │  BOUNDARY TEST   │                 │                            │
│   │  (direct interface│    ┌───────────┴───────────┐                │
│   │   module only)   │    │ YES                   │ NO              │
│   └──────────────────┘    ▼                       ▼                 │
│                    ┌──────────────┐     ┌──────────────┐            │
│                    │ INTEGRATION  │     │  UNIT TEST   │            │
│                    │    TEST      │     │              │            │
│                    └──────────────┘     └──────────────┘            │
│                                                                     │
│   Note: You may need BOTH unit tests AND boundary/integration tests │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Note on existing tests**: Some existing `*.integration.test.ts` files (e.g., `simple-git-client.integration.test.ts`) are actually boundary tests per these definitions because they test against real external systems. These will be reclassified in Phase 2 of the BOUNDARY_TESTS plan.

## Implementation Steps

- [x] **Step 1: Create docs/TESTING.md**
  - Include TDD Workflow section with red-green-refactor explanation
  - Define all four test types with timing guidance
  - Establish file naming conventions with correct/incorrect examples
  - Document decision flow for choosing test type
  - Include test command reference
  - Document when to run each test type (especially boundary tests)
  - Add Test Quality Guidelines (AAA pattern, naming, isolation)
  - Add Mocking Strategies section (vi.fn, vi.mock, vi.spyOn)
  - Add What to Test section (happy path, errors, edge cases)
  - Document test helpers from `src/services/test-utils.ts`
  - Use existing codebase tests as examples (see Content Specifications)
  - Files: `docs/TESTING.md` (new)
  - Test criteria:
    - [ ] Includes TDD Workflow section with red-green-refactor
    - [ ] Includes Test Type Definitions with examples
    - [ ] Includes What to Test section (happy/error/edge cases)
    - [ ] Includes Test Quality Guidelines (AAA, naming, isolation)
    - [ ] Includes Mocking Strategies with vitest examples
    - [ ] Includes When to Run section explaining boundary test timing
    - [ ] Includes Test Commands reference
    - [ ] Includes Test Helpers documentation (all 4 helpers)
    - [ ] Follows existing docs style (compare to ARCHITECTURE.md)

- [x] **Step 2: Verify and update vitest.config.ts**
  - Verify current include pattern matches all test types
  - Current: `["src/**/*.{test,spec}.{js,ts}"]` - verify this matches `*.integration.test.ts`
  - If needed, update to: `["src/**/*.test.ts", "src/**/*.integration.test.ts", "src/**/*.boundary.test.ts"]`
  - Files: `vitest.config.ts` (verify, update if needed)
  - Test criteria: `npm test` runs all test types including integration tests

- [x] **Step 3: Update package.json scripts**
  - Add `test:unit` script: `vitest run --exclude '**/*.integration.test.ts' --exclude '**/*.boundary.test.ts'`
  - Add `test:integration` script: `vitest run --include '**/*.integration.test.ts'`
  - Add `test:boundary` script: `vitest run --include '**/*.boundary.test.ts'`
  - Update `validate`: `npm run format:check && npm run lint && npm run check && npm run test:unit && npm run test:integration && npm run build`
  - Update `validate:fix`: `npm run format && npm run lint:fix && npm run check && npm run test:unit && npm run test:integration && npm run build`
  - Files: `package.json` (update)
  - Test criteria:
    - [ ] `npm run test:unit` runs only `*.test.ts` files (not integration/boundary)
    - [ ] `npm run test:integration` runs only `*.integration.test.ts` files
    - [ ] `npm run test:boundary` runs only `*.boundary.test.ts` files (0 for now)
    - [ ] `npm run validate` runs unit + integration, excludes boundary
    - [ ] Verify test counts match expected numbers

- [x] **Step 4: Update AGENTS.md**
  - Add "Testing Requirements" section after "Code Quality Standards"
  - Reference docs/TESTING.md for full details
  - Add quick reference table for when to write each test type
  - Add test commands quick reference
  - Add row to Key Documents table: `| Testing Strategy | docs/TESTING.md | Test types, conventions, commands |`
  - Files: `AGENTS.md` (update)
  - Test criteria: Testing guidance is discoverable in table of contents

- [x] **Step 5: Update review-testing.md agent**
  - File location: `.opencode/agent/review-testing.md`
  - Add "6. Test Strategy Compliance" section to Review Focus
  - Add criteria for correct test type usage
  - Add criteria for file naming conventions
  - Add criteria for boundary test presence when interfacing with external systems
  - Update Severity Definitions to include test strategy violations as Critical
  - Files: `.opencode/agent/review-testing.md` (update)
  - Test criteria:
    - [ ] Agent prompt includes "Test Strategy Compliance" section
    - [ ] Section checks correct test type for code changes
    - [ ] Section checks file naming conventions
    - [ ] Section checks boundary tests for external interfaces

## Testing Strategy

This plan is about documentation and configuration - no new test code is written.

### Verification Approach

| Step   | Verification Method                                    |
| ------ | ------------------------------------------------------ |
| Step 1 | Manual review against test criteria checklist          |
| Step 2 | Run `npm test`, verify integration tests are included  |
| Step 3 | Run each script, verify correct tests execute by count |
| Step 4 | Manual review of AGENTS.md updates                     |
| Step 5 | Manual review of review-testing.md updates             |

### Script Verification Commands

After Step 3, verify with:

```bash
# Should run all tests
npm test

# Should run only *.test.ts (excluding *.integration.test.ts and *.boundary.test.ts)
npm run test:unit

# Should run only *.integration.test.ts
npm run test:integration

# Should run only *.boundary.test.ts (will show 0 tests until boundary tests exist)
npm run test:boundary

# Should run unit + integration only
npm run validate
```

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File                                | Changes Required                                             |
| ----------------------------------- | ------------------------------------------------------------ |
| `AGENTS.md`                         | Add Testing Requirements section, update Key Documents table |
| `.opencode/agent/review-testing.md` | Add test strategy compliance review criteria                 |
| `package.json`                      | Add test scripts, update validate scripts                    |
| `vitest.config.ts`                  | Verify/update include pattern if needed                      |

### New Documentation Required

| File              | Purpose                                 |
| ----------------- | --------------------------------------- |
| `docs/TESTING.md` | Complete testing strategy documentation |

## Definition of Done

- [ ] `docs/TESTING.md` created with all sections per test criteria
- [ ] `vitest.config.ts` verified to run all test types
- [ ] `package.json` has all four test scripts working correctly
- [ ] `validate` and `validate:fix` run unit + integration only
- [ ] `AGENTS.md` updated with testing requirements section
- [ ] `.opencode/agent/review-testing.md` updated to enforce strategy
- [ ] `npm run validate:fix` passes
- [ ] All existing tests still pass
- [ ] Changes committed

## Detailed Content Specifications

### docs/TESTING.md Content

```markdown
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
│ YES │ NO
▼ ▼
┌──────────────┐ Code spans multiple modules?
│ BOUNDARY │ │
│ TEST │ ┌────────────┴────────────┐
│ (direct │ │ YES │ NO
│ interface) │ ▼ ▼
└──────────────┘ ┌──────────────┐ ┌──────────────┐
│ INTEGRATION │ │ UNIT TEST │
│ TEST │ │ │
└──────────────┘ └──────────────┘

````

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
````

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

````

### AGENTS.md Addition

Add after "Code Quality Standards" section:

```markdown
## Testing Requirements

See `docs/TESTING.md` for the complete testing strategy.

### Quick Reference

| Code Change                                    | Required Tests                    |
| ---------------------------------------------- | --------------------------------- |
| New module/function                            | Unit tests (TDD)                  |
| Module interactions                            | Integration tests (TDD)           |
| External interface (Git, HTTP, fs, processes)  | Boundary tests                    |
| Bug fix                                        | Test that reproduces the bug      |

### TDD Workflow

1. **RED**: Write failing test first
2. **GREEN**: Write minimal code to pass
3. **REFACTOR**: Clean up while keeping tests green

### Test Commands

| Command                    | Use Case                          |
| -------------------------- | --------------------------------- |
| `npm test`                 | Run all tests                     |
| `npm run test:unit`        | Quick feedback during TDD         |
| `npm run test:boundary`    | When developing external interfaces |
| `npm run validate`         | Pre-commit check (unit + integration) |
````

Update Key Documents table to include (add as fourth row after UI Specification):

```markdown
| Testing Strategy | docs/TESTING.md | Test types, conventions, commands |
```

### review-testing.md Addition

Add new section "6. Test Strategy Compliance" to Review Focus (after section 5):

```markdown
### 6. Test Strategy Compliance

- Is the correct test type being used?
  - Unit tests (`*.test.ts`) for single modules with mocked deps
  - Integration tests (`*.integration.test.ts`) for multi-module interactions
  - Boundary tests (`*.boundary.test.ts`) for external system interfaces
- Does file naming follow conventions?
  - Correct: `foo.test.ts`, `foo.integration.test.ts`, `foo.boundary.test.ts`
  - Incorrect: `foo.test.integration.ts`, `foo-integration.test.ts`
- Are boundary tests present when code interfaces with external systems?
- Are boundary tests self-contained (proper setup/teardown)?
- Do integration tests mock external systems appropriately?
- Is the TDD workflow being followed (tests before implementation)?
```

Update Severity Definitions to include:

```markdown
- **Critical**: Missing tests for critical paths, TDD not followed, no error case coverage, wrong test type used, missing boundary tests for external interfaces
```

### package.json Script Updates

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --exclude '**/*.integration.test.ts' --exclude '**/*.boundary.test.ts'",
    "test:integration": "vitest run --include '**/*.integration.test.ts'",
    "test:boundary": "vitest run --include '**/*.boundary.test.ts'",
    "test:watch": "vitest",
    "validate": "npm run format:check && npm run lint && npm run check && npm run test:unit && npm run test:integration && npm run build",
    "validate:fix": "npm run format && npm run lint:fix && npm run check && npm run test:unit && npm run test:integration && npm run build"
  }
}
```

## Manual Testing Checklist

- [ ] `npm test` runs all tests (unit + integration + boundary)
- [ ] `npm run test:unit` excludes integration and boundary tests
- [ ] `npm run test:integration` runs only integration tests
- [ ] `npm run test:boundary` runs only boundary tests (shows 0 tests until boundary tests exist)
- [ ] `npm run validate` runs unit + integration, not boundary
- [ ] `npm run validate:fix` runs unit + integration, not boundary
- [ ] docs/TESTING.md includes all required sections per Step 1 test criteria
- [ ] AGENTS.md testing section is discoverable in document
- [ ] review-testing.md includes "Test Strategy Compliance" section
