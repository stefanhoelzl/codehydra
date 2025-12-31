---
status: USER_TESTING
last_updated: 2025-12-31
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

> **Current State**: Phase 3 complete - Proactive blocking process detection implemented.

# HANDLES_BLOCKING_DELETION

## Overview

- **Problem**: Workspace deletion fails on Windows when processes hold file handles. Users see generic errors with no actionable info.
- **Solution**: Detect blocking processes and their locked files via Windows APIs (Restart Manager + NtQuerySystemInformation), show detailed scrollable list, offer resolution options via split button dropdown.
- **Platform**: Windows only (Linux/macOS skip detection steps)
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

**Request**: Add `WorkspaceLockHandler` as a new boundary interface.

- **External system**: Windows APIs via PowerShell + Add-Type (C# interop)
  - Restart Manager API (rstrtmgr.dll) for process detection
  - NtQuerySystemInformation for file handle enumeration
  - DuplicateHandle for handle closing (elevated)
- **Why existing interfaces don't cover**: ProcessRunner spawns processes but doesn't provide Windows-specific handle detection
- **Pattern followed**: Interface + factory + platform implementations (like `FileSystemLayer`, `HttpClient`)

### API/IPC Interface Changes

**Request**: Modify existing IPC interfaces.

| Change                                                                       | Files Affected                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Add `BlockingProcess` type with `files` array                                | `src/shared/api/types.ts`                              |
| Add `blockingProcesses?` to `DeletionProgress`                               | `src/shared/api/types.ts`                              |
| Change `killBlocking?: boolean` to `unblock?: "kill" \| "close" \| "ignore"` | `src/shared/electron-api.d.ts`, `src/preload/index.ts` |
| Add `detecting-blockers` to `DeletionOperationId`                            | `src/shared/api/types.ts`                              |

**Files requiring atomic update for `unblock` change:**

- `src/shared/electron-api.d.ts` - Type definition
- `src/shared/api/types.ts` - DeletionOperationId type, UnblockOption type
- `src/preload/index.ts` - IPC bridge
- `src/main/api/workspace-api.ts` - IPC handler
- `src/main/modules/core/index.ts` - CoreModule executeDeletion
- `src/main/modules/core/index.integration.test.ts` - CoreModule tests
- `src/renderer/lib/components/MainView.svelte` - Handler calls
- `src/renderer/lib/components/DeletionProgressView.svelte` - Button callbacks

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              WorkspaceLockHandler (interface)                    │
│                                                                  │
│  detect(path: Path): Promise<BlockingProcess[]>                  │
│  killProcesses(pids: number[]): Promise<void>                    │
│  closeHandles(path: Path): Promise<void>  ← spawns elevated      │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
┌─────────────────────────┐           ┌─────────────────────────┐
│ WindowsWorkspaceLock    │           │ (undefined on non-Win)  │
│ Handler                 │           │                         │
│                         │           │ Factory returns         │
│ Uses single script:     │           │ undefined, detection    │
│ blocking-processes.ps1  │           │ steps are skipped       │
│   -Detect               │           │                         │
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

createWorkspaceLockHandler(processRunner, platformInfo, logger, scriptPath?)
  → WindowsWorkspaceLockHandler if platformInfo.isWindows
  → undefined otherwise
```

### Deletion Flow Integration (Phase 3)

```
remove(path, { keepBranch, unblock, isRetry })
        │
        ▼
    if (unblock === "kill" && workspaceLockHandler)
        ├─► Step: killing-blockers
        └─► killProcesses(pids from previous detect)
    else if (unblock === "close" && workspaceLockHandler)
        ├─► Step: closing-handles
        └─► closeHandles(path)
        │
        ▼
    Step: kill-terminals
        │
        ▼
    Step: stop-server
        │
        ▼
    Step: cleanup-vscode
        │
        ▼
    if (workspaceLockHandler && !isRetry && unblock !== "ignore")
        │   // First attempt OR kill/close: run detection
        │   // Retry without action: skip detection
        ├─► Step: detecting-blockers
        ├─► detect(path) → BlockingProcess[]
        └─► if (processes.length > 0)
              ├─► Mark step as "error"
              ├─► Set blockingProcesses
              └─► Emit progress with hasErrors: true
                  (remaining steps stay pending)
        │
        ▼
    Step: cleanup-workspace
        │
        ▼
    Success: emit completed
```

**Flow by scenario:**

| Scenario                    | `unblock`   | `isRetry` | Steps                                                                                                             |
| --------------------------- | ----------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| First attempt (Windows)     | `undefined` | `false`   | kill-terminals → stop-server → cleanup-vscode → **detecting-blockers** → cleanup-workspace                        |
| First attempt (non-Windows) | `undefined` | `false`   | kill-terminals → stop-server → cleanup-vscode → cleanup-workspace                                                 |
| Retry                       | `undefined` | `true`    | kill-terminals → stop-server → cleanup-vscode → cleanup-workspace                                                 |
| Retry + Kill                | `"kill"`    | `false`   | **killing-blockers** → kill-terminals → stop-server → cleanup-vscode → **detecting-blockers** → cleanup-workspace |
| Retry + Close               | `"close"`   | `false`   | **closing-handles** → kill-terminals → stop-server → cleanup-vscode → **detecting-blockers** → cleanup-workspace  |
| Retry + Ignore              | `"ignore"`  | `false`   | kill-terminals → stop-server → cleanup-vscode → cleanup-workspace                                                 |

**Key behaviors:**

- Detection runs **after** our cleanup (terminals, server, vscode) to only detect **external** blockers
- First attempt always runs detection (when `!isRetry && unblock === undefined`)
- Retry button skips detection (`isRetry: true`)
- Kill/Close retries **always detect after** to verify the operation worked
- "Ignore" bypasses detection entirely (power user escape hatch)
- **UX tradeoff**: First deletion takes ~3-5s on Windows (cleanup + detection) before showing blockers. This delay is acceptable for the benefit of detecting external blockers proactively.

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

**Schema notes:**

- `blocking[].files` - paths **relative to workspace** (all files, no limit)
- `blocking[].cwd` - path **relative to workspace** if process CWD is within workspace, `null` otherwise
- `closed` - **absolute paths** of file handles closed (only present with `-CloseHandles`)
- `error` - present on failure, other fields may be absent

### UI Design (Phase 3)

```
┌─────────────────────────────────────────────────────────────────┐
│ <Icon name="warning" label="Warning" /> Deletion blocked by     │
│ 3 process(es) holding 5 file(s)                                 │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ role="region" aria-label="Blocking processes and files"     │ │
│ │                                          max-height: 300px  │ │
│ │                                              overflow-y:    │ │
│ │  Code.exe (PID 1234)                              auto      │ │
│ │  C:\Program...\Code.exe --folder ...                        │ │
│ │    • src/index.ts                                           │ │
│ │    • package.json                                           │ │
│ │    • src/components/App.svelte                              │ │
│ │    • ...all files listed (no truncation)...                 │ │
│ │                                                             │ │
│ │  explorer.exe (PID 9012)                                    │ │
│ │  C:\Windows\explorer.exe                                    │ │
│ │    Working directory: subfolder/                            │ │
│ │                                                             │ │
│ │  node.exe (PID 5678)                                        │ │
│ │  node dist/server.js                                        │ │
│ │    • node_modules/.cache/file1.json                         │ │
│ │    • node_modules/.cache/file2.json                         │ │
│ │    • ...more files...                                       │ │
│ │                                                             │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────┐                                   │
│  │ Retry                  ▼ │      <vscode-button secondary     │
│  ├──────────────────────────┤        title="Close dialog.       │
│  │ Kill Processes          │        Workspace will be removed   │
│  │ Close Handles           │        from CodeHydra, but         │
│  │ Ignore Blockers         │        blocking processes and      │
│  └──────────────────────────┘        files may remain on disk.">│
│                                      Dismiss                    │
│                                    </vscode-button>             │
│                                                                 │
│ Split button disabled during operation, spinner on main button  │
│ List has opacity: 0.5 during operation                          │
└─────────────────────────────────────────────────────────────────┘
```

**Key UI points:**

- **Single scrollable region** for all processes and their files (no nested scrollable areas)
- `max-height: 300px` with `overflow-y: auto` on the entire blocking processes container
- All files listed per process (no truncation) - scrolling handles long lists

**Split Button Implementation:**

Uses `<vscode-button-group>` + `<vscode-context-menu>` pattern from vscode-elements.

```svelte
<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { VscContextMenu } from "@vscode-elements/elements";

  interface Props {
    progress: DeletionProgress;
    onRetry: () => void;
    onDismiss: () => void;
    onKillAndRetry: () => void;
    onCloseHandlesAndRetry: () => void;
    onIgnoreBlockers: () => void;
  }

  const {
    progress,
    onRetry,
    onDismiss,
    onKillAndRetry,
    onCloseHandlesAndRetry,
    onIgnoreBlockers,
  }: Props = $props();

  let isOperating = $state(false);
  let menuRef = $state<VscContextMenu | null>(null);

  // Menu option type for type safety
  interface RetryMenuOption {
    readonly label: string;
    readonly value: "kill" | "close" | "ignore";
  }

  const menuOptions: readonly RetryMenuOption[] = [
    { label: "Kill Processes", value: "kill" },
    { label: "Close Handles", value: "close" },
    { label: "Ignore Blockers", value: "ignore" },
  ];

  // Initialize menu data when ref is available
  $effect(() => {
    if (menuRef) {
      menuRef.data = [...menuOptions];
    }
  });

  function toggleMenu() {
    if (menuRef) {
      menuRef.show = !menuRef.show;
    }
  }

  function handleMenuSelect(e: CustomEvent<{ value: string }>) {
    if (menuRef) {
      menuRef.show = false; // Close menu after selection
    }

    const value = e.detail.value;
    if (value === "kill") onKillAndRetry();
    else if (value === "close") onCloseHandlesAndRetry();
    else if (value === "ignore") onIgnoreBlockers();
  }
</script>

<div class="button-with-menu">
  <vscode-button-group>
    <vscode-button onclick={onRetry} disabled={isOperating}>
      {#if isOperating}<Icon name="loading" spin />{/if}
      Retry
    </vscode-button>
    <vscode-button
      icon="chevron-down"
      title="More retry options"
      onclick={toggleMenu}
      disabled={isOperating}
    ></vscode-button>
  </vscode-button-group>
  <vscode-context-menu bind:this={menuRef} class="dropdown-menu" on:vsc-select={handleMenuSelect}
  ></vscode-context-menu>
</div>

<vscode-button
  secondary
  onclick={onDismiss}
  disabled={isOperating}
  title="Close dialog. Workspace will be removed from CodeHydra, but blocking processes and files may remain on disk."
>
  Dismiss
</vscode-button>

<style>
  .button-with-menu {
    display: inline-block;
    position: relative;
  }

  /* Note: vscode-context-menu may have built-in positioning.
     Test and adjust if needed. May need position: fixed with
     getBoundingClientRect() coordinates if absolute doesn't work. */
  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 10;
  }
</style>
```

**Display per process:**

- Process name and PID: `Code.exe (PID 1234)`
- Command line: Show first ~30 chars + `...` + last ~20 chars if truncated, full text in `title` tooltip
- If `cwd` set: Show `Working directory: <cwd>/` (with trailing slash to indicate directory)
- List of locked files: All files shown (no truncation), entire region scrolls
- If both `files` empty and `cwd` null: show `(no files detected)`

**Button Behaviors:**

| Action              | Calls                                 | Detection                   |
| ------------------- | ------------------------------------- | --------------------------- |
| Retry (main button) | `remove(path, { isRetry: true })`     | Skipped (user claims fixed) |
| Kill Processes      | `remove(path, { unblock: "kill" })`   | After kill, verify          |
| Close Handles       | `remove(path, { unblock: "close" })`  | After close, verify         |
| Ignore Blockers     | `remove(path, { unblock: "ignore" })` | Skipped entirely            |
| Dismiss             | Close dialog, no further deletion     | N/A                         |

## Implementation Steps

### Phase 1-2: Complete (see previous sections)

### Phase 3: Proactive Detection & UI Simplification

- [x] **Step 12: Rename BlockingProcessService to WorkspaceLockHandler**
  - Rename interface: `BlockingProcessService` → `WorkspaceLockHandler`
  - Rename Windows implementation: `WindowsBlockingProcessService` → `WindowsWorkspaceLockHandler`
  - Rename factory: `createBlockingProcessService` → `createWorkspaceLockHandler`
  - Rename mock factory: `createMockBlockingProcessService` → `createMockWorkspaceLockHandler`
  - Rename test utils file: `blocking-process.test-utils.ts` → `workspace-lock-handler.test-utils.ts`
  - Rename main file: `blocking-process.ts` → `workspace-lock-handler.ts`
  - Rename test file: `blocking-process.test.ts` → `workspace-lock-handler.test.ts`
  - Rename boundary test file: `blocking-process.boundary.test.ts` → `workspace-lock-handler.boundary.test.ts`
  - Update all imports across the codebase
  - Update CoreModule dependency: `blockingProcessService` → `workspaceLockHandler`
  - Files: Multiple files across `src/services/platform/`, `src/main/`, `src/services/index.ts`
  - Test: Types compile, all tests pass

- [x] **Step 13: Update types for Phase 3**
  - Update `UNBLOCK_OPTIONS` const array (maintain existing pattern):
    ```typescript
    export const UNBLOCK_OPTIONS = ["kill", "close", "ignore"] as const;
    export type UnblockOption = (typeof UNBLOCK_OPTIONS)[number];
    ```
  - Add `detecting-blockers` to `DeletionOperationId`:
    ```typescript
    type DeletionOperationId =
      | "killing-blockers"
      | "closing-handles"
      | "kill-terminals"
      | "stop-server"
      | "cleanup-vscode"
      | "detecting-blockers" // NEW
      | "cleanup-workspace";
    ```
  - Update `electron-api.d.ts`:
    ```typescript
    remove(path: string, options: {
      keepBranch: boolean;
      unblock?: "kill" | "close" | "ignore";
      isRetry?: boolean;
    }): Promise<void>
    ```
  - Update `preload/index.ts` to pass `unblock` and `isRetry` through IPC
  - Files: `src/shared/api/types.ts`, `src/shared/electron-api.d.ts`, `src/preload/index.ts`
  - Test: Types compile

- [x] **Step 14: Update CoreModule deletion flow for proactive detection**
  - Add `isRetry` parameter to track retry vs first attempt:
    ```typescript
    private async executeDeletion(
      ...args,
      unblock: UnblockOption | undefined,
      isRetry: boolean  // NEW: true when user clicked Retry button
    )
    ```
  - Reorder operations to run detection AFTER our cleanup:
    1. `killing-blockers` / `closing-handles` (only if unblock is "kill" or "close")
    2. `kill-terminals`
    3. `stop-server`
    4. `cleanup-vscode`
    5. `detecting-blockers` (only if workspaceLockHandler exists AND !isRetry AND unblock !== "ignore")
    6. `cleanup-workspace`
  - Add `detecting-blockers` step logic (uses existing helper functions `addOp`, `updateOp`, `emitProgress`):

    ```typescript
    // Run detection on first attempt only (not retry, not ignore)
    if (this.deps.workspaceLockHandler && !isRetry && unblock !== "ignore") {
      addOp("detecting-blockers", "Detecting blocking processes...");
      updateOp("detecting-blockers", "in-progress");
      emitProgress(false, false);

      try {
        const detected = await this.deps.workspaceLockHandler.detect(new Path(workspacePath));
        if (detected.length > 0) {
          blockingProcesses = detected;
          updateOp("detecting-blockers", "error", `Blocked by ${detected.length} process(es)`);
          emitProgress(false, true); // hasErrors: true stops here
          return;
        }
        updateOp("detecting-blockers", "done");
        emitProgress(false, false);
      } catch (error) {
        // Detection error: show warning but continue with deletion
        this.logger.warn("Detection failed, continuing with deletion", {
          error: getErrorMessage(error),
        });
        updateOp("detecting-blockers", "done"); // Mark as done (not error) - detection is best-effort
        emitProgress(false, false);
      }
    }
    ```

  - Update `workspaceRemove` to pass `isRetry: false` for initial call
  - Files: `src/main/modules/core/index.ts`
  - Test: Integration tests verify detection runs at correct point in flow

- [x] **Step 15: Update DeletionProgressView with split button UI**
  - Replace four buttons with split button + Dismiss (see "UI Design (Phase 3)" section for complete code)
  - Key implementation details:
    - Initialize menu data in `$effect` when `menuRef` is available
    - Implement `handleMenuSelect` to close menu and call appropriate handler
    - Use `<Icon name="loading" spin />` for spinner (not `<vscode-icon>`)
    - Add CSS for dropdown positioning (test if absolute works, fall back to fixed + getBoundingClientRect if needed)
  - Single scrollable container for all blocking processes and files (no nested scrolling)
  - Remove old `.warning-button` and `.danger-button` CSS styles (no longer needed)
  - Rename callback: `onCancel` → `onDismiss`
  - Files: `src/renderer/lib/components/DeletionProgressView.svelte`
  - Test: UI tests verify split button and menu behavior

- [x] **Step 16: Update MainView handlers for new unblock options**
  - Update `handleRetry()` to pass `isRetry: true`
  - Add `handleIgnoreBlockers()` handler that calls `remove(path, { unblock: "ignore" })`
  - Rename `handleCancel` → `handleDismiss`
  - Files: `src/renderer/lib/components/MainView.svelte`
  - Test: Integration tests verify all unblock options work

- [x] **Step 17: Update documentation for Phase 3**
  - `docs/API.md`: Rename to WorkspaceLockHandler, update unblock options, document isRetry
  - `docs/USER_INTERFACE.md`: Replace four-button mockup with split button, document Dismiss tooltip
  - `docs/ARCHITECTURE.md`: Update deletion flow diagram with new step order
  - `docs/PATTERNS.md`: Rename BlockingProcessService to WorkspaceLockHandler
  - Files: `docs/API.md`, `docs/USER_INTERFACE.md`, `docs/ARCHITECTURE.md`, `docs/PATTERNS.md`

## Testing Strategy

### Integration Tests

| #   | Test Case                                     | Entry Point                          | Boundary Mocks                                                         | Behavior Verified                                                                                                   |
| --- | --------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | detect() parses valid output with files       | `WindowsWorkspaceLockHandler`        | ProcessRunner (behavioral)                                             | Returns BlockingProcess[] with correct structure                                                                    |
| 2   | detect() returns empty on malformed JSON      | `WindowsWorkspaceLockHandler`        | ProcessRunner                                                          | Returns [], warning logged                                                                                          |
| 3   | detect() returns empty on timeout             | `WindowsWorkspaceLockHandler`        | ProcessRunner (instant timeout)                                        | Returns [] immediately (mock doesn't wait 10s)                                                                      |
| 4   | killProcesses() terminates processes          | `WindowsWorkspaceLockHandler`        | ProcessRunner                                                          | Second detect() returns empty (outcome verification)                                                                |
| 5   | closeHandles() releases locks                 | `WindowsWorkspaceLockHandler`        | ProcessRunner                                                          | FileSystem deletion succeeds after (outcome verification)                                                           |
| 6   | closeHandles() handles UAC cancel             | `WindowsWorkspaceLockHandler`        | ProcessRunner (exit 1)                                                 | Throws UACCancelledError                                                                                            |
| 7   | Factory returns correct impl                  | `createWorkspaceLockHandler`         | PlatformInfo                                                           | Windows→Windows, other→undefined                                                                                    |
| 8   | deletion with unblock:"kill" succeeds         | `workspace.remove()`                 | WorkspaceLockHandler, FileSystem                                       | Deletion completes, dialog closes                                                                                   |
| 9   | deletion with unblock:"close" succeeds        | `workspace.remove()`                 | WorkspaceLockHandler, FileSystem                                       | Deletion completes, dialog closes                                                                                   |
| 10  | deletion failure shows blockingProcesses      | `workspace.remove()`                 | FileSystem (EBUSY), WorkspaceLockHandler                               | UI shows process list with files                                                                                    |
| 11  | first attempt runs proactive detection        | `workspace.remove()`                 | WorkspaceLockHandler (returns processes)                               | Operations: kill-terminals, stop-server, cleanup-vscode, detecting-blockers in order; errors; blockingProcesses set |
| 12  | retry skips detection                         | `workspace.remove(isRetry:true)`     | WorkspaceLockHandler                                                   | detecting-blockers NOT in operations, cleanup-workspace completes, deletion succeeds                                |
| 13  | kill then detects to verify                   | `workspace.remove(unblock:"kill")`   | WorkspaceLockHandler (behavioral)                                      | killing-blockers completes, detecting-blockers returns empty (mock removes killed PIDs), deletion succeeds          |
| 14  | ignore skips detection                        | `workspace.remove(unblock:"ignore")` | WorkspaceLockHandler                                                   | detecting-blockers NOT in operations, cleanup-workspace completes, deletion succeeds                                |
| 15  | non-Windows skips all detection steps         | `workspace.remove()`                 | workspaceLockHandler: undefined                                        | Operations: [kill-terminals, stop-server, cleanup-vscode, cleanup-workspace] only                                   |
| 16  | proactive detection error allows retry        | `workspace.remove()`                 | WorkspaceLockHandler (detect throws)                                   | detecting-blockers completes (not error), deletion continues, no blockingProcesses shown                            |
| 17  | close handles partial success shows remaining | `workspace.remove(unblock:"close")`  | WorkspaceLockHandler (closeHandles succeeds, detect returns remaining) | closing-handles completes, detecting-blockers finds remaining, error state with updated blocking list               |

**Behavioral Mock Pattern:**

Mocks use factory pattern with configurable responses and **state tracking**:

```typescript
interface MockWorkspaceLockHandlerState {
  readonly initialProcesses: readonly BlockingProcess[];
  killedPids: Set<number>;
  handlesClosed: boolean;
}

createMockWorkspaceLockHandler(options?: {
  initialProcesses?: readonly BlockingProcess[];
  detectThrows?: Error;
  killThrows?: Error;
  closeThrows?: Error;
}): WorkspaceLockHandler & { _getState(): MockWorkspaceLockHandlerState }
```

This ensures `detect()` returns different results after `killProcesses()` or `closeHandles()` (behavioral simulation).

**Performance requirement**: All mocks return immediately (no actual waits). All Phase 3 integration tests complete in <50ms.

Tests verify **outcomes** (deletion succeeded, processes removed) not implementation calls.

**Test file locations:**

- Tests #1-17: `src/main/modules/core/index.integration.test.ts`
- UI tests: `src/renderer/lib/components/DeletionProgressView.test.ts`

### UI Integration Tests

| #   | Test Case                           | Category | Component            | Behavior Verified                                                    |
| --- | ----------------------------------- | -------- | -------------------- | -------------------------------------------------------------------- |
| 1   | Process list renders with files     | UI-state | DeletionProgressView | Single scrollable list visible with ARIA                             |
| 2   | List hidden when no processes       | UI-state | DeletionProgressView | No list rendered                                                     |
| 3   | Retry button triggers retry         | API-call | DeletionProgressView | Calls onRetry                                                        |
| 4   | Kill menu item triggers kill        | API-call | DeletionProgressView | Calls onKillAndRetry                                                 |
| 5   | Close menu item triggers close      | API-call | DeletionProgressView | Calls onCloseHandlesAndRetry                                         |
| 6   | Ignore menu item triggers ignore    | API-call | DeletionProgressView | Calls onIgnoreBlockers                                               |
| 7   | Dismiss button closes dialog        | API-call | DeletionProgressView | Calls onDismiss                                                      |
| 8   | Split button disabled during op     | UI-state | DeletionProgressView | disabled attribute set                                               |
| 9   | Focus moves to Retry on error       | a11y     | DeletionProgressView | Retry button focused                                                 |
| 10  | Menu opens on chevron click         | UI-state | DeletionProgressView | Context menu visible with 3 items: Kill, Close, Ignore               |
| 11  | Menu closes after selection         | UI-state | DeletionProgressView | Context menu hidden, action triggered                                |
| 12  | Dismiss button has tooltip          | a11y     | DeletionProgressView | title attribute present                                              |
| 13  | detecting-blockers shows progress   | UI-state | DeletionProgressView | "Detecting blocking processes..." visible during in-progress         |
| 14  | CWD-only process shows working dir  | UI-state | DeletionProgressView | Process with empty files and non-null cwd shows "Working directory:" |
| 15  | Command line truncated with tooltip | UI-state | DeletionProgressView | Long command shows first 30 + "..." + last 20, title has full text   |
| 16  | Empty files and null cwd            | UI-state | DeletionProgressView | Process shows "(no files detected)"                                  |

### Manual Testing Checklist

**Phase 3 (new):**

- [ ] First deletion attempt shows "Detecting blocking processes..." step
- [ ] Detection finds external process → fails early with blocking UI
- [ ] Click "Retry" → skips detection, attempts deletion
- [ ] Click dropdown → "Kill Processes" → kills then detects then deletes
- [ ] Click dropdown → "Close Handles" → UAC prompt, closes then detects then deletes
- [ ] Click dropdown → "Ignore Blockers" → skips detection entirely
- [ ] Click "Dismiss" → closes dialog, workspace removed from sidebar
- [ ] Verify Dismiss button has tooltip explaining leftovers
- [ ] Verify split button disabled during operation
- [ ] Verify spinner on main button during operation
- [ ] Test dropdown positioning (should appear below button)
- [ ] Test keyboard navigation in dropdown menu (↑↓ arrows, Enter, Escape)
- [ ] Non-Windows: verify no "Detecting..." step appears
- [ ] Detection timeout: verify deletion continues with warning

## Definition of Done

**Phase 3:**

- [ ] BlockingProcessService renamed to WorkspaceLockHandler
- [ ] Proactive detection runs on first attempt (Windows only)
- [ ] Detection runs AFTER our cleanup (terminals, server, vscode)
- [ ] Retry skips detection (isRetry: true)
- [ ] Kill/Close runs operation then detects to verify
- [ ] Ignore Blockers skips detection entirely
- [ ] Split button UI with dropdown menu
- [ ] Dismiss button with tooltip explaining leftovers
- [ ] Single scrollable container for all processes/files
- [ ] All menu options work correctly
- [ ] Non-Windows skips all detection steps
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed

---

## Resolved Questions

1. **File path display**: Relative to workspace (calculated using `Path` class)
2. **Empty files array**: Show `(no files detected)` under process info
3. **Handle close partial failure**: Re-run detect() and show updated blocking processes
4. **Proactive detection timing**: Run AFTER our cleanup (terminals, server, vscode) to only detect EXTERNAL blockers
5. **Retry behavior**: Skip detection on retry (`isRetry: true`)
6. **Ignore option**: Skip detection entirely as escape hatch for false positives
7. **Service naming**: `WorkspaceLockHandler` - describes what it handles (workspace locks)
8. **Dismiss button**: Replaces "Cancel" with tooltip explaining workspace removal and potential leftovers
9. **File list display**: Single scrollable container for all processes and files (no nested scrolling, no truncation)
10. **unblock type**: Simplified to `"kill" | "close" | "ignore" | undefined`; use `isRetry` flag for retry distinction
