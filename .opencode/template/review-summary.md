# Review Summary Template

This template is used by the feature agent to summarize reviews. It works for both plan reviews (multiple reviewers) and implementation reviews (single reviewer).

## Plan Review Summary Format

Use when summarizing plan reviews from multiple reviewers:

```markdown
## Plan Review Summary

| Reviewer           | Grade | Issues                     |
| ------------------ | ----- | -------------------------- |
| @review-arch       | B     | 1 important, 2 suggestions |
| @review-typescript | A     | No issues                  |
| @review-testing    | C     | 1 critical, 1 important    |
| @review-docs       | A     | 1 suggestion               |
| @review-platform   | B     | 1 important                |
| @review-ui         | A     | No issues                  |

### Critical Issues

1. **[review-testing]** Issue description
   - Location: affected section
   - Fix: recommendation

### Important Issues

2. **[review-arch]** Issue description
   - Location: affected section
   - Fix: recommendation

3. **[review-platform]** Issue description
   - Location: affected section
   - Fix: recommendation

### Suggestions

4. **[review-arch]** Suggestion description
   - Location: affected section
   - Fix: recommendation

5. **[review-arch]** Suggestion description
   - Location: affected section
   - Fix: recommendation

6. **[review-docs]** Suggestion description
   - Location: affected section
   - Fix: recommendation

---

Addressing all 6 issues. Let me know if you want to skip any (e.g., "skip 5-6").
```

## Implementation Review Summary Format

Use when summarizing a single implementation review:

```markdown
## Implementation Review

**Grade: B** - Good implementation with minor issues

### Critical Issues

1. **Issue title** - description
   - File: path/to/file.ts
   - Fix: what needs to change

### Important Issues

2. **Issue title** - description
   - File: path/to/file.ts
   - Fix: what needs to change

### Suggestions

3. **Issue title** - description
   - File: path/to/file.ts
   - Fix: what needs to change

---

Fixing all 3 issues. Let me know if you want to skip any (e.g., "skip 3").
```

## Key Rules

- Numbers are **continuous** across categories (never restart at 1)
- **Default behavior**: Fix ALL issues (Critical + Important + Suggestions)
- User can opt out by specifying issues to skip (e.g., "skip 3" or "skip suggestions")
- Grade table shows each reviewer's letter grade
- When addressing issues, use a **single write** to update the plan (not multiple edits)

## Letter Grade Meanings

Grade meanings (A-F) are provided in the reviewer invocation prompts.
