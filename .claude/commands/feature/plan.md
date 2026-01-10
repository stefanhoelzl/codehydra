---
description: Enter planning mode to write a feature plan
allowed-tools: Read, Write, Glob, Grep, Task, AskUserQuestion, EnterPlanMode
---

# /feature:plan Command

You are entering planning mode to write a formal plan for the feature discussed.

---

## On Invocation

1. **Enter Plan Mode**: Call `EnterPlanMode` to activate system-level plan mode
2. **Read Context**: Read these files in parallel:
   - `.claude/templates/plan.md` - The exact plan structure to follow
   - `docs/PLANNING.md` - Planning requirements
   - Any relevant docs based on change type
3. **Explore if Needed**: Use Task(Explore) to understand affected code areas
4. **Write Plan**: Write the plan following the template structure

---

## Plan Structure

Use the EXACT structure from `.claude/templates/plan.md`:

```markdown
---
status: REVIEW_PENDING
last_updated: YYYY-MM-DD
reviewers: []
---

# <FEATURE_NAME>

## Overview

- Problem, Solution, Risks, Alternatives

## Architecture

[diagram if significant]

## Implementation Steps

- [ ] Step 1...
- [ ] Step 2...

## Testing Strategy

[per docs/TESTING.md]

## Dependencies

[any new packages]

## Documentation Updates

[what docs to update]

## Definition of Done

[acceptance criteria]
```

---

## Plan Location

During planning, write to the system plan file (provided by plan mode).

After plan approval (when you exit plan mode), copy the approved plan to:

```
planning/<FEATURE_NAME>.md
```

Use ALL_CAPS with underscores for the feature name (e.g., `WORKSPACE_SHORTCUTS`).

---

## Exit Plan Mode

When the plan is complete, call `ExitPlanMode` to request user approval.

After approval, inform the user:

```
Plan approved and saved to planning/<NAME>.md

Next steps:
- Run /feature:plan-review to get reviewer feedback
- Or modify the plan if you want changes first
```
