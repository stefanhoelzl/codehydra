---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-02-08
reviewers: [review-arch, review-quality, review-testing, review-ui]
---

# WORKSPACE_DELETE_INTENT

## Overview

- **Problem**: `workspace:delete` is a ~300-line monolithic method in CoreModule (`executeDeletion`), inconsistent with the intent-based architecture used by all other workspace operations. It also duplicates cleanup logic with `appState.removeWorkspace()`.
- **Solution**: Migrate to a single `workspace:delete` intent with 3 hook points (`shutdown` → `release` → `delete`), an idempotency interceptor, and event subscribers for post-deletion state cleanup. Force-remove becomes a `force: true` flag on the same intent — modules check this flag and ignore errors when set.
- **Interfaces**:
  - IPC `workspaces.remove` return type widens: `Promise<{started: true}>` → `Promise<{started: boolean}>` (false when interceptor blocks)
  - IPC `workspaces.forceRemove` removed — merged into `workspaces.remove` via `force?: boolean` payload field
  - `appState.removeWorkspace()` deleted — replaced by hook modules + event subscribers
  - New domain event: `workspace:deleted`
- **Risks**:
  - Duplicate cleanup: current `appState.removeWorkspace()` overlaps with `executeDeletion` (both call stopServer, destroyView). Must ensure no double-execution during migration.
  - Progress format: renderer expects specific `DeletionProgress` shape with existing `DeletionOperationId` values. Must preserve exact format.
  - Windows-specific paths: blocker detection/killing logic is complex. Must preserve exact behavior.
- **Alternatives Considered**:
  - Fine-grained hooks (7+ hook points mirroring each step): rejected for complexity and tight coupling to implementation details.
  - Two-phase hooks (cleanup/remove only): rejected for insufficient separation of Windows-specific concerns.
  - Operation skips hooks on force (vs modules self-skip): rejected because modules owning their force behavior is more flexible and keeps the operation simple.

### Pre-approved Interface Changes

The following IPC/API changes were explicitly approved by the user during planning:

- **IPC return type**: `workspaces.remove` widened from `Promise<{started: true}>` to `Promise<{started: boolean}>`
- **IPC channel removed**: `api:workspace:force-remove` (`ApiIpcChannels.WORKSPACE_FORCE_REMOVE`)
- **API method removed**: `IWorkspaceApi.forceRemove()` — merged into `remove()` with `force?: boolean`
- **Payload field added**: `force?: boolean` on `WorkspaceRemovePayload`
- **Method deleted**: `appState.removeWorkspace()` — replaced by intent modules + event subscribers

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         IPC Handler                              │
│  "workspaces.remove" → dispatch(workspace:delete intent)         │
│  Returns { started: true } on success (result !== undefined)     │
│  Returns { started: false } if interceptor blocks (undefined)    │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Dispatcher Pipeline                            │
│                                                                  │
│  1. Interceptors ─► IdempotencyInterceptor                       │
│     │  FIRST: if intent.type !== "workspace:delete", pass through│
│     │  Check inProgressDeletions, return null if duplicate       │
│     │  Allow if force=true regardless                            │
│     │  Set in-progress flag                                      │
│     ▼                                                            │
│  2. Operation ─► DeleteWorkspaceOperation                        │
│     │  Returns { started: true } (not void, for disambiguation)  │
│     │                                                            │
│     ├── Hook: "shutdown"  (all handlers independent)             │
│     │   ├── ViewModule: switch workspace + destroy view          │
│     │   └── AgentModule: kill terminals + stop server            │
│     │                    + clear MCP + clear TUI                 │
│     │                                                            │
│     ├── emit progress (after shutdown)                           │
│     │                                                            │
│     ├── check ctx.error → if set, skip remaining hooks           │
│     │                                                            │
│     ├── Hook: "release"  (Windows-only)                          │
│     │   └── WindowsLockModule: detect + kill/close blockers      │
│     │                                                            │
│     ├── emit progress (after release)                            │
│     │                                                            │
│     ├── check ctx.error → if set, skip delete hook               │
│     │                                                            │
│     ├── Hook: "delete"                                           │
│     │   ├── WorktreeModule: remove git worktree                  │
│     │   └── CodeServerModule: delete .code-workspace file        │
│     │                                                            │
│     ├── emit progress (final, completed: true)                   │
│     │                                                            │
│     └── emit workspace:deleted domain event                      │
│         NOTE: when force=true, emit in finally block             │
│         to ensure state cleanup even if hooks error              │
│                                                                  │
│  3. Event Subscribers                                            │
│     ├── StateModule: remove workspace from project state (A14)   │
│     ├── IpcEventBridge: emit workspace:removed IPC event (A15)   │
│     └── Idempotency event handler: clear in-progress flag (A16)  │
└──────────────────────────────────────────────────────────────────┘
```

### Hook Context

```typescript
interface DeleteWorkspaceHookContext extends HookContext {
  // Set by operation (available to all hooks)
  // Note: paths are strings (consistent with CreateWorkspaceHookContext precedent).
  // Hook modules construct Path objects where needed for service calls.
  readonly projectId: ProjectId;
  readonly projectPath: string;
  readonly workspacePath: string;
  readonly workspaceName: WorkspaceName;
  readonly keepBranch: boolean;
  readonly force: boolean;
  readonly skipSwitch?: boolean;
  readonly unblock?: "kill" | "close" | "ignore";
  readonly isRetry?: boolean;

  // Populated by modules for progress reporting.
  // The operation maps these to DeletionOperation[] using existing DeletionOperationId values.
  shutdownResults?: {
    terminalsClosed?: boolean; // maps to "kill-terminals" operation
    serverStopped?: boolean; // maps to "stop-server" operation
    serverError?: string; // error message if server stop failed
    viewDestroyed?: boolean; // maps to "cleanup-vscode" operation
    viewError?: string; // error message if view destroy failed
    switchedWorkspace?: boolean;
  };
  releaseResults?: {
    blockersDetected?: boolean; // maps to "detecting-blockers" operation
    blockingProcesses?: readonly BlockingProcess[];
    unblockPerformed?: boolean; // maps to "killing-blockers" or "closing-handles"
    unblockError?: string;
  };
  deleteResults?: {
    worktreeRemoved?: boolean; // maps to "cleanup-workspace" operation
    worktreeError?: string;
    workspaceFileDeleted?: boolean; // (no separate DeletionOperationId, part of cleanup)
  };
}
```

### Progress Mapping

The operation builds the `DeletionProgress.operations` array from hook context results, preserving existing `DeletionOperationId` values:

| Hook Context Field                | DeletionOperationId                         | When Added                                         |
| --------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `shutdownResults.terminalsClosed` | `"kill-terminals"`                          | Always                                             |
| `shutdownResults.serverStopped`   | `"stop-server"`                             | Always                                             |
| `shutdownResults.viewDestroyed`   | `"cleanup-vscode"`                          | Always                                             |
| `releaseResults.unblockPerformed` | `"killing-blockers"` or `"closing-handles"` | When `unblock` is set                              |
| `releaseResults.blockersDetected` | `"detecting-blockers"`                      | When Windows + `!isRetry` + `unblock !== "ignore"` |
| `deleteResults.worktreeRemoved`   | `"cleanup-workspace"`                       | Always                                             |

This preserves the exact `DeletionProgress` shape the renderer expects. No `DeletionOperationId` changes needed.

### Force Mode Behavior

All hooks always run. With `force: true`, modules wrap their work in try/catch and ignore errors. The operation emits `workspace:deleted` in a **`finally` block** when `force=true` to ensure state cleanup even if a hook unexpectedly throws (programming error):

| Module            | Normal Mode                              | Force Mode                                   |
| ----------------- | ---------------------------------------- | -------------------------------------------- |
| ViewModule        | Switch + destroy (errors propagate)      | Switch + destroy (errors caught, ignored)    |
| AgentModule       | Kill + stop + clear (errors propagate)   | Kill + stop + clear (errors caught, ignored) |
| WindowsLockModule | Detect + kill/close                      | Skip entirely (no point detecting)           |
| WorktreeModule    | Remove worktree (errors propagate)       | Try remove, ignore errors                    |
| CodeServerModule  | Delete workspace file (errors propagate) | Try delete, ignore errors                    |

### Progress Emission

The operation emits progress after each hook point completes. It reads `shutdownResults`, `releaseResults`, `deleteResults` from the hook context and maps them to `DeletionOperation[]` using the mapping table above. Each operation entry has `id`, `label`, and `status` ("pending" | "in-progress" | "done" | "error") matching the existing `DeletionOperation` type.

Progress is emitted via a callback injected at operation construction (same pattern as current `emitDeletionProgress`). The callback calls `apiRegistry.emit("workspace:deletion-progress", progress)`.

### Intent Result Type

The `DeleteWorkspaceIntent` extends `Intent<{ started: true }>` (not `Intent<void>`) so the IPC handler can distinguish success from interceptor cancellation:

- Dispatcher returns `{ started: true }` on success
- Dispatcher returns `undefined` on interceptor cancellation (interceptor returned `null`)
- IPC handler: `const result = await dispatch(intent); return result ?? { started: false };`

### ViewModule: Workspace Switching Algorithm

The ViewModule's shutdown hook must replicate the prioritized workspace selection from `switchToNextWorkspaceIfAvailable` (CoreModule lines 534-613). Key behavioral requirements:

1. If `skipSwitch` is true, skip switching (used for retry scenarios)
2. Collect all workspaces across all projects (excluding the one being deleted)
3. Score each workspace by agent status: idle=0, busy=1, none=2, deleting=3
4. Build composite sort key: `{status score}-{project name}-{workspace name}`
5. Sort workspaces, pick the best candidate
6. If a candidate exists: call `viewManager.setActiveWorkspace(candidatePath, true)`
7. If no candidates (last workspace): call `viewManager.setActiveWorkspace(null, false)`

This is the source of truth. The implementation should reference `switchToNextWorkspaceIfAvailable` for exact logic.

## Testing Strategy

### Integration Tests

All tests use `dispatcher.dispatch()` as entry point. Hook module behaviors are verified as outcomes (state changes), not call tracking. Tests use behavioral mocks that simulate Windows behavior on all platforms (no platform-conditional skipping needed).

| #   | Test Case                                                   | Entry Point                                                         | Boundary Mocks                                       | Behavior Verified                                                                                                                      |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Normal deletion completes all hooks                         | `dispatcher.dispatch(deleteIntent)`                                 | ViewLayer, ProcessRunner, GitClient, FileSystemLayer | All hooks run, workspace removed from state, IPC event emitted, progress emitted after each hook                                       |
| 2   | Force deletion ignores errors                               | `dispatcher.dispatch(deleteIntent, force=true)`                     | Same (throwing mocks)                                | All hooks run, errors caught, `workspace:deleted` event still emitted (finally block), state cleaned up                                |
| 3   | Second deletion of same workspace returns without action    | `dispatcher.dispatch(deleteIntent)` twice concurrently              | Same                                                 | Second dispatch returns `undefined` (interceptor blocks), first completes normally                                                     |
| 4   | Force deletion proceeds when normal deletion in-progress    | dispatch normal then dispatch force                                 | Same                                                 | Force intent passes interceptor, both complete                                                                                         |
| 5   | In-progress flag cleared after completion                   | `dispatcher.dispatch(deleteIntent)`                                 | Same                                                 | After `workspace:deleted` event, subsequent non-force dispatch for same workspace succeeds                                             |
| 6   | Windows blocker detection stops deletion                    | `dispatcher.dispatch(deleteIntent)`                                 | WindowsLockHandler mock returning blockers           | `ctx.error` set after release hook, delete hook skipped, progress shows `detecting-blockers` error, workspace NOT removed from state   |
| 7   | Progress format matches DeletionProgress                    | `dispatcher.dispatch(deleteIntent)`                                 | Same                                                 | Emitted progress has exact `DeletionProgress` shape: correct `DeletionOperationId` values, operations array, completed/hasErrors flags |
| 8   | Active workspace switches to best candidate on delete       | `dispatcher.dispatch(deleteIntent)`                                 | ViewManager with multiple workspaces                 | After deletion, active workspace is the best candidate per scoring algorithm (idle preferred over busy)                                |
| 9   | Agent resources cleaned up after deletion                   | `dispatcher.dispatch(deleteIntent)`                                 | ServerManager, AgentStatusManager                    | After deletion, agent server for workspace is no longer running, MCP tracking cleared, TUI tracking cleared                            |
| 10  | Workspace removed from project state after deletion         | `dispatcher.dispatch(deleteIntent)`                                 | AppState                                             | After deletion, workspace not in `project.workspaces` array                                                                            |
| 11  | IPC workspace:removed event emitted with correct payload    | `dispatcher.dispatch(deleteIntent)`                                 | ApiRegistry                                          | IPC event emitted with `WorkspaceRef` containing correct projectId, workspaceName, path                                                |
| 12  | Deleting workspace A does not block workspace B             | `dispatcher.dispatch(deleteIntentA)` then `dispatch(deleteIntentB)` | Same                                                 | Both dispatches succeed, per-workspace idempotency                                                                                     |
| 13  | Deleting inactive workspace skips switch                    | `dispatcher.dispatch(deleteIntent)` for non-active workspace        | ViewManager                                          | Active workspace unchanged after deletion                                                                                              |
| 14  | Deleting last workspace sets active to null                 | `dispatcher.dispatch(deleteIntent)` for only workspace              | ViewManager                                          | Active workspace is null after deletion                                                                                                |
| 15  | IPC handler returns `{started: false}` on interceptor block | IPC handler function directly                                       | Dispatcher mock returning undefined                  | Handler returns `{ started: false }`                                                                                                   |
| 16  | Progress callback captures correct format                   | `dispatcher.dispatch(deleteIntent)`                                 | Same                                                 | Progress callback receives `DeletionProgress` objects with operations array populated from hook results                                |

### Manual Testing Checklist

- [ ] Delete a workspace — verify progress UI shows each step
- [ ] Delete active workspace — verify switches to next workspace first
- [ ] Delete last workspace — verify handles empty state
- [ ] Delete while deletion in-progress — verify idempotency (no double deletion)
- [ ] Force delete after failed deletion — verify bypasses and cleans up
- [ ] (Windows) Delete with blocking processes — verify detection and UI prompt
- [ ] (Windows) Force delete with blocking processes — verify skips detection
- [ ] Create workspace after deleting same name — verify clean state (no stale flags)

## Implementation Steps

- [x] **Step 1: Create DeleteWorkspaceOperation with types**
  - Create `src/main/operations/delete-workspace.ts`
  - Define: `DeleteWorkspacePayload` (with `force`, `skipSwitch`, `keepBranch`, `unblock`, `isRetry`)
  - Define: `DeleteWorkspaceIntent` extending `Intent<{ started: true }>` (not `void` — needed to distinguish success from interceptor cancellation at IPC layer)
  - Define: `INTENT_DELETE_WORKSPACE` constant
  - Define: `DeleteWorkspaceHookContext` with fields for all hook data (see Hook Context section)
  - Define: `WorkspaceDeletedPayload`, `WorkspaceDeletedEvent`, `EVENT_WORKSPACE_DELETED`
  - Define: `DELETE_WORKSPACE_OPERATION_ID` and hook point IDs (`shutdown`, `release`, `delete`)
  - Implement `DeleteWorkspaceOperation.execute()`:
    - Runs hooks in sequence: `shutdown` → check `ctx.error` → `release` → check `ctx.error` → `delete`
    - Emits progress after each hook (mapping hook results to `DeletionOperationId` values per Progress Mapping table)
    - When `force=true`: emit `workspace:deleted` in a `finally` block to ensure state cleanup even if hooks throw
    - When `force=false`: emit `workspace:deleted` only on success (no `ctx.error` after all hooks)
    - Returns `{ started: true }`
  - Progress emission via injected callback (constructor parameter)
  - Files: `src/main/operations/delete-workspace.ts`
  - Test criteria: operation runs hooks in order, emits progress with correct DeletionOperationId values, emits domain event, returns `{ started: true }`

- [x] **Step 2: Create IdempotencyInterceptor**
  - Create as `IntentInterceptor` implementation
  - `before()`: FIRST check `intent.type !== INTENT_DELETE_WORKSPACE` → return intent unchanged (pass through non-delete intents). Then check `inProgressDeletions` set — if in-progress and not `force`, return `null` (cancel). If allowed, add to set.
  - Separate event handler function for `workspace:deleted`: remove from `inProgressDeletions` set. This is wired via `dispatcher.subscribe(EVENT_WORKSPACE_DELETED, handler)` in bootstrap — NOT via the interceptor interface (which only has `before()`). The interceptor and event handler are two separate registrations that share the `inProgressDeletions` set.
  - Files: `src/main/operations/delete-workspace.ts` (interceptor + event handler exported separately)
  - Test criteria: passes through non-delete intents, blocks duplicate non-force delete, allows force, clears flag on event

- [x] **Step 3: Update IPC types and shared interfaces**
  - `WorkspaceRemovePayload`: add `force?: boolean` field
  - `IWorkspaceApi.remove()`: change signature to accept options. New signature:
    ```typescript
    remove(
      projectId: ProjectId,
      workspaceName: WorkspaceName,
      options?: {
        keepBranch?: boolean;
        skipSwitch?: boolean;
        force?: boolean;
        unblock?: "kill" | "close" | "ignore";
        isRetry?: boolean;
      }
    ): Promise<{ started: boolean }>;
    ```
  - Remove `IWorkspaceApi.forceRemove()` method
  - Remove `ApiIpcChannels.WORKSPACE_FORCE_REMOVE` channel
  - Update preload script to remove `forceRemove` exposure
  - Files: `src/main/api/registry-types.ts`, `src/shared/api/interfaces.ts`, `src/shared/ipc.ts`, `src/preload/`
  - Test criteria: types compile, no references to old forceRemove

- [x] **Step 4: Create hook modules for shutdown hook**
  - **ViewModule**: Check `skipSwitch` flag. If not skipping, run prioritized workspace selection algorithm (see "ViewModule: Workspace Switching Algorithm" section — source of truth is `switchToNextWorkspaceIfAvailable` in CoreModule lines 534-613). Destroy workspace view via `viewManager.destroyWorkspaceView()`. Populate `ctx.shutdownResults.switchedWorkspace` and `ctx.shutdownResults.viewDestroyed`. Force mode: wrap in try/catch, ignore errors.
  - **AgentModule**: Kill terminals (via `pluginServer.sendExtensionHostShutdown`, best-effort even in normal mode), stop server (via `serverManager.stopServer`), clear MCP tracking (`mcpServerManager.clearWorkspace`), clear TUI tracking (`agentStatusManager.clearTuiTracking`). Populate `ctx.shutdownResults.terminalsClosed` and `ctx.shutdownResults.serverStopped`. Force mode: wrap in try/catch, ignore errors.
  - Consider defining these modules in a separate file (e.g., `src/main/modules/delete-workspace-modules.ts`) to avoid growing `bootstrap.ts` further (already 734 lines). Import and wire in bootstrap.
  - Files: `src/main/modules/delete-workspace-modules.ts` (or `bootstrap.ts`), `src/main/bootstrap.ts`
  - Test criteria: each module performs its actions, populates context, respects force flag, ViewModule implements correct workspace selection scoring

- [x] **Step 5: Create hook module for release hook**
  - **WindowsLockModule**: if `force`, skip entirely. Otherwise, if `workspaceLockHandler` exists and conditions met (`!isRetry`, `unblock !== "ignore"`): detect blockers. If `unblock === "kill"`, kill processes. If `unblock === "close"`, close handles. Populate `ctx.releaseResults`. If blockers detected without unblock strategy, set `ctx.error` to stop the operation (the operation checks `ctx.error` after this hook and skips the `delete` hook).
  - Files: `src/main/modules/delete-workspace-modules.ts` (or `bootstrap.ts`), `src/main/bootstrap.ts`
  - Test criteria: detects blockers, kills/closes, skips on force, sets ctx.error when blockers found without unblock strategy

- [x] **Step 6: Create hook modules for delete hook**
  - **WorktreeModule**: remove git worktree via `provider.removeWorkspace(new Path(ctx.workspacePath), !ctx.keepBranch)`. Populate `ctx.deleteResults.worktreeRemoved`. Force mode: try/catch, ignore errors. On error in non-force mode (Windows): attempt reactive blocker detection if `workspaceLockHandler` available.
  - **CodeServerModule**: delete `.code-workspace` file via `workspaceFileService.deleteWorkspaceFile()`. Populate `ctx.deleteResults.workspaceFileDeleted`. Force mode: try/catch, ignore errors.
  - Files: `src/main/modules/delete-workspace-modules.ts` (or `bootstrap.ts`), `src/main/bootstrap.ts`
  - Test criteria: removes worktree, deletes file, respects force flag

- [x] **Step 7: Create event subscribers**
  - **StateModule**: on `workspace:deleted` — remove workspace from `openProject.workspaces` array in AppState (the A14 action from `appState.removeWorkspace()`)
  - **IpcEventBridge**: on `workspace:deleted` — emit `workspace:removed` IPC event with `WorkspaceRef` payload (projectId, workspaceName, path)
  - **Idempotency event handler**: on `workspace:deleted` — clear `inProgressDeletions` flag (shares set with interceptor)
  - Add to existing modules in `bootstrap.ts` and `ipc-event-bridge.ts`
  - Files: `src/main/bootstrap.ts`, `src/main/modules/ipc-event-bridge.ts`
  - Test criteria: state updated, IPC event emitted with correct payload, idempotency flag cleared

- [x] **Step 8: Wire operation, interceptor, and modules in bootstrap**
  - Register `DeleteWorkspaceOperation` with dispatcher
  - Add `IdempotencyInterceptor` via `dispatcher.addInterceptor()`
  - Wire idempotency event handler via `dispatcher.subscribe(EVENT_WORKSPACE_DELETED, handler)` (separate from interceptor registration)
  - Wire all hook modules via `wireModules()`
  - Register IPC handler: `registry.register("workspaces.remove", ...)` mapping to dispatch
  - IPC handler logic: `const result = await dispatch(intent); return result ?? { started: false };`
  - Files: `src/main/bootstrap.ts`
  - Test criteria: full pipeline works end-to-end from IPC to domain event

- [x] **Step 9: Update renderer**
  - Update all `api.workspaces.remove()` call sites to use new options signature:
    - `MainView.svelte` lines 253-308: `handleRetry`, `handleKillAndRetry`, `handleCloseHandlesAndRetry`, `handleIgnoreBlockers` — update to pass options object. Consider consolidating these 4 nearly-identical retry handler functions into a single `handleRetryWithOptions(unblock?, isRetry?)` function.
    - `MainView.svelte` line ~315: `handleDismiss` — change from `api.workspaces.forceRemove(projectId, name)` to `api.workspaces.remove(projectId, name, { force: true })`. Note: `{started: false}` won't occur for force calls since force bypasses the interceptor, so `clearDeletion()` can be called unconditionally.
    - `RemoveWorkspaceDialog.svelte` line ~51: update remove call signature. Note: if user double-clicks and deletion is already in-progress, dialog closes but `{started: false}` is silently ignored (fire-and-forget). This is acceptable because the existing progress view will already be showing.
  - Handle `{ started: boolean }` return type where awaited (most call sites are fire-and-forget with `void` prefix, so no change needed)
  - Update renderer test mocks:
    - `src/renderer/lib/test-utils.ts`: remove `forceRemove` mock, update `remove` mock return to `{ started: true }`
    - `src/renderer/lib/components/MainView.test.ts`: update assertions
    - `src/renderer/lib/components/MainView.integration.test.ts`: update assertions
    - `src/renderer/lib/integration.test.ts`: update assertions
  - Files: `src/renderer/lib/components/MainView.svelte`, `src/renderer/lib/components/RemoveWorkspaceDialog.svelte`, renderer test files listed above
  - Test criteria: renderer compiles, force-remove UI still works, no references to `forceRemove`

- [x] **Step 10: Update non-renderer consumers of forceRemove**
  - Update MCP server, plugin server, and API test utilities that reference `forceRemove`:
    - `src/services/mcp-server/mcp-server.test.ts`
    - `src/services/mcp-server/mcp-server-manager.test.ts`
    - `src/services/mcp-server/mcp-server-manager.integration.test.ts`
    - `src/services/plugin-server/plugin-server.integration.test.ts`
    - `src/main/api/registry.test-utils.ts`
  - Update `ICodeHydraApi` / `ICoreApi` interfaces if they expose `forceRemove`
  - Files: listed above
  - Test criteria: all test files compile and pass, no references to `forceRemove`

- [x] **Step 11: Remove old code**
  - Remove `workspaceRemove()` and `workspaceForceRemove()` from `CoreModule`
  - Remove `executeDeletion()` from `CoreModule`
  - Remove `inProgressDeletions` set from `CoreModule`
  - Remove `switchToNextWorkspaceIfAvailable()` helper (logic moved to ViewModule hook)
  - Delete `appState.removeWorkspace()` method entirely
  - Remove `emitDeletionProgress` from `CoreModuleDeps`
  - Remove IPC registrations for old channels from `CoreModule.registerMethods()`
  - Files: `src/main/modules/core/index.ts`, `src/main/app-state.ts`
  - Test criteria: old code removed, no dead code, existing tests updated/removed

- [x] **Step 12: Integration tests**
  - Test the full DeleteWorkspaceOperation through `dispatcher.dispatch()` (tests 1-16 from strategy)
  - All behavioral verification: check state changes and outcomes, not call tracking
  - Progress emission captured via injected callback mock
  - Windows behavior tested via behavioral mocks on all platforms
  - Files: `src/main/operations/delete-workspace.integration.test.ts`
  - Test criteria: all 16 tests pass, coverage of normal/force/idempotent/Windows/edge-case paths

- [x] **Step 13: Run validate:fix and cleanup**
  - Run `pnpm validate:fix` to catch lint/format/type issues
  - Remove any dead imports, unused types
  - Ensure all existing tests still pass
  - Files: various
  - Test criteria: `pnpm validate:fix` passes clean

- [x] **Step 14: Documentation updates**
  - Update `docs/ARCHITECTURE.md`: add workspace:delete to intent dispatcher section, list hook points and modules
  - Update `docs/API.md`: update `workspaces.remove` signature and return type, remove `workspaces.forceRemove`, fix existing stale `DeletionProgress` type definition to match the actual `operations`-based format in `src/shared/api/types.ts`
  - Update `docs/PATTERNS.md`: update Module Registration Pattern section to reflect that `workspaces.remove` is now handled by the intent dispatcher (matching `workspaces.create` pattern)
  - Update `CLAUDE.md`: add note that interceptors are used for cross-cutting concerns (idempotency), referencing the delete-workspace interceptor as the pattern example
  - Files: `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/PATTERNS.md`, `CLAUDE.md`
  - Test criteria: documentation accurate and consistent

## Dependencies

None. All required infrastructure (dispatcher, hook registry, interceptors, domain events) already exists.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add `workspace:delete` operation to intent dispatcher section, list hook points and modules                                                                                                          |
| `docs/API.md`          | Update `workspaces.remove` return type to `{started: boolean}`, add `force` parameter, remove `workspaces.forceRemove`. Fix stale `DeletionProgress` type to match actual `operations`-based format. |
| `docs/PATTERNS.md`     | Update Module Registration Pattern section: `workspaces.remove` now handled by intent dispatcher (like `workspaces.create`)                                                                          |
| `CLAUDE.md`            | Add note on interceptor pattern for cross-cutting concerns (idempotency)                                                                                                                             |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated (ARCHITECTURE.md, API.md, PATTERNS.md, CLAUDE.md)
- [ ] Normal deletion works (progress UI, state cleanup, workspace removed)
- [ ] Force deletion works (bypasses errors, cleans up state via finally block)
- [ ] Idempotency works (duplicate calls return `{started: false}`, per-workspace tracking)
- [ ] Windows blocker detection preserved
- [ ] No duplicate cleanup calls (stopServer, destroyView called exactly once)
- [ ] `appState.removeWorkspace()` deleted
- [ ] `workspaces.forceRemove` IPC channel removed from all consumers (renderer, MCP, plugin, test utils)
- [ ] All existing deletion-related tests pass or are migrated
- [ ] CI passed
- [ ] Merged to main
