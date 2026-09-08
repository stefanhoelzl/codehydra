# Contributing to CodeHydra

## Development Setup

See [README.md](README.md) for quick start instructions.

## /ship

`/ship` is a **global skill**, not a command in this repo. It lives in `~/.claude/skills/ship/`
(with a sibling `~/.claude/skills/ship-init/`) and is shared with every repo on the machine. It
creates a PR with auto-merge, waits for the merge through a client-side FIFO queue, and deletes the
CodeHydra workspace afterwards.

Everything specific to CodeHydra lives in `.ship/` at the repo root — the skill's five hook points.
See `~/.claude/skills/ship/hooks.md` for the contract:

| File            | What it does here                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`   | The merge-wait budget: 25 min total, 15 min for CI. Measured from this repo — p85 of the last 100 merged PRs' createdAt→mergedAt is 24 min, and the slowest CI run on a PR branch was 13 min |
| `gates.sh`      | Runs `pnpm format:check` after the rebase and before the push. CI is the real gate; this is what is worth failing locally first                                                              |
| `gates.md`      | Scans the newest `app-data/logs/*.log` and stops the ship on an `error`/`warn` entry whose cause the change does not address                                                                 |
| `pr-title.md`   | The title policy. `feat:`/`fix:` titles are published verbatim in the release notes, so they must name an observable outcome                                                                 |
| `post-merge.md` | Resolves the PostHog error-tracking issue when the session was spent fixing one. Never fails the ship                                                                                        |

To change how shipping behaves here, edit `.ship/`. To change how it behaves everywhere, edit the
skill — a repo that needs different behaviour needs a hook, not a fork.

**Outcomes:**

- **MERGED** — merged into `main`; the workspace is deleted unless `--keep-workspace` was passed
- **FAILED** — fix the issue and run `/ship` again
- **TIMEOUT** — the _watcher_ stopped waiting, which is not a failed merge. Auto-merge stays armed on
  GitHub, so the PR lands on its own. Re-run `/ship` afterwards to confirm it and clean up the
  workspace; that run skips the rebase and the gates

---

## GitHub Repository Setup

There is nothing to set up by hand. The skill owns the `main` branch ruleset and the merge-related
repository settings — they live as data in `~/.claude/skills/ship/ruleset.ts` and are applied through
a confirm-a-diff flow, so a divergence is shown and approved rather than silently written.

Ship enforces: the ruleset active with no bypass actors; `deletion`, `non_fast_forward`,
`required_linear_history`, `required_status_checks` (strict) and `pull_request` (0 approvals,
rebase-only); and the repo settings `allow_auto_merge`, `allow_rebase_merge`,
`delete_branch_on_merge` on, `allow_merge_commit` and `allow_squash_merge` off.

Required status-check contexts are **additive**: each ship adds the checks that actually executed on
its PR, and nothing is ever removed implicitly. The live ruleset is therefore the accumulated
history, and there is no committed copy of it — a `.github/rulesets/*.json` would only mislead the
next person who edited it.

GitHub's own merge queue is unavailable on personal-account repos, which is why the skill runs a
client-side queue (`ship-wait.ts`): PRs merge in order of when auto-merge was enabled, and each one
is rebased onto `main` before its CI runs.

---

## Code Quality

See [docs/TESTING.md](docs/TESTING.md) for testing requirements.

### Validation

Before submitting changes:

```bash
pnpm validate:fix  # Auto-fix formatting/linting, run tests
```

All checks must pass:

- TypeScript: `pnpm check`
- ESLint: `pnpm lint`
- Prettier: `pnpm format:check`
- Tests: `pnpm test`
- Build: `pnpm build`
