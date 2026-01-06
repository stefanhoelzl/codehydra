# Plan Template

Use this EXACT structure when creating a plan:

```markdown
---
status: REVIEW_PENDING
last_updated: YYYY-MM-DD
reviewers: []
---

# <FEATURE_NAME>

## Overview

- **Problem**: What problem does this solve?
- **Solution**: High-level approach
- **Risks**: Identified risks and mitigations
- **Alternatives Considered**: Other approaches and why they were rejected

## Architecture

` ` `[ASCII architecture diagram showing components and data flow]` ` `

## UI Design (if applicable)

` ` `[ASCII wireframes]` ` `

### User Interactions

- Interaction 1: description
- Interaction 2: description

## Implementation Steps

- [ ] **Step 1: Title**
  - Description
  - Files affected
  - Test criteria

- [ ] **Step 2: Title**
  - Description
  - Files affected
  - Test criteria

(continue for all steps...)

## Testing Strategy

### Integration Tests

Test behavior through high-level entry points with behavioral mocks.

| #   | Test Case | Entry Point             | Boundary Mocks        | Behavior Verified               |
| --- | --------- | ----------------------- | --------------------- | ------------------------------- |
| 1   | test name | `CodeHydraApi.method()` | GitClient, FileSystem | `expect(result).toContain(...)` |

### UI Integration Tests (if applicable)

| #   | Test Case | Category                      | Component     | Behavior Verified |
| --- | --------- | ----------------------------- | ------------- | ----------------- |
| 1   | test name | API-call / UI-state / Pure-UI | ComponentName | what it verifies  |

### Boundary Tests (only for new external interfaces)

| #   | Test Case | Interface     | External System | Behavior Verified    |
| --- | --------- | ------------- | --------------- | -------------------- |
| 1   | test name | InterfaceName | Git/HTTP/FS/etc | real system behavior |

### Focused Tests (only for pure utility functions)

| #   | Test Case | Function     | Input/Output             |
| --- | --------- | ------------ | ------------------------ |
| 1   | test name | functionName | input -> expected output |

### Manual Testing Checklist

- [ ] Test scenario 1
- [ ] Test scenario 2

## Dependencies

| Package  | Purpose    | Approved |
| -------- | ---------- | -------- |
| pkg-name | why needed | [ ]      |

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `pnpm add <package>` to use the latest versions.**

## Documentation Updates

### Files to Update

| File            | Changes Required       |
| --------------- | ---------------------- |
| path/to/file.md | description of changes |

### New Documentation Required

| File           | Purpose           |
| -------------- | ----------------- |
| path/to/new.md | what it documents |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
```

## Status Values

| Status                  | Set By    | When                                                |
| ----------------------- | --------- | --------------------------------------------------- |
| `REVIEW_PENDING`        | feature   | Plan created                                        |
| `APPROVED`              | implement | Starting implementation                             |
| `IMPLEMENTATION_REVIEW` | implement | Implementation complete, ready for review & testing |
| `COMPLETED`             | general   | User accepted, committed                            |
