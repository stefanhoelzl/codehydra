---
description: Create PR with auto-merge, wait for merge via client-side queue
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npx:*), Bash(pnpm:*)
---

# /ship Command

Ship the current branch by creating a PR with auto-merge and waiting for it to merge.

## Arguments

$ARGUMENTS

- Empty: Auto-generate PR title and summary from commits
- `feature` or `bugfix`: User-facing change. Agent proposes a PR title, user reviews.
- `feature(<title>)` or `bugfix(<title>)`: User-facing change with explicit PR title.
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

### 1.5. Rebase onto main

```bash
git fetch origin main
git rebase origin/main
```

If rebase fails, abort and report:

```
Rebase onto main failed (conflicts?).

Resolve conflicts manually, then run `/ship` again.
```

### 2. Push

```bash
git push --force-with-lease origin HEAD
```

### 3. Create PR

Generate title and summary from commits:

```bash
git log origin/main..HEAD --pretty=format:"%s%n%b"
```

Also get the diff for changelog analysis:

```bash
git diff origin/main..HEAD
```

#### 3a. Determine changelog category

A `changelog_category` variable tracks the result: `"feature"`, `"bugfix"`, or `null` (internal).

**If `feature` or `bugfix` argument was provided:**

Set `changelog_category` to `"feature"` or `"bugfix"` accordingly.

**If no changelog argument was provided:**

Analyze the actual changes (diffs and commit messages) to determine if the changes are user-facing.
User-facing changes include: new features, bug fixes, UX improvements, new configuration options, API changes visible to users.
Internal changes include: refactors, test additions/fixes, documentation, CI/CD, dependency bumps, code style, chore tasks.

- If changes appear **user-facing**: Ask the user via AskUserQuestion: "This looks like a user-facing change. Should it appear in the changelog?" with options:
  - `Feature` — categorize as feature
  - `Bugfix` — categorize as bugfix
  - `No` — skip changelog (internal)
    Set `changelog_category` based on the user's choice (`"feature"`, `"bugfix"`, or `null`).
- If changes appear **purely internal**: set `changelog_category` to `null` (no prompt).

#### 3b. Determine PR title

**If `changelog_category` is `"feature"` or `"bugfix"`:**

1. Determine the prefix: `feat: ` for feature, `fix: ` for bugfix.
2. If a title was provided in parentheses (e.g., `feature(Add dark mode)`): PR title = `feat: Add dark mode`
3. If no title in parentheses: Analyze the changes and propose 3 concise PR title options via AskUserQuestion (the user can also pick "Other" to enter a custom title). Prepend the appropriate prefix (`feat: ` or `fix: `) to the selected title.

**If `changelog_category` is `null`:**

Determine PR title using the standard convention:

- **PR title**: `<type>(<scope>): <description>` (from primary commit or summarized)

**Commit types (for internal PRs):**

| Type    | Description                                     |
| ------- | ----------------------------------------------- |
| `feat`  | new feature                                     |
| `fix`   | bug fix                                         |
| `docs`  | documentation only or landing page updates      |
| `chore` | maintenance, deps, config, refactor, formatting |
| `test`  | adding/fixing tests                             |
| `infra` | CI/CD, build system                             |

#### 3c. Create the PR

- **PR body**: Bullet-point summary of changes
  - If `--resolves <number>` was provided (directly or via `?` selection), append an empty line followed by `resolves #<number>`

**Example PR body with resolves:**

```
- Added feature X
- Fixed bug Y

resolves #123
```

Determine the label from `changelog_category`:

- `"feature"`: `enhancement`
- `"bugfix"`: `bug`
- `null` (internal): `internal`

Create PR with the label included:

```bash
gh pr create --repo stefanhoelzl/codehydra --title "<title>" --label "<label>" --body "<body>"
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
- Fetching origin

**Exit codes:**

- 0: MERGED
- 1: FAILED
- 2: TIMEOUT

### 5.5. CI failure retry (one attempt)

If ship-wait exited with code 1 and the output contains "CI failed":

1. Find the failed run:

   ```bash
   BRANCH=$(git branch --show-current)
   gh run list --repo stefanhoelzl/codehydra --workflow=ci.yaml --branch=$BRANCH --limit=1 --json databaseId
   ```

2. Get the failed job logs:

   ```bash
   gh run view --repo stefanhoelzl/codehydra <run-id> --log-failed
   ```

3. **Analyze the logs.** Determine if the failure is an infrastructure issue or a code issue.

   Infrastructure issues (retry): runner provisioning failures, network timeouts, GitHub service errors, OOM on runner, docker pull failures, checkout rate limiting, flaky runner environment.

   Code issues (do NOT retry): test failures, lint errors, build errors, type errors.

4. If infrastructure issue:
   - Rerun the failed job(s):
     ```bash
     gh run rerun --repo stefanhoelzl/codehydra <run-id> --failed
     ```
   - Wait 10 seconds for GitHub to register the rerun
   - Re-run ship-wait:
     ```bash
     npx tsx .claude/commands/ship-wait.ts <number>
     ```
   - Use the exit code from this second ship-wait run as the final result

5. If code issue: proceed to FAILED report as usual.

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
