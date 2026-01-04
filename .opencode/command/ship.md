---
description: Create PR with auto-merge, wait for merge via client-side queue
---

# /ship Command

Ship the current branch by creating a PR with auto-merge and waiting for it to merge.

## Arguments

$ARGUMENTS

- Empty: Auto-generate PR title and summary from commits
- `--dry-run`: Show what would happen without making changes

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

**Check we're not on the target branch:**

```bash
git branch --show-current
```

If on main: ABORT with "Cannot ship from target branch"

### 1. Detect target branch

```bash
git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'
```

Use this as <target> in all subsequent steps (typically 'main').

### 2. Check for existing PR (idempotency)

```bash
gh pr list --head $(git branch --show-current) --json number,url,state
```

If a PR already exists for this branch:

- If state is OPEN: skip to step 5 (run ship-wait script)
- If state is MERGED: report MERGED and exit
- If state is CLOSED: continue to create new PR

### 3. Push

```bash
git push --force-with-lease origin HEAD
```

### 4. Create PR

Generate title and summary from commits:

```bash
# Get commits since diverging from target
git log origin/<target>..HEAD --pretty=format:"%s%n%b"
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
gh pr create --title "<title>" --body "<summary>"
```

Capture the PR URL and number from output.

### 5. Enable Auto-merge

```bash
gh pr merge <number> --auto --merge --delete-branch
```

This:

- Enables auto-merge (will merge when all checks pass and branch is up-to-date)
- Uses **merge** (not squash) to preserve commit history
- Sets branch to auto-delete after merge

### 6. Run ship-wait script

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

## Report Formats

### MERGED (exit code 0)

```
PR merged successfully!

**PR**: <url>
**Commit**: <sha> merged to <target>
**Local <target> updated**: <path>
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
