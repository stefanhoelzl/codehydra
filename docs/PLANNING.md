# Planning Requirements

This document specifies what context to load and what a plan must contain for different types of changes.

---

## Required Reading by Change Type

Before planning, read the documents relevant to your change type:

| Change Type        | Required Documents                                |
| ------------------ | ------------------------------------------------- |
| New feature        | ARCHITECTURE.md, PATTERNS.md, TESTING.md          |
| UI change          | PATTERNS.md (UI Patterns section), TESTING.md     |
| API/IPC change     | API.md, ARCHITECTURE.md                           |
| External interface | ARCHITECTURE.md, PATTERNS.md (abstraction layers) |
| Bug fix            | TESTING.md                                        |
| Refactoring        | ARCHITECTURE.md, PATTERNS.md                      |
| Documentation      | Existing docs in docs/                            |

---

## Plan Template

Use `.claude/templates/plan.md` for the exact structure. Every plan must include:

### Required Sections

| Section                  | What It Answers                                                      |
| ------------------------ | -------------------------------------------------------------------- |
| **Overview**             | What problem? What solution? What risks? What alternatives?          |
| **Architecture**         | How does this fit into the system? (diagram for significant changes) |
| **Testing Strategy**     | Which test types needed? (per docs/TESTING.md)                       |
| **Implementation Steps** | What to build, in what order, with test criteria for each step       |
| **Dependencies**         | Any new packages needed? (require user approval)                     |
| **Documentation**        | What docs need updating?                                             |
| **Definition of Done**   | Acceptance criteria                                                  |

### Optional Sections

| Section            | When to Include                                 |
| ------------------ | ----------------------------------------------- |
| **UI Design**      | Changes to src/renderer/                        |
| **Boundary Tests** | New external interfaces (FileSystem, Git, HTTP) |

---

## Questions to Answer During Discussion

Before writing a plan, ensure you can answer:

1. **Problem**: What specific problem does this solve?
2. **Users**: Who benefits and how?
3. **Scope**: What's in scope? What's explicitly out of scope?
4. **Approach**: Why this solution over alternatives?
5. **Patterns**: Which project patterns apply? (from docs/PATTERNS.md)
6. **Testing**: How will we verify it works? (from docs/TESTING.md)
7. **Risks**: What could go wrong? How do we mitigate?
8. **Dependencies**: Any new packages or external requirements?

---

## Constraints Reference

From CLAUDE.md, these must never be violated without explicit user approval:

### No Ignore Comments

- No `@ts-ignore`, `@ts-expect-error`, `eslint-disable*`, `any` assertions

### API/IPC Changes

- IPC channel names/signatures are stable contracts
- Changes require explicit approval

### External System Access

- Must use abstraction interfaces (FileSystemLayer, HttpClient, GitClient, etc.)
- Never access external systems directly

### Path Handling

- Use `Path` class for internal paths
- Convert at IPC boundary

---

## Plan Status Lifecycle

| Status                  | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| `REVIEW_PENDING`        | Plan created, awaiting reviewer feedback       |
| `APPROVED`              | Reviews passed, implementation can begin       |
| `IMPLEMENTATION_REVIEW` | Implementation complete, ready for code review |
| `COMPLETED`             | User accepted, committed                       |
