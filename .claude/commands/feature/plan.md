---
description: Write a feature plan through structured discussion phases
allowed-tools: Read, Write, Glob, Grep, Task, AskUserQuestion
---

# /feature:plan Command

You guide the user through structured discussion phases, then write a formal plan.

---

## On Invocation

1. **Read Context**: Read these files IN PARALLEL to understand project patterns:
   - `docs/PLANNING.md` - What documents to read and what a plan needs
   - `.claude/templates/plan.md` - The plan structure (so you know what to discuss)
   - `CLAUDE.md` - Critical rules (if not already in context)

2. **Identify Change Type**: Based on the user's feature description, read the required documents per the matrix in `docs/PLANNING.md`

3. **Introduce the Process**:

```
Ready to plan your feature. I've loaded:
- [list relevant documents read]

Key patterns/constraints for this type of change:
- [list 3-5 key patterns from the docs]

We'll work through 4 discussion phases before writing the plan:
1. Problem Exploration - understand what we're solving
2. Option Exploration - explore approaches and agree on one
3. Section Coverage - ensure all plan areas are covered
4. Approval Check - surface items needing your explicit approval

Then I'll write the formal plan for your approval.

Let's start with the problem. What are we solving?
```

---

## Discussion Phases (Required Before Plan Writing)

All 4 phases MUST complete before proceeding to plan writing. Track phase completion internally.

### Phase 1: Problem Exploration

Understand the problem space before discussing solutions:

- **What problem are we solving?** - Get specific about the pain point
- **Who benefits?** - Users, developers, the system?
- **What's in scope?** - Define boundaries clearly
- **What's explicitly out of scope?** - Prevent scope creep

Stay in this phase until the problem is clearly understood. Don't jump to solutions yet.

### Phase 2: Option Exploration

Explore implementation approaches:

1. **Research the codebase** - Use Task(Explore) to find existing patterns and code
2. **Present 2-3 options** - Each with pros/cons and complexity assessment
3. **Discuss tradeoffs** - Performance, maintainability, complexity, risk
4. **Get explicit agreement** - User must agree on the chosen approach

Example transition:

```
Based on our exploration, I see 3 approaches:

**Option A: [Name]**
- Approach: [brief description]
- Pros: [list]
- Cons: [list]

**Option B: [Name]**
- Approach: [brief description]
- Pros: [list]
- Cons: [list]

**Option C: [Name]**
- Approach: [brief description]
- Pros: [list]
- Cons: [list]

Which approach would you like to pursue?
```

### Phase 3: Section Coverage

For the chosen approach, ensure all plan sections are discussed:

- [ ] **Architecture** - Components involved, data flow, interfaces. For significant changes: discuss diagram approach
- [ ] **Testing Strategy** - Which test types (integration, boundary, UI, focused)? Key scenarios to test
- [ ] **UI Design** (if applicable) - User interactions, wireframe approach
- [ ] **Dependencies** - Any new packages needed?
- [ ] **Risks** - What could go wrong? Mitigations?
- [ ] **Documentation** - What docs need updating?

Track coverage internally. Before proceeding to Phase 4, verify all applicable sections have been discussed.

### Phase 4: Approval Check

Before proceeding to plan writing, explicitly surface any items requiring user approval per CLAUDE.md:

**Must surface if applicable:**

- **API/IPC interface changes** - Any changes to IPC channel names/signatures, API interface definitions, preload scripts, event names/payloads, shared types
- **New boundary interfaces** - Any new abstraction interfaces (`*Layer`, `*Client`, `*Provider`)
- **New dependencies** - Any packages to add (user must approve before implementation)

Example:

```
## Approval Required

Before we proceed to the plan, these items need your explicit approval:

1. **New IPC channel**: `api:workspace:newMethod` - [reason needed]
2. **New dependency**: `some-package` - [why needed]

Do you approve these? (yes/no for each)
```

If no approval items: State "No items requiring explicit approval identified."

---

## Phase Gating

If the user tries to proceed before phases are complete, remind them what's missing.

When all 4 phases are complete, confirm before writing:

```
## Discussion Complete

We've completed all discussion phases:
- [x] Problem understood: [one-line summary]
- [x] Agreed approach: [option name]
- [x] Sections covered: Architecture, Testing, [others as applicable]
- [x] Approvals: [list or "None required"]

Now I'll write the formal plan.
```

---

## Phase 5: Write the Plan

After all discussion phases are complete:

1. **Write the plan** directly to `planning/<FEATURE_NAME>.md` (ALL_CAPS with underscores)
2. Use the EXACT structure from `.claude/templates/plan.md`:

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

## Phase 6: Plan Ready for Review

After writing the plan, inform the user:

```
Plan written to planning/<NAME>.md

Next steps:
- Run /feature:plan-review to get reviewer feedback
- Or modify the plan if you want changes first
```

---

## Allowed Actions

- Read any file
- Search codebase (Glob, Grep)
- Use Task(Explore) for codebase exploration
- Use WebFetch for external documentation
- Ask user questions via AskUserQuestion
- Write to the planning file

---

## Forbidden Actions

- Writing files other than the plan
- Modifying code
- Using Task(implement) or other implementation agents
- Invoking reviewers (that's /feature:plan-review)
