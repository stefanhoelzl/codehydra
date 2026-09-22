Two gates below — the application log and the user guide. Run both; the ship passes only if
both pass, and an abort reports every gate that failed.

# Gate: the application log

CodeHydra writes its dev logs to `app-data/logs/`. An `error` or `warn` entry sitting there when a
change ships is either a bug this change was supposed to fix, or a bug nobody has looked at. Both
are worth stopping for; telling them apart needs the diff, which is why this gate is prose.

## The check

Read the **newest** `.log` file in `app-data/logs/`. Filenames are timestamps, so newest = last by
name. The directory is gitignored, so a fresh worktree may not have it at all.

**Pass immediately** if there is no `app-data/logs/`, no `.log` file in it, or no `error`/`warn`
entries in the newest one.

Entries come in two shapes:

- **Text**: `[timestamp] [error] [scope] message` or `[timestamp] [warn] [scope] message`
- **JSON**: one object per line, with `"level"` set to `"error"` or `"warn"`

Collect the unique entries — deduplicate repeated messages. For each one, read
`git diff origin/main..HEAD` and decide whether **this** change fixes its underlying cause.

That is the judgment the gate is asking for, so make it honestly: "the entry looks harmless",
"it was already there", and "it is unrelated to this change" are **not** the same as "this change
fixes it". An unrelated entry is unaddressed.

## The outcome

**Every entry addressed → pass.**

**Any entry left unaddressed → abort**, listing exactly the ones that are:

```
Cannot ship with unresolved log issues.

**Log file**: <filename>
**Unresolved issues**:
- [<level>] [<scope>] <message>
- [<level>] [<scope>] <message>

Review these issues. Fix them or confirm they are expected, then run `/ship` again.
```

---

# Gate: the user guide

`docs/USER_GUIDE.md` is the one user-facing guide: the site's help page, `ch guide` (which agents
read to learn how CodeHydra works) and the in-app help dialog all render it. A change that alters
what users or agents can observe and leaves the guide behind makes all three wrong at once. Deciding
whether a diff is user-facing needs judgment, which is why this gate is prose.

## The check

Read `git diff origin/main..HEAD` and list every change a user or an agent can observe: UI
(sidebar, dialogs, notifications), keyboard shortcuts, workspace lifecycle, config keys and their
meaning, the `ch` CLI and MCP tools, auto-workspace sources, repository hooks (`.codehydra/hooks`
input, output, when they run, failure behavior), what agents are told, install and first-run.

**Pass immediately** if there is none — refactors, tests, internal docs, build and CI changes.

For each one, read the section of `docs/USER_GUIDE.md` that covers it — or should — and decide
whether the guide, as it stands **after** this diff, describes the new behavior correctly. The
guide describes what the code does, so a change that makes a sentence of it false counts, and so
does a new capability a user would need to be told about.

"The guide doesn't mention this area anyway" is **not** a pass for a new user-facing behavior; it
is a missing section.

## The outcome

**Every change reflected → pass.**

**Any change not reflected → abort**, listing each one with the section it affects:

```
Cannot ship with the user guide out of date.

**Not reflected in docs/USER_GUIDE.md**:
- <change> → <section slug, or "new section needed">
- <change> → <section slug, or "new section needed">

Update the guide in this change, then run `/ship` again.
```
