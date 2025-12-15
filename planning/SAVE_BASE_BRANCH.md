---
status: COMPLETED
last_updated: 2025-12-15
reviewers: [review-arch, review-testing, review-docs]
---

# SAVE_BASE_BRANCH

## Overview

- **Problem**: When a workspace is created, the base branch used to create it is not persisted. This information is useful for:
  - Rebasing workflows (knowing which branch to rebase onto)
  - Display in the UI (showing what the workspace was based on)
  - Branch management (understanding branch relationships)

- **Solution**: Store the base branch in git config using the `branch.<name>.codehydra.base` key. This is a per-branch configuration that persists in `.git/config` and follows standard git conventions. The `codehydra.` prefix clearly namespaces it as CodeHydra-specific, avoiding confusion with git's standard branch config keys. When no config exists (backwards compatibility), fall back to the branch's own name.

- **Risks**:
  - The config key `branch.<name>.codehydra.base` is not a standard git key (unlike `.remote` and `.merge`), but git allows arbitrary branch config keys
  - If a branch is renamed, the config is lost (acceptable - same behavior as other branch config)

- **Alternatives Considered**:
  1. **Store in a separate file** (e.g., `.codehydra/workspaces.json`) - Rejected: would need to sync with git state, extra file to manage
  2. **Store in worktree-specific config** (`git config --worktree`) - Rejected: would be lost if worktree is removed and recreated
  3. **Store in app-data** - Rejected: not portable, lost if app-data is cleared

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Git Repository                            │
│  .git/config                                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ [branch "feature-x"]                                        │ │
│  │     codehydra.base = main                                   │ │
│  │                                                             │ │
│  │ [branch "feature-y"]                                        │ │
│  │     codehydra.base = origin/develop                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         ▲                              │
         │ setBranchConfig()            │ getBranchConfig()
         │                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SimpleGitClient                             │
│  + getBranchConfig(repoPath, branch, key): Promise<string|null>  │
│  + setBranchConfig(repoPath, branch, key, value): Promise<void>  │
└─────────────────────────────────────────────────────────────────┘
         ▲                              │
         │                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   GitWorktreeProvider                            │
│  createWorkspace():                                              │
│    1. Create branch (if new)                                     │
│    2. Create worktree                                            │
│    3. Save base branch via setBranchConfig() ← NEW               │
│       (failure logged, not rolled back - matches branch delete)  │
│                                                                  │
│  discover():                                                     │
│    1. List worktrees                                             │
│    2. For each: getBranchConfig() for base ← NEW                 │
│    3. If null, fallback to worktree.branch ?? worktree.name      │
│    4. Return Workspace[] with baseBranch                         │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Service Workspace Type                        │
│  {                                                               │
│    name: string;                                                 │
│    path: string;                                                 │
│    branch: string | null;                                        │
│    baseBranch: string;  ← NEW (non-nullable, fallback to branch) │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Workspace Type                          │
│  {                                                               │
│    projectId: ProjectId;                                         │
│    name: WorkspaceName;                                          │
│    branch: string | null;                                        │
│    baseBranch: string;  ← NEW (non-nullable, fallback to branch) │
│    path: string;                                                 │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘

Fallback Logic:
┌────────────────────────────────────────────────────────────────┐
│  baseBranch = configValue ?? worktree.branch ?? worktree.name   │
│                                                                 │
│  Priority:                                                      │
│  1. Git config `branch.<name>.codehydra.base` (if set)          │
│  2. worktree.branch - current branch name (if not detached)     │
│  3. worktree.name - workspace directory name (detached HEAD)    │
└────────────────────────────────────────────────────────────────┘

Error Handling:
┌────────────────────────────────────────────────────────────────┐
│  setBranchConfig() failure in createWorkspace():                │
│  - Log warning and continue (matches branch deletion behavior)  │
│  - Workspace is created, baseBranch uses fallback on discover() │
│  - NOT rolled back - worktree creation is the critical op       │
│                                                                 │
│  getBranchConfig() failure in discover():                       │
│  - Catch error, log warning, use fallback value                 │
│  - Never fails discover() for a single workspace's config error │
└────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

Steps follow TDD: write failing tests → implement → verify tests pass.

- [x] **Step 1: Add config methods to IGitClient interface**
  - Add `getBranchConfig(repoPath, branch, key)` method returning `Promise<string | null>`
  - Add `setBranchConfig(repoPath, branch, key, value)` method returning `Promise<void>`
  - Use branch-specific config pattern: `branch.<branch>.<key>`
  - Files affected: `src/services/git/git-client.ts`
  - Test criteria: Interface compiles, TypeScript requires implementation

- [x] **Step 2: Write boundary tests for config operations (RED)**
  - Write tests that will fail until implementation exists
  - Tests defined in Testing Strategy below
  - Files affected: `src/services/git/simple-git-client.boundary.test.ts`
  - Test criteria: Tests written, all fail (no implementation yet)

- [x] **Step 3: Implement config methods in SimpleGitClient (GREEN)**
  - Implement `getBranchConfig()` using `git config --get branch.<branch>.<key>`
    - Handle exit code 1 (key not found) by returning `null`
    - Only throw `GitError` for other failures (exit code 128 = not a repo, etc.)
  - Implement `setBranchConfig()` using `git config branch.<branch>.<key> <value>`
    - Note: Git allows setting config for non-existent branches (config is key-value store)
  - Files affected: `src/services/git/simple-git-client.ts`
  - Test criteria: All boundary tests from Step 2 pass

- [x] **Step 4: Extend service-level Workspace type**
  - Add `baseBranch: string` to `Workspace` interface in `git/types.ts`
  - Non-nullable - always has a value (via fallback logic)
  - Files affected: `src/services/git/types.ts`
  - Test criteria: Type compiles

- [x] **Step 5: Write unit tests for GitWorktreeProvider changes (RED)**
  - Add mock for `getBranchConfig()` and `setBranchConfig()` in mock git client factory
  - Write failing tests for:
    - `createWorkspace()` calls `setBranchConfig(projectRoot, name, 'codehydra.base', baseBranch)`
    - `createWorkspace()` logs warning and continues if `setBranchConfig()` fails
    - `discover()` returns `baseBranch` from config when set
    - `discover()` falls back to `worktree.branch` when config returns null
    - `discover()` falls back to `worktree.name` when detached HEAD (branch is null)
    - `discover()` logs warning and uses fallback when `getBranchConfig()` throws
    - Fallback priority is correct (config > branch > name)
  - Files affected: `src/services/git/git-worktree-provider.test.ts`
  - Test criteria: Tests written, all fail

- [x] **Step 6: Update GitWorktreeProvider to save and retrieve base branch (GREEN)**
  - Define constant at top of class: `private static readonly BASE_CONFIG_KEY = "codehydra.base";`
  - In `createWorkspace()`:
    - After successful worktree creation, call `setBranchConfig()`
    - Wrap in try/catch, log warning on failure, don't throw
  - In `discover()`:
    - For each worktree, call `getBranchConfig()` wrapped in try/catch
    - Apply fallback: `configValue ?? worktree.branch ?? worktree.name`
  - Files affected:
    - `src/services/git/git-worktree-provider.ts`
    - `src/services/git/workspace-provider.ts` (interface implicitly updated via Workspace type)
  - Test criteria: All unit tests from Step 5 pass

- [x] **Step 7: Write integration tests for GitWorktreeProvider (RED → GREEN)**
  - Create `git-worktree-provider.integration.test.ts` with real git repos
  - Tests:
    - Create workspace with baseBranch, retrieve via discover(), verify baseBranch persists
    - Legacy workspace (no config) returns branch name as baseBranch
    - Mixed state: some workspaces with config, some without
    - BaseBranch survives provider instance recreation
  - Files affected: `src/services/git/git-worktree-provider.integration.test.ts` (new file)
  - Test criteria: All integration tests pass

- [x] **Step 8: Extend API-level Workspace type**
  - Add `baseBranch: string` to `Workspace` interface in `shared/api/types.ts`
  - Non-nullable to match service type
  - Files affected: `src/shared/api/types.ts`
  - Test criteria: Type compiles

- [x] **Step 9: Update API implementation to pass through baseBranch**
  - In `CodeHydraApiImpl`, update service → API workspace mapping:
    - Find where `Workspace` objects are created/mapped (for both `workspaces.create()` and `projects.list()` flows)
    - Add `baseBranch: serviceWorkspace.baseBranch` to the mapping
  - Update `workspace:created` event payload to include `baseBranch`
  - Files affected: `src/main/api/codehydra-api.ts`
  - Test criteria:
    - API tests pass
    - `workspaces.create()` returns workspace with `baseBranch`
    - `projects.list()` returns workspaces with `baseBranch`

- [x] **Step 10: Run validation and verify all tests pass**
  - Run `npm run validate:fix`
  - Verify all existing tests still pass
  - Verify new tests pass (boundary, unit, integration)
  - Files affected: None
  - Test criteria: `npm run validate` passes

## Testing Strategy

### Boundary Tests (real git repos) - Step 2

| Test Case                                                     | Description                    | File                                 |
| ------------------------------------------------------------- | ------------------------------ | ------------------------------------ |
| `getBranchConfig returns null for non-existent config`        | Real git repo, no config set   | `simple-git-client.boundary.test.ts` |
| `setBranchConfig stores value retrievable by getBranchConfig` | Set then get                   | `simple-git-client.boundary.test.ts` |
| `config persists across client instances`                     | Create new client, read config | `simple-git-client.boundary.test.ts` |
| `config works with branch names containing slashes`           | Branch like `feature/foo`      | `simple-git-client.boundary.test.ts` |
| `setBranchConfig succeeds for non-existent branch`            | Git allows this                | `simple-git-client.boundary.test.ts` |
| `getBranchConfig throws GitError for non-repo path`           | Invalid path handling          | `simple-git-client.boundary.test.ts` |
| `concurrent setBranchConfig calls don't corrupt config`       | Parallel writes                | `simple-git-client.boundary.test.ts` |

### Unit Tests (vitest with mocks) - Step 5

| Test Case                                                  | Description                                                                     | File                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `createWorkspace calls setBranchConfig with correct args`  | Verify mock: `setBranchConfig(projectRoot, name, 'codehydra.base', baseBranch)` | `git-worktree-provider.test.ts` |
| `createWorkspace logs warning on setBranchConfig failure`  | Mock throws, workspace still created                                            | `git-worktree-provider.test.ts` |
| `discover returns baseBranch from config`                  | Mock returns config value                                                       | `git-worktree-provider.test.ts` |
| `discover falls back to branch name when config null`      | Mock returns null                                                               | `git-worktree-provider.test.ts` |
| `discover falls back to workspace name when detached HEAD` | Branch null, config null                                                        | `git-worktree-provider.test.ts` |
| `discover logs warning when getBranchConfig throws`        | Mock throws, fallback used                                                      | `git-worktree-provider.test.ts` |
| `fallback priority: config > branch > name`                | Verify correct precedence                                                       | `git-worktree-provider.test.ts` |

### Integration Tests (real git repos) - Step 7

| Test Case                                       | Description                        | File                                        |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| `creates workspace and persists baseBranch`     | Full create → discover flow        | `git-worktree-provider.integration.test.ts` |
| `legacy workspace returns branch as baseBranch` | No config, verify fallback         | `git-worktree-provider.integration.test.ts` |
| `handles mixed state workspaces`                | Some with config, some without     | `git-worktree-provider.integration.test.ts` |
| `baseBranch survives provider recreation`       | New provider instance reads config | `git-worktree-provider.integration.test.ts` |

### Manual Testing Checklist

- [ ] Create workspace with base branch "main" - verify baseBranch is "main"
- [ ] Create workspace from existing branch - verify baseBranch equals branch name (fallback)
- [ ] Close and reopen app - baseBranch persists
- [ ] Check `.git/config` has `[branch "workspace-name"]` with `codehydra.base = main`
- [ ] Create workspace from remote branch (e.g., `origin/develop`) - baseBranch shows full remote ref

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| None    | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                       |
| ---------------------- | ------------------------------------------------------ |
| `docs/ARCHITECTURE.md` | Add "Git Configuration Storage" subsection (see below) |

### Documentation Content for ARCHITECTURE.md

Add under "Git Worktree Provider" section:

```markdown
### Git Configuration Storage

CodeHydra stores workspace metadata in git config using the `branch.<name>.<key>` pattern:

| Config Key                     | Purpose                                | Example                                  |
| ------------------------------ | -------------------------------------- | ---------------------------------------- |
| `branch.<name>.codehydra.base` | Base branch workspace was created from | `branch.feature-x.codehydra.base = main` |

**Storage location**: Repository's `.git/config` file

**Why git config?**

- Portable: survives app reinstall, stored with the repository
- Standard mechanism: git provides CLI and library support
- Per-branch: each workspace/branch has isolated config

**Caveats**:

- Lost if branch is renamed (same as `branch.<name>.remote`)
- Not a standard git key, but git allows arbitrary branch config

**Fallback logic** (for backwards compatibility):
```

baseBranch = config ?? branch ?? name

```
- First: git config value (if set)
- Second: current branch name (if not detached HEAD)
- Third: workspace directory name (fallback for detached HEAD)
```

### New Documentation Required

None - documentation added to existing ARCHITECTURE.md.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
