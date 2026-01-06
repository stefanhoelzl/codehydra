---
description: Scan codebase for quality issues across 8 topics
allowed-tools: Read, Glob, Grep, Task, WebFetch
---

You are orchestrating a quality review of the CodeHydra codebase.

## Available Topics

| Topic          | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| architecture   | Layer violations, circular deps, boundary violations, god modules |
| code-quality   | Duplication, complexity, dead code, scattered responsibilities    |
| consistency    | Pattern deviations, naming, error handling, async patterns        |
| documentation  | Completeness, accuracy, AI-readability, structure                 |
| type-safety    | tsconfig strictness, API type design, type-driven correctness     |
| testing        | TESTING.md enforcement, test type compliance, behavioral mocks    |
| infrastructure | Dependencies, project layout, tooling, CI/CD, scripts             |
| ux             | Accessibility, UI patterns, user flows, keyboard navigation       |

## Parse User Intent

$ARGUMENTS

Interpret naturally:

- Empty or "all": run all 8 topics
- "only X and Y" or "focus on X": whitelist those topics
- "skip X" or "except X": blacklist those topics
- "help", "?", or "what topics": show the topics table above and exit
- Any other text: interpret the intent naturally

## Execution

Launch Plan agents **in parallel** for each selected topic using the prompts below.

Each agent invocation MUST:

1. Read docs/QUALITY.md first (their topic section + Accepted Patterns)
2. Read the reference docs listed for that topic
3. Explore the ENTIRE codebase systematically
4. Use WebFetch for online research when uncertain about best practices
5. Filter out issues matching "Accepted Patterns" in docs/QUALITY.md
6. Focus on CODEBASE-WIDE patterns, not localized issues
7. Assess severity (Critical or Warning) based on impact and spread
8. Return max 10 issues

---

## Topic Prompts

### architecture

Review CodeHydra for ARCHITECTURE quality issues.

**Read first:**

- docs/QUALITY.md (Architecture section + Accepted Patterns)
- docs/ARCHITECTURE.md
- CLAUDE.md (External System Access Rules, Path Handling)

**Look for codebase-wide issues:**

- Layer violations (platform <-> shell, renderer <-> main process)
- Circular dependencies between modules
- God modules (>500 lines, >10 exports, too many responsibilities)
- Boundary interface violations (direct fs/fetch/execa bypassing abstractions)
- Improper dependency injection patterns
- Cross-cutting concerns leaking into domain logic

**Use WebFetch** to research Electron architecture best practices when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected locations, pattern violated.

---

### code-quality

Review CodeHydra for CODE QUALITY issues.

**Read first:**

- docs/QUALITY.md (Code Quality section + Accepted Patterns)
- CLAUDE.md (Code Quality Standards)

**Look for codebase-wide patterns (NOT localized issues):**

- Duplicated logic across multiple modules
- Inconsistent abstraction levels across similar code
- Scattered feature responsibilities (logic spread across unrelated files)
- Dead code patterns (unused exports, unreachable branches)
- Complexity hotspots (modules consistently hard to understand)
- Copy-paste code that should be extracted

**Use WebFetch** to research clean code principles when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected locations.

---

### consistency

Review CodeHydra for CONSISTENCY issues.

**Read first:**

- docs/QUALITY.md (Consistency section + Accepted Patterns)
- docs/PATTERNS.md (all patterns)

**Look for deviations from established patterns:**

- Deviations from docs/PATTERNS.md across the codebase
- Inconsistent error handling (throw vs return vs log)
- Naming convention violations (Service vs Manager vs Client)
- Mixed async patterns (callbacks vs promises vs async/await)
- Inconsistent return type patterns across similar functions

**Use WebFetch** to research TypeScript/Electron conventions when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected locations, pattern reference.

---

### documentation

Review CodeHydra for DOCUMENTATION quality issues.

**Read first:**

- docs/QUALITY.md (Documentation section + Accepted Patterns)
- All files in docs/ directory
- CLAUDE.md

**Assess documentation for:**

- **Completeness**: Are all public APIs documented? Missing sections?
- **AI-agent readability**: Clear structure, decision trees, actionable guidance?
- **Accuracy**: Does documentation match actual code behavior?
- **Freshness**: Outdated examples? Deprecated patterns still documented?
- **Cross-references**: Do docs link to each other appropriately?
- **Actionable guidance**: Do docs tell you what to do, not just what exists?

**Use WebFetch** to research documentation best practices for AI agents when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected docs.

---

### type-safety

Review CodeHydra for TYPE SAFETY issues.

**Read first:**

- docs/QUALITY.md (Type Safety section + Accepted Patterns)
- tsconfig.json, tsconfig.node.json, tsconfig.web.json
- CLAUDE.md (Code Quality Standards)

**Assess TypeScript configuration and usage:**

- **tsconfig review**: Is strict mode fully enabled? All strict flags on?
- **API type design**: Do types guide correct usage and prevent misuse?
  - Can you call an API incorrectly and have it compile?
  - Are discriminated unions used where appropriate?
  - Are optional vs required properties correct?
- **Generic usage**: Are generics used to enforce constraints?
- **Type narrowing**: Are type guards used appropriately?
- **Branded types**: Are distinct primitives (IDs, paths) distinguished?

**Use WebFetch** to research TypeScript strict mode best practices when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected locations, type improvement suggestions.

---

### testing

Review CodeHydra for TESTING strategy compliance.

**Read first:**

- docs/QUALITY.md (Testing section + Accepted Patterns)
- docs/TESTING.md (complete document)
- vitest.config.ts

**Verify TESTING.md enforcement:**

- Are boundary tests used for external interfaces (git, fs, http, processes)?
- Are integration tests used instead of deprecated unit tests?
- Are behavioral mocks used (not structural mocks)?
- Is the right test type used for each code type?
- Are public APIs covered by tests?
- Do tests have meaningful assertions (not just "doesn't throw")?
- Are tests fast (<50ms per integration test)?

**Use WebFetch** to research behavioral testing patterns when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected test files, TESTING.md reference.

---

### infrastructure

Review CodeHydra for INFRASTRUCTURE quality.

**Read first:**

- docs/QUALITY.md (Infrastructure section + Accepted Patterns)
- package.json, pnpm-workspace.yaml
- eslint.config.js, .prettierrc
- .github/workflows/\*.yaml
- scripts/\*.ts

**Assess project health:**

- **Dependencies**: Unused deps? Duplicate deps? Significantly outdated?
- **Project layout**: Files in wrong directories? Orphaned files?
- **Tooling config**: ESLint, Prettier, TypeScript configs aligned?
- **Build scripts**: Maintainable? Documented? Following patterns?
- **CI/CD**: Workflows complete and correct?
- **Non-production code**: Quality of scripts, tools, dev utilities?

**Use WebFetch** to research pnpm/Electron project best practices when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected files.

---

### ux

Review CodeHydra for UX quality.

**Read first:**

- docs/QUALITY.md (UX section + Accepted Patterns)
- docs/USER_INTERFACE.md
- docs/PATTERNS.md (UI Patterns, VSCode Elements, CSS Theming)
- src/renderer/ directory

**Assess user experience quality:**

- **Accessibility**: ARIA attributes, keyboard navigation, screen reader support
- **UI pattern adherence**: Consistent with docs/USER_INTERFACE.md?
- **User flow completeness**: Are flows complete and intuitive?
- **Keyboard shortcuts**: Documented and working?
- **Visual consistency**: CSS variables, theming patterns followed?
- **Error state UX**: Are error UIs helpful and informative?

**Use WebFetch** to research VS Code extension UX guidelines when uncertain.

**Return max 10 issues** with: severity (Critical/Warning), description, affected components.

---

## Aggregation

After all agent invocations complete:

1. Collect all findings from each topic
2. **Deduplicate**: Combine issues that describe the same or overlapping problems
   - If multiple topics report the same root cause, merge into one issue
   - List all contributing topics in brackets: `[architecture, consistency]`
   - Combine affected locations from all reports
   - Use the highest severity among the duplicates
3. Sort by severity (Critical first), then by spread (more affected locations = higher)
4. **Limit to 10 issues total**
5. Summarize to user in the format below

## Output Format

# Quality Report

**Scanned:** <file count> files | **Topics:** <comma-separated list of topics run>

---

## Critical (N)

### [topic1, topic2] Issue Title

<2-3 sentence description explaining the codebase-wide issue, its impact on maintainability/correctness, and why it matters. When combined from multiple topics, explain how the issue manifests across different quality dimensions.>

**Affected locations:**

- path/to/file1.ts
- path/to/file2.ts
- ... (N total)

**Pattern violated:** <reference to docs if applicable>

---

## Warnings (N)

### [topic] Issue Title

<description>

**Affected locations:**

- ...

---

_Report limited to 10 most severe issues. Run `/review-quality only <topic>` for focused analysis of a specific area._
