---
status: COMPLETED
last_updated: 2025-12-12
reviewers: [review-testing, review-typescript, review-docs, review-senior, review-arch]
---

# GIT_BOUNDARY_TESTS

## Overview

- **Problem**: The `SimpleGitClient` boundary tests exist but are misnamed as "integration" tests, and `fetch`/`listRemotes` are only tested without remotes configured.
- **Solution**: Rename the test file to match naming conventions, extend test utilities to support local remotes, and add complete coverage for remote operations including error cases.
- **Risks**: None - uses local bare repos, no network dependencies
- **Alternatives Considered**: Testing with real network remotes - rejected due to flakiness and auth complexity

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    TEST SETUP                                    │
│                                                                  │
│   createTestGitRepoWithRemote()                                  │
│                                                                  │
│   /tmp/codehydra-test-xxx/                                       │
│   ├── repo/              ◄── Test Repo (working directory)       │
│   │   └── .git/                                                  │
│   │       └── config     ◄── origin = ../remote.git              │
│   └── remote.git/        ◄── Bare "Remote" (local filesystem)    │
│                                                                  │
│   Single cleanup() removes entire temp directory                 │
│                                                                  │
│   ┌──────────────┐         ┌──────────────────┐                  │
│   │  Test Repo   │────────►│  Bare "Remote"   │                  │
│   │  (working)   │ origin  │  (local path)    │                  │
│   └──────────────┘         └──────────────────┘                  │
│         │                           │                            │
│         ▼                           ▼                            │
│   SimpleGitClient            Git CLI (real)                      │
│         │                           │                            │
│         └───────────────────────────┘                            │
│                      │                                           │
│                      ▼                                           │
│              Boundary Tests                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Review existing test coverage**
  - Review `simple-git-client.integration.test.ts` to identify what's already tested
  - Document which operations are tested without remotes
  - Identify any gaps beyond `fetch`/`listRemotes` with remotes
  - Files: `src/services/git/simple-git-client.integration.test.ts`
  - Test criteria: Coverage gaps documented

- [x] **Step 2: Rename test file**
  - Rename `simple-git-client.integration.test.ts` → `simple-git-client.boundary.test.ts`
  - Update file header comment to say "Boundary tests" instead of "Integration tests"
  - Files: `src/services/git/simple-git-client.boundary.test.ts`
  - Test criteria: File renamed, existing tests still pass

- [x] **Step 3: Write tests for test utility extension (TDD - RED)**
  - Write failing tests in `src/services/test-utils.test.ts` for:
    - `createTestGitRepoWithRemote()` creates repo with `.git/config` containing origin
    - `createTestGitRepoWithRemote()` creates bare repo at sibling path
    - `cleanup()` removes both repo and remote directories
    - Return type includes `remotePath` as required string
  - Files: `src/services/test-utils.test.ts`
  - Test criteria: Tests written and failing (RED phase)

- [x] **Step 4: Implement test utility extension (TDD - GREEN)**
  - Create new function `createTestGitRepoWithRemote()` with explicit return type:
    ```typescript
    interface TestRepoWithRemoteResult {
      path: string; // Working repo path
      remotePath: string; // Bare remote path
      cleanup: () => Promise<void>;
    }
    ```
  - Implementation sub-steps:
    1. Create temp directory as parent: `/tmp/codehydra-test-xxx/`
    2. Create working repo at `${parent}/repo/`
    3. Create bare repo: `git init --bare ${parent}/remote.git`
    4. Add remote: `git remote add origin ../remote.git`
    5. Push initial commit: `git push -u origin main`
    6. Return paths and cleanup that removes parent directory
  - Add helper function `createCommitInRemote(remotePath: string, message: string)`:
    ```typescript
    // Creates a commit directly in the bare repo for fetch testing
    async function createCommitInRemote(remotePath: string, message: string): Promise<void>;
    ```
  - Add convenience wrapper `withTempRepoWithRemote()` following existing pattern
  - Files: `src/services/test-utils.ts`
  - Test criteria: Tests from Step 3 pass (GREEN phase)

- [x] **Step 5: Add fetch with remote tests**
  - Test: `fetch() successfully fetches from configured origin`
    ```typescript
    it("fetches from configured origin", async () => {
      const { path, cleanup } = await createTestGitRepoWithRemote();
      try {
        const client = new SimpleGitClient();
        await expect(client.fetch(path)).resolves.not.toThrow();
      } finally {
        await cleanup();
      }
    });
    ```
  - Test: `fetch() fetches new commits from remote`

    ```typescript
    it("fetches new commits from remote", async () => {
      const { path, remotePath, cleanup } = await createTestGitRepoWithRemote();
      try {
        // Create commit in remote
        await createCommitInRemote(remotePath, "Remote commit");

        const client = new SimpleGitClient();
        await client.fetch(path);

        // Verify remote ref is updated (origin/main has new commit)
        const git = simpleGit(path);
        const log = await git.log(["origin/main"]);
        expect(log.latest?.message).toBe("Remote commit");
      } finally {
        await cleanup();
      }
    });
    ```

  - Test: `fetch(path, "origin") works with explicit remote name`
    ```typescript
    it("fetches with explicit remote name", async () => {
      const { path, cleanup } = await createTestGitRepoWithRemote();
      try {
        const client = new SimpleGitClient();
        await expect(client.fetch(path, "origin")).resolves.not.toThrow();
      } finally {
        await cleanup();
      }
    });
    ```
  - Test: `fetch() throws GitError for invalid remote`
    ```typescript
    it("throws GitError when fetching from non-existent remote", async () => {
      const { path, cleanup } = await createTestGitRepoWithRemote();
      try {
        const client = new SimpleGitClient();
        await expect(client.fetch(path, "nonexistent")).rejects.toThrow(GitError);
      } finally {
        await cleanup();
      }
    });
    ```
  - Files: `src/services/git/simple-git-client.boundary.test.ts`
  - Test criteria: All fetch tests pass with proper assertions

- [x] **Step 6: Add listRemotes with remote tests**
  - Test: `listRemotes() returns configured remotes`
    ```typescript
    it("returns configured remotes", async () => {
      const { path, cleanup } = await createTestGitRepoWithRemote();
      try {
        const client = new SimpleGitClient();
        const remotes = await client.listRemotes(path);
        expect(remotes).toEqual(["origin"]);
      } finally {
        await cleanup();
      }
    });
    ```
  - Test: `listRemotes() returns multiple remotes`

    ```typescript
    it("returns multiple remotes when configured", async () => {
      const { path, cleanup } = await createTestGitRepoWithRemote();
      try {
        // Add second remote
        const git = simpleGit(path);
        await git.addRemote("upstream", "../upstream.git");

        const client = new SimpleGitClient();
        const remotes = await client.listRemotes(path);
        expect(remotes).toHaveLength(2);
        expect(remotes).toContain("origin");
        expect(remotes).toContain("upstream");
      } finally {
        await cleanup();
      }
    });
    ```

  - Files: `src/services/git/simple-git-client.boundary.test.ts`
  - Test criteria: All listRemotes tests pass with exact assertions

- [x] **Step 7: Update documentation**
  - Update `docs/TESTING.md` line ~388: change reference from `simple-git-client.integration.test.ts` to `simple-git-client.boundary.test.ts`, remove "(to be renamed)" comment
  - Update `docs/TESTING.md` helper documentation section to add:
    - `createTestGitRepoWithRemote()` function and return type
    - `withTempRepoWithRemote()` convenience wrapper
    - `createCommitInRemote()` helper
  - Files: `docs/TESTING.md`
  - Test criteria: Documentation accurately reflects new utilities

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                        | Description             | File                 |
| ------------------------------------------------ | ----------------------- | -------------------- |
| createTestGitRepoWithRemote creates linked repos | Verifies repo structure | `test-utils.test.ts` |
| createTestGitRepoWithRemote cleanup removes both | Verifies no leaked dirs | `test-utils.test.ts` |
| createCommitInRemote creates commit in bare repo | Verifies helper works   | `test-utils.test.ts` |

### Boundary Tests

| Test Case                       | Description        | File                                 |
| ------------------------------- | ------------------ | ------------------------------------ |
| fetch from configured origin    | Basic fetch works  | `simple-git-client.boundary.test.ts` |
| fetch new commits from remote   | Fetch updates refs | `simple-git-client.boundary.test.ts` |
| fetch with explicit remote name | Named remote works | `simple-git-client.boundary.test.ts` |
| fetch throws for invalid remote | Error handling     | `simple-git-client.boundary.test.ts` |
| listRemotes returns origin      | Single remote      | `simple-git-client.boundary.test.ts` |
| listRemotes returns multiple    | Multiple remotes   | `simple-git-client.boundary.test.ts` |

### Manual Testing Checklist

- [ ] Run `npm run test:boundary` - all Git tests pass
- [ ] Run `npm test` - full test suite passes
- [ ] Verify no temp directories left in `/tmp` after test run

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File              | Changes Required                                                   |
| ----------------- | ------------------------------------------------------------------ |
| `docs/TESTING.md` | Update filename reference (~line 388), document new test utilities |

### New Documentation Required

| File   | Purpose             |
| ------ | ------------------- |
| (none) | No new files needed |

## Deviations

### Bug Fix in SimpleGitClient.fetch()

During Step 5, when testing `fetch(path, "origin")` with an explicit remote name, the test revealed a bug in `src/services/git/simple-git-client.ts`. The original implementation:

```typescript
await git.fetch(remote);
```

Was treating the `remote` parameter as a refspec rather than a remote name. The fix changed it to:

```typescript
await git.fetch([remote]);
```

Passing the remote as an array element ensures simple-git treats it correctly as a remote name. This fix was required for the boundary tests to pass.

## Definition of Done

- [x] Existing test coverage reviewed and gaps documented
- [x] Test file renamed to `*.boundary.test.ts`
- [x] `createTestGitRepoWithRemote()` implemented with tests (TDD)
- [x] `createCommitInRemote()` helper implemented
- [x] `withTempRepoWithRemote()` convenience wrapper implemented
- [x] `fetch` tested: basic, with new commits, explicit remote name, error case
- [x] `listRemotes` tested: single remote, multiple remotes
- [x] `docs/TESTING.md` updated with new utilities and filename
- [x] `npm run validate:fix` passes
- [x] All existing tests still pass
- [x] No temp directories leaked after test run
