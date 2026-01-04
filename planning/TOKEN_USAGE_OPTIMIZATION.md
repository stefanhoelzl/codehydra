---
status: COMPLETED
last_updated: 2026-01-04
reviewers: [review-arch, review-docs, prompt-engineering]
---

# TOKEN_USAGE_OPTIMIZATION

## Overview

- **Problem**: Feature agent workflow consumes ~$10.48 per session. Analysis of 675 sessions ($3,542 total) shows inefficiencies: each @implement call creates new session (re-discovers codebase), 6 reviewers run by default, expensive Opus model used for mechanical tasks, and full plan content embedded in every subagent prompt (causing verbose output as agents repeat/summarize it).

- **Solution**: Optimize token usage through 5 strategies:
  1. Reuse @implement sessions (pass session_id for subsequent calls)
  2. Pass plan file path instead of embedding content (reduces output tokens)
  3. Consolidate reviewers from 6 to 4 (3 default + 1 optional)
  4. Reduce thinking budgets for mechanical tasks
  5. Use Sonnet 4.5 model for most reviewers and simple @implement fixes

- **Risks**:
  - Sonnet may miss subtle issues that Opus would catch → Mitigated by keeping Opus for @review-arch, complex fixes, and initial implementation
  - Combined reviewers may miss specialized issues → Mitigated by keeping @review-ui optional for UI work
  - Session reuse may fail → Fallback to creating new session on any failure

- **Alternatives Considered**:
  - Skip reviewers entirely: Rejected - reviews catch real issues
  - Use Sonnet for all @implement calls: Rejected - initial implementation needs Opus quality
  - Reduce to 2 reviewers: Rejected - testing review is valuable
  - Chunked plan reading by section: Rejected - may miss context

## Baseline Metrics

| Metric                   | Value         |
| ------------------------ | ------------- |
| Average session cost     | $10.48        |
| Sessions analyzed        | 675           |
| Total cost analyzed      | $3,542        |
| Average @implement calls | 5 per session |
| Average reviewers        | 5 per session |

### Expected Savings Per Optimization

| Optimization                 | Estimated Savings | Notes                           |
| ---------------------------- | ----------------- | ------------------------------- |
| Session reuse for @implement | $1.66 (16%)       | Context cached after first call |
| Plan path references         | $0.40 (4%)        | Reduces output token verbosity  |
| Consolidate to 3 reviewers   | $0.26 (2%)        | @review-arch stays Opus         |
| Reduce thinking budgets      | $0.50 (5%)        | Lower reasoning token usage     |
| Sonnet for reviewers/fixes   | $1.24 (12%)       | 5x cheaper than Opus            |
| **Total**                    | **$4.06 (39%)**   | Target: ~$6.42/session          |

## Architecture

```
CURRENT WORKFLOW (expensive):
┌─────────────────────────────────────────────────────────────────┐
│ @feature (Opus, 16K thinking)                                   │
│   ├─→ @review-arch (Opus)     ─┐                                │
│   ├─→ @review-typescript (Opus)│                                │
│   ├─→ @review-testing (Opus)   ├─ 6 parallel, Opus, full plan   │
│   ├─→ @review-docs (Opus)      │  embedded in each prompt       │
│   ├─→ @review-platform (Opus)  │                                │
│   └─→ @review-ui (Opus)       ─┘                                │
│                                                                 │
│   ├─→ @implement (Opus) ──── NEW SESSION ────┐                  │
│   ├─→ @implement (Opus) ──── NEW SESSION ────┤ Each re-discovers│
│   ├─→ @implement (Opus) ──── NEW SESSION ────┤ codebase         │
│   └─→ @implement (Opus) ──── NEW SESSION ────┘                  │
│                                                                 │
│   └─→ @implementation-review (Opus)                             │
└─────────────────────────────────────────────────────────────────┘

OPTIMIZED WORKFLOW:
┌─────────────────────────────────────────────────────────────────┐
│ @feature (Opus, 16K thinking)                                   │
│   ├─→ @review-arch (Opus, 6K)────┐                              │
│   ├─→ @review-quality (Sonnet,4K)├─ 3 default, plan path only   │
│   └─→ @review-testing (Sonnet,4K)┘                              │
│   └─→ @review-ui (Sonnet, 4K) ───── only if renderer touched    │
│                                                                 │
│   ├─→ @implement (Opus, 8K) ──── SESSION CREATED ───┐           │
│   ├─→ @implement (Sonnet/Opus) ── REUSE SESSION ────┤ Context   │
│   ├─→ @implement (Sonnet/Opus) ── REUSE SESSION ────┤ cached    │
│   └─→ @implement (Sonnet/Opus) ── REUSE SESSION ────┘           │
│       (fallback: new session if reuse fails)                    │
│                                                                 │
│   └─→ @code-review (Sonnet, 6K)                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Create @review-quality agent**
  - Create new agent combining @review-typescript and @review-platform
  - Focus: TypeScript patterns, clean code, cross-platform compatibility
  - Model: `anthropic/claude-sonnet-4-5-20250514`
  - Thinking budget: 4000
  - Files: `.opencode/agent/review-quality.md` (new)

- [x] **Step 2: Update @review-arch to include docs focus**
  - Expand scope to include documentation quality and plan clarity
  - Model: Keep Opus (most judgment-intensive review)
  - Thinking budget: 6000
  - Files: `.opencode/agent/review-arch.md`

- [x] **Step 3: Update @review-testing**
  - Add model and thinking budget configuration
  - Model: `anthropic/claude-sonnet-4-5-20250514`
  - Thinking budget: 4000
  - Files: `.opencode/agent/review-testing.md`

- [x] **Step 4: Update @review-ui**
  - Add model and thinking budget configuration
  - Model: `anthropic/claude-sonnet-4-5-20250514`
  - Thinking budget: 4000
  - Files: `.opencode/agent/review-ui.md`

- [x] **Step 5: Update @implement agent**
  - Reduce thinking budget from 10000 to 8000
  - Keep model unset (feature agent selects per invocation)
  - Files: `.opencode/agent/implement.md`

- [x] **Step 6: Rename @implementation-review to @code-review**
  - Rename agent file
  - Model: `anthropic/claude-sonnet-4-5-20250514`
  - Thinking budget: 6000
  - Files: `.opencode/agent/code-review.md` (new), delete `.opencode/agent/implementation-review.md`

- [x] **Step 7: Update feature.md (all changes as single atomic update)**
  - This step consolidates all feature.md changes to avoid conflicts
  - Files: `.opencode/agent/feature.md`

  **7a. Add token optimization rationale comment:**

  ```markdown
  <!-- Token Optimization (2026-01-04)
       - Session reuse: pass session_id to reduce context reload
       - Plan paths: reference file instead of embedding to reduce output
       - Reviewers: 3 default (arch=Opus, quality/testing=Sonnet)
       - Model selection: Sonnet for simple fixes, Opus for complex
       See: planning/TOKEN_USAGE_OPTIMIZATION.md -->
  ```

  **7b. Add session reuse section:**

  ```markdown
  ## Session Management

  ### @implement Session Reuse

  Store the session_id from the first @implement invocation and reuse it:

  1. First @implement call returns session_id in `<task_metadata>` block
  2. Store this session_id for the duration of the feature workflow
  3. Pass session_id to all subsequent @implement calls
  4. On any failure (session not found, errors), fallback to new session

  **Rationale**: Reusing sessions keeps codebase context cached, reducing
  token usage by ~40% for subsequent @implement calls.
  ```

  **7c. Update invocation prompts to use plan paths:**

  ```markdown
  ### Invoking @implement (Initial)

  Task(subagent_type="implement",
  description="Implement plan",
  prompt="Implement the plan at: planning/<FEATURE_NAME>.md

  Read the plan file and follow all implementation steps.
  Report: IMPLEMENTATION COMPLETE or BLOCKED with details.")

  → Store the session_id from response metadata

  ### Invoking @implement (Fix Mode)

  Task(subagent_type="implement",
  session_id="<stored_session_id>",
  model="anthropic/claude-sonnet-4-5-20250514", # or opus for complex
  description="Fix issues",
  prompt="Fix these issues in planning/<FEATURE_NAME>.md:

  [LIST OF ISSUES]

  Run validation after fixing.")

  If session_id fails, omit it to create new session.
  ```

  **7d. Update reviewer selection:**

  ```markdown
  ### State: REVIEW_SETUP

  **Default reviewers** (3):

  - @review-arch (architecture + documentation) - Opus
  - @review-quality (TypeScript + cross-platform) - Sonnet
  - @review-testing (test strategy) - Sonnet

  **Optional reviewer**:

  - @review-ui - include when plan affects `src/renderer/` files

  Present to user:
  "Plan written. Reviewers: arch, quality, testing [+ ui if renderer touched]
  Reply 'go' to start, or adjust: 'add ui', 'skip testing', etc."
  ```

  **7e. Add model selection logic for @implement fixes:**

  ```markdown
  ### @implement Fix Model Selection

  Before invoking @implement for fixes, assess complexity:

  **Use Sonnet** (`anthropic/claude-sonnet-4-5-20250514`) for simple fixes:

  - Typo or naming corrections
  - Adding missing imports
  - Small syntax adjustments
  - Linting/formatting fixes
  - Single-line changes
  - Test assertion adjustments

  **Use Opus** (omit model parameter) for complex fixes:

  - Logic changes or bug fixes
  - Changes spanning multiple files
  - Refactoring
  - Security-related fixes
  - Performance improvements
  - Anything requiring investigation
  - **When uncertain → default to Opus**
  ```

  **7f. Update @code-review references:**
  - Replace all `@implementation-review` with `@code-review`
  - Update invocation prompt to reference plan by path

- [x] **Step 8: Delete obsolete reviewer agents**
  - Delete @review-typescript (merged into @review-quality)
  - Delete @review-platform (merged into @review-quality)
  - Delete @review-docs (merged into @review-arch)
  - Delete @implementation-review (renamed to @code-review)
  - Files to delete:
    - `.opencode/agent/review-typescript.md`
    - `.opencode/agent/review-platform.md`
    - `.opencode/agent/review-docs.md`
    - `.opencode/agent/implementation-review.md`

- [x] **Step 9: Update review-summary template**
  - Update reviewer list to: arch, quality, testing, ui (optional)
  - Update @implementation-review references to @code-review
  - Files: `.opencode/template/review-summary.md`

## Testing Strategy

### Manual Testing Checklist

| Test                       | Verification Method                  | Expected Result                                 |
| -------------------------- | ------------------------------------ | ----------------------------------------------- |
| Default reviewers          | Count Task invocations after "go"    | 3 reviewers: arch, quality, testing             |
| @review-ui auto-include    | Create plan touching `src/renderer/` | 4 reviewers including ui                        |
| @review-arch uses Opus     | Check `<task_metadata>` in response  | model: claude-opus or similar                   |
| Other reviewers use Sonnet | Check `<task_metadata>` in response  | model: claude-sonnet-4-5                        |
| Session ID returned        | Check first @implement response      | `<task_metadata>` contains session_id           |
| Session reuse works        | Check subsequent @implement calls    | Same session_id, context preserved              |
| Session fallback           | Force error (invalid session_id)     | New session created, no crash                   |
| Simple fix uses Sonnet     | Request typo fix                     | model parameter set to sonnet                   |
| Complex fix uses Opus      | Request logic change                 | model parameter omitted (Opus default)          |
| @code-review works         | Complete implementation              | Invokes code-review (not implementation-review) |

### Post-Implementation Metrics

After implementation, run 5-10 feature workflows and measure:

- Average session cost (target: ~$6.42, down from $10.48)
- @implement cost reduction (target: 40% lower)
- Reviewer cost reduction (target: 50% lower)

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                                   | Changes Required                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `.opencode/template/review-summary.md` | Update reviewer list to 4 (arch, quality, testing, ui), rename implementation-review to code-review |

### New Documentation Required

None - this is internal agent configuration.

## Definition of Done

- [ ] All implementation steps complete
- [ ] New @review-quality agent created and working
- [ ] @review-arch expanded to include docs, keeps Opus model
- [ ] @code-review created (renamed from @implementation-review)
- [ ] @review-quality, @review-testing, @review-ui use Sonnet 4.5
- [ ] @code-review uses Sonnet 4.5
- [ ] Session reuse working for @implement with fallback on failure
- [ ] Plan path references working (not embedding content)
- [ ] Model selection logic working for @implement fixes
- [ ] Obsolete agent files deleted (4 files)
- [ ] Manual testing checklist passed
- [ ] User acceptance testing passed
