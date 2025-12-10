---
status: COMPLETED
last_updated: 2025-12-10
reviewers: [review-testing]
---

# EXECA_PROCESS_RUNNER_BOUNDARY

## Overview

- **Problem**: Need boundary tests that verify `ExecaProcessRunner` works correctly against real OS processes, including process tree cleanup for code-server scenarios.
- **Solution**: Create dedicated boundary test file with comprehensive real-process tests.
- **Note**: This is **adding test coverage for existing functionality**, not TDD. The implementation already exists; we're verifying its behavior.
- **Risks**:
  - Process tree tests are timing-sensitive → use polling with defined intervals
  - Platform-specific behavior → skip signal tests on Windows

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BOUNDARY TEST SCOPE                          │
│                                                                 │
│  ┌─────────────────────┐         ┌─────────────────────────┐   │
│  │  ExecaProcessRunner │ ──────► │  Real OS Processes      │   │
│  │  (module under test)│         │  (external entity)      │   │
│  └─────────────────────┘         └─────────────────────────┘   │
│           │                                │                    │
│           │ uses                           │ spawns             │
│           ▼                                ▼                    │
│  ┌─────────────────────┐         ┌─────────────────────────┐   │
│  │  execa library      │         │  echo, sleep, sh, dd    │   │
│  └─────────────────────┘         └─────────────────────────┘   │
│                                                                 │
│  Tests verify: spawn, stdout/stderr, signals, env, cleanup     │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Create boundary test file with infrastructure**
  - Create `src/services/platform/process.boundary.test.ts`
  - Move `ExecaProcessRunner` tests from `process.test.ts`
  - Keep `findAvailablePort` tests in `process.test.ts` (Phase 2.B)
  - Add test timeout configuration (5000ms default for boundary tests)
  - Add platform skip helper: `const isWindows = process.platform === 'win32'`
  - Update `afterEach` to track and cleanup all spawned PIDs (parents + children)
  - Files: `src/services/platform/process.boundary.test.ts` (new), `src/services/platform/process.test.ts` (update)

- [x] **Step 2: Add SIGKILL test** _(Unix only)_
  - Skip on Windows: `it.skipIf(isWindows)`
  - Spawn `sleep 30`
  - Call `kill('SIGKILL')`, verify returns `true`
  - Wait and verify `signal: 'SIGKILL'` in result
  - Verify `exitCode` is `null`
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 3: Add SIGTERM→SIGKILL escalation test** _(Unix only)_
  - Skip on Windows
  - Spawn process that ignores SIGTERM: `sh -c 'trap "" TERM; sleep 30'`
  - First verify trap works: send SIGTERM, `wait(500)`, expect `running: true`
  - Then send SIGKILL, wait, verify termination with `signal: 'SIGKILL'`
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 4: Add environment isolation test**
  - Set `process.env.BOUNDARY_TEST_VAR = 'should_not_inherit'`
  - Spawn with custom env that excludes `BOUNDARY_TEST_VAR`
  - Run `sh -c 'echo ${BOUNDARY_TEST_VAR:-EMPTY}'`
  - Verify output is `EMPTY`, not `should_not_inherit`
  - Clean up: `delete process.env.BOUNDARY_TEST_VAR`
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 5: Add environment edge cases**
  - Empty string value: `{ TEST: '' }` → verify child sees empty string
  - Special characters: `{ TEST: 'foo$bar"baz' }` → verify preserved
  - Long value: 1KB+ string → verify no truncation
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 6: Add process tree cleanup tests** _(Unix only)_
  - **Expected behavior**: With `cleanup: true`, execa uses process groups. Killing parent should kill all children.
  - Spawn: `sh -c 'sleep 30 & echo $!; wait'`
  - Capture child PID from stdout
  - Kill parent with SIGTERM
  - Poll child status using `process.kill(childPid, 0)`:
    - 50ms interval, max 10 attempts (500ms total)
    - Expect `ESRCH` error (process not found)
  - Add second test: same but with SIGKILL
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 7: Add wait() edge cases**
  - `wait()` after natural exit: spawn `echo done`, delay 100ms, then call `wait()` → returns immediately with cached result
  - Concurrent `wait()` calls: spawn process, call `wait()` twice without awaiting, `Promise.all()` both → results are identical
  - `wait(0)` returns `running: true` immediately for long process
  - `wait()` without timeout waits for completion (note: `wait(Infinity)` doesn't work due to JS setTimeout limitation)
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 8: Add kill() edge cases**
  - Rapid sequential calls: call `kill()` 3 times rapidly → first returns `true`, subsequent return `false`, no crashes
  - Verify return value contract in all signal tests
  - Files: `src/services/platform/process.boundary.test.ts`

- [x] **Step 9: Add large output test**
  - Spawn: `dd if=/dev/zero bs=1024 count=100 2>/dev/null | base64` (generates ~137KB)
  - Verify stdout captured without hanging or truncation
  - Verify process completes normally
  - Files: `src/services/platform/process.boundary.test.ts`

## Testing Strategy

### Test Structure

```
┌─────────────────────────────────────────────────────────────────┐
│              process.boundary.test.ts                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  // Test configuration                                          │
│  const isWindows = process.platform === 'win32'                 │
│  const TEST_TIMEOUT = 5000                                      │
│                                                                 │
│  describe('ExecaProcessRunner', () => {                         │
│  │                                                              │
│  ├── describe('basic operations')                               │
│  │   ├── spawns process and returns handle                      │
│  │   ├── captures stdout                                        │
│  │   ├── captures stderr                                        │
│  │   ├── provides exit code on completion                       │
│  │   ├── provides non-zero exit code (no throw)                 │
│  │   ├── supports custom working directory                      │
│  │   ├── supports environment variables                         │
│  │   └── handles large stdout without hanging (new)             │
│  │                                                              │
│  ├── describe('signal handling') // skipIf(isWindows)           │
│  │   ├── terminates with SIGTERM                                │
│  │   ├── terminates with SIGKILL (new)                          │
│  │   ├── SIGTERM→timeout→SIGKILL escalation (new)               │
│  │   ├── kill() returns false when already dead                 │
│  │   └── rapid sequential kill() calls are safe (new)           │
│  │                                                              │
│  ├── describe('timeout behavior')                               │
│  │   ├── wait(timeout) returns running:true when not exited     │
│  │   ├── wait(timeout) returns result before timeout            │
│  │   ├── multiple wait() calls return cached result             │
│  │   ├── wait() after natural exit returns cached (new)         │
│  │   ├── concurrent wait() calls return same result (new)       │
│  │   ├── wait(0) returns running:true immediately (new)         │
│  │   └── wait() without timeout waits for completion (new)      │
│  │                                                              │
│  ├── describe('environment isolation')                          │
│  │   ├── custom env excludes inherited variables (new)          │
│  │   ├── empty string env values preserved (new)                │
│  │   ├── special characters in env values preserved (new)       │
│  │   └── long env values not truncated (new)                    │
│  │                                                              │
│  ├── describe('error handling')                                 │
│  │   └── handles ENOENT when command not found                  │
│  │                                                              │
│  └── describe('process tree cleanup') // skipIf(isWindows)      │
│      ├── SIGTERM kills child processes (new)                    │
│      └── SIGKILL kills child processes (new)                    │
│                                                                 │
│  })                                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Process Cleanup Strategy

```typescript
// In test file
const spawnedPids: number[] = [];

afterEach(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead - expected
    }
  }
  spawnedPids.length = 0;
});

// Helper to track spawned processes
function trackProcess(proc: SpawnedProcess): void {
  if (proc.pid !== undefined) {
    spawnedPids.push(proc.pid);
  }
}
```

### Process Tree Verification Helper

```typescript
async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false; // No such process
    }
    throw err; // Unexpected error
  }
}

async function waitForProcessDeath(pid: number, maxMs = 500): Promise<boolean> {
  const interval = 50;
  const maxAttempts = maxMs / interval;

  for (let i = 0; i < maxAttempts; i++) {
    if (!(await isProcessRunning(pid))) {
      return true; // Process died
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false; // Still running after timeout
}
```

### Manual Testing Checklist

- [ ] Run `npm run test:boundary` and verify all tests pass
- [ ] Verify tests are skipped on Windows (if testing on Windows)
- [ ] Verify no orphaned processes after test run (`ps aux | grep sleep`)

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | Uses existing execa | N/A      |

## Documentation Updates

### Files to Update

| File   | Changes Required                           |
| ------ | ------------------------------------------ |
| (none) | No doc updates needed - internal test file |

### New Documentation Required

| File   | Purpose                    |
| ------ | -------------------------- |
| (none) | Tests are self-documenting |

## Definition of Done

- [ ] `process.boundary.test.ts` created with all test scenarios
- [ ] `process.test.ts` contains only `findAvailablePort` tests
- [ ] Platform-specific tests skip correctly on Windows
- [ ] All boundary tests have appropriate timeouts
- [ ] Process cleanup handles orphaned children
- [ ] All tests passing
- [ ] `npm run validate:fix` passes
