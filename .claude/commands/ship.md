---
description: Create PR with auto-merge, wait for merge via client-side queue
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npx:*), Bash(pnpm:*)
---

# /ship Command

Ship the current branch by creating a PR with auto-merge and waiting for it to merge.

## Arguments

$ARGUMENTS

- Empty: Auto-generate PR title and summary from commits
- `--keep-workspace`: Keep workspace after successful merge (default: delete)
- `--resolves <issue>`: Link PR to a GitHub issue
  - `--resolves #123` or `--resolves 123`: Links to issue #123
  - `--resolves ?`: List all open issues and prompt for selection

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

**Check formatting:**

```bash
pnpm format:check
```

If formatting check fails: ABORT with:

```
Cannot ship with formatting issues.

Run `pnpm format` to fix, then commit and run `/ship` again.
```

### 0.5. Resolve issue selection (if --resolves ? was passed)

If `--resolves ?` was provided:

1. Fetch open issues:

   ```bash
   gh issue list --repo stefanhoelzl/codehydra --state open --json number,title --limit 100
   ```

2. If no open issues exist: ABORT with "No open issues found on stefanhoelzl/codehydra"

3. Display the list to the user:

   ```
   Open issues on stefanhoelzl/codehydra:

   #<number> <title>
   #<number> <title>
   ...
   ```

4. Ask the user explicitly:

   ```
   Which issue does this PR resolve? Enter the issue number (e.g., 123):
   ```

5. Wait for user response and store the issue number for step 3.

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
  - If `--resolves <number>` was provided (directly or via `?` selection), append an empty line followed by `resolves #<number>`

**Example PR body with resolves:**

```
- Added feature X
- Fixed bug Y

resolves #123
```

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
gh pr create --repo stefanhoelzl/codehydra --title "<title>" --body "<body>"
```

Capture the PR URL and number from output.

### 4. Enable Auto-merge

```bash
gh pr merge --repo stefanhoelzl/codehydra <number> --auto --rebase --delete-branch
```

This:

- Enables auto-merge (will merge when all checks pass and branch is up-to-date)
- Uses **rebase** to maintain linear history
- Sets branch to auto-delete after merge

### 5. Run ship-wait script

```bash
npx tsx .claude/commands/ship-wait.ts <number>
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
