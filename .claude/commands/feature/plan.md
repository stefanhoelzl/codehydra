---
description: Write a feature plan through structured discussion phases
allowed-tools: Read, Write, Glob, Grep, Task, AskUserQuestion, mcp__codehydra__workspace_execute_command
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

**Using AskUserQuestion for scope:**

When you need to clarify boundaries or have open questions, use AskUserQuestion:

AskUserQuestion example:

- question: "What should be in scope for this feature?"
- header: "Scope"
- options:
  - label: "[Specific capability A]", description: "Include this functionality"
  - label: "[Specific capability B]", description: "Include this functionality"
  - label: "Minimal MVP", description: "Only the core requirement"
- multiSelect: true

### Phase 2: Option Exploration

Explore implementation approaches:

1. **Research the codebase** - Use Task(Explore) to find existing patterns and code
2. **Present 2-3 options** - Each with pros/cons and complexity assessment
3. **Discuss tradeoffs** - Performance, maintainability, complexity, risk
4. **Get explicit agreement** - User must agree on the chosen approach

**Presenting options:**

First explain each option in detail, then ALWAYS use AskUserQuestion for selection:

1. Describe each option with full context (approach, pros, cons)
2. Use AskUserQuestion for the user to select (required):

AskUserQuestion example:

- question: "Which implementation approach should we use?"
- header: "Approach"
- options:
  - label: "Option A: [Name]", description: "[Key tradeoff summary]"
  - label: "Option B: [Name]", description: "[Key tradeoff summary]"
  - label: "Option C: [Name]", description: "[Key tradeoff summary]"
- multiSelect: false

If user selects "Other", discuss their alternative approach.

### Phase 3: Section Coverage

For the chosen approach, ensure all plan sections are discussed:

- [ ] **Architecture** - Components involved, data flow, interfaces. For significant changes: discuss diagram approach
- [ ] **Testing Strategy** - Which test types (integration, boundary, UI, focused)? Key scenarios to test
- [ ] **UI Design** (if applicable) - User interactions, wireframe approach
- [ ] **Dependencies** - Any new packages needed?
- [ ] **Risks** - What could go wrong? Mitigations?
- [ ] **Documentation** - What docs need updating?

Track coverage internally. Before proceeding to Phase 4, verify all applicable sections have been discussed.

**Determining applicable sections:**

If unclear which sections apply, use AskUserQuestion:

AskUserQuestion example:

- question: "Which areas does this feature involve?"
- header: "Areas"
- options:
  - label: "UI changes", description: "User interface modifications"
  - label: "API/IPC changes", description: "Interface contracts (requires approval)"
  - label: "New dependencies", description: "External packages (requires approval)"
  - label: "Backend only", description: "No UI or interface changes"
- multiSelect: true

### Phase 4: Approval Check

Before proceeding to plan writing, explicitly surface any items requiring user approval per CLAUDE.md:

**Must surface if applicable:**

- **API/IPC interface changes** - Any changes to IPC channel names/signatures, API interface definitions, preload scripts, event names/payloads, shared types
- **New boundary interfaces** - Any new abstraction interfaces (`*Layer`, `*Client`, `*Provider`)
- **New dependencies** - Any packages to add (user must approve before implementation)

**Getting approvals:**

List all items requiring approval, then ALWAYS use AskUserQuestion:

AskUserQuestion example:

- question: "Do you approve these items?"
- header: "Approval"
- options:
  - label: "Approve all", description: "Proceed with all listed items"
  - label: "Approve with changes", description: "I want to modify some items"
  - label: "Discuss further", description: "I have concerns to address"
- multiSelect: false

If multiple distinct approval categories exist, you can ask up to 4 questions in one call.

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
2. **Open the plan** in VS Code using the MCP tool:
   ```
   mcp__codehydra__workspace_execute_command({
     command: "vscode.open",
     args: [{ "$vscode": "Uri", "value": "file://<absolute-path-to-plan>" }]
   })
   ```
3. Use the EXACT structure from `.claude/templates/plan.md`:

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

## Using AskUserQuestion

**ALWAYS use AskUserQuestion when:**

1. You have options the user needs to decide between
2. You have open questions that need user input

This is REQUIRED, not optional. The tool provides faster, clearer interactions.

**Mandatory use cases:**

- Scope decisions (Phase 1) - clarifying what's in/out of scope
- Approach selection (Phase 2) - choosing between implementation options
- Section applicability (Phase 3) - which plan sections apply
- Approvals (Phase 4) - getting explicit yes/no on required items
- Any open question where you need user input

**When conversation is acceptable:**

- Pure information sharing (no decision needed)
- When more than 4 options exist (present in text, then use tool for top choices)
- Follow-up clarification after user selects "Other"

**Tool constraints:**

- 1-4 questions per call
- 2-4 options per question
- Headers max 12 characters
- Users can always select "Other" for custom input

---

## Forbidden Actions

- Writing files other than the plan
- Modifying code
- Using Task(implement) or other implementation agents
- Invoking reviewers (that's /feature:plan-review)
