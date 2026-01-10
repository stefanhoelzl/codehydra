# Contributing to CodeHydra

## Development Setup

See [README.md](README.md) for quick start instructions.

## Feature Workflow

The feature workflow uses explicit commands for each phase transition:

| Command              | Purpose                             |
| -------------------- | ----------------------------------- |
| `/feature:discuss`   | Load context, discuss the feature   |
| `/feature:plan`      | Enter planning mode, write the plan |
| `/feature:review`    | Invoke parallel reviewers           |
| `/feature:implement` | Start implementation                |
| `/ship`              | Create PR with auto-merge           |

### Workflow Overview

```
/feature:discuss → Load context (docs/PLANNING.md + relevant docs)
       ↓
Natural discussion (explore, ask questions)
       ↓
/feature:plan → Enter plan mode → Write plan → User approves
       ↓
/feature:review → Invoke reviewers (parallel) → Summarize → Fix issues
       ↓
/feature:implement → implement agent → code-review → User testing
       ↓
User accepts → commit → /ship
       ↓
┌──────┼──────┬─────────┐
↓      ↓      ↓         ↓
MERGED FAILED TIMEOUT
```

### Plan Status Transitions

| Status                  | Set By    | When                                                |
| ----------------------- | --------- | --------------------------------------------------- |
| `REVIEW_PENDING`        | plan      | Plan created                                        |
| `APPROVED`              | implement | Starting implementation                             |
| `IMPLEMENTATION_REVIEW` | implement | Implementation complete, ready for review & testing |
| `COMPLETED`             | user      | User accepted, committed                            |

### Planning Requirements

See [docs/PLANNING.md](docs/PLANNING.md) for:

- Which documents to read for each change type
- What a plan must contain
- Questions to answer during discussion

### /ship Command

The `/ship` command creates a PR with auto-merge and waits for merge via client-side queue:

1. Validates clean working tree (fails if uncommitted changes)
2. Checks for existing PR (idempotent - resumes if PR exists)
3. Pushes branch, creates PR with conventional commit title
4. Enables auto-merge with merge (not squash)
5. Runs `ship-wait.ts` script which handles:
   - Waiting for PRs ahead in queue (FIFO by creation time)
   - Rebasing onto main when it's our turn
   - Waiting for CI via `gh pr checks --watch`
   - Confirming auto-merge completion
6. Updates local target branch on success

**Outcomes:**

- **MERGED**: PR merged successfully, workspace deleted by default
- **FAILED**: PR failed (conflicts, checks, etc.) - requires user review
- **TIMEOUT**: Still processing after 15 min - user decides wait/abort

---

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

**Note:** GitHub merge queue is not available for personal account repos.
The `/ship` command implements a client-side queue via `.claude/commands/ship-wait.ts`
that provides similar functionality:

- PRs merge in FIFO order (by creation time)
- Each PR is rebased onto main before CI runs
- No merge conflicts at merge time

### 4. Verify CI Workflow Triggers

Ensure `.github/workflows/ci.yaml` has:

```yaml
on:
  push:
    branches-ignore: [main]
  pull_request:

jobs:
  ci:
    if: |
      github.event_name != 'pull_request' ||
      github.event.pull_request.head.repo.full_name != github.repository
```

The `if` condition prevents duplicate CI runs for same-repo PRs.

---

## Code Quality

See [docs/TESTING.md](docs/TESTING.md) for testing requirements.

### Validation

Before submitting changes:

```bash
pnpm validate:fix  # Auto-fix formatting/linting, run tests
```

All checks must pass:

- TypeScript: `pnpm check`
- ESLint: `pnpm lint`
- Prettier: `pnpm format:check`
- Tests: `pnpm test`
- Build: `pnpm build`
