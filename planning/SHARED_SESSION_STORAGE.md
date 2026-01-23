---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-23
reviewers: []
---

# SHARED_SESSION_STORAGE

## Overview

- **Problem**: VS Code extension `globalState` and `secretStorage` are not shared across workspaces. When a user configures an extension (e.g., enters API keys, sets preferences) in one workspace, that configuration is not available in other workspaces. Users must reconfigure extensions in each workspace.

- **Solution**: Change from per-workspace Electron session partitions to a single shared global session. Currently each workspace uses `persist:<projectDirName>/<workspaceName>` as its partition. The change uses `persist:codehydra-global` for all workspaces, causing all browser-based storage (IndexedDB, localStorage, cookies) to be shared.

- **Risks**:
  | Risk | Likelihood | Impact | Mitigation |
  |------|------------|--------|------------|
  | VS Code workspace state leaks between workspaces | Medium | Low | VS Code uses folder path for workspace-specific state; shared session affects browser storage not VS Code's workspace state model |
  | Extension workspace-specific data shared unexpectedly | Low | Low | Most extensions use `workspaceState` API (file-based) not browser storage for per-workspace data |
  | Existing workspace sessions not migrated | High | Medium | Accept data loss on first run after update. **Data lost includes**: VS Code globalState (extension settings, API keys), cookies (authentication tokens), localStorage (cached data). Document in release notes with migration guidance. |

- **Alternatives Considered**:
  1. **Storage sync mechanism**: Implement IPC-based sync between sessions for globalState/secrets only. Rejected: High complexity, potential race conditions, modifying code-server not possible.
  2. **Custom storage proxy**: Intercept storage calls and redirect to shared store. Rejected: Would require modifying code-server internals.
  3. **Keep per-workspace isolation**: Status quo. Rejected: User explicitly wants shared storage.

## Architecture

```
BEFORE (Current):
┌─────────────────────────────────────────────────────────────────────┐
│ Workspace A                     │ Workspace B                       │
│ partition: persist:proj/ws-a    │ partition: persist:proj/ws-b      │
│ ┌─────────────────────────────┐ │ ┌─────────────────────────────┐   │
│ │ IndexedDB, localStorage     │ │ │ IndexedDB, localStorage     │   │
│ │ (globalState, secrets)      │ │ │ (globalState, secrets)      │   │
│ └─────────────────────────────┘ │ └─────────────────────────────┘   │
│           ISOLATED              │           ISOLATED                │
└─────────────────────────────────┴───────────────────────────────────┘

AFTER (Proposed):
┌─────────────────────────────────────────────────────────────────────┐
│                    ALL WORKSPACES                                   │
│            partition: persist:codehydra-global                      │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │         IndexedDB, localStorage (globalState, secrets)          │ │
│ │                         SHARED                                  │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Workspace A  │  │ Workspace B  │  │ Workspace C  │              │
│  │ ?folder=/a   │  │ ?folder=/b   │  │ ?folder=/c   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│  code-server uses folder path for workspace-specific state          │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Points:**

- All WebContentsViews share the same Electron session
- Session storage (IndexedDB, localStorage, cookies) becomes global
- code-server distinguishes workspaces via the `?folder=` URL parameter
- VS Code's workspace-specific state uses the folder path, not browser storage

**Session Lifecycle:**

- `SessionLayer.fromPartition()` returns the same handle for `persist:codehydra-global` across all workspaces
- `SessionLayer.dispose()` on app shutdown will clear the global session (existing behavior preserved)
- Per-workspace `clearStorageData()` is skipped to preserve shared data

## Testing Strategy

### Integration Tests

Test behavior through ViewManager with SessionLayer mock. Tests verify **behavioral outcomes** (shared storage behavior) rather than implementation calls.

| #   | Test Case                                      | Entry Point                                                         | Boundary Mocks | Behavior Verified                                                                                                                                                                  |
| --- | ---------------------------------------------- | ------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Workspaces share session storage               | `ViewManager.createWorkspaceView()` (2 workspaces)                  | SessionLayer   | Both workspaces receive the same `SessionHandle.id`, verifying they share the same session instance                                                                                |
| 2   | Session data persists after workspace deletion | `ViewManager.destroyWorkspaceView()` then check remaining workspace | SessionLayer   | After deleting workspace A, workspace B's session still has `cleared: false`, verifying data was not cleared: `expect(sessionLayer).toHaveSession(handleB.id, { cleared: false })` |
| 3   | Upgrade from old partitions (migration)        | Create workspace after old partition data exists                    | SessionLayer   | New workspace uses global partition; old per-workspace partitions are not accessed                                                                                                 |

### Manual Testing Checklist

- [ ] Create workspace A, configure an extension with secrets (e.g., GitHub Copilot, API key)
- [ ] Create workspace B in same project, verify extension has the secrets
- [ ] Create workspace C in different project, verify extension has the secrets
- [ ] Close and reopen CodeHydra, verify secrets persist
- [ ] Delete a workspace, verify other workspaces still have secrets
- [ ] Verify VS Code workspace-specific state (open files, cursor) is per-workspace

## Implementation Steps

- [x] **Step 1: Add global partition constant and modify partition naming**
  - Add constant: `export const GLOBAL_SESSION_PARTITION = "persist:codehydra-global";`
  - Change `partitionName` from `persist:${projectDirName(projectPath)}/${workspaceName}` to use the constant
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: Integration test verifies both workspaces receive same SessionHandle.id

- [x] **Step 2: Update session cleanup logic**
  - Since all workspaces share one session, we should NOT clear storage when deleting a workspace
  - Modify `destroyWorkspaceView()` to skip `clearStorageData()` call
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: Integration test verifies session data persists after workspace deletion (session `cleared` remains `false`)

- [x] **Step 3: Keep partition tracking for debugging**
  - Keep the `partitionName` field in `WorkspaceState` for logging and debugging purposes
  - The value will be constant (`GLOBAL_SESSION_PARTITION`) but useful for diagnostics
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: Code review, logging still shows partition name

- [x] **Step 4: Update integration tests**
  - Update `view-manager.integration.test.ts` to expect shared partition
  - Replace per-workspace isolation tests with behavioral tests for shared session
  - Add test verifying same SessionHandle.id returned for multiple workspaces
  - Add test verifying session data persists after workspace deletion
  - Files affected: `src/main/managers/view-manager.integration.test.ts`
  - Test criteria: All tests pass, behavioral coverage maintained

- [x] **Step 5: Update documentation**
  - Rename "Workspace Session Isolation" section to "Workspace Session Model"
  - Document the new shared session model and its implications
  - Update "View Destruction Cleanup" subsection to reflect that `clearStorageData()` is no longer called per-workspace
  - Remove per-workspace partition examples
  - Add simplified before/after diagram from this plan
  - Files affected: `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects implementation

- [x] **Step 6: Add release notes entry**
  - Document the breaking change and migration impact
  - Files affected: GitHub Release notes (no dedicated CHANGELOG.md in this project)
  - Release notes wording (to be added to GitHub Release):
    > **Breaking Change**: Extension storage is now shared across all workspaces. Existing per-workspace settings will be lost on first launch after this update. You will need to reconfigure extension settings (API keys, preferences) once in any workspace, and they will automatically be available in all workspaces.
  - Test criteria: Release notes reviewed before release

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Rename "Workspace Session Isolation" to "Workspace Session Model". Update to describe shared global session with workspace identification via folder path. Update "View Destruction Cleanup" to reflect no per-workspace storage clearing. Remove per-workspace partition examples. Add before/after diagram. |

### New Documentation Required

| File   | Purpose                           |
| ------ | --------------------------------- |
| (none) | No new documentation files needed |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] Release notes entry added
- [ ] Manual testing: Extension secrets from Workspace A visible in Workspace B
- [ ] Manual testing: VS Code workspace-specific state (open files) remains per-workspace
- [ ] CI passed
