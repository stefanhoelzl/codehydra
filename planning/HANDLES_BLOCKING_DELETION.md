---
status: USER_TESTING
last_updated: 2025-12-31
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

> **Current State**: Phase 1 complete and reviewed. Ready for user testing before Phase 2 (UI integration).

# HANDLES_BLOCKING_DELETION

## Overview

- **Problem**: Workspace deletion fails on Windows when processes hold file handles. Users see generic errors with no actionable info.
- **Solution**: Detect blocking processes and their locked files via Windows APIs (Restart Manager + NtQuerySystemInformation), show detailed scrollable list, offer three resolution options: retry, kill processes, or close handles (elevated).
- **Platform**: Windows only (Linux/macOS use NoOp implementation)
- **Risks**:
  - Restart Manager may miss some edge cases (kernel handles, services)
  - Elevated processes may resist taskkill
  - Closing handles can corrupt application state if actively in use
- **Alternatives Considered**:
  - handle.exe (requires download + licensing)
  - koffi for direct API calls (adds native dependency, complicates elevation)
  - WMI queries alone (unreliable for file locks)

## Approval Requests

### New Boundary Interface

**Request**: Add `BlockingProcessService` as a new boundary interface.

- **External system**: Windows APIs via PowerShell + Add-Type (C# interop)
  - Restart Manager API (rstrtmgr.dll) for process detection
  - NtQuerySystemInformation for file handle enumeration
  - DuplicateHandle for handle closing (elevated)
- **Why existing interfaces don't cover**: ProcessRunner spawns processes but doesn't provide Windows-specific handle detection
- **Pattern followed**: Interface + factory + platform implementations (like `FileSystemLayer`, `HttpClient`)

### API/IPC Interface Changes

**Request**: Modify existing IPC interfaces.

| Change                                                                    | Files Affected                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Add `BlockingProcess` type with `files` array                             | `src/shared/api/types.ts`                              |
| Add `blockingProcesses?` to `DeletionProgress`                            | `src/shared/api/types.ts`                              |
| Change `killBlocking?: boolean` to `unblock?: "kill" \| "close" \| false` | `src/shared/electron-api.d.ts`, `src/preload/index.ts` |

**Files requiring atomic update for `unblock` change:**

- `src/shared/electron-api.d.ts` - Type definition
- `src/preload/index.ts` - IPC bridge
- `src/main/api/workspace-api.ts` - IPC handler
- `src/main/modules/core/index.ts` - CoreModule executeDeletion
- `src/main/modules/core/index.integration.test.ts` - CoreModule tests
- `src/renderer/lib/components/MainView.svelte` - Handler calls
- `src/renderer/lib/components/DeletionProgressView.svelte` - Button callbacks

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              BlockingProcessService (interface)                  │
│                                                                  │
│  detect(path: Path): Promise<BlockingProcess[]>                  │
│  killProcesses(pids: number[]): Promise<void>                    │
│  closeHandles(path: Path): Promise<void>  ← spawns elevated      │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
┌─────────────────────────┐           ┌─────────────────────────┐
│ WindowsBlockingProcess  │           │ NoOpBlockingProcess     │
│ Service                 │           │ Service                 │
│                         │           │                         │
│ Uses single script:     │           │ detect: return []       │
│ blocking-processes.ps1  │           │ killProcesses: no-op    │
│   -Detect               │           │ closeHandles: no-op     │
│   -CloseHandles         │           │                         │
└─────────────────────────┘           └─────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│ resources/scripts/blocking-processes.ps1                        │
│                                                                 │
│ -Detect:       Restart Manager + NtQuerySystemInfo → JSON       │
│ -CloseHandles: Detect + self-elevate + DuplicateHandle → JSON   │
│                                                                 │
│ • Scans only blocking PIDs (fast: ~1-2s)                        │
│ • Hidden window (no user-visible progress)                      │
│ • JSON output to stdout                                         │
└─────────────────────────────────────────────────────────────────┘

createBlockingProcessService(processRunner, platformInfo, logger, scriptPath?)
  → WindowsBlockingProcessService if platformInfo.isWindows
  → NoOpBlockingProcessService otherwise
```

### Detection Flow (`-Detect`)

```
blocking-processes.ps1 -BasePath "C:\workspace" -Detect
    │
    ├─► Restart Manager API (get blocking PIDs)
    │     RmStartSession()
    │     RmRegisterResources(files in workspace)
    │     RmGetList() → process list with PID, Name, CommandLine
    │     RmEndSession()
    │
    ├─► NtQuerySystemInformation (for blocking PIDs only - FAST)
    │     SystemHandleInformation → all handles
    │     Filter by blocking PIDs (HashSet lookup)
    │     NtQueryObject → file path
    │     Convert NT path → DOS path
    │     Filter: under workspace?
    │
    └─► CWD Detection (for each blocking PID)
          NtQueryInformationProcess(ProcessBasicInformation)
            → PEB → ProcessParameters → CurrentDirectory.DosPath
          Check if CWD is under workspace path
    │
    └─► Output JSON: {"blocking": [...]}  (includes files[] and cwd)
```

### Handle Closing Flow (`-CloseHandles`)

```
blocking-processes.ps1 -BasePath "C:\workspace" -CloseHandles
    │
    ├─► Detection phase (same as -Detect, ~1-2s)
    │     Returns blocking PIDs
    │
    ├─► Check elevation
    │     │
    │     ├─► Not admin? Re-launch self elevated:
    │     │     Start-Process -Verb RunAs -WindowStyle Hidden
    │     │         └─► UAC Prompt
    │     │               │
    │     │               └─► Elevated instance continues below
    │     │
    │     └─► Already admin? Continue
    │
    └─► Close handles (for blocking PIDs only - FAST)
          For each handle belonging to blocking PID:
            OpenProcess(pid)
            DuplicateHandle(DUPLICATE_CLOSE_SOURCE)
    │
    └─► Output JSON: {"blocking": [...], "closed": [...]}
```

### Deletion Flow Integration

```
remove(path, { keepBranch, unblock })
        │
        ▼
    if (unblock === "kill") killProcesses(pids)
    else if (unblock === "close") closeHandles(path)
        │
        ▼
    proceed with deletion (kill-terminals → stop-server → cleanup-vscode → cleanup-workspace)
        │
        ▼
    on cleanup-workspace failure:
        Check error.code for EBUSY/EACCES/EPERM
        detect(path) → BlockingProcess[]
        emit DeletionProgress { blockingProcesses: [...], hasErrors: true }
```

### PowerShell Script Design

Single script `resources/scripts/blocking-processes.ps1` handles both detection and handle closing:

```
blocking-processes.ps1 -BasePath "C:\path" -Detect        # Detection only
blocking-processes.ps1 -BasePath "C:\path" -CloseHandles  # Detect + elevate + close
```

| Mode            | Elevation             | Window | Output         |
| --------------- | --------------------- | ------ | -------------- |
| `-Detect`       | None                  | Hidden | JSON to stdout |
| `-CloseHandles` | Self-elevates via UAC | Hidden | JSON to stdout |

**Self-elevation flow** (for `-CloseHandles`):

1. Script starts non-elevated
2. Detects blocking processes (fast, ~1-2s)
3. Checks if admin, if not → re-launches self with `-Verb RunAs`
4. Elevated instance closes handles for detected PIDs only
5. Returns combined JSON result

### JSON Output Schema

**`-Detect` output:**

```json
{
  "blocking": [
    {
      "pid": 1234,
      "name": "Code.exe",
      "commandLine": "C:\\Program Files\\VS Code\\Code.exe --folder ...",
      "files": ["src/index.ts", "package.json"],
      "cwd": null
    },
    {
      "pid": 5678,
      "name": "powershell.exe",
      "commandLine": "powershell.exe",
      "files": [],
      "cwd": "subdir"
    }
  ]
}
```

**`-CloseHandles` output:**

```json
{
  "blocking": [
    {
      "pid": 1234,
      "name": "Code.exe",
      "commandLine": "...",
      "files": ["src/index.ts"],
      "cwd": null
    },
    {
      "pid": 5678,
      "name": "powershell.exe",
      "commandLine": "powershell.exe",
      "files": [],
      "cwd": "subdir"
    }
  ],
  "closed": ["C:\\workspace\\src\\index.ts"]
}
```

**Error output:**

```json
{
  "error": "UAC cancelled by user"
}
```

**Schema notes:**

- `blocking[].files` - paths **relative to workspace** (max 20 per process)
- `blocking[].cwd` - path **relative to workspace** if process CWD is within workspace, `null` otherwise
- `closed` - **absolute paths** of file handles closed (only present with `-CloseHandles`)
- `error` - present on failure, other fields may be absent

**Operation behavior:**

| Field State              | `closeHandles`           | `killProcesses` |
| ------------------------ | ------------------------ | --------------- |
| `files` not empty        | Closes file handles      | Kills process   |
| `files` empty, `cwd` set | No-op (can't close CWD)  | Kills process   |
| Both `files` and `cwd`   | Closes file handles only | Kills process   |

**Rationale:** Processes with CWD in workspace are typically leftover processes from workspace operations (terminals, build tools, dev servers). Windows prevents directory deletion when any process has CWD there, so these processes must be killed - handles cannot be "closed" for CWD.

### UI Design

```
┌─────────────────────────────────────────────────────────────────┐
│ <Icon name="warning" label="Warning" /> Deletion blocked by     │
│ 3 process(es) holding 5 file(s)                                 │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ role="region" aria-label="Blocking processes and files"     │ │
│ │                                          max-height: 300px  │ │
│ │  Code.exe (PID 1234)                          overflow-y:   │ │
│ │  C:\Program...\Code.exe --folder ...               auto     │ │
│ │    • src/index.ts                                           │ │
│ │    • package.json                                           │ │
│ │                                                             │ │
│ │  node.exe (PID 5678)                                        │ │
│ │  node dist/server.js                                        │ │
│ │    • node_modules/.cache/file.json                          │ │
│ │                                                             │ │
│ │  explorer.exe (PID 9012)                                    │ │
│ │  C:\Windows\explorer.exe                                    │ │
│ │    • (no files detected)                                    │ │
│ │                                                             │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ <vscode-button>Retry</vscode-button>                  primary   │
│ <vscode-button appearance="secondary" class="warning">          │
│   Kill & Retry</vscode-button>                                  │
│ <vscode-button appearance="secondary" class="danger">           │
│   Close Handles & Retry</vscode-button>                         │
│                                                                 │
│                 <vscode-button appearance="secondary">          │
│                   Cancel</vscode-button>               subtle   │
│                                                                 │
│ All buttons disabled during operation, clicked shows spinner    │
│ List has opacity: 0.5 during operation                          │
└─────────────────────────────────────────────────────────────────┘
```

**Display per process:**

- Process name and PID: `Code.exe (PID 1234)`
- Command line: Show first ~30 chars + `...` + last ~20 chars if truncated, full text in `title` tooltip
- If `cwd` set: Show `Working directory: <cwd>/` (with trailing slash to indicate directory)
- List of locked files (relative to workspace, bullet points)
- If both `files` empty and `cwd` null: show `(no files detected)`
- If files > 20: show first 20 + `(and N more files)`

**Example display:**

```
powershell.exe (PID 1234)
  powershell.exe -NoProfile ...
  Working directory: src/components/

Code.exe (PID 5678)
  C:\Program Files\VS Code\Code.exe --folder ...
  • src/index.ts
  • package.json
```

**Button Implementation:**

- All buttons use `<vscode-button>` component (per AGENTS.md)
- **Retry**: Default appearance (primary)
- **Kill & Retry**: `appearance="secondary"` with `.warning-button` class (background: `--ch-warning`)
- **Close Handles & Retry**: `appearance="secondary"` with `.danger-button` class (background: `--ch-danger`)
- **Cancel**: `appearance="secondary"` (subtle styling)

**Accessibility:**

- Scrollable region: `role="region"` with `aria-label="Blocking processes and locked files"`
- Warning icon: `<Icon name="warning" label="Warning" />` (semantic)
- Focus management: On error state, focus Retry button (safest action)

**State Management (Svelte 5):**

```typescript
let activeOp = $state<"retry" | "kill" | "close" | null>(null);
let isOperating = $derived(activeOp !== null);
```

**Button Behaviors:**

- **Retry** (primary): Calls `remove(path, { unblock: false })` - just retry deletion
- **Kill & Retry** (warning): Calls `remove(path, { unblock: "kill" })` - taskkill then retry
- **Close Handles & Retry** (danger): Calls `remove(path, { unblock: "close" })` - elevated handle close then retry (UAC prompt serves as confirmation)
- **Cancel** (subtle): Closes dialog without deleting

## Implementation Steps

### Phase 1: Boundary Service (implement first, user reviews before Phase 2)

- [x] **Step 1: Update types and interfaces**
  - Added `files: readonly string[]` to `BlockingProcess` type
  - Added `UnblockOption` type (`"kill" | "close" | false`)
  - Changed `killBlocking` to `unblock` in electron-api.d.ts
  - Updated preload/index.ts to pass `unblock` through IPC
  - Update `BlockingProcess` to include files array and cwd:
    ```typescript
    interface BlockingProcess {
      readonly pid: number;
      readonly name: string;
      readonly commandLine: string;
      readonly files: readonly string[]; // paths relative to workspace, max 20
      readonly cwd: string | null; // path relative to workspace, or null
    }
    ```
  - Add const assertion for type safety:
    ```typescript
    const UNBLOCK_OPTIONS = ["kill", "close", false] as const;
    type UnblockOption = (typeof UNBLOCK_OPTIONS)[number];
    ```
  - Change `remove()` signature in `electron-api.d.ts`:
    ```typescript
    remove(path: string, options: {
      keepBranch: boolean;
      unblock?: "kill" | "close" | false
    }): Promise<void>
    ```
  - Update `src/preload/index.ts` to pass `unblock` through IPC
  - Files: `src/shared/api/types.ts`, `src/shared/electron-api.d.ts`, `src/preload/index.ts`
  - Test: Types compile

- [x] **Step 2: Update BlockingProcessService interface**
  - Change interface to new method signatures:
    ```typescript
    interface BlockingProcessService {
      detect(path: Path): Promise<BlockingProcess[]>;
      killProcesses(pids: number[]): Promise<void>;
      closeHandles(path: Path): Promise<void>;
    }
    ```
  - Update `NoOpBlockingProcessService` with new methods (all return [] or no-op)
  - Update mock factory with behavioral callbacks:
    ```typescript
    interface MockBlockingProcessServiceOptions {
      readonly processes?: readonly BlockingProcess[];
      readonly onDetect?: (path: Path) => void;
      readonly onKillProcesses?: (pids: number[]) => void;
      readonly onCloseHandles?: (path: Path) => void;
    }
    ```
  - Files: `src/services/platform/blocking-process.ts`, `src/services/platform/blocking-process.test-utils.ts`
  - Test: Focused tests for NoOp

- [x] **Step 3: Create unified PowerShell script asset**
  - Single script: `resources/scripts/blocking-processes.ps1`
  - Parameters: `-BasePath` (required), `-Detect` or `-CloseHandles` (mutually exclusive)
  - Add-Type C# code for:
    - Restart Manager API (RmStartSession, RmRegisterResources, RmGetList, RmEndSession)
    - NtQuerySystemInformation for file enumeration (filtered by blocking PIDs only)
    - NT path → DOS path conversion
    - NtQueryInformationProcess for CWD detection (PEB → ProcessParameters → CurrentDirectory)
    - DuplicateHandle for closing (with `-CloseHandles`)
  - CWD detection: For each blocking PID, read process CWD and check if under workspace
  - Self-elevation: Script checks if admin, re-launches with `-Verb RunAs -WindowStyle Hidden` if needed
  - JSON output to stdout (see JSON Output Schema above)
  - Hidden window: `-WindowStyle Hidden` for both non-elevated and elevated instances
  - Files: `resources/scripts/blocking-processes.ps1`
  - Test: Manual testing with test script

- [x] **Step 4: Update WindowsBlockingProcessService - killProcesses()**
  - Change signature to accept `pids: number[]`
  - Batch PIDs in single taskkill call: `taskkill /pid X /pid Y /t /f`
  - Log stderr as warnings
  - Throw error if taskkill exits non-zero, include failed PIDs in error message
  - Files: `src/services/platform/blocking-process.ts`
  - Test: Integration tests with mocked ProcessRunner

- [x] **Step 5: Implement WindowsBlockingProcessService using script asset**
  - Constructor accepts single `scriptPath?: string` for `blocking-processes.ps1`
  - `detect()`: Runs script with `-Detect`, parses JSON output
  - `closeHandles()`: Runs script with `-CloseHandles`, parses JSON output
  - Logging: Log stdout/stderr only (no temp files)
  - JSON output parsing with type guard validation
  - Timeout: 30s for `-Detect`, 60s for `-CloseHandles` (includes UAC wait)
  - Handle UAC cancellation: `{"error": "UAC cancelled..."}` → throw `UACCancelledError`
  - Files: `src/services/platform/blocking-process.ts`
  - Test: Integration tests with mocked ProcessRunner

- [x] **Step 6: Update exports**
  - Ensure all exports in `src/services/index.ts` are up to date
  - Files: `src/services/index.ts`
  - Test: Types compile

- [x] **Step 7: Add boundary tests for Windows implementation**
  - Use `describe.skipIf(process.platform !== "win32")`
  - Create test helper to spawn blocking process:
    ```typescript
    async function withLockedFile(
      filePath: string,
      fn: (pid: number) => Promise<void>
    ): Promise<void>;
    ```
  - Test detect(): spawn helper process that locks a file, verify JSON output with file paths
  - Test killProcesses(): verify process terminated
  - Test closeHandles(): verify file deletable after (attempts `fs.unlinkSync()`, succeeds without EBUSY)
  - Test script: `scripts/test-close-handles.ts` for manual UAC testing
  - Files: `src/services/platform/blocking-process.boundary.test.ts`, `scripts/test-close-handles.ts`
  - Test: Boundary tests pass on Windows

**>>> USER REVIEW CHECKPOINT: Review boundary implementation before Phase 2 <<<**

### Phase 2: Integration (after user approves Phase 1)

- [ ] **Step 8: Update IPC handler and CoreModule deletion flow**
  - Update IPC handler in `src/main/api/workspace-api.ts` to receive and validate `unblock` parameter
  - Change `killBlocking` handling to `unblock` handling in CoreModule:
    - `unblock: "kill"` → call `killProcesses(pids from previous detect)`
    - `unblock: "close"` → call `closeHandles(path)`
  - Store detected processes: Add `blockingProcesses: BlockingProcess[] | null` to workspace deletion state
  - If closeHandles() completes but deletion still fails, re-run detect() and show updated blockers
  - Files: `src/main/api/workspace-api.ts`, `src/main/modules/core/index.ts`
  - Test: Integration tests verify outcomes (deletion succeeds, not implementation calls)

- [ ] **Step 9: Update DeletionProgressView UI**
  - Replace table with scrollable list:
    - Process name and PID as header
    - Command line (truncated: first 30 + ... + last 20 chars)
    - Files as `<ul>` with `<li>` per file
  - Scrollable container: `max-height: 300px`, `overflow-y: auto`, `role="region"`, `aria-label`
  - Show "Detecting blocking processes..." while detection runs
  - Four buttons using `<vscode-button>`:
    - Retry (default), Kill & Retry (`.warning-button`), Close Handles & Retry (`.danger-button`), Cancel (secondary)
  - CSS: Use `--ch-warning`, `--ch-danger`, `--ch-foreground` variables
  - Button states: disabled during operation, spinner on clicked button
  - List opacity: 0.5 during operation
  - Focus: Move to Retry button when blocking processes appear
  - Files: `src/renderer/lib/components/DeletionProgressView.svelte`
  - Test: Component tests verify UI states and outcomes

- [ ] **Step 10: Update MainView handlers**
  - Update `handleWorkspaceRemove()` to accept `unblock` parameter
  - Pass `unblock` value from clicked button ('kill', 'close', or false)
  - Files: `src/renderer/lib/components/MainView.svelte`
  - Test: Integration tests verify dialog closes on success

- [ ] **Step 11: Documentation updates**
  - `docs/ARCHITECTURE.md`: Add "Three-Operation Model" subsection to BlockingProcessService with workflow diagram
  - `docs/PATTERNS.md`: Add "PowerShell Script Asset Pattern" section documenting:
    - Script location: `resources/scripts/` → copied to `out/main/assets/scripts/` via vite
    - Parameter-based modes (`-Detect`, `-CloseHandles`)
    - Self-elevation pattern for UAC
    - JSON output schema
  - `docs/API.md`: Change `killBlocking` to `unblock` option; document files array in `BlockingProcess`
  - `docs/USER_INTERFACE.md`: Update deletion UI with four-button layout, scrollable file list, accessibility notes
  - `AGENTS.md`: Add "Windows API Integration Pattern" documenting PowerShell + Add-Type as standard approach

## Testing Strategy

### Integration Tests

| #   | Test Case                                | Entry Point                     | Boundary Mocks                             | Behavior Verified                                         |
| --- | ---------------------------------------- | ------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| 1   | detect() parses valid output with files  | `WindowsBlockingProcessService` | ProcessRunner (behavioral)                 | Returns BlockingProcess[] with correct structure          |
| 2   | detect() returns empty on malformed JSON | `WindowsBlockingProcessService` | ProcessRunner                              | Returns [], warning logged                                |
| 3   | detect() returns empty on timeout        | `WindowsBlockingProcessService` | ProcessRunner (instant timeout)            | Returns [] immediately (mock doesn't wait 10s)            |
| 4   | killProcesses() terminates processes     | `WindowsBlockingProcessService` | ProcessRunner                              | Second detect() returns empty (outcome verification)      |
| 5   | closeHandles() releases locks            | `WindowsBlockingProcessService` | ProcessRunner                              | FileSystem deletion succeeds after (outcome verification) |
| 6   | closeHandles() handles UAC cancel        | `WindowsBlockingProcessService` | ProcessRunner (exit 1)                     | Throws UACCancelledError                                  |
| 7   | Factory returns correct impl             | `createBlockingProcessService`  | PlatformInfo                               | Windows→Windows, other→NoOp                               |
| 8   | NoOp detect() returns empty array        | `NoOpBlockingProcessService`    | None                                       | Returns [] on all platforms                               |
| 9   | deletion with unblock:"kill" succeeds    | `workspace.remove()`            | BlockingProcessService, FileSystem         | Deletion completes, dialog closes                         |
| 10  | deletion with unblock:"close" succeeds   | `workspace.remove()`            | BlockingProcessService, FileSystem         | Deletion completes, dialog closes                         |
| 11  | deletion failure shows blockingProcesses | `workspace.remove()`            | FileSystem (EBUSY), BlockingProcessService | UI shows process list with files                          |

**Behavioral Mock Pattern:**

Mocks use factory pattern with configurable responses and state tracking:

```typescript
createMockProcessRunner({
  detectResult: [...],
  killSucceeds: true,
  simulateTimeout: false  // Returns immediately, doesn't actually wait
})
```

Tests verify **outcomes** (deletion succeeded, processes removed) not implementation calls.

### Boundary Tests

| #   | Test Case                                   | Interface       | External System           | Behavior Verified                     |
| --- | ------------------------------------------- | --------------- | ------------------------- | ------------------------------------- |
| 1   | Restart Manager detects blocking process    | detect()        | PowerShell + rstrtmgr.dll | Returns process info                  |
| 2   | NtQuerySystemInformation returns file paths | detect()        | PowerShell + ntdll.dll    | Files array populated                 |
| 3   | NtQueryInformationProcess detects CWD       | detect()        | PowerShell + ntdll.dll    | CWD field populated when in workspace |
| 4   | taskkill terminates process                 | killProcesses() | taskkill.exe              | Process no longer running             |
| 5   | Detection completes < 5s                    | detect()        | PowerShell                | Performance acceptable                |

Note: Boundary tests use `describe.skipIf(process.platform !== "win32")`.

**Manual testing only (requires UAC elevation):**

- `closeHandles()` - tested via `scripts/test-blocking-processes.ts`

**Test Files:**

- `src/services/platform/blocking-process.test.ts` - Tests #1-11
- `src/services/platform/blocking-process.boundary.test.ts` - Windows only, tests #1-5
- `src/renderer/lib/components/DeletionProgressView.test.ts` - UI tests

### UI Integration Tests

| #   | Test Case                             | Category | Component            | Behavior Verified                 |
| --- | ------------------------------------- | -------- | -------------------- | --------------------------------- |
| 1   | Process list renders with files       | UI-state | DeletionProgressView | Scrollable list visible with ARIA |
| 2   | List hidden when no processes         | UI-state | DeletionProgressView | No list rendered                  |
| 3   | Retry succeeds and closes dialog      | API-call | DeletionProgressView | Dialog not visible after          |
| 4   | Kill & Retry succeeds and closes      | API-call | DeletionProgressView | Dialog not visible after          |
| 5   | Close Handles succeeds and closes     | API-call | DeletionProgressView | Dialog not visible after          |
| 6   | Cancel closes dialog                  | API-call | DeletionProgressView | Dialog not visible                |
| 7   | Buttons disabled during operation     | UI-state | DeletionProgressView | disabled attribute set            |
| 8   | Focus moves to Retry on error         | a11y     | DeletionProgressView | Retry button focused              |
| 9   | Screen reader announces process count | a11y     | DeletionProgressView | Live region updated               |

### Manual Testing Checklist

- [ ] Open file in workspace with another editor, try to delete
- [ ] Open terminal with CWD in workspace, try to delete
- [ ] Verify "Detecting blocking processes..." shown during detection
- [ ] Verify process list appears with file paths and/or CWD
- [ ] Verify CWD shows as "Working directory: path/"
- [ ] Verify scrolling works when many files
- [ ] Verify command line truncation shows first+last chars
- [ ] Click "Retry" - verify retry without killing
- [ ] Click "Kill & Retry" - verify processes killed (including CWD-only), deletion completes
- [ ] Click "Close Handles & Retry" - verify UAC prompt, file handles closed, CWD processes remain
- [ ] After "Close Handles & Retry", if CWD processes remain, verify they're shown and "Kill & Retry" works
- [ ] Cancel UAC prompt - verify graceful handling (shows error, can retry)
- [ ] Click "Cancel" - verify dialog closes without deleting
- [ ] Test with multiple blocking processes (mix of file handles and CWD)
- [ ] Test button disabled states and spinners
- [ ] Test list opacity during operation
- [ ] Test on Linux/macOS - verify no blocking processes shown

## Dependencies

| Package | Purpose                                              | Approved |
| ------- | ---------------------------------------------------- | -------- |
| (none)  | Uses built-in Windows APIs via PowerShell + Add-Type | N/A      |

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                               |
| ------------------------ | ------------------------------------------------------------------------------ |
| `docs/ARCHITECTURE.md`   | Add "Three-Operation Model" subsection with detect/kill/close workflow diagram |
| `docs/PATTERNS.md`       | Add "PowerShell + Add-Type Pattern" section with C# API interop example        |
| `docs/API.md`            | Change `killBlocking` to `unblock`; document `files` in `BlockingProcess`      |
| `docs/USER_INTERFACE.md` | Update deletion UI: four buttons, scrollable file list, accessibility          |
| `AGENTS.md`              | Add "Windows API Integration Pattern" section                                  |

### New Documentation Required

None.

## Definition of Done

- [ ] Phase 1 complete (boundary service + tests)
- [ ] User review of Phase 1 passed
- [ ] Phase 2 complete (integration + UI)
- [ ] `npm run validate:fix` passes
- [ ] Blocking processes and files shown in deletion UI on Windows
- [ ] All four buttons work (Retry, Kill & Retry, Close Handles & Retry, Cancel)
- [ ] UAC elevation works for Close Handles
- [ ] NoOp works correctly on Linux/macOS
- [ ] Boundary tests pass on Windows
- [ ] Integration tests complete in <50ms each
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed

---

## Resolved Questions

1. **File path display**: Relative to workspace (calculated using `Path` class)
2. **Empty files array**: Show `(no files detected)` under process info
3. **Handle close partial failure**: Re-run detect() and show updated blocking processes. User can retry or choose different action.

## Proposed Improvements

1. **Retry count/circuit breaker**: Track retry count, show "Attempt 2 of 3". After 3 retries, show "Manual intervention required"
2. **Show detection progress**: Display "Detecting blocking processes..." while PowerShell runs ✓ (included in plan)
3. **Selective process kill**: Let user choose which processes to kill instead of all

## Critiques

1. **PowerShell startup time**: ~200-500ms overhead per operation (acceptable for error path)
2. **Restart Manager limitations**: May not detect kernel-level handles or some services
3. **Handle closing danger**: Closing handles can corrupt application state - user accepts risk (UAC serves as confirmation)
4. **UAC friction**: Elevation prompt is disruptive but necessary for handle closing
5. **Complexity**: Three operations (detect, kill, close) adds complexity vs simpler kill-only approach
6. **NtQuerySystemInformation risks**: Can hang on certain handle types, may need timeout per handle query

## Implementation Notes (Phase 1)

### Key Fixes Made During Development

1. **PIDs > 65535 support**: Changed from `SYSTEM_HANDLE_INFORMATION` (class 16) to `SYSTEM_HANDLE_INFORMATION_EX` (class 64) which uses pointer-sized `UniqueProcessId` instead of `USHORT`

2. **Admin privilege check**: Changed from string `'Administrator'` to enum `[Security.Principal.WindowsBuiltInRole]::Administrator` for reliability

3. **Handle timeout**: Added 100ms timeout to `GetObjectNameWithTimeout()` to prevent hanging on pipes/mailslots

4. **Self-elevation**: Script correctly self-elevates via UAC using `Start-Process -Verb RunAs -WindowStyle Hidden`

5. **Parameter syntax**: Plan showed `-Detect` and `-CloseHandles` as bare switches, but implementation uses `-Action Detect` and `-Action CloseHandles` with ValidateSet for cleaner validation

### Test Results

```
Detected 1 blocking process(es):
  - Windows PowerShell (PID 87628)
    CWD: subdir
    Files: subdir\locked-file.txt, subdir

closeHandles() completed successfully!
Closed file handles { closedCount: 2 }
```
