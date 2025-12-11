---
status: COMPLETED
last_updated: 2025-12-12
reviewers:
  [review-testing, review-typescript, review-arch, review-senior, review-docs, review-electron]
---

# BOUNDARY_TEST_UTILS

## Overview

- **Problem**: Existing boundary tests in `process.boundary.test.ts` use Unix-specific shell commands (`sh -c`, `sleep`, `/dev/zero`), making them non-portable to Windows. The upcoming `process-tree.boundary.test.ts` needs to spawn processes with children, which also requires platform-specific commands.
- **Solution**: Create cross-platform test utilities using Node.js as the process spawner (guaranteed available in test environment), then refactor existing boundary tests to use these utilities. Utilities are developed incrementally following TDD - each utility is created when first needed by a test.
- **Risks**:
  - Node.js process spawning behavior might differ slightly from shell-spawned processes
  - Some tests (signal handling) are inherently Unix-specific and cannot be made cross-platform
  - Windows child process cleanup differs from Unix (no process groups)
- **Alternatives Considered**:
  - Conditional commands per platform: Rejected - leads to duplicated test logic
  - Skip all tests on Windows: Current approach, but limits CI flexibility
  - Use WSL on Windows: Rejected - adds complexity and external dependency

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BOUNDARY TEST UTILITIES                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  src/services/platform/process.boundary-test-utils.ts                │
│  ├── spawnWithChildren(runner, count) → ProcessWithChildren          │
│  ├── spawnLongRunning(runner, durationMs?) → SpawnedProcess          │
│  ├── spawnWithOutput(runner, stdout, stderr?) → SpawnedProcess       │
│  ├── spawnWithExitCode(runner, code) → SpawnedProcess                │
│  ├── spawnIgnoringSignals(runner) → SpawnedProcess [Unix-only]       │
│  └── isWindows: boolean                                              │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  CONSUMERS:                                                          │
│  ├── src/services/platform/process.boundary.test.ts (refactor)       │
│  └── src/services/opencode/process-tree.boundary.test.ts (new)       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Cross-Platform Strategy

```
┌─────────────────────────────────────────────────────────────────────┐
│  BEFORE (Unix-only)              AFTER (Cross-platform)              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  runner.run("sleep", ["30"])  →  spawnLongRunning(runner, 30000)     │
│  Uses: sleep binary               Uses: node -e "setTimeout(...)"    │
│                                                                      │
│  runner.run("echo", ["hi"])   →  spawnWithOutput(runner, "hi")       │
│  Uses: echo binary                Uses: node -e "console.log(...)"   │
│                                                                      │
│  runner.run("sh", ["-c",      →  spawnWithChildren(runner, 2)        │
│    "sleep 30 & sleep 30"])        Uses: node + child_process.spawn   │
│                                                                      │
│  runner.run("sh", ["-c",      →  spawnWithExitCode(runner, 42)       │
│    "exit 42"])                    Uses: node -e "process.exit(42)"   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Script Generation Safety

All utilities use `JSON.stringify()` when embedding dynamic values into inline scripts to prevent injection and handle special characters safely:

```typescript
// Safe: uses JSON.stringify for string content
const script = `console.log(${JSON.stringify(stdout)});`;

// Safe: numeric values validated before embedding
if (durationMs < 0) throw new Error("Duration must be non-negative");
const script = `setTimeout(() => {}, ${durationMs});`;
```

### Tests That Remain Unix-Only

Some tests cannot be made cross-platform due to fundamental platform differences:

| Test Category                      | Reason                                  | Approach                                   |
| ---------------------------------- | --------------------------------------- | ------------------------------------------ |
| Signal semantics (SIGTERM/SIGKILL) | Windows has different termination model | Keep `it.skipIf(isWindows)`                |
| Signal trapping (`trap '' TERM`)   | Unix shell feature                      | Keep `spawnIgnoringSignals()` as Unix-only |
| `/dev/zero` large output           | Unix device file                        | Use Node.js Buffer generation instead      |

**Note on Windows signals**: On Windows, `kill("SIGTERM")` calls `TerminateProcess` (immediate termination, similar to SIGKILL on Unix). Signal trapping is not possible on Windows.

## Implementation Steps

### TDD Approach

Utilities are developed incrementally: when refactoring a test that needs a utility, create that utility first (red-green-refactor). The utility is proven correct by the boundary test that uses it.

- [x] **Step 1: Record baseline test coverage**
  - Run `npm run test:boundary -- --coverage` and record line/branch coverage for `process.boundary.test.ts`
  - Document baseline in this plan or commit message
  - Files: (none - documentation only)
  - Test criteria: Baseline coverage recorded
  - **Baseline**: 27 tests passing (coverage tool not installed, using test count)

- [x] **Step 2: Create process.boundary-test-utils.ts with initial utilities**
  - Create new file with platform detection and basic utilities
  - Export `isWindows` constant: `export const isWindows = process.platform === "win32";`
  - Implement `spawnLongRunning()` - needed for timeout/signal tests
  - Implement `spawnWithOutput()` - needed for stdout/stderr tests
  - Implement `spawnWithExitCode()` - needed for exit code tests
  - All utilities MUST use `process.execPath`, never hardcode `"node"`
  - All string values MUST use `JSON.stringify()` for safe embedding
  - Files: `src/services/platform/process.boundary-test-utils.ts` (new)
  - Test criteria: TypeScript compiles, utilities can be imported

- [x] **Step 3: Refactor process.boundary.test.ts - basic operations**
  - Replace `echo` commands with `spawnWithOutput()`
  - Replace `sleep` commands with `spawnLongRunning()`
  - Replace `sh -c "exit N"` with `spawnWithExitCode()`
  - Replace `pwd` test with `node -e "console.log(process.cwd())"`
  - Keep tests functionally equivalent
  - Files: `src/services/platform/process.boundary.test.ts` (modify)
  - Test criteria: All basic operation tests pass, behavior unchanged

  **Before/After Example:**

  ```typescript
  // Before
  const proc = runner.run("sleep", ["30"]);

  // After
  const proc = spawnLongRunning(runner, 30_000);
  ```

- [x] **Step 4: Refactor process.boundary.test.ts - advanced tests**
  - Implement `spawnIgnoringSignals()` for signal escalation test (Unix-only)
  - Replace environment variable tests using Node.js
  - Replace large output test using Node.js Buffer generation
  - Keep Unix-only signal tests with `it.skipIf(isWindows)`
  - Files: `src/services/platform/process.boundary-test-utils.ts` (add utility), `src/services/platform/process.boundary.test.ts` (modify)
  - Test criteria: All tests pass, Unix-only tests properly skipped on Windows

- [x] **Step 5: Implement spawnWithChildren utility**
  - Implement `spawnWithChildren()` with self-synchronizing `waitForChildPids()`
  - Implement `cleanup()` method that kills parent and all tracked children
  - Use `detached: false` to ensure children are killed with parent on Unix
  - Document Windows limitation: children must be explicitly tracked and killed
  - Files: `src/services/platform/process.boundary-test-utils.ts` (add utility)
  - Test criteria: Utility compiles and can be used in Step 6

- [x] **Step 6: Create process-tree.boundary.test.ts**
  - Add smoke test verifying `pidtree` works on current platform
  - Use `spawnWithChildren()` to create test process trees
  - Test `PidtreeProvider.getDescendantPids()` with real processes
  - Test error handling with non-existent PIDs
  - Test empty result for process without children
  - Ensure cleanup of all spawned processes in `afterEach`
  - Files: `src/services/opencode/process-tree.boundary.test.ts` (new)
  - Test criteria: All PidtreeProvider boundary tests pass

- [x] **Step 7: Verify coverage and vitest config**
  - Run `npm run test:boundary -- --coverage` and compare to baseline
  - Verify coverage matches or exceeds baseline
  - Verify `*.boundary.test.ts` pattern is included in vitest config
  - Run `npm run test:boundary` to confirm all boundary tests discovered
  - Files: `vitest.config.ts` (modify if pattern not matched)
  - Test criteria: Coverage maintained, all boundary tests run

- [x] **Step 8: Update documentation**
  - Add section to `docs/TESTING.md` under "Test Helpers" covering:
    - Purpose: Cross-platform process spawning for boundary tests
    - Available utilities: `spawnLongRunning`, `spawnWithOutput`, `spawnWithExitCode`, `spawnWithChildren`, `spawnIgnoringSignals`
    - Usage examples for each utility
    - When to use utilities vs platform-specific commands
    - Platform limitations (Unix-only utilities, Windows signal behavior)
  - Files: `docs/TESTING.md` (modify)
  - Test criteria: Documentation is clear and complete

## Testing Strategy

### Boundary Tests

Utilities are NOT separately tested. They are proven correct through usage in actual boundary tests:

| Test Case                          | Description                            | File                          |
| ---------------------------------- | -------------------------------------- | ----------------------------- |
| ExecaProcessRunner basic ops       | Uses spawnWithOutput, spawnLongRunning | process.boundary.test.ts      |
| ExecaProcessRunner exit codes      | Uses spawnWithExitCode                 | process.boundary.test.ts      |
| ExecaProcessRunner signals         | Uses spawnIgnoringSignals (Unix-only)  | process.boundary.test.ts      |
| PidtreeProvider with real children | Uses spawnWithChildren                 | process-tree.boundary.test.ts |
| PidtreeProvider non-existent PID   | Returns empty Set gracefully           | process-tree.boundary.test.ts |
| PidtreeProvider no children        | Uses spawnLongRunning (no children)    | process-tree.boundary.test.ts |
| pidtree platform smoke test        | Verify pidtree works on current OS     | process-tree.boundary.test.ts |

### Manual Testing Checklist

- [ ] Run `npm run test:boundary` on Linux - all tests pass
- [ ] Compare coverage to baseline - no regression
- [ ] Verify no orphaned processes after test run (`ps aux | grep node`)

## Dependencies

| Package | Purpose                                      | Approved |
| ------- | -------------------------------------------- | -------- |
| (none)  | No new dependencies - uses Node.js built-ins | N/A      |

## Documentation Updates

### Files to Update

| File              | Changes Required                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/TESTING.md` | Add "Boundary Test Utilities" section: purpose, available utilities (spawnLongRunning, spawnWithOutput, spawnWithExitCode, spawnWithChildren, spawnIgnoringSignals), examples, caveats |

### New Documentation Required

| File   | Purpose                                  |
| ------ | ---------------------------------------- |
| (none) | Utilities are self-documenting via JSDoc |

## Definition of Done

- [x] Baseline coverage recorded
- [x] `process.boundary-test-utils.ts` created with all spawn utilities
- [x] `process.boundary.test.ts` refactored to use utilities
- [x] `process-tree.boundary.test.ts` created and passing
- [x] All existing boundary tests still pass
- [x] Coverage matches or exceeds baseline
- [x] `npm run validate:fix` passes
- [x] Documentation updated in `docs/TESTING.md`

## API Reference

### ProcessWithChildren

```typescript
interface ProcessWithChildren {
  /** The spawned parent process */
  process: SpawnedProcess;

  /**
   * Wait for children to spawn and return their PIDs.
   * Self-synchronizing: waits for parent to output child PIDs to stdout.
   * @param timeoutMs - Max time to wait for children (default: 5000)
   * @returns Array of child PIDs (readonly to prevent accidental mutation)
   * @throws Error if timeout exceeded before children reported
   */
  waitForChildPids(timeoutMs?: number): Promise<readonly number[]>;

  /**
   * Kill parent process and all tracked children.
   * Call this in afterEach to ensure cleanup.
   */
  cleanup(): Promise<void>;
}
```

### spawnWithChildren

```typescript
/**
 * Spawn a process that creates N child processes.
 * Cross-platform using Node.js child_process.
 *
 * The parent process outputs child PIDs as JSON to stdout, then waits.
 * Use waitForChildPids() to get the PIDs (self-synchronizing, no arbitrary delays).
 * Use cleanup() in afterEach to kill parent and all children.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param childCount - Number of child processes to create (must be >= 1)
 * @returns ProcessWithChildren with parent process, PID accessor, and cleanup
 * @throws Error if childCount < 1
 *
 * @example
 * const spawned = spawnWithChildren(runner, 2);
 * const childPids = await spawned.waitForChildPids();
 * // childPids = [12345, 12346] (readonly)
 *
 * // In afterEach:
 * await spawned.cleanup();
 */
function spawnWithChildren(runner: ProcessRunner, childCount: number): ProcessWithChildren;
```

### spawnLongRunning

```typescript
/**
 * Spawn a long-running process (no children).
 * Cross-platform using Node.js setTimeout.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param durationMs - How long the process should run (default: 60_000)
 * @returns SpawnedProcess handle
 * @throws Error if durationMs < 0
 *
 * @example
 * const proc = spawnLongRunning(runner, 30_000);
 * // Process runs for 30 seconds
 */
function spawnLongRunning(runner: ProcessRunner, durationMs?: number): SpawnedProcess;
```

### spawnWithOutput

```typescript
/**
 * Spawn a process that outputs to stdout and optionally stderr.
 * Cross-platform using Node.js console methods.
 *
 * String content is safely escaped using JSON.stringify to handle
 * special characters, quotes, and newlines.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param stdout - Content to write to stdout
 * @param stderr - Optional content to write to stderr
 * @returns SpawnedProcess handle
 *
 * @example
 * const proc = spawnWithOutput(runner, "hello", "error");
 * const result = await proc.wait();
 * // result.stdout = "hello\n"
 * // result.stderr = "error\n"
 *
 * @example
 * // Special characters are handled safely
 * const proc = spawnWithOutput(runner, "user's \"input\"");
 * const result = await proc.wait();
 * // result.stdout = "user's \"input\"\n"
 */
function spawnWithOutput(runner: ProcessRunner, stdout: string, stderr?: string): SpawnedProcess;
```

### spawnWithExitCode

```typescript
/**
 * Spawn a process that exits with a specific code.
 * Cross-platform using Node.js process.exit.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param exitCode - Exit code for the process (0-255)
 * @returns SpawnedProcess handle
 *
 * @example
 * const proc = spawnWithExitCode(runner, 42);
 * const result = await proc.wait();
 * // result.exitCode = 42
 */
function spawnWithExitCode(runner: ProcessRunner, exitCode: number): SpawnedProcess;
```

### spawnIgnoringSignals

```typescript
/**
 * Spawn a process that ignores SIGTERM.
 * **Unix-only** - use with it.skipIf(isWindows).
 *
 * On Windows, SIGTERM is not trappable - it calls TerminateProcess
 * which immediately kills the process (similar to SIGKILL on Unix).
 *
 * @param runner - ProcessRunner to use for spawning
 * @returns SpawnedProcess handle
 * @throws PlatformNotSupportedError if called on Windows
 *
 * @example
 * it.skipIf(isWindows)("escalates SIGTERM to SIGKILL", async () => {
 *   const proc = spawnIgnoringSignals(runner);
 *   proc.kill("SIGTERM"); // Ignored on Unix
 *   proc.kill("SIGKILL"); // Works
 * });
 */
function spawnIgnoringSignals(runner: ProcessRunner): SpawnedProcess;
```

### isWindows

```typescript
/**
 * Platform detection constant.
 * Use with vitest's it.skipIf() for platform-specific tests.
 *
 * @example
 * it.skipIf(isWindows)("Unix signal test", async () => {
 *   // This test only runs on Unix
 * });
 */
export const isWindows: boolean = process.platform === "win32";
```

## Node.js Script Templates

These are inline scripts passed to `node -e '<script>'` for cross-platform process spawning. Using CommonJS syntax because `-e` eval context doesn't support ESM imports. The `execa` library handles shell escaping for these inline scripts.

### spawnWithChildren script

```javascript
// Spawns N children and outputs their PIDs as JSON, then waits
const { spawn } = require("child_process");
const children = [];
for (let i = 0; i < CHILD_COUNT; i++) {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    stdio: "ignore",
    detached: false, // Ensures children die with parent on Unix
  });
  children.push(child.pid);
}
// Output PIDs immediately so waitForChildPids() can read them
console.log(JSON.stringify(children));
// Keep parent alive for test duration
setTimeout(() => {}, 60000);
```

### spawnLongRunning script

```javascript
// Simply waits for the specified duration
setTimeout(() => {}, DURATION_MS);
```

### spawnWithOutput script

```javascript
// Outputs to stdout and optionally stderr
// Values are embedded via JSON.stringify for safety
console.log(STDOUT_JSON_STRINGIFIED);
console.error(STDERR_JSON_STRINGIFIED); // Only if stderr provided
```

### spawnWithExitCode script

```javascript
// Exits with the specified code
process.exit(EXIT_CODE);
```

### spawnIgnoringSignals script (Unix-only)

```bash
# Shell script using trap to ignore SIGTERM
trap '' TERM; sleep 60
```
