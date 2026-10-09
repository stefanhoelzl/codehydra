# Ship gates

Deliberately thin: `.github/workflows/ci.yaml` is the real gate. What lands here is what is cheap
and certain enough to be worth failing before the push. CI also gates a merge on `pnpm lint`,
`pnpm check`, `pnpm test`, `pnpm site:check`, `pnpm site:build`, `git diff --exit-code` and
`pnpm test:canary`, plus the packaged build/e2e jobs.

Widening this is a one-file edit — but note that `pnpm validate` runs `pnpm test` BEFORE
`pnpm build`, while wrapper.boundary.test.ts and server-manager.boundary.test.ts need `dist/bin` to
exist. CI runs `pnpm build:wrappers` first for that reason; a gate that just calls `pnpm validate`
on a clean worktree fails for that reason, not a real one.

## Format

```bash
pnpm format:check
```

On failure: run `pnpm format`, commit, and run `/ship` again.

## Application log

CodeHydra writes its dev logs to `app-data/logs/`. An `error` or `warn` entry sitting there when a
change ships is either a bug this change was supposed to fix, or a bug nobody has looked at. Both
are worth stopping for; telling them apart needs the diff, which is why this gate is prose.

### The check

Read the **newest** `.log` file in `app-data/logs/`. Filenames are timestamps, so newest = last by
name. The directory is gitignored, so a fresh worktree may not have it at all.

**Pass immediately** if there is no `app-data/logs/`, no `.log` file in it, or no `error`/`warn`
entries in the newest one.

Entries come in two shapes:

- **Text**: `[timestamp] [error] [scope] message` or `[timestamp] [warn] [scope] message`
- **JSON**: one object per line, with `"level"` set to `"error"` or `"warn"`

**Skip** these known entries — they are not issues:

- `[warn] [config] Unknown config key (ignored)` with `source=CLI flag` and `key` of `inspect`,
  `remote-debugging-port` or `no-sandbox`. Playwright's `_electron.launch()` always prepends the
  first two, and the e2e fixtures (which appctrl launches through) add `--no-sandbox` for a
  packaged build on Linux, so every appctrl or e2e launch logs these. Any other key is not
  skipped.

Collect the unique remaining entries — deduplicate repeated messages. For each one, read
`git diff origin/main..HEAD` and decide whether **this** change fixes its underlying cause.

That is the judgment the gate is asking for, so make it honestly: "the entry looks harmless",
"it was already there", and "it is unrelated to this change" are **not** the same as "this change
fixes it". An unrelated entry is unaddressed.

### Pass condition

**Every entry addressed → pass.** **Any entry left unaddressed → fail**, listing exactly the ones
that are:

```
**Log file**: <filename>
**Unresolved issues**:
- [<level>] [<scope>] <message>
```

## User guide

`docs/USER_GUIDE.md` is the one user-facing guide: the site's help page, `ch guide` (which agents
read to learn how CodeHydra works) and the in-app help dialog all render it. A change that alters
what users or agents can observe and leaves the guide behind makes all three wrong at once. Deciding
whether a diff is user-facing needs judgment, which is why this gate is prose.

### The check

Read `git diff origin/main..HEAD` and list every change a user or an agent can observe: UI
(sidebar, dialogs, notifications), keyboard shortcuts, workspace lifecycle, config keys and their
meaning, the `ch` CLI and MCP tools, plugins (hooks, automations), what agents are told, install
and first-run.

**Pass immediately** if there is none — refactors, tests, internal docs, build and CI changes.

For each one, read the section of `docs/USER_GUIDE.md` that covers it — or should — and decide
whether the guide, as it stands **after** this diff, describes the new behavior correctly. The
guide describes what the code does, so a change that makes a sentence of it false counts, and so
does a new capability a user would need to be told about.

"The guide doesn't mention this area anyway" is **not** a pass for a new user-facing behavior; it
is a missing section.

### Pass condition

**Every change reflected → pass.** **Any change not reflected → fail**, listing each one with the
section it affects:

```
**Not reflected in docs/USER_GUIDE.md**:
- <change> → <section slug, or "new section needed">
```
