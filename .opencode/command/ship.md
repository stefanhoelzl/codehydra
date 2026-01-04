---
description: Create PR with auto-merge, wait for merge via client-side queue
---

# /ship Command

Ship the current branch by creating a PR with auto-merge and waiting for it to merge.

## Arguments

$ARGUMENTS

- Empty: Auto-generate PR title and summary from commits
- `--keep-workspace`: Keep workspace after successful merge (default: delete)

## Execution

You are a BUILD AUTOMATION agent. Execute the workflow below. On FAILED or TIMEOUT,
return immediately with a report - do NOT attempt to diagnose or fix issues.

### 0. Validate preconditions

**Check for uncommitted changes:**

```bash
git status --porcelain
```

If output is non-empty: ABORT with:

```
Cannot ship with uncommitted changes.

**Uncommitted files:**
<list of files>

Commit your changes first, then run `/ship` again.
```

**Check we're not on main:**

```bash
git branch --show-current
```

If on main: ABORT with "Cannot ship from main branch"

### 1. Check for existing PR (idempotency)

```bash
gh pr list --repo stefanhoelzl/codehydra --head <current-branch> --json number,url,state
```

If a PR already exists for this branch:

- If state is OPEN: skip to step 5 (run ship-wait script)
- If state is MERGED: skip to step 6 (delete workspace) with exit code 0
- If state is CLOSED: continue to create new PR

### 2. Push

```bash
git push --force-with-lease origin HEAD
```

### 3. Create PR

Generate title and summary from commits:

```bash
git log origin/main..HEAD --pretty=format:"%s%n%b"
```

Analyze commits to determine:

- **PR title**: `<type>(<scope>): <description>` (from primary commit or summarized)
- **PR body**: Bullet-point summary of changes

**Commit types:**

| Type    | Description                                     |
| ------- | ----------------------------------------------- |
| `feat`  | new feature                                     |
| `fix`   | bug fix                                         |
| `docs`  | documentation only or landing page updates      |
| `chore` | maintenance, deps, config, refactor, formatting |
| `test`  | adding/fixing tests                             |
| `infra` | CI/CD, build system                             |

Create PR:

```bash
gh pr create --repo stefanhoelzl/codehydra --title "<title>" --body "<summary>"
```

Capture the PR URL and number from output.

### 4. Enable Auto-merge

```bash
gh pr merge --repo stefanhoelzl/codehydra <number> --auto --merge --delete-branch
```

This:

- Enables auto-merge (will merge when all checks pass and branch is up-to-date)
- Uses **merge** (not squash) to preserve commit history
- Sets branch to auto-delete after merge

### 5. Run ship-wait script

```bash
npx tsx .opencode/scripts/ship-wait.ts <number>
```

The script handles:

- Waiting for PRs ahead in queue (created before ours with auto-merge enabled)
- Rebasing onto main when it's our turn
- Waiting for CI via `gh pr checks --watch`
- Waiting for auto-merge to complete
- Updating local main branch

**Exit codes:**

- 0: MERGED
- 1: FAILED
- 2: TIMEOUT

### 6. Delete workspace

If `--keep-workspace` was NOT passed and merge succeeded (exit code 0):

1. Call `codehydra_workspace_delete` tool with `keepBranch: false`
2. Report: "Workspace deleted."

If `--keep-workspace` was passed, report: "Workspace kept."

## Report Formats

### MERGED (exit code 0)

```
PR merged successfully!

**PR**: <url>
**Commit**: <sha> merged to main
**Local main updated**: <path>
**Workspace**: deleted (or "kept" if --keep-workspace)
```

### FAILED (exit code 1)

```
PR failed to merge.

**PR**: <url>
**Reason**: <explanation from script output>

Action required: Fix the issue and run `/ship` again.
```

### TIMEOUT (exit code 2)

```
PR still processing after 15 minutes.

**PR**: <url>
**Status**: <from script output>

Action required: Review the PR status and decide how to proceed.
```
