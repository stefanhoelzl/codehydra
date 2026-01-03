---
description: Create PR with auto-merge, add to merge queue, wait for merge
---

# /ship Command

Ship the current branch by creating a PR and adding it to the merge queue.

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

- If state is OPEN: skip to step 5 (resume polling)
- If state is MERGED: report MERGED and exit
- If state is CLOSED: continue to create new PR

### 3. Rebase and Push

```bash
git fetch origin <target>
git rebase origin/<target>
```

If conflicts occur:

- Resolve them using standard merge strategies
- `git add <resolved-file>`
- `git rebase --continue`
- Repeat until complete

Push:

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

- Enables auto-merge (will merge when all checks pass)
- Uses **merge** (not squash) to preserve commit history
- Sets branch to auto-delete after merge
- Merge queue (if enabled) will pick it up automatically

### 6. Wait for Merge (max 15 minutes)

The 15-minute timeout covers the entire merge queue process, including:

- Waiting for position in queue
- CI running on merge candidate
- Actual merge

Poll every 30 seconds:

```bash
gh pr view <number> --json state,mergeStateStatus
```

**Response parsing:**

```json
{
  "state": "OPEN" | "MERGED" | "CLOSED",
  "mergeStateStatus": "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" | "UNSTABLE" | "HAS_HOOKS"
}
```

**State machine:**

- `state == "MERGED"`: SUCCESS → go to step 7
- `state == "CLOSED"`: FAILED → report and return
- `mergeStateStatus == "DIRTY"`: FAILED (conflicts) → report and return
- `mergeStateStatus == "BLOCKED"`: Waiting for checks/queue → keep polling
- `mergeStateStatus == "UNSTABLE"`: Some checks failing → keep polling (might recover)
- After 15 minutes with no resolution: TIMEOUT → report and return

For more detail on failures, check:

```bash
gh pr checks <number> --json name,state,conclusion
```

### 7. Cleanup (on success)

GitHub auto-deletes the branch (from --delete-branch flag).

Update local target branch:

```bash
# Find main worktree (not current dir, not under workspaces/)
git worktree list
```

Parse output to find main worktree path, then:

```bash
git -C <main-worktree> fetch origin <target>
git -C <main-worktree> pull --ff-only origin <target>
```

If pull fails (local changes), report warning but continue.

## Report Formats

### MERGED

```
PR merged successfully!

**PR**: <url>
**Commit**: <sha> merged to <target>
**Local <target> updated**: <path>
```

### FAILED

```
PR failed to merge.

**PR**: <url>
**Reason**: <explanation - conflicts, checks failed, etc.>
**Failed checks**:
<output from: gh pr checks <number> --json name,state,conclusion | jq '.[] | select(.conclusion == "FAILURE")'>

Action required: Fix the issue and run `/ship` again.
```

### TIMEOUT

```
PR still processing after 15 minutes.

**PR**: <url>
**Status**: <current mergeStateStatus>
**Checks**: <summary from gh pr checks>

Action required: Review the PR status and decide how to proceed.
```
