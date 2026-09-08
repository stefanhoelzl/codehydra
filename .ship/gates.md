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
