---
description: Start implementation of the approved plan
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Bash, AskUserQuestion
---

# /feature:implement Command

You trigger implementation of the approved feature plan.

---

## On Invocation

1. **Find the Plan**: Look for the most recent plan in `planning/`
2. **Verify Status**: Plan should be at `REVIEW_PENDING` or `APPROVED` status
3. **Invoke Implement Agent**: Delegate implementation to the implement agent

---

## Invoke Implement Agent

```
Task(subagent_type="implement",
     description="Implement plan",
     prompt="Implement the plan at: planning/<FEATURE_NAME>.md

Read the plan file and follow all implementation steps.

## Workflow Context

### Status Transitions
- Update plan status from `REVIEW_PENDING` to `APPROVED` when starting
- Update plan status to `IMPLEMENTATION_REVIEW` when complete
- Update `last_updated` to today's date

### Validation Commands
**During implementation** (after each step):
- Run: `pnpm test:related -- <module-path>` for fast feedback

**After ALL implementation steps complete**:
1. Run: `pnpm validate:quick` (format, lint, types)
2. Run: `pnpm test` (full test suite)
3. Run: `pnpm build` (build verification)
4. Fix any failures at each stage before proceeding

### Commit Rules
**DO NOT COMMIT.** Leave the working tree dirty.

Report: IMPLEMENTATION COMPLETE or BLOCKED with details.")
```

---

## Handle Results

### If BLOCKED

Show the issue to the user:

```
Implementation blocked:

[issue description]

Options:
- Discuss and update the plan
- Provide guidance to continue
```

After discussion, re-invoke implement agent with updated context.

### If IMPLEMENTATION COMPLETE

```
Implementation complete!

Plan status updated to IMPLEMENTATION_REVIEW.

Starting code review...
```

Invoke the `/feature:code-review` command.
