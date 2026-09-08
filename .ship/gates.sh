#!/usr/bin/env bash
# Local gate for /ship. Ports §3.1 of the retired .claude/commands/ship.md.
#
# Deliberately thin: .github/workflows/ci.yaml is the real gate. What lands here is
# what is cheap and certain enough to be worth failing before the push. CI also gates
# a merge on `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm site:check`, `pnpm site:build`,
# `git diff --exit-code` and `pnpm test:canary`, plus the packaged build/e2e jobs.
#
# Widening this is a one-file edit — but note that `pnpm validate` runs `pnpm test`
# BEFORE `pnpm build`, while wrapper.boundary.test.ts and server-manager.boundary.test.ts
# need dist/bin to exist. CI runs `pnpm build:wrappers` first for that reason; a gate that
# just calls `pnpm validate` on a clean worktree fails for that reason, not a real one.
set -euo pipefail

# `prettier --check` exits non-zero on unformatted files, so the assertion is explicit.
# The `if !` form is load-bearing: under `set -e` a bare failure would exit before the
# message, and this script's output IS the failure report /ship shows.
if ! pnpm format:check; then
  echo
  echo "Cannot ship with formatting issues."
  echo "Run \`pnpm format\` to fix, then commit and run /ship again."
  exit 1
fi
