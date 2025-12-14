---
status: COMPLETED
last_updated: 2025-12-14
reviewers: []
---

# DEFAULT_BASE_BRANCH

## Overview

- **Problem**: When creating a workspace, users must manually select a base branch every time. There's no memory of previously used branches, and no smart default for new projects.
- **Solution**: Track last selected base branch per project in runtime memory. Fall back to `main` or `master` for new projects via `defaultBase()` in WorkspaceProvider.
- **Risks**:
  - Last selection lost on app restart → Acceptable per requirements (runtime-only)
  - Saved branch may no longer exist → Mitigated by validation in BranchDropdown
- **Alternatives Considered**:
  - Persist in config file: Rejected by user - runtime-only is sufficient
  - Frontend-only fallback: Rejected - keeps logic in backend with `defaultBase()`

### Design Rationale: Runtime-Only Storage

Runtime-only design was chosen because:

1. Default branch may change or be deleted between sessions - validating persisted state on startup adds complexity
2. The `main`/`master` fallback provides reasonable first-time UX
3. User will quickly establish their preferred branch within a session

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Project Open Flow                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  AppState.openProject()                                                  │
│         │                                                                │
│         ├──► await getDefaultBaseBranch(projectPath)                     │
│         │         │                                                      │
│         │         ├── lastBaseBranches.get(path) exists? → return it     │
│         │         └── else → provider.defaultBase() → "main"/"master"    │
│         │                                                                │
│         ▼                                                                │
│  ┌─────────────────┐     ┌────────────────────────┐                      │
│  │ Project         │     │ AppState (runtime)     │                      │
│  │ - path          │     │                        │                      │
│  │ - name          │     │ lastBaseBranches: Map  │                      │
│  │ - workspaces    │     │   projectPath → branch │                      │
│  │ - defaultBase?  │◄────│                        │                      │
│  └─────────────────┘     └────────────────────────┘                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      Workspace Creation Flow                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CreateWorkspaceDialog                                                   │
│         │                                                                │
│         │ Initialize: selectedBranch = project.defaultBaseBranch ?? ""   │
│         │                                                                │
│         ▼                                                                │
│  ┌─────────────────┐     ┌─────────────────┐                             │
│  │ BranchDropdown  │────►│ listBases()     │                             │
│  │                 │     │ (loads branches)│                             │
│  │ value (from     │     └─────────────────┘                             │
│  │  selectedBranch)│                                                     │
│  └────────┬────────┘                                                     │
│           │                                                              │
│           │ $effect validates value exists in loaded branches            │
│           │ If not found → clears value, calls onSelect("")              │
│           ▼                                                              │
│  User confirms or changes branch selection                               │
│           │                                                              │
│           ▼                                                              │
│  createWorkspace(projectPath, name, baseBranch)                          │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ workspace-handlers.ts                                           │     │
│  │                                                                 │     │
│  │  1. provider.createWorkspace(name, baseBranch)                  │     │
│  │  2. appState.setLastBaseBranch(projectPath, baseBranch)         │     │
│  │  3. Emit workspace:created event                                │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

All steps follow TDD: (1) Write failing test, (2) Implement minimal code to pass, (3) Refactor.

### Step 1: Add defaultBase() to WorkspaceProvider interface

- [x] **1a. Update interface with JSDoc**
  - Add `defaultBase(): Promise<string | undefined>` to `IWorkspaceProvider`
  - Add JSDoc: Returns the default base branch (`main` or `master`) if it exists, `undefined` otherwise
  - Files: `src/services/git/workspace-provider.ts`

### Step 2: Implement defaultBase() in GitWorktreeProvider

- [x] **2a. Write failing tests**
  - Test: `defaultBase() returns "main" when main branch exists`
  - Test: `defaultBase() returns "master" when only master exists (no main)`
  - Test: `defaultBase() returns "main" when both main and master exist`
  - Test: `defaultBase() returns undefined when neither main nor master exists`
  - Test: `defaultBase() returns undefined when listBases() throws (error handling)`
  - Files: `src/services/git/git-worktree-provider.test.ts`
  - Mocks: Mock `GitClient.listBranches()` to return controlled branch lists

- [x] **2b. Implement defaultBase()**
  - Call `listBases()`, find `main` or `master` (prefer `main`)
  - If `listBases()` throws, catch error, log it, and return `undefined`
  - Add JSDoc documentation
  - Files: `src/services/git/git-worktree-provider.ts`

### Step 3: Add defaultBaseBranch to Project IPC type

- [x] **3a. Update Project interface**
  - Add optional `defaultBaseBranch?: string` field to `Project` interface
  - Files: `src/shared/ipc.ts`

### Step 4: Add runtime tracking in AppState

- [x] **4a. Write failing tests**
  - Test: `setLastBaseBranch() stores branch in runtime map`
  - Test: `setLastBaseBranch() with same branch twice is idempotent`
  - Test: `getDefaultBaseBranch() returns runtime value when set`
  - Test: `getDefaultBaseBranch() falls back to provider.defaultBase() when not set`
  - Test: `getDefaultBaseBranch() returns undefined when provider not found`
  - Test: `getDefaultBaseBranch() returns undefined when provider.defaultBase() throws`
  - Test: `openProject() includes defaultBaseBranch in returned Project`
  - Test: `getAllProjects() includes current defaultBaseBranch for each project`
  - Files: `src/main/app-state.test.ts`
  - Mocks: Mock `IWorkspaceProvider` with controllable `defaultBase()` return

- [x] **4b. Implement runtime tracking**
  - Add `private readonly lastBaseBranches = new Map<string, string>()`
  - Add `setLastBaseBranch(projectPath: string, branch: string): void` with JSDoc
  - Add `async getDefaultBaseBranch(projectPath: string): Promise<string | undefined>` with JSDoc
    - Return `lastBaseBranches.get(path)` if set
    - Otherwise get provider via `getWorkspaceProvider(projectPath)`
    - If provider exists, return `await provider.defaultBase()`
    - Handle errors gracefully (return undefined)
  - Update `openProject()`: call `await this.getDefaultBaseBranch(projectPath)` and include in Project
  - Update `getAllProjects()`: for each project, include current `defaultBaseBranch`
  - Files: `src/main/app-state.ts`

- [x] **4c. Write integration test**
  - Test: `getDefaultBaseBranch integration - returns cached value after setLastBaseBranch, falls back to provider initially`
  - Files: `src/main/app-state.test.ts` (or new integration file if complex)

### Step 5: Update workspace create handler to save last branch

- [x] **5a. Write failing tests**
  - Test: `workspace creation calls appState.setLastBaseBranch() with baseBranch`
  - Test: `workspace creation still returns workspace correctly after saving branch`
  - Test: `workspace creation saves branch after emitting workspace:created event`
  - Files: `src/main/ipc/workspace-handlers.test.ts`
  - Mocks: Mock `AppState` with spy on `setLastBaseBranch`

- [x] **5b. Update handler**
  - After successful `provider.createWorkspace()` and after emitting event, call `appState.setLastBaseBranch(projectPath, baseBranch)`
  - Files: `src/main/ipc/workspace-handlers.ts`

### Step 6: Update BranchDropdown to validate initial value

- [x] **6a. Write failing tests**
  - Test: `displays initial value prop in input when it exists in loaded branches`
  - Test: `clears value and calls onSelect("") when initial value not in branch list`
  - Test: `does not clear value when branches are still loading`
  - Test: `handles value prop changing after initial render`
  - Test: `user can override initial value by selecting different branch`
  - Files: `src/renderer/lib/components/BranchDropdown.test.ts`
  - Mocks: Mock `listBases` API to return controlled branch lists

- [x] **6b. Implement validation effect**
  - The existing `value` prop is used (no new `defaultBranch` prop needed)
  - Add `$effect` to validate `value` exists in `branches` after loading:

    ```typescript
    let hasValidated = $state(false);

    $effect(() => {
      // Only validate once after branches load
      if (loading || hasValidated) return;
      hasValidated = true;

      // If value is set but doesn't exist in branches, clear it
      if (value && !branches.some((b) => b.name === value)) {
        onSelect(""); // Notify parent the value is invalid
      }
    });
    ```

  - Files: `src/renderer/lib/components/BranchDropdown.svelte`

### Step 7: Update CreateWorkspaceDialog to initialize from project default

- [x] **7a. Write failing tests**
  - Test: `initializes selectedBranch from project.defaultBaseBranch`
  - Test: `initializes selectedBranch to empty string when defaultBaseBranch is undefined`
  - Test: `form is valid when defaultBaseBranch exists and is valid`
  - Files: `src/renderer/lib/components/CreateWorkspaceDialog.test.ts`
  - Mocks: Mock projects store with controllable `defaultBaseBranch`

- [x] **7b. Update dialog initialization**
  - Change `let selectedBranch = $state("")` to initialize from project:
    ```typescript
    const project = $derived(projects.value.find((p) => p.path === projectPath));
    let selectedBranch = $state(project?.defaultBaseBranch ?? "");
    ```
  - Note: `selectedBranch` is initialized once; if project changes, dialog should be remounted
  - Files: `src/renderer/lib/components/CreateWorkspaceDialog.svelte`

### Step 8: Update documentation

- [x] **8a. Update USER_INTERFACE.md**
  - Update "Creating a Workspace" section to describe default branch pre-selection behavior
  - Explain: last-used branch is remembered within session, falls back to main/master
  - Files: `docs/USER_INTERFACE.md`

## Testing Strategy

### Mocking Strategy

| Test File                     | What to Mock                                                |
| ----------------------------- | ----------------------------------------------------------- |
| git-worktree-provider.test.ts | `IGitClient` (listBranches returns controlled data)         |
| app-state.test.ts             | `IWorkspaceProvider` (defaultBase returns controlled value) |
| workspace-handlers.test.ts    | `AppState` (spy on setLastBaseBranch)                       |
| BranchDropdown.test.ts        | `window.api.listBases` (returns controlled branch lists)    |
| CreateWorkspaceDialog.test.ts | Projects store, `window.api` methods                        |

### Unit Tests (vitest)

| Test Case                               | Description                                       | File                          |
| --------------------------------------- | ------------------------------------------------- | ----------------------------- |
| `defaultBase() returns "main"`          | Provider returns "main" when it exists            | git-worktree-provider.test.ts |
| `defaultBase() returns "master"`        | Provider returns "master" when main doesn't exist | git-worktree-provider.test.ts |
| `defaultBase() prefers "main"`          | Provider returns "main" when both exist           | git-worktree-provider.test.ts |
| `defaultBase() returns undefined`       | Provider returns undefined when neither exists    | git-worktree-provider.test.ts |
| `defaultBase() handles errors`          | Returns undefined when listBases throws           | git-worktree-provider.test.ts |
| `setLastBaseBranch() stores`            | AppState stores branch in map                     | app-state.test.ts             |
| `setLastBaseBranch() idempotent`        | Setting same branch twice is idempotent           | app-state.test.ts             |
| `getDefaultBaseBranch() returns last`   | Returns runtime value when set                    | app-state.test.ts             |
| `getDefaultBaseBranch() falls back`     | Returns provider.defaultBase() when not set       | app-state.test.ts             |
| `getDefaultBaseBranch() handles errors` | Returns undefined when provider throws            | app-state.test.ts             |
| `openProject includes default`          | Project has defaultBaseBranch                     | app-state.test.ts             |
| `getAllProjects includes defaults`      | All projects have defaultBaseBranch               | app-state.test.ts             |
| `Handler saves last branch`             | Create workspace calls setLastBaseBranch          | workspace-handlers.test.ts    |
| `BranchDropdown displays value`         | Shows initial value when valid                    | BranchDropdown.test.ts        |
| `BranchDropdown validates`              | Clears invalid initial value                      | BranchDropdown.test.ts        |
| `BranchDropdown waits for load`         | Doesn't validate while loading                    | BranchDropdown.test.ts        |
| `Dialog initializes from project`       | selectedBranch from defaultBaseBranch             | CreateWorkspaceDialog.test.ts |
| `Dialog handles undefined default`      | selectedBranch empty when no default              | CreateWorkspaceDialog.test.ts |

### Integration Tests

| Test Case                          | Description                             | File              |
| ---------------------------------- | --------------------------------------- | ----------------- |
| `getDefaultBaseBranch integration` | Returns cached → falls back to provider | app-state.test.ts |

### Manual Testing Checklist

- [ ] Open project for first time, verify main/master is pre-selected in dropdown
- [ ] Create workspace with branch X, reopen dialog, verify X is pre-selected
- [ ] Delete branch X from git (outside app), reopen dialog, verify falls back gracefully (empty selection, can pick new branch)
- [ ] Project with neither main nor master, verify empty selection on first open
- [ ] Restart app, verify falls back to main/master (runtime state cleared)

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------- |
| docs/USER_INTERFACE.md | Update "Creating a Workspace" section to describe default branch pre-selection behavior |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
