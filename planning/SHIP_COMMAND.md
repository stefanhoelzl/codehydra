---
status: COMPLETED
last_updated: 2026-01-04
reviewers: []
---

# SHIP_COMMAND

## Overview

- **Problem**: CI/merge workflow is hardcoded in the feature agent; uses direct merge instead of PRs; no merge queue
- **Solution**: Extract to a reusable `/ship` command that creates PRs with auto-merge + merge queue
- **Risks**:
  - Merge queue requires GitHub repo configuration (documented below)
  - First-time setup needed for branch protection rules
- **Alternatives Considered**:
  - Keep inline in feature agent → rejected (not reusable by other agents/humans)
  - Manual PR creation → rejected (doesn't fit automated workflow)
  - Direct merge without PR → rejected (no code review trail, no merge queue benefits)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ @feature (coordinator)                              Status: PLANNING        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Discuss requirements, gather information, outline approach               │
│ 2. WAIT for user to say "create plan" / "write plan" / "go ahead"           │
│ 3. Write plan to planning/<FEATURE_NAME>.md (status: REVIEW_PENDING)        │
│ 4. Ask: "Which reviewers? (default: all) Or describe changes needed."       │
│    - If changes requested → revise plan → ask again                         │
│    - If approved → immediately invoke reviewers                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ @review-* agents (in parallel)                      Status: REVIEW_PENDING  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Each reviewer analyzes plan and provides letter grade (A-F)              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ @feature (coordinator)                              Status: REVIEW_PENDING  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. Summarize reviews with grades and consistent numbering                   │
│ 6. Default: address ALL issues (unless user opts out)                       │
│ 7. Update plan with fixes                                                   │
│ 8. Ask: "Ready to implement? Or request another review round."              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ @implement                                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 9. Update plan: REVIEW_PENDING → APPROVED                                   │
│ 10. Implement all steps (TDD)                                               │
│ 11. Run `pnpm validate:fix`                                                 │
│ 12. Run `pnpm test`                                                         │
│ 13. Update plan: APPROVED → IMPLEMENTATION_REVIEW                           │
│ 14. DO NOT COMMIT - leave working tree dirty                                │
│ 15. Report: IMPLEMENTATION COMPLETE                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ @feature (coordinator)                              Status: IMPLEMENTATION  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 16. Invoke @implementation-review                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ @implementation-review                              Status: IMPLEMENTATION  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 17. Review code against plan                                                │
│ 18. Report issues with letter grade (A-F)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ @feature (coordinator)                              Status: IMPLEMENTATION  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 19. Summarize issues with grade and consistent numbering                    │
│ 20. Default: ALL issues will be fixed (unless user says otherwise)          │
│ 21. Invoke @implement to fix → back to step 11                              │
│ 22. If no issues: proceed to user testing                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ User                                                Status: IMPLEMENTATION  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 23. Manual testing                                                          │
│ 24. Reports issues OR accepts                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
┌───────────────────────────┐               ┌───────────────────────────────┐
│ Issues reported           │               │ User accepts                  │
├───────────────────────────┤               ├───────────────────────────────┤
│ Status: IMPLEMENTATION    │               │ @feature invokes @general     │
│         _REVIEW           │               └───────────────────────────────┘
│                           │                               │
│ @feature invokes          │                               ▼
│ @implement to fix         │               ┌───────────────────────────────┐
│ → back to step 11         │               │ @general                      │
└───────────────────────────┘               ├───────────────────────────────┤
                                            │ 25. Update plan:              │
                                            │     IMPLEMENTATION_REVIEW     │
                                            │     → COMPLETED               │
                                            │ 26. Commit all (code + plan)  │
                                            │ 27. (Optional) push + wait CI │
                                            │ 28. Report: READY | BLOCKED   │
                                            └───────────────────────────────┘
                                                            │
            ┌───────────────────────────────────────────────┴───────────────┐
            ▼                                                               ▼
┌───────────────────────────┐                               ┌───────────────┐
│ BLOCKED (CI failed)       │                               │ READY_TO_SHIP │
├───────────────────────────┤                               ├───────────────┤
│ Status: COMPLETED         │                               │ Status:       │
│                           │                               │ COMPLETED     │
│ @feature reports to user  │                               │               │
│ @implement fixes          │                               │ @feature      │
│ → back to step 11         │                               │ invokes /ship │
└───────────────────────────┘                               └───────────────┘
                                                                    │
                                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ /ship (command)                                           Status: COMPLETED │
├─────────────────────────────────────────────────────────────────────────────┤
│ 29. Check for existing PR (idempotency)                                     │
│ 30. If no PR: rebase, push, create PR, enable auto-merge                    │
│ 31. Poll until merged/failed/timeout (max 15 min for merge queue)           │
│ 32. Update local target branch                                              │
│ 33. Report: MERGED | FAILED | TIMEOUT                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────────────┐
│ MERGED            │   │ FAILED            │   │ TIMEOUT                   │
├───────────────────┤   ├───────────────────┤   ├───────────────────────────┤
│ @feature:         │   │ @feature:         │   │ @feature:                 │
│ Delete workspace  │   │ Report to user    │   │ Report to user            │
│ (unless user      │   │ User reviews      │   │ User decides wait/abort   │
│ asked to keep)    │   │ @implement fixes  │   │                           │
│                   │   │ → back to step 11 │   │                           │
└───────────────────┘   └───────────────────┘   └───────────────────────────┘
```

## Plan Status Transitions

| Status                  | Set By     | When                                                |
| ----------------------- | ---------- | --------------------------------------------------- |
| `REVIEW_PENDING`        | @feature   | Plan created                                        |
| `APPROVED`              | @implement | Starting implementation                             |
| `IMPLEMENTATION_REVIEW` | @implement | Implementation complete, ready for review & testing |
| `COMPLETED`             | @general   | User accepted, committed                            |

## Agent Responsibilities

| Agent                  | Responsibilities                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| @feature               | Coordinate workflow, invoke other agents, summarize reviews with ratings, delete workspace             |
| @implement             | Write code, run validate:fix, run test, update plan status (not COMPLETED), NO commit                  |
| @review-\*             | Review plan, provide letter grade                                                                      |
| @implementation-review | Review code against plan, provide letter grade                                                         |
| @general               | Update plan to COMPLETED, commit all changes (using conventional commit types), optional CI validation |
| /ship                  | Check for existing PR, rebase, push, create PR, enable auto-merge, poll for merge                      |

**Note on commit responsibility**: @implement intentionally does NOT commit. This allows @general to commit code changes together with plan status updates atomically, ensuring the plan always reflects the committed state. @general uses conventional commit types (feat, fix, docs, chore, test, infra) matching the PR title format.

### Example Workflow

Fix bug #123:

1. @feature creates plan `planning/BUG_FIX_123.md`
2. @review-testing reviews → Grade B, 1 issue
3. @feature updates plan, user approves
4. @implement fixes bug, runs tests → status: IMPLEMENTATION_REVIEW
5. @implementation-review checks → Grade A
6. User tests, says "accept"
7. @general commits with `fix(auth): resolve session timeout issue`
8. /ship creates PR, waits for merge queue → MERGED
9. Workspace deleted

## Review Rating System

### Letter Grades

| Grade | Meaning                                         | Action                 |
| ----- | ----------------------------------------------- | ---------------------- |
| **A** | Excellent - no issues or minor suggestions only | Ready to proceed       |
| **B** | Good - minor issues that should be addressed    | Fix before proceeding  |
| **C** | Acceptable - notable issues that need attention | Fix required           |
| **D** | Poor - significant issues found                 | Major fixes required   |
| **F** | Failing - critical issues or plan not followed  | Revisit implementation |

### Plan Writing and Review Flow

```
@feature discusses requirements with user
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Outline approach, ask clarifying questions                      │
│ DO NOT write plan file yet                                      │
│                                                                 │
│ When ready, ask:                                                │
│ "Ready to create the plan?"                                     │
└─────────────────────────────────────────────────────────────────┘
        │
        ├─── User says "create plan" / "go ahead" ──► write plan file
        │
        └─── User has more questions ──► continue discussion
                                              │
                                              ▼
@feature writes plan to planning/<FEATURE_NAME>.md
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Plan written. Ready to review.                                  │
│                                                                 │
│ **Reviewers** (default: all):                                   │
│ - @review-arch                                                  │
│ - @review-typescript                                            │
│ - @review-testing                                               │
│ - @review-docs                                                  │
│ - @review-platform                                              │
│ - @review-ui                                                    │
│                                                                 │
│ Reply:                                                          │
│ - "go" or "all" - run all reviewers                             │
│ - "skip <reviewer>" - run all except specified                  │
│ - "only <reviewers>" - run only specified                       │
│ - Or describe changes needed to the plan                        │
└─────────────────────────────────────────────────────────────────┘
        │
        ├─── User describes changes ──► revise plan ──► ask again
        │
        └─── User approves ──► immediately invoke reviewers (in parallel)
```

### Plan Review Summary Format

When summarizing plan reviews:

```markdown
## Plan Review Summary

| Reviewer           | Grade | Issues                     |
| ------------------ | ----- | -------------------------- |
| @review-arch       | B     | 1 important, 2 suggestions |
| @review-typescript | A     | No issues                  |
| @review-testing    | C     | 1 critical, 1 important    |
| @review-docs       | A     | 1 suggestion               |
| @review-platform   | B     | 1 important                |
| @review-ui         | A     | No issues                  |

### Critical Issues

1. **[review-testing]** Issue description
   - Location: affected section
   - Fix: recommendation

### Important Issues

2. **[review-arch]** Issue description
   - Location: affected section
   - Fix: recommendation

...

---

Addressing all N issues. Let me know if you want to skip any (e.g., "skip 5-7").
```

### Implementation Review Summary Format

When summarizing implementation review:

```markdown
## Implementation Review

**Grade: B** - Good implementation with minor issues

### Critical Issues

1. **Issue title** - description
   - File: path/to/file.ts
   - Fix: what needs to change

### Important Issues

2. **Issue title** - description
   - File: path/to/file.ts
   - Fix: what needs to change

### Suggestions

3. **Issue title** - description
   - File: path/to/file.ts
   - Fix: what needs to change

---

Fixing all 3 issues. Let me know if you want to skip any (e.g., "skip 3").
```

**Key rules:**

- Numbers are **continuous** across categories (never restart at 1)
- **Default behavior**: Fix ALL issues (Critical + Important + Suggestions)
- User can opt out by specifying issues to skip (e.g., "skip 3" or "skip suggestions")
- Grade reflects overall quality, not just issue count
- When addressing review issues, use a **single write** to update the plan (not multiple edits)

## CI Workflow Changes

### Current

```yaml
on:
  push: # Runs on every push (including main)
  pull_request: # Also runs on PR - duplicate!
```

### New

```yaml
on:
  push:
    branches-ignore: [main]
  pull_request:
  merge_group:

jobs:
  ci:
    # Skip PR trigger if from same repo (push already ran)
    if: |
      github.event_name != 'pull_request' || 
      github.event.pull_request.head.repo.full_name != github.repository
```

**Behavior:**

| Scenario                           | Trigger        | CI Runs?                   |
| ---------------------------------- | -------------- | -------------------------- |
| Push to feature branch (same repo) | `push`         | Yes                        |
| PR created from same repo          | `pull_request` | Skipped (push already ran) |
| PR created from fork               | `pull_request` | Yes                        |
| PR updated from fork               | `pull_request` | Yes                        |
| Merge queue candidate              | `merge_group`  | Yes                        |
| Merge to main                      | -              | No (merge queue validated) |

**Known edge cases where duplicate runs may occur:**

- PRs updated via GitHub web UI (no push event)
- PRs reopened after being closed
- These are rare and acceptable

### How Merge Queue Works

```
                                         Merge Queue (temporary refs)
                                         ┌─────────────────────────────┐
main: [M]                                │                             │
       │                                 │  gh-readonly-queue/main/    │
       │    PR-A added to queue ────────►│  pr-123-abc123              │
       │                                 │  [M + A] ← CI runs here     │
       │                                 │                             │
       │    PR-B added to queue ────────►│  pr-456-def456              │
       │                                 │  [M + A + B] ← CI runs here │
       │                                 │                             │
       │                                 └─────────────────────────────┘
       │                                              │
       │                                    CI passes on both
       │                                              │
       ▼◄─────────────────────────────────────────────┘
main: [M + A + B]   (actual merge happens now)
```

- Temporary merge commits are created in `refs/heads/gh-readonly-queue/main/pr-*`
- CI runs on the **merged result** (branch + main + other queued PRs)
- Main is only updated after CI passes
- If CI fails, PR is removed from queue, main unchanged

### Separate Pages Workflow

New file: `.github/workflows/pages.yaml`

- Triggers on push to main with site-related path changes
- Handles GitHub Pages deployment only

## Implementation Steps

- [x] **Step 1: Create `/ship` command**
  - File: `.opencode/command/ship.md`
  - Changes:
    - Check for existing PR from current branch before creating (idempotency)
    - If PR exists, resume polling instead of creating duplicate
    - Fail on uncommitted changes (require clean working tree)
    - Rebase onto target, push, create PR with conventional commit title
    - Use merge (not squash) to preserve commit history
    - Enable auto-merge, poll for merge queue completion
    - 15-minute timeout covers merge queue processing time
    - Handle MERGED/FAILED/TIMEOUT states
  - Test: `/ship` creates PR; re-running `/ship` resumes polling existing PR

- [x] **Step 2: Split CI and Pages workflows**
  - Files: `.github/workflows/ci.yaml`, `.github/workflows/pages.yaml`
  - Changes to `ci.yaml`:
    - Remove `pages` job entirely
    - Update triggers: `push` (branches-ignore: main), `pull_request`, `merge_group`
    - Add `if` condition to skip same-repo PRs
    - Keep `ci` job unchanged (ubuntu + windows matrix)
  - New `pages.yaml`:
    - Trigger on push to main with paths: `site/**`, `pnpm-lock.yaml`, `svelte.config.js`, `tsconfig.web.json`
    - Move pages job content from ci.yaml
    - Add concurrency group for deploy cancellation
  - Test: Push to feature branch runs CI only; push to main with site/ changes runs pages only

- [x] **Step 3: Update feature agent**
  - File: `.opencode/agent/feature.md`
  - Changes:
    - Remove direct code/validation execution (coordinator only)
    - Discuss requirements first, only write plan when user explicitly requests ("create plan", "go ahead")
    - After writing plan: immediately ask reviewer question, start on approval
    - Add review summary format with letter grades table
    - Add consistent numbering across issue categories (1, 2, 3... not restarting)
    - Default to fixing ALL issues, allow user to skip specific numbers
    - When addressing review issues, use single write (not multiple edits)
    - Invoke @general for commit after user accepts
    - Invoke /ship after @general reports READY_TO_SHIP
    - Default delete workspace on MERGED (unless user said keep)
    - Require user review on FAILED/TIMEOUT
  - Test: Full workflow from planning to merge completes

- [x] **Step 4: Update implement agent**
  - File: `.opencode/agent/implement.md`
  - Changes:
    - Remove commit step entirely (leave working tree dirty)
    - Update status from REVIEW_PENDING → APPROVED at start
    - Update status from APPROVED → IMPLEMENTATION_REVIEW at completion
    - Clarify "DO NOT COMMIT" instruction
  - Test: @implement completes without committing

- [x] **Step 5: Update review agents**
  - Files: `.opencode/agent/review-arch.md`, `.opencode/agent/review-typescript.md`, `.opencode/agent/review-testing.md`, `.opencode/agent/review-docs.md`, `.opencode/agent/review-platform.md`, `.opencode/agent/review-ui.md`, `.opencode/agent/implementation-review.md`
  - Changes:
    - Add letter grade requirement (A-F) at start of response
    - Define grade meanings in each agent's instructions
  - Test: All reviews include letter grade

- [x] **Step 6: Update AGENTS.md with workflow and GitHub configuration**
  - File: `AGENTS.md`
  - Changes:
    - Add "GitHub Repository Setup" section with merge queue, auto-merge, branch protection
    - Add branch protection settings: require up-to-date, linear history optional
    - Document merge queue batch size recommendation (1-2 for this project)
    - Add agent workflow overview: plan statuses, who sets them, /ship command usage
  - Test: Instructions are complete and accurate

- [x] **Step 7: Refactor workflow instructions to feature agent**
  - Architecture:
    - Sub-agents have ONLY domain knowledge (how to review, how to implement)
    - Feature agent passes ALL workflow context via invocation prompts
    - Templates extracted to `.opencode/template/` to keep feature.md manageable
  - New files:
    - `.opencode/template/plan.md` - Plan template (extracted from feature.md)
    - `.opencode/template/review-summary.md` - Review summary format (works for both plan reviews and implementation review - feature agent adapts header)
  - Changes to sub-agents (remove workflow, keep domain):
    - `.opencode/agent/implement.md` - Remove: status transitions, commit rules, specific commands. Keep: TDD approach, plan reading, checkbox marking, block reporting
    - `.opencode/agent/implementation-review.md` - Remove: grade format, output format. Keep: what to look for (plan adherence, coverage, quality, dead code, duplication)
    - `.opencode/agent/review-*.md` (6 files) - Remove: grade format, output format. Keep: domain-specific review criteria
  - Changes to feature agent:
    - Reference templates from `.opencode/template/` instead of embedding
    - Add detailed invocation prompts that pass workflow context:
      - Grade format (A-F with meanings)
      - Output format requirements
      - Status transitions
      - Commands to run (pnpm validate:fix, pnpm test:boundary)
      - Commit rules (DO NOT COMMIT)
  - Test: Full workflow still works with context passed via invocation

## `/ship` Command Specification

### File: `.opencode/command/ship.md`

````markdown
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
````

## CI Workflow Specification

### File: `.github/workflows/ci.yaml` (Updated)

```yaml
name: CI

on:
  push:
    branches-ignore: [main]
  pull_request:
  merge_group:

jobs:
  ci:
    name: CI (${{ matrix.os }})
    # Skip PR trigger if from same repo (push already ran)
    if: |
      github.event_name != 'pull_request' || 
      github.event.pull_request.head.repo.full_name != github.repository
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-2025]

    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup

      - run: pnpm validate
      - run: pnpm test:boundary

      - run: pnpm dist

      - run: git diff --exit-code

      - if: runner.os == 'Windows'
        run: mv dist/win-unpacked dist/CodeHydra-win

      - uses: actions/upload-artifact@v4
        with:
          name: CodeHydra-${{ runner.os == 'Windows' && 'win' || 'linux' }}
          path: dist/CodeHydra-*
          retention-days: 7
          if-no-files-found: error
```

### File: `.github/workflows/pages.yaml` (New)

```yaml
name: Deploy Landing Page

on:
  push:
    branches: [main]
    paths:
      - "site/**"
      - "pnpm-lock.yaml"
      - "svelte.config.js"
      - "tsconfig.web.json"
      - ".github/workflows/pages.yaml"

concurrency:
  group: pages-deploy
  cancel-in-progress: true

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}

    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup

      - run: pnpm site:build

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/dist

      - id: deployment
        uses: actions/deploy-pages@v4
```

## Feature Agent Changes

### Updated Workflow States

````markdown
### State: PLANNING

1. Discuss feature with user, gather information, outline approach
2. **DO NOT write plan file yet** - wait for user to explicitly request it
3. When approach is clear, ask: "Ready to create the plan?"
4. **Only when user says "create plan" / "write plan" / "go ahead"**:
   - Write plan to `planning/<FEATURE_NAME>.md` with status `REVIEW_PENDING`
5. Present plan and ask:

   ```
   Plan written. Ready to review.

   **Reviewers** (default: all):
   - @review-arch
   - @review-typescript
   - @review-testing
   - @review-docs
   - @review-platform
   - @review-ui

   Reply:
   - "go" or "all" - run all reviewers
   - "skip <reviewer>" - run all except specified
   - "only <reviewers>" - run only specified
   - Or describe changes needed to the plan
   ```

6. Handle response:
   - **Changes requested** → revise plan → ask again
   - **Approved** → immediately invoke reviewers in parallel

### State: REVIEWING

1. All reviewers run in parallel, each providing letter grade (A-F)
2. Collect results and summarize with:
   - Grade table showing each reviewer's grade
   - Consistent numbering across all issue categories
3. Default: address ALL issues
4. Update plan with fixes (single write, not multiple edits)
5. Ask: "Ready to implement? Or request another review round."

### State: IMPLEMENTING

- @implement subagent is working
- Wait for @implement to report back with one of:
  - **BLOCKED**: Implementation hit an issue
  - **IMPLEMENTATION COMPLETE**: All steps done, status is now `IMPLEMENTATION_REVIEW`

#### If BLOCKED:

- Show the issue to user
- Discuss and update the plan
- Invoke @implement again

#### If IMPLEMENTATION COMPLETE:

- Plan status is now `IMPLEMENTATION_REVIEW` (set by @implement)
- Invoke @implementation-review

### State: CODE_REVIEWING

1. **Invoke code review**:

   ```
   @implementation-review
   ```

2. **Summarize results** with grade and consistent numbering

3. **Invoke @implement** to fix issues (unless user opts out)
   - @implement runs validate:fix + test
   - Back to code review if needed

4. **Proceed to user testing** when no issues remain

### State: USER_TESTING

Ask user: "Please test the implementation. Say 'accept' when satisfied, or describe any issues."

#### If user reports issues:

- Invoke @implement with fix instructions
- @implement runs validate:fix + test
- Back to user testing

#### If user says "accept":

- Invoke @general to commit and optionally validate CI

### State: COMMITTING

Invoke @general:

```
Update plan status to COMPLETED, commit all changes.

Plan file: planning/<FEATURE_NAME>.md

Steps:
1. Update plan: IMPLEMENTATION_REVIEW → COMPLETED, last_updated to today
2. Commit all changes (code + plan) with conventional commit message
3. (If platform-specific changes) Push and wait for CI
4. Report: READY_TO_SHIP | BLOCKED
```

#### If BLOCKED (CI failed):

- Report to user
- User reviews
- @implement fixes
- Back to validate:fix + test

#### If READY_TO_SHIP:

- Invoke `/ship`

### State: SHIPPING

Invoke `/ship` command.

#### MERGED:

```
Feature shipped!

- PR: <url>
- Commit: <sha> merged to <target>

Deleting workspace...
```

Delete workspace: `codehydra_workspace_delete(keepBranch=false)`

Exception: If user previously said "keep workspace", skip deletion.

#### FAILED:

```
Ship failed!

**PR**: <url>
**Reason**: <from /ship report>

Please review the failure. Once fixed, say "retry" to ship again.
```

When user confirms fix is ready:

- @implement fixes
- Back to validate:fix + test
- Then /ship again

#### TIMEOUT:

```
PR still processing after 15 minutes.

**PR**: <url>

Please review the PR status:
- "wait" - continue waiting
- "abort" - leave PR open, end workflow
```
````

### Updated Workflow Diagram

```
PLANNING
     │
     ▼
Discuss requirements, outline approach
(DO NOT write plan file yet)
     │
     ▼
Ask: "Ready to create the plan?"
     │
     ├─── User has questions ──► continue discussion
     │
     └─── User says "create plan" / "go ahead"
                    │
                    ▼
          Write plan (status: REVIEW_PENDING)
                    │
                    ▼
          Ask: "Which reviewers? Or describe changes."
                    │
                    ├─── Changes requested ──► revise plan ──► ask again
                    │
                    └─── Approved ──► immediately invoke reviewers (parallel)
                              │
                              ▼
                    Reviews complete (with grades)
                              │
                              ▼
                    Summarize with grades + numbering
                    Default: fix ALL issues (single write)
                              │
                              ▼
                    "Ready to implement?"
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│ @implement                                              │
│ - Set status: APPROVED                                  │
│ - Implement steps                                       │
│ - Run validate:fix + test                               │
│ - Set status: IMPLEMENTATION_REVIEW                     │
│ - DO NOT COMMIT                                         │
└─────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│ @feature invokes @implementation-review                 │
│ Summarize with grade + consistent numbering (1, 2, 3...)│
│ Default: fix ALL issues                                 │
└─────────────────────────────────────────────────────────┘
     │
     ├─── issues ──► @implement fixes ──► back to validate:fix
     │
     ▼
USER TESTING (status: IMPLEMENTATION_REVIEW)
     │
     ├─── issues ──► @implement fixes ──► back to validate:fix
     │
     ▼ user: "accept"
┌─────────────────────────────────────────────────────────┐
│ @general                                                │
│ - Set status: COMPLETED                                 │
│ - Commit all (code + plan) with conventional commit     │
│ - (Optional) push + wait CI                             │
└─────────────────────────────────────────────────────────┘
     │
     ├─── BLOCKED (CI fail) ──► @implement fixes ──► back to validate:fix
     │
     ▼ READY_TO_SHIP
┌─────────────────────────────────────────────────────────┐
│ /ship                                                   │
│ - Check for existing PR (idempotency)                   │
│ - Rebase + push (if needed)                             │
│ - Create PR (if needed)                                 │
│ - Enable auto-merge                                     │
│ - Poll for merge (15 min timeout)                       │
└─────────────────────────────────────────────────────────┘
     │
     ├─── FAILED ──► user reviews ──► @implement fixes ──► back to validate:fix
     │
     ├─── TIMEOUT ──► user decides wait/abort
     │
     ▼ MERGED
Delete workspace (default) ──► DONE
```

## GitHub Repository Configuration

Add to `AGENTS.md`:

````markdown
## GitHub Repository Setup

The `/ship` command requires the following GitHub configuration:

### 1. Enable Auto-Delete Branches

Settings → General → "Automatically delete head branches" ✓

### 2. Enable Auto-Merge

Settings → General → "Allow auto-merge" ✓

### 3. Configure Branch Protection (Ruleset)

Settings → Rules → Rulesets → New ruleset

**Ruleset settings:**

- Name: `main-protection`
- Enforcement status: Active
- Target branches: Include by pattern → `main`

**Branch rules:**

- ✓ Restrict deletions
- ✓ Require a pull request before merging
  - Required approvals: 0 (for automated workflow)
- ✓ Require status checks to pass before merging
  - Status checks:
    - `CI (ubuntu-24.04)`
    - `CI (windows-2025)`
  - ✓ Require branches to be up to date before merging
- ✓ Block force pushes
- ✓ Require merge queue
  - Merge method: Merge commit (preserve history)
  - Build concurrency: 2
  - Minimum entries to merge: 1
  - Maximum entries to build: 5

**Recommended merge queue settings for this project:**

- Batch size: 1-2 (small project, fast CI)
- This minimizes wait time when one PR in a batch fails

### 4. Verify CI Workflow Triggers

Ensure `.github/workflows/ci.yaml` has:

```yaml
on:
  push:
    branches-ignore: [main]
  pull_request:
  merge_group:

jobs:
  ci:
    if: |
      github.event_name != 'pull_request' || 
      github.event.pull_request.head.repo.full_name != github.repository
```

The `merge_group` trigger is required for merge queue to run CI.
The `if` condition prevents duplicate CI runs for same-repo PRs.
````

## Testing Strategy

### Manual Testing Checklist

- [ ] Push to feature branch triggers CI
- [ ] PR from same repo does NOT trigger CI (push already ran)
- [ ] PR from fork triggers CI
- [ ] Push to main does NOT trigger CI
- [ ] Push to main with site/ changes triggers pages deployment
- [ ] Push to main with pnpm-lock.yaml changes triggers pages deployment
- [ ] Feature agent discusses requirements WITHOUT writing plan file
- [ ] Feature agent asks "Ready to create the plan?" before writing
- [ ] Feature agent only writes plan when user explicitly requests it
- [ ] Feature agent starts reviewers immediately on approval (no extra step)
- [ ] Feature agent allows plan revision before starting reviewers
- [ ] Plan reviewers include letter grade in their response
- [ ] @feature summarizes plan reviews with grades and consistent numbering
- [ ] @feature uses single write when updating plan with review fixes
- [ ] @implement does not commit (leaves dirty working tree)
- [ ] @implement updates plan status to APPROVED then IMPLEMENTATION_REVIEW
- [ ] Implementation review includes letter grade
- [ ] @feature summarizes implementation review with grade and consistent numbering
- [ ] @feature fixes ALL issues by default
- [ ] @feature allows user to skip specific issues
- [ ] @general uses conventional commit type matching PR title
- [ ] @general updates plan status to COMPLETED and commits
- [ ] `/ship` with uncommitted changes fails with clear message
- [ ] `/ship` detects existing PR and resumes polling (idempotency)
- [ ] `/ship` on clean branch creates PR with correct title format
- [ ] PR uses merge (not squash)
- [ ] Auto-merge is enabled on created PR
- [ ] PR enters merge queue
- [ ] CI runs on merge queue candidate (not on main after merge)
- [ ] Successful CI results in auto-merge
- [ ] Branch is auto-deleted after merge
- [ ] Local main branch is updated after merge
- [ ] Feature agent deletes workspace on MERGED by default
- [ ] Feature agent requires user review on FAILED
- [ ] Feature agent requires user review on TIMEOUT
- [ ] End-to-end workflow completes successfully

## Dependencies

None - uses existing `gh` CLI and git.

## Documentation Updates

### Files to Update

| File                                       | Changes Required                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `AGENTS.md`                                | Add GitHub repo configuration section, agent workflow overview, /ship command usage |
| `.opencode/agent/feature.md`               | Coordinator role, streamlined review flow, review summary with grades, invoke /ship |
| `.opencode/agent/implement.md`             | Remove commit step, update plan status transitions, clarify "DO NOT COMMIT"         |
| `.opencode/agent/review-arch.md`           | Add letter grade requirement (A-F)                                                  |
| `.opencode/agent/review-typescript.md`     | Add letter grade requirement (A-F)                                                  |
| `.opencode/agent/review-testing.md`        | Add letter grade requirement (A-F)                                                  |
| `.opencode/agent/review-docs.md`           | Add letter grade requirement (A-F)                                                  |
| `.opencode/agent/review-platform.md`       | Add letter grade requirement (A-F)                                                  |
| `.opencode/agent/review-ui.md`             | Add letter grade requirement (A-F)                                                  |
| `.opencode/agent/implementation-review.md` | Add letter grade requirement (A-F)                                                  |
| `.github/workflows/ci.yaml`                | Update triggers, remove pages job, add fork condition                               |

### New Files

| File                           | Purpose                            |
| ------------------------------ | ---------------------------------- |
| `.opencode/command/ship.md`    | The ship command                   |
| `.github/workflows/pages.yaml` | Separate pages deployment workflow |

## Definition of Done

- [ ] `.opencode/command/ship.md` created with idempotency (detect existing PR)
- [ ] `.github/workflows/ci.yaml` updated: triggers changed, pages job removed, fork condition added
- [ ] `.github/workflows/pages.yaml` created with path triggers for site-related files
- [ ] `.opencode/agent/feature.md` updated: coordinator role, explicit plan creation trigger, review summary format with grades and numbering, single-write for fixes, /ship invocation
- [ ] `.opencode/agent/implement.md` updated: no commit, status transitions (APPROVED, IMPLEMENTATION_REVIEW)
- [ ] `.opencode/agent/review-arch.md` updated: letter grade requirement
- [ ] `.opencode/agent/review-typescript.md` updated: letter grade requirement
- [ ] `.opencode/agent/review-testing.md` updated: letter grade requirement
- [ ] `.opencode/agent/review-docs.md` updated: letter grade requirement
- [ ] `.opencode/agent/review-platform.md` updated: letter grade requirement
- [ ] `.opencode/agent/review-ui.md` updated: letter grade requirement
- [ ] `.opencode/agent/implementation-review.md` updated: letter grade requirement
- [ ] `AGENTS.md` updated: GitHub configuration, merge queue batch size, agent workflow overview
- [ ] GitHub repo configured (merge queue, auto-merge, branch protection with "require up-to-date")
- [ ] Manual testing checklist completed
