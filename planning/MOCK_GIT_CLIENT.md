---
status: COMPLETED
last_updated: 2026-01-03
reviewers: [review-typescript, review-testing, review-docs]
---

# MOCK_GIT_CLIENT

## Overview

- **Problem**: `git-worktree-provider.test.ts` uses call-tracking mocks (`vi.fn().mockResolvedValue(...)`) which test implementation details rather than behavior. Integration tests in `git-worktree-provider.integration.test.ts` use real git repos, making them slow and flaky.
- **Solution**: Create a behavioral mock for `IGitClient` following the `mock.$` pattern. Migrate all tests to use the new mock.
- **Risks**:
  - Mock behavior might not match real git behavior → Mitigated by following boundary test contracts in `simple-git-client.boundary.test.ts`
  - Large test file migration → Mitigated by incremental approach (mock first, then migrate)
- **Alternatives Considered**:
  - Keep call-tracking mocks: Rejected because they test implementation, not behavior
  - Use real git in all tests: Rejected because too slow for integration tests

**Note**: Boundary tests (`simple-git-client.boundary.test.ts`) remain unchanged - they test `SimpleGitClient` against real git. The behavioral mock is for testing code that _uses_ `IGitClient`, not for testing `SimpleGitClient` itself.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     createMockGitClient()                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    MockGitClientOptions                      ││
│  │  repositories: {                                             ││
│  │    "/project": {                                             ││
│  │      branches: ["main", "feature-x"],                        ││
│  │      remoteBranches: ["origin/main"],                        ││
│  │      remotes: ["origin"],                                    ││
│  │      worktrees: [{ name, path, branch, isDirty }],           ││
│  │      branchConfigs: { "feature-x": { "codehydra.base": "main" } },│
│  │      mainIsDirty: false,                                     ││
│  │      currentBranch: "main"  // main worktree's branch        ││
│  │    }                                                         ││
│  │  }                                                           ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │      MockGitClient = IGitClient & MockWithState<State>       ││
│  │                                                              ││
│  │  ┌──────────────┐    ┌──────────────────────────────────┐   ││
│  │  │ IGitClient   │    │ GitClientMockState ($)           │   ││
│  │  │ methods      │    │                                  │   ││
│  │  │              │    │ repositories: Map<path, RepoState>│   ││
│  │  │ isRepoRoot() │◄───│   branches: Set<string>          │   ││
│  │  │ listWorktrees│    │   remoteBranches: Set<string>    │   ││
│  │  │ addWorktree()│    │   remotes: Set<string>           │   ││
│  │  │ createBranch │    │   worktrees: Map<path, Worktree> │   ││
│  │  │ getStatus()  │    │   branchConfigs: Map<...>        │   ││
│  │  │ ...          │    │                                  │   ││
│  │  └──────────────┘    │ snapshot(): Snapshot             │   ││
│  │                      │ toString(): string               │   ││
│  │                      └──────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

Path Handling:
- Repository keys in Map use path.toString() (normalized)
- All path parameters (Path | string) normalized via path.toString() before lookup
- Path comparisons use Path.equals()
```

## Implementation Steps

- [x] **Step 1: Create git-client.state-mock.ts with types and factory**
  - Create `src/services/git/git-client.state-mock.ts`
  - Define `GitClientMockState` interface extending `MockState`
  - Implement `snapshot(): Snapshot` - captures current state for comparison
  - Implement `toString(): string` - human-readable state (sorted repo paths with branch/worktree info)
  - Define `RepositoryState`, `WorktreeState` internal types
  - Define `MockGitClientOptions`, `RepositoryInit`, `WorktreeInit` factory options
  - Define `MockGitClient` type alias: `IGitClient & MockWithState<GitClientMockState>`
  - Implement `createMockGitClient()` factory with state initialization
  - Add `normalizePath(path: Path | string): string` helper using `path.toString()`
  - Note: `currentBranch` in `RepositoryInit` sets the main worktree's branch only; each `WorktreeState` has its own `branch` field
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Factory creates mock with correct initial state, paths normalized consistently

- [x] **Step 2: Implement IGitClient methods - repository operations**
  - Implement `isRepositoryRoot(path)`: Returns true if normalized path equals a repo path, false otherwise
  - Uses `Path.equals()` for comparison after normalization
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Returns true for repository root paths, false for non-repo paths and child directories

- [x] **Step 3: Implement IGitClient methods - worktree operations**
  - Implement `listWorktrees(repo)`: Returns `readonly WorktreeInfo[]`, main worktree first
  - Implement `addWorktree(repo, path, branch)`: Adds worktree to state; throws `GitError` if branch doesn't exist or is checked out in any worktree
  - Implement `removeWorktree(repo, path)`: Removes worktree; throws `GitError` if worktree doesn't exist
  - Implement `pruneWorktrees(repo)`: No-op (nothing to prune in mock)
  - All methods throw `GitError` for invalid repo path
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Worktrees can be added, removed, listed; errors thrown for invalid operations

- [x] **Step 4: Implement IGitClient methods - branch operations**
  - Implement `listBranches(repo)`: Returns `readonly BranchInfo[]` with local + remote branches
  - Implement `createBranch(repo, name, startPoint)`: Adds branch; throws `GitError` if branch exists or startPoint doesn't exist (must be in branches or remoteBranches)
  - Implement `deleteBranch(repo, name)`: Removes branch; throws `GitError` if branch doesn't exist or is checked out in ANY worktree (including main)
  - Implement `getCurrentBranch(path)`: Looks up worktree by normalized path, returns its `branch` field (null for detached HEAD)
  - All methods throw `GitError` for invalid repo/worktree path
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Branches can be created from valid start points, deleted when not checked out, listed with local/remote distinction

- [x] **Step 5: Implement IGitClient methods - status and remote operations**
  - Implement `getStatus(path)`: Returns `{ isDirty: worktree.isDirty, modifiedCount: 0, stagedCount: 0, untrackedCount: 0 }`
    - Note: Returns `0` for counts - tests only need `isDirty` flag, not exact counts
  - Implement `fetch(repo, remote?)`: No-op on success; throws `GitError` if remote specified and doesn't exist in remotes set
  - Implement `listRemotes(repo)`: Returns `readonly string[]` of remote names
  - All methods throw `GitError` for invalid repo/worktree path
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Status reflects worktree isDirty state, fetch validates remote exists

- [x] **Step 6: Implement IGitClient methods - config operations**
  - Implement `getBranchConfig(repo, branch, key)`: Returns config value or null (not error) if not set
  - Implement `setBranchConfig(repo, branch, key, value)`: Sets config value in branch's config map
  - Implement `getBranchConfigsByPrefix(repo, branch, prefix)`: Returns matching configs with prefix stripped
    - Example: `getBranchConfigsByPrefix(repo, "feature-x", "codehydra")` with config `{ "codehydra.base": "main" }` returns `{ base: "main" }`
  - Implement `unsetBranchConfig(repo, branch, key)`: Removes config (no-op if missing, no error)
  - All methods throw `GitError` for invalid repo path
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Config can be set, retrieved, deleted; prefix query strips prefix from keys

- [x] **Step 7: Implement custom matchers**
  - Implement `toHaveBranch(repoPath: Path | string, branch: string)`: Assert local branch exists
  - Implement `toHaveWorktree(repoPath: Path | string, worktreePath: Path | string)`: Assert worktree exists
  - Implement `toHaveBranchConfig(repoPath: Path | string, branch: string, key: string, value?: string)`: Assert config is set (optionally with specific value)
  - Register matchers with `expect.extend()`
  - Add TypeScript matcher declarations via Vitest module augmentation in same file (see `filesystem.state-mock.ts` pattern)
  - Files: `src/services/git/git-client.state-mock.ts`
  - Test criteria: Matchers provide clear pass/fail messages, accept both Path and string

- [x] **Step 8: Migrate git-worktree-provider.test.ts**
  - Import `createMockGitClient` from new state-mock file
  - Update test setup to use `repositories` configuration
  - Replace call-tracking assertions with behavioral assertions:

    ```typescript
    // Before (call-tracking)
    expect(mockClient.createBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x", "main");

    // After (behavioral)
    expect(mock).toHaveBranch(PROJECT_ROOT, "feature-x");
    ```

  - Use new matchers for state assertions
  - Remove `vi.fn()` mocking patterns
  - Remove old `createMockGitClient()` function from test file
  - Files: `src/services/git/git-worktree-provider.test.ts`
  - Test criteria: All tests pass with behavioral mock, each test <50ms

- [x] **Step 9: Migrate git-worktree-provider.integration.test.ts**
  - Replace `SimpleGitClient` with behavioral mock
  - Remove `createTestGitRepo()` usage and cleanup
  - Update assertions to use behavioral patterns
  - Remove `beforeEach`/`afterEach` cleanup logic
  - Files: `src/services/git/git-worktree-provider.integration.test.ts`
  - Test criteria: All integration tests pass, each test <50ms

- [x] **Step 10: Migrate services.integration.test.ts git-related tests**
  - Update "IWorkspaceProvider works with mocked IGitClient" test
  - Replace inline mock object with `createMockGitClient()`
  - Files: `src/services/services.integration.test.ts`
  - Test criteria: Test passes with behavioral mock

## Testing Strategy

### Integration Tests

The migrated tests in `git-worktree-provider.test.ts` and `git-worktree-provider.integration.test.ts` serve as the tests for the mock. No separate mock tests needed.

### Performance Target

Each integration test should complete in <50ms. The behavioral mock eliminates real git/filesystem overhead.

### Manual Testing Checklist

- [ ] Run `pnpm test:integration` - all tests pass
- [ ] Run `pnpm test` - full suite passes
- [ ] Verify each migrated test completes in <50ms

## Dependencies

No new dependencies required. Uses existing:

- `vitest` for testing
- `Path` class for path handling
- `GitError` for error throwing (from `src/services/errors.ts`)

## Documentation Updates

### Files to Update

| File               | Changes Required                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `docs/PATTERNS.md` | Add `createMockGitClient()` to "Test utils location" table; add usage example after table showing repositories config and matchers |
| `docs/TESTING.md`  | Add reference to git mock in Behavioral Mock Pattern section                                                                       |

### New Documentation Required

None - mock is self-documenting via TypeScript types and JSDoc.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
