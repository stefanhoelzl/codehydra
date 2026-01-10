---
description: Invoke parallel reviewers on the feature plan
allowed-tools: Read, Write, Edit, Glob, Grep, Task, AskUserQuestion
---

# /feature:plan-review Command

You invoke parallel reviewers to analyze the feature plan and provide feedback.

---

## On Invocation

1. **Find the Plan**: Look for the most recent plan in `planning/`
2. **Determine Reviewers**: Select reviewers based on plan content

---

## Reviewer Selection

**Default reviewers (always include):**

- `review-arch` - Architecture, dependencies, documentation
- `review-quality` - TypeScript, clean code, cross-platform
- `review-testing` - Test strategy, TDD approach

**Optional reviewer:**

- `review-ui` - Include when plan affects `src/renderer/` files

---

## Invoke Reviewers

Invoke ALL selected reviewers IN PARALLEL (single message, multiple Task calls).

Each reviewer invocation MUST include:

```
Review this plan for [aspect] aspects.

## Output Requirements

Your response MUST start with a letter grade (A-F):

| Grade | Meaning                                         |
| ----- | ----------------------------------------------- |
| **A** | Excellent - no issues or minor suggestions only |
| **B** | Good - minor issues that should be addressed    |
| **C** | Acceptable - notable issues that need attention |
| **D** | Poor - significant issues found                 |
| **F** | Failing - critical issues or fundamental flaws  |

Use this EXACT format:

## [Aspect] Review

**Grade: X** - Brief explanation

### Critical Issues
(numbered list or "None identified.")

### Important Issues
(numbered list or "None identified.")

### Suggestions
(numbered list or "None identified.")

Read the plan at: planning/<FEATURE_NAME>.md
```

---

## After Reviews Complete

1. Read `.claude/templates/review-summary.md` for format
2. Create a summary with:
   - Grade table (reviewer | grade | summary)
   - All issues with continuous numbering
   - Consolidated suggestions

3. Ask user how to proceed:

```
## Plan Review Summary

| Reviewer | Grade | Summary |
|----------|-------|---------|
| arch     | B     | ... |
| quality  | A     | ... |
| testing  | B     | ... |

### Issues to Address
1. [Issue from arch review]
2. [Issue from testing review]
...

### Suggestions (optional)
...

**Options:**
- "fix all" - Apply all fixes to the plan (default)
- "skip 2,3" - Skip specific issues
- "discuss 1" - Discuss a specific issue before deciding
```

---

## Fixing Issues

When user approves fixes:

1. Read the current plan
2. Apply fixes in a single write (preserve any completed checkboxes)
3. Report what was changed

```
Plan updated with fixes for issues 1, 2, 4.
Skipped: issue 3 (user requested)

Ready for implementation? Run /feature:implement
```
