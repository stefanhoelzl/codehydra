---
status: COMPLETED
last_updated: 2025-12-16
reviewers: [review-typescript, review-arch, review-testing, review-docs]
note: Simplified implementation - partition isolation and about:blank navigation only (no OpenCode process killing, no VS Code storage tracking)
---

# WORKSPACE_SESSION_ISOLATION

## Overview

- **Problem**: When a workspace is deleted, resources are not properly cleaned up:
  1. All workspace views share the same Electron session (localStorage leaks between workspaces)
  2. Views are destroyed without navigating away first (potential resource leaks)

- **Solution**: Implement session isolation and clean view destruction:
  1. Use per-workspace Electron partitions for session isolation
  2. Navigate to `about:blank` before destroying views
  3. Clear Electron partition storage via `session.clearStorageData()` API

- **Scope Reduction**: The following features were considered but NOT implemented:
  - OpenCode process killing (ProcessKiller) - Complexity not justified; OpenCode handles its own lifecycle
  - VS Code workspaceStorage cleanup (VscodeStorageTracker) - Hash detection is fragile; storage is small and can be manually cleaned

- **Risks**:
  - Existing workspaces created before this change won't have partition storage to clean up (graceful degradation)
  - Partition storage clearing timing: handled by using Electron's official API instead of manual deletion

- **Alternatives Considered**:
  - Using in-memory partitions (`workspace-<hash>` without `persist:`): Rejected because we want VS Code state to persist across app restarts
  - Manual partition directory deletion: Rejected - use Electron's `session.clearStorageData()` for correct timing and lock handling

## Architecture

```
Workspace Deletion Flow
=======================

┌─────────────────────────────────────────────────────────────────┐
│ codehydra-api.remove()                                          │
│     │                                                           │
│     ├─► git worktree remove                                     │
│     │                                                           │
│     └─► await appState.removeWorkspace(workspacePath)           │
│             │                                                   │
│             ├─► agentStatusManager.removeWorkspace()            │
│             │       └─► provider.dispose() (disconnect SSE)     │
│             │                                                   │
│             └─► await viewManager.destroyWorkspaceView()        │
│                     │                                           │
│                     ├─► view.webContents.loadURL('about:blank') │
│                     │       └─► await with NAVIGATION_TIMEOUT_MS│
│                     ├─► unregister from shortcutController      │
│                     ├─► remove from maps                        │
│                     ├─► window.contentView.removeChildView()    │
│                     ├─► session.clearStorageData()              │
│                     └─► view.webContents.close()                │
└─────────────────────────────────────────────────────────────────┘
```

## Partition Storage

```
Partition Naming Convention:
  persist:<project-dir-name>/<workspace-name>

Example:
  Project: /home/user/repos/my-app
  Workspace: feature-auth
  Partition: persist:my-app-a1b2c3d4/feature-auth

Partition Name Generation:
  Use projectDirName() from src/services/platform/paths.ts
  (sanitizes project name and adds hash for uniqueness)

Storage Clearing:
  Use Electron's session.fromPartition(partitionName).clearStorageData()
  This is the official API and handles timing/locks correctly.

Benefits:
  - Each workspace has isolated localStorage, cookies, cache
  - VS Code state persists across app restarts (persist: prefix)
  - Clean separation prevents data leakage between workspaces
```

## Implementation Summary

### Implemented Features

1. **Per-workspace Electron partitions** (ViewManager)
   - Partition name: `persist:<projectDirName>/<workspaceName>`
   - Set in `webPreferences.partition` when creating WebContentsView
   - Partition name stored in map for cleanup

2. **About:blank navigation before destruction** (ViewManager)
   - `destroyWorkspaceView()` navigates to `about:blank` before closing
   - Uses timeout to prevent hanging on unresponsive views
   - Ensures clean resource release

3. **Partition storage clearing** (ViewManager)
   - Calls `session.fromPartition(name).clearStorageData()` on destruction
   - Best-effort: errors logged but don't block cleanup

### Files Changed

| File                                          | Changes                                 |
| --------------------------------------------- | --------------------------------------- |
| `src/main/managers/view-manager.ts`           | Partition support, about:blank, cleanup |
| `src/main/managers/view-manager.interface.ts` | Updated interface for async destroy     |
| `src/main/managers/view-manager.test.ts`      | Tests for partition and cleanup         |
| `src/main/app-state.ts`                       | Pass project path to ViewManager        |
| `src/main/app-state.test.ts`                  | Updated tests                           |

## Testing Strategy

### Unit Tests

| Test Case                        | Description                      | File                   |
| -------------------------------- | -------------------------------- | ---------------------- |
| partition name generation        | Format: `persist:<proj>/<ws>`    | `view-manager.test.ts` |
| partition special chars          | Handles spaces, unicode          | `view-manager.test.ts` |
| destroyWorkspaceView about:blank | Navigates before close           | `view-manager.test.ts` |
| destroyWorkspaceView timeout     | Continues after timeout          | `view-manager.test.ts` |
| partition storage clearing       | Calls session.clearStorageData() | `view-manager.test.ts` |
| partition map cleanup            | Removes entry after clearing     | `view-manager.test.ts` |

### Manual Testing Checklist

- [ ] Create two workspaces, store different values in localStorage, verify they're isolated
- [ ] Verify partition storage path: `ls -la app-data/electron/Partitions/`
- [ ] Delete a workspace, verify:
  - [ ] Partition storage cleared (directory may still exist but empty)
  - [ ] Other workspaces' localStorage unaffected
- [ ] Restart app, verify persisted localStorage data still isolated per workspace

## Definition of Done

- [x] Per-workspace Electron partitions implemented
- [x] About:blank navigation before view destruction
- [x] Partition storage clearing via Electron API
- [x] All unit tests pass
- [x] `npm run validate:fix` passes
- [ ] Documentation updated (ARCHITECTURE.md, AGENTS.md)
- [ ] User acceptance testing passed (manual checklist)
