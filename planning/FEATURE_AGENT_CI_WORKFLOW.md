---
status: COMPLETED
last_updated: 2025-12-30
reviewers: [review-docs, review-arch]
---

# FEATURE_AGENT_CI_WORKFLOW

## Overview

- **Problem**: The feature agent workflow ends after commit. Changes must be manually rebased, pushed, CI-checked, and merged into main.
- **Solution**: Extend workflow to automate everything after user acceptance: commit → rebase → push → CI → merge → cleanup. One @general invocation handles the entire flow, only returning on failures.
- **Risks**:
  - CI timeout needs user decision
  - Workspace deletion is irreversible (user must confirm)

## Workflow

```
REVIEW_PENDING ──► (reviews) ──► @implement ──► APPROVED
                                                    │
                                          (implement completes)
                                                    │
                                                    ▼
                              @implementation-review ──► USER_TESTING ◄───┐
                                                              │           │
                                                        ┌─────┴─────┐     │
                                                        ▼           ▼     │
                                                    (issues)    "accept"  │
                                                        │           │     │
                                                        ▼           │     │
                                                    @implement      │     │
                                                        │           │     │
                                                        └───────────┤     │
                                                                    │     │
                                                                    ▼     │
                                                               CI_CYCLE   │
                                                                    │     │
                                                                    ▼     │
                                            @general (runs to COMPLETED)  │
                                            ┌────────────────────────────┐│
                                            │ 1. commit                  ││
                                            │ 2. rebase (resolve any)    ││
                                            │ 3. push                    ││
                                            │ 4. wait CI (~10m)          ││
                                            │    ├─ TIMEOUT → bail       ││
                                            │    ├─ FAILED → bail        ││
                                            │    └─ PASSED → continue    ││
                                            │ 5. ff-merge                ││
                                            │    ├─ OK → continue        ││
                                            │    └─ target advanced:     ││
                                            │        rebase, if conflict ││
                                            │        → push, goto 4      ││
                                            │        else → ff-merge     ││
                                            │ 6. verify merge success    ││
                                            │ 7. delete remote branch    ││
                                            │ 8. update local target     ││
                                            │ 9. report COMPLETED        ││
                                            └────────────────────────────┘│
                                                        │                 │
                                               ┌────────┼────────┐        │
                                               ▼        ▼        ▼        │
                                            TIMEOUT COMPLETED  FAILED     │
                                               │        │        │        │
                                               ▼        ▼        ▼        │
                                             ask     ask user  propose    │
                                             wait/   delete?   fix        │
                                             abort      │        │        │
                                               │     ┌──┴──┐     ▼        │
                                               │     ▼     ▼  @implement  │
                                               │    yes    no    │        │
                                               │     │     │     └────────┘
                                               │     ▼     │
                                               │  delete   │
                                               │    ws     │
                                               │     │     │
                                               ▼     ▼     ▼
                                              DONE  DONE  DONE
```

## State Changes

### Rename: CODE_REVIEW_DONE → USER_TESTING

The state after implementation review should be called USER_TESTING.

### Modified: USER_TESTING "accept" handling

**Before**:

```
#### If user says "accept":
- Invoke general agent to commit [long prompt]
- Move to COMPLETED
```

**After**:

```
#### If user says "accept":
- Move to CI_CYCLE state
```

### New State: CI_CYCLE

Single @general invocation that handles everything until completion.

```
Task(subagent_type="general",
     description="Commit, push, CI, merge, cleanup",
     prompt="Complete the feature: commit, push to CI, merge to main, cleanup.

Plan file: planning/<FEATURE_NAME>.md

Execute these steps in order, only stopping on CI_TIMEOUT or CI_FAILED.

## 0. Detect target branch
- Get default branch: git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'
- Use this as <target> in all subsequent steps (typically 'main')

## 1. Commit (skip if already committed)
- Check if there are uncommitted changes: git status --porcelain
- If no changes: skip to step 2 (idempotent restart)
- Update plan status to USER_TESTING, last_updated to today
- git add -A
- Commit with message:
  feat(<scope>): <short description>

  Implements <FEATURE_NAME> plan.

  - <key change 1>
  - <key change 2>

  Plan: planning/<FEATURE_NAME>.md

## 2. Rebase and Push
- git fetch origin <target>
- git rebase origin/<target>
  - If conflicts occur: RESOLVE THEM using standard strategies
    - For code conflicts: analyze both versions, merge intelligently
    - git add <resolved-file>
    - git rebase --continue
    - Repeat until rebase completes
- git push --force-with-lease origin HEAD
- Record current HEAD sha: git rev-parse HEAD

## 3. Wait for CI (max 10 minutes)
- Get branch: git branch --show-current
- Get HEAD sha: git rev-parse HEAD
- Poll every 30s for up to 10 minutes:
  gh run list --branch <branch> --json headSha,status,conclusion,url --limit 5

  Example response:
  [
    {"headSha": "abc123", "status": "completed", "conclusion": "success", "url": "..."},
    {"headSha": "def456", "status": "completed", "conclusion": "failure", "url": "..."}
  ]

  Parsing rules:
  - Find entry where headSha matches current HEAD (ignore runs for old commits)
  - If no matching entry: CI not started yet, keep polling
  - If status != "completed": still running, keep polling
  - If status == "completed" AND conclusion == "success": CI_PASSED
  - If status == "completed" AND conclusion != "success": CI_FAILED

If TIMEOUT (10 min elapsed, no completed run for HEAD): Report CI_TIMEOUT and stop
If FAILED: Report CI_FAILED with error details and stop
If PASSED: Continue to merge

## 4. Merge to target
- git fetch origin <target>
- Check ff-merge possible: git merge-base --is-ancestor origin/<target> HEAD
  (exit 0 = our HEAD is ahead of origin/<target>, ff possible)
- If YES: git push origin HEAD:<target>
- If NO (target has new commits since we branched):
  - git rebase origin/<target>
  - If conflicts: resolve them (same as step 2), push, go back to step 3
  - If clean (no conflicts): git push origin HEAD:<target>

## 5. Verify merge success
- git fetch origin <target>
- Verify: git rev-parse HEAD == git rev-parse origin/<target>
- If mismatch: report error (race condition with another merge)

## 6. Cleanup
- Get branch name: git branch --show-current
- Delete remote branch: git push origin --delete <branch>
- Find main worktree:
  git worktree list
  (Parse output: find entry that is NOT current directory and NOT under workspaces/)
- Update local target branch:
  git -C <main-dir> fetch origin <target>
  git -C <main-dir> pull --ff-only origin <target>
  (If pull fails due to local changes, report warning but continue)
- Update plan status to COMPLETED

## Report Formats

CI_TIMEOUT
**Branch**: <branch>
**Run URL**: <url>
**Status**: still running after 10 minutes

CI_FAILED
**Branch**: <branch>
**Run URL**: <url>
**Failed jobs**: <list>
**Error**: <relevant logs from gh run view --log-failed>

COMPLETED
**Commit**: <hash> merged to <target>
**Branch deleted**: <branch>
**Local <target> updated**: <path>")
```

### CI_TIMEOUT Handling

```
CI still running after 10 minutes.

**Run**: [url]

Reply:
- "wait" - wait another 10 minutes
- "abort" - stop workflow
```

**Technical flow:**

- "wait": Invoke @general with prompt: "Continue waiting for CI on branch <branch>. Start from step 3 (Wait for CI). Current HEAD: <sha>. Target branch: <target>."
- "abort": End workflow (changes are committed and pushed, but not merged)

### CI_FAILED Handling

```
CI failed!

**Run**: [url]
**Failed jobs**: [list]

**Error analysis**: [explain what went wrong]

**Proposed fix**: [specific fix]

Reply:
- "fix" - implement the fix
- Describe a different approach
- "abort" - stop workflow
```

- Fix accepted: Invoke @implement → returns to **USER_TESTING** (user tests the fix before re-accepting)
- "abort": End workflow

### COMPLETED Handling

**Important**: Report completion FIRST, then offer deletion as optional cleanup.

```
Feature complete!

- Merged to <target>: [commit hash]
- Remote branch deleted
- Local <target> updated

Delete this workspace?
- "yes" - delete workspace
- "no" - keep workspace
```

- Workflow is COMPLETE regardless of deletion choice
- "yes": `codehydra_workspace_delete(keepBranch=false)`, then report "Workspace deleted"
- "no": Report "Workspace kept"

## Status Values

**Before**: `REVIEW_PENDING` → `APPROVED` → `CLEANUP` → `CODE_REVIEW_DONE` → `COMPLETED`

**After**: `REVIEW_PENDING` → `APPROVED` → `CLEANUP` → `USER_TESTING` → `COMPLETED`

Note: CI_CYCLE is a transient operation, not a persisted status. The plan goes directly from USER_TESTING to COMPLETED.

## Definition of Done (plan template update)

After "User acceptance testing passed", add:

```
- [ ] CI passed
- [ ] Merged to main
```

Full list:

```
- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
```

## Implementation Steps

- [x] **Step 1: Rename CODE_REVIEW_DONE to USER_TESTING**
  - Search and replace all occurrences
  - File: `.opencode/agent/feature.md`

- [x] **Step 2: Update workflow diagram**
  - Add CI_CYCLE state between USER_TESTING "accept" and COMPLETED
  - Show TIMEOUT/COMPLETED/FAILED outcomes
  - Show FAILED → @implement → USER_TESTING loop
  - File: `.opencode/agent/feature.md`

- [x] **Step 3: Update agent description**
  - Change "code review, and commit" to "code review, CI/CD, and merge"
  - File: `.opencode/agent/feature.md`

- [x] **Step 4: Modify USER_TESTING "accept" handling**
  - Replace commit invocation with "Move to CI_CYCLE state"
  - File: `.opencode/agent/feature.md`

- [x] **Step 5: Add CI_CYCLE state section**
  - Add full @general prompt with all steps
  - Add CI_TIMEOUT handling with resume instructions
  - Add CI_FAILED handling with @implement → USER_TESTING flow
  - Add COMPLETED handling with deletion confirmation
  - File: `.opencode/agent/feature.md`

- [x] **Step 6: Update status values**
  - Change CODE_REVIEW_DONE to USER_TESTING
  - Remove any COMMITTED intermediate state
  - File: `.opencode/agent/feature.md`

- [x] **Step 7: Update Definition of Done in plan template**
  - After "User acceptance testing passed" add:
    - "- [ ] CI passed"
    - "- [ ] Merged to main"
  - File: `.opencode/agent/feature.md`

- [x] **Step 8: Update behavior rules**
  - Add: "CI_CYCLE runs to completion, only bails on TIMEOUT or FAILED"
  - Add: "After CI_FAILED fix, return to USER_TESTING (not directly to CI_CYCLE)"
  - Add: "Report COMPLETED before offering workspace deletion"
  - File: `.opencode/agent/feature.md`

## Manual Testing Checklist

- [ ] Happy path: accept → CI passes → merge → confirm delete → done
- [ ] Happy path keep ws: accept → CI passes → merge → decline delete → done
- [ ] Pre-CI conflicts: rebase conflicts resolved automatically → CI passes → merge
- [ ] CI failure: fails → fix → USER_TESTING → accept → CI passes → merge
- [ ] CI timeout wait: timeout → wait → CI passes → merge
- [ ] CI timeout abort: timeout → abort (verify changes still pushed)
- [ ] Main advanced clean: CI passes → main advanced → clean rebase → ff-merge
- [ ] Main advanced conflicts: CI passes → main advanced → resolve → CI again → merge
- [ ] Idempotent restart: if CI_CYCLE interrupted, re-running skips already-committed changes

## Dependencies

None.

## Definition of Done

- [ ] All steps complete
- [ ] Happy path tested
