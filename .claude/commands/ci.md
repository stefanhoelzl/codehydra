---
description: Push branch and trigger CI workflow
allowed-tools: Bash(npx:*)
---

# /ci Command

Push the current branch, trigger CI workflow, and wait for completion.

## Execution

Run the CI script:

```bash
npx tsx .claude/commands/ci-wait.ts
```

## Exit Codes

- 0: SUCCESS - CI passed
- 1: FAILED - CI failed (logs printed)
- 2: TIMEOUT - Still running after 15 minutes

## Report

After the script completes, report the result to the user:

- On success: "CI passed"
- On failure: Include the failed job names and relevant error details from the output
- On timeout: "CI timed out after 15 minutes"
