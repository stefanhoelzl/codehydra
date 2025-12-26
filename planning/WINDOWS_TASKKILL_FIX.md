---
status: COMPLETED
last_updated: 2025-12-27
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# WINDOWS_TASKKILL_FIX

## Overview

- **Problem**: Workspace deletion almost always fails on Windows because:
  1. `taskkill` without `/f` sends WM_CLOSE which console apps ignore
  2. Kill result is never checked - deletion continues even if process survives
  3. 5s/5s timeouts are too long (should be 1s/1s)
  4. `ProcessTreeProvider` interface was designed but never integrated - kill logic uses native tree-kill commands directly (`pkill -P`, `taskkill /t`)
- **Solution**:
  1. On Windows, always use `/f` flag in `killProcess()` (skip useless graceful WM_CLOSE)
  2. Log when kill fails and surface error to deletion UI
  3. Reduce timeouts to 1s/1s (configurable)
  4. Remove unused `ProcessTreeProvider` and its dependencies

- **Risks**:
  - Forceful kill means no graceful shutdown for OpenCode - but this is unavoidable since we can't send CTRL_C_EVENT to detached processes
  - Removing pidtree/windows-process-tree removes ability to enumerate child PIDs - but `taskkill /t` handles tree killing natively

- **Alternatives Considered**:
  - Keep graceful attempt with shorter timeout: Rejected because WM_CLOSE literally cannot work for console apps
  - Use GenerateConsoleCtrlEvent: Only works for processes in same console group, not detached processes

## Architecture

```
Before (broken):
┌─────────────────────────────────────────────────────────────────┐
│ stopServer()                                                     │
│     │                                                            │
│     └─► process.kill(5000, 5000)  ← result ignored!             │
│             │                                                    │
│             ├─► taskkill /pid X /t        ← WM_CLOSE (ignored)  │
│             │   wait 5s...                 ← wasted time        │
│             │                                                    │
│             └─► taskkill /pid X /t /f     ← finally works       │
│                 wait 5s...                                       │
│                                                                  │
│     └─► return (no error even if kill failed)                   │
└─────────────────────────────────────────────────────────────────┘

After (fixed):
┌─────────────────────────────────────────────────────────────────┐
│ stopServer()                                                     │
│     │                                                            │
│     └─► process.kill(1000, 1000)                                │
│             │                                                    │
│             ├─► [Windows] taskkill /pid X /t /f  ← immediate    │
│             │   wait 1s for exit                                 │
│             │                                                    │
│             ├─► [Unix] SIGTERM + wait 1s                        │
│             │   SIGKILL + wait 1s                                │
│             │                                                    │
│             └─► return KillResult { success, reason }           │
│                                                                  │
│     └─► if (!result.success) log warning                        │
│     └─► return StopResult { success, error? }                   │
└─────────────────────────────────────────────────────────────────┘
```

**Platform-specific kill behavior:**

- **Windows**: `killProcess()` always uses `taskkill /t /f` (immediate forceful termination) because WM_CLOSE cannot signal console processes
- **Unix**: `killProcess()` uses SIGTERM (graceful) or SIGKILL (forceful) based on `force` parameter

## Implementation Steps

### Phase 1: Tests First (TDD)

- [x] **Step 1: Write failing tests for Windows kill behavior**
  - Add unit test: "Windows killProcess always uses /f flag"
  - Add unit test: "Unix killProcess uses SIGTERM for graceful, SIGKILL for force"
  - Add boundary test: "Windows taskkill /t /f kills process tree" (spawns real process)
  - Add boundary test: "kill times out after 1s if process doesn't exit"
  - Files: `src/services/platform/process.test.ts`, `src/services/platform/process.boundary.test.ts`
  - Test criteria: Tests fail (implementation not done yet)

- [x] **Step 2: Write failing tests for stopServer return type**
  - Add unit test: "stopServer returns { success: true } when kill succeeds"
  - Add unit test: "stopServer returns { success: false, error } when kill fails"
  - Add unit test: "stopServer logs warning when kill fails"
  - Add unit test: "stopServer uses 1000ms timeouts"
  - Files: `src/services/opencode/opencode-server-manager.test.ts`
  - Test criteria: Tests fail (implementation not done yet)

- [x] **Step 3: Write failing tests for error propagation**
  - Add integration test: "executeDeletion marks stop-server operation as error when kill fails"
  - Add integration test: "deletion progress event includes error when kill fails"
  - Files: `src/main/api/codehydra-api.integration.test.ts`
  - Test criteria: Tests fail (implementation not done yet)

### Phase 2: Implementation

- [x] **Step 4: Fix Windows kill logic in process.ts**
  - Modify `killProcess()` to always use `/f` flag on Windows (both graceful and force calls)
  - Keep two-phase SIGTERM/SIGKILL for Unix
  - Update logging to reflect actual behavior (don't log "SIGTERM" on Windows)
  - Add code comment explaining why graceful kill isn't attempted on Windows

  **Before:**

  ```typescript
  private async killProcess(pid: number, force: boolean): Promise<void> {
    if (isWindows) {
      const args = ["/pid", String(pid), "/t"];
      if (force) {
        args.push("/f");
      }
      // ...
    }
  }
  ```

  **After:**

  ```typescript
  private async killProcess(pid: number, force: boolean): Promise<void> {
    if (isWindows) {
      // Windows: Always use /f because WM_CLOSE (sent by taskkill without /f)
      // is ignored by console applications. We can't send CTRL_C_EVENT to
      // detached processes, so forceful termination is our only option.
      const args = ["/pid", String(pid), "/t", "/f"];
      // ...
    }
  }
  ```

  - Files: `src/services/platform/process.ts`
  - Test criteria: Windows kill tests pass

- [x] **Step 5: Add timeout constants**
  - Create shared constants for kill timeouts:
    ```typescript
    export const PROCESS_KILL_GRACEFUL_TIMEOUT_MS = 1000;
    export const PROCESS_KILL_FORCE_TIMEOUT_MS = 1000;
    ```
  - Files: `src/services/platform/process.ts`
  - Test criteria: Constants exported and used

- [x] **Step 6: Update stopServer to return result and check kill**
  - Change signature from `Promise<void>` to `Promise<StopResult>`
  - Check `KillResult.success` and log warning if failed
  - Also check kill result in health check failure path (line 178)

  **Before:**

  ```typescript
  async stopServer(workspacePath: string): Promise<void> {
    // ...
    await currentEntry.process.kill(5000, 5000);
    // ...
  }
  ```

  **After:**

  ```typescript
  interface StopResult {
    success: boolean;
    error?: string;
  }

  async stopServer(workspacePath: string): Promise<StopResult> {
    // ...
    const killResult = await currentEntry.process.kill(
      PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
      PROCESS_KILL_FORCE_TIMEOUT_MS
    );
    if (!killResult.success) {
      this.logger.warn("Failed to kill OpenCode server", {
        workspacePath,
        pid: currentEntry.process.pid
      });
      return { success: false, error: "Process did not terminate" };
    }
    // ...
    return { success: true };
  }
  ```

  - Files: `src/services/opencode/opencode-server-manager.ts`
  - Test criteria: stopServer tests pass

- [x] **Step 7: Update code-server-manager timeouts**
  - Change `kill(5000, 5000)` to use timeout constants
  - Check kill result and log if failed
  - Files: `src/services/code-server/code-server-manager.ts`
  - Test criteria: Uses 1000ms timeouts

- [x] **Step 8: Add stop-server operation to executeDeletion**
  - Add new operation `stop-server` before `cleanup-workspace`
  - Mark as error if `stopServer()` returns `{ success: false }`
  - Keep `appState.removeWorkspace()` as void (logging at boundary is sufficient)

  **Updated operations:**

  ```typescript
  const operations: DeletionOperation[] = [
    { id: "kill-terminals", label: "Terminating terminals", status: "pending" },
    { id: "stop-server", label: "Stopping OpenCode server", status: "pending" },
    { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
    { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
  ];
  ```

  - Files: `src/main/api/codehydra-api.ts`, `src/shared/api/types.ts` (add operation ID)
  - Test criteria: Error propagation tests pass

### Phase 3: Cleanup

- [x] **Step 9: Remove ProcessTreeProvider and dependencies**
  - Delete `src/services/platform/process-tree.ts`
  - Delete `src/services/platform/process-tree.test.ts`
  - Delete `src/services/platform/process-tree.boundary.test.ts`
  - Remove export from `src/services/index.ts`
  - Run `npm uninstall pidtree @vscode/windows-process-tree`
  - Files: Multiple (see above)
  - Test criteria: `npm install` succeeds, no references to removed code

- [x] **Step 10: Update documentation**
  - **AGENTS.md**: Remove "Windows Development Requirements" section about Visual Studio Build Tools
  - **AGENTS.md**: Remove `[pidtree]` from Logger Names table
  - **docs/ARCHITECTURE.md**: Remove ProcessTreeProvider from Platform Abstractions table
  - **docs/ARCHITECTURE.md**: Remove process-tree.boundary.test.ts from Boundary test files table
  - **docs/PATTERNS.md**: Add platform-specific kill behavior documentation to ProcessRunner Pattern section:

    ```markdown
    **Platform-specific kill behavior:**

    - Windows: Always uses `taskkill /t /f` (immediate forceful termination)
      because WM_CLOSE cannot signal console processes
    - Unix: Uses two-phase SIGTERM → SIGKILL with configurable timeouts
    ```

  - **planning/WINDOWS_PROCESS_TREE.md**: Add note at top: "Superseded by WINDOWS_TASKKILL_FIX.md"
  - Files: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PATTERNS.md`, `planning/WINDOWS_PROCESS_TREE.md`
  - Test criteria: Docs are accurate

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                       | Description                     | File                              |
| ----------------------------------------------- | ------------------------------- | --------------------------------- |
| `Windows killProcess always uses /f flag`       | Verify taskkill /f on all calls | `process.test.ts`                 |
| `Unix killProcess uses SIGTERM for graceful`    | Verify two-phase on Unix        | `process.test.ts`                 |
| `Unix killProcess uses SIGKILL for force`       | Verify force behavior           | `process.test.ts`                 |
| `kill returns success=true on termination`      | Verify success result           | `process.test.ts`                 |
| `kill returns success=false on timeout`         | Verify failure result           | `process.test.ts`                 |
| `stopServer returns success when kill succeeds` | Verify return type              | `opencode-server-manager.test.ts` |
| `stopServer returns failure when kill fails`    | Verify error propagation        | `opencode-server-manager.test.ts` |
| `stopServer logs warning on kill failure`       | Verify logging                  | `opencode-server-manager.test.ts` |
| `stopServer uses 1000ms timeouts`               | Verify timeout values           | `opencode-server-manager.test.ts` |
| `health check failure path checks kill result`  | Verify line 178 fixed           | `opencode-server-manager.test.ts` |

### Boundary Tests

| Test Case                                   | Description              | File                       |
| ------------------------------------------- | ------------------------ | -------------------------- |
| `Windows taskkill /t /f kills process tree` | Real process termination | `process.boundary.test.ts` |
| `Unix SIGTERM/SIGKILL kills process tree`   | Real process termination | `process.boundary.test.ts` |
| `kill times out after configured timeout`   | Verify timeout behavior  | `process.boundary.test.ts` |
| `kill handles already-terminated process`   | Edge case                | `process.boundary.test.ts` |

### Integration Tests

| Test Case                                                    | Description              | File                                |
| ------------------------------------------------------------ | ------------------------ | ----------------------------------- |
| `executeDeletion marks stop-server as error when kill fails` | Error surfacing          | `codehydra-api.integration.test.ts` |
| `deletion progress event includes error`                     | UI integration           | `codehydra-api.integration.test.ts` |
| `workspace deletion completes within 3s`                     | Performance verification | `codehydra-api.integration.test.ts` |

### Manual Testing Checklist

- [ ] Delete workspace on Windows - should complete in ~2s (not 10s)
- [ ] Delete workspace on Linux/macOS - should work as before (~2s)
- [ ] Create workspace with long-running terminal, delete it, verify process killed
- [ ] If process survives kill, deletion UI should show error indicator on "Stopping OpenCode server" step
- [ ] `npm install` succeeds on clean Windows machine without Visual Studio Build Tools
- [ ] Verify log output includes PID and failure reason when kill fails

## Dependencies

| Package                        | Purpose | Approved |
| ------------------------------ | ------- | -------- |
| (none - removing dependencies) |         |          |

**Packages to REMOVE:**

- `pidtree` - was used by PidtreeProvider (now deleted)
- `@vscode/windows-process-tree` - was used by WindowsProcessTreeProvider (now deleted)

## Documentation Updates

### Files to Update

| File                               | Changes Required                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `AGENTS.md`                        | Remove "Windows Development Requirements" section; Remove `[pidtree]` from Logger Names |
| `docs/ARCHITECTURE.md`             | Remove ProcessTreeProvider from tables                                                  |
| `docs/PATTERNS.md`                 | Add platform-specific kill behavior to ProcessRunner Pattern                            |
| `planning/WINDOWS_PROCESS_TREE.md` | Mark as superseded                                                                      |

### New Documentation Required

None.

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes (note: 3 vscode-setup tests fail - pre-existing, unrelated)
- [ ] Windows workspace deletion completes in ~2s (not 10s) (requires manual testing)
- [x] Kill failures are logged and shown in deletion UI (stop-server operation)
- [x] No references to pidtree or windows-process-tree in codebase
- [x] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
