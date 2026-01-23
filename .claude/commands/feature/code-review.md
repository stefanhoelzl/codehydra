---
description: Review implementation against the approved plan
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Bash, AskUserQuestion
---

# /feature:code-review Command

You invoke a code review to verify the implementation follows the approved plan.

---

## On Invocation

1. **Find the Plan**: Look for the most recent plan in `planning/`
2. **Verify Status**: Plan should be at `APPROVED` or `IMPLEMENTATION_REVIEW` status
3. **Invoke Code Review Agent**: Delegate review to the code-review agent

---

## Invoke Code Review

```
Task(subagent_type="code-review",
     description="Review implementation",
     prompt="Review the implementation to verify it followed the plan at: planning/<FEATURE_NAME>.md

## Output Requirements

Use this EXACT format:

## Code Review

**Grade: X** - Brief explanation

### Critical Issues
(numbered list or "None identified.")

### Important Issues
(numbered list or "None identified.")

### Suggestions
(numbered list or "None identified.")

### Verification Checklist
- [ ] All plan steps marked complete
- [ ] Tests added per testing strategy
- [ ] No ignore comments added
- [ ] Abstraction layers used correctly
- [ ] Documentation updated")
```

---

## After Code Review

If issues found:

1. Summarize with continuous numbering
2. Default: fix ALL issues
3. User can skip specific issues (e.g., "skip 3")
4. Re-invoke implement agent with fix instructions:

```
Task(subagent_type="implement",
     description="Fix review issues",
     prompt="Fix the following issues identified in code review:

[list of issues to fix]

Read the plan at: planning/<FEATURE_NAME>.md for context.

## Workflow Context

### Validation Commands
After ALL fixes complete:
1. Run: `pnpm validate:fix`
2. Fix any failures and re-run until all pass

### Commit Rules
**DO NOT COMMIT.** Leave the working tree dirty.

Report: FIXES COMPLETE or BLOCKED with details.")
```

After fixes complete, re-invoke code review to verify.

---

## If No Critical/Important Issues

```
Implementation complete and reviewed!

Please test the changes:
- [list key things to test based on plan]

When satisfied, say "accept" to proceed to commit.
If issues found, describe them and I'll fix.
```

---

## User Acceptance

**If user reports issues:**

- Formulate clear fix instructions
- Invoke implement agent with fix instructions
- When implement completes: re-run code review

**If user says "accept":**

```
Creating commit...
```

1. Run `git status` and `git diff`
2. Create conventional commit message:
   - `feat(<scope>): <description>` for new features
   - `fix(<scope>): <description>` for bug fixes
   - `chore(<scope>): <description>` for maintenance
3. Commit with Co-Authored-By footer

```
Committed: <commit message>

Ready to ship? Run /ship to create PR and merge.
```
