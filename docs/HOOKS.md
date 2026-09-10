# Repository Hooks

A repository can ship scripts that CodeHydra runs at a few points in a
workspace's life: set a new worktree up, refuse to delete one, or hear that one
was created. They live in the repository, so everyone who works on it gets them.

This replaces `.keepfiles`, which is gone.

## Where they go

One directory in the **worktree**, not the project root:

```
.codehydra/hooks/
  after-worktree-created      # blocking; may return data
  before-worktree-deleted     # blocking; may refuse
  on-workspace-created        # fire-and-forget; output ignored
```

The name is the rule. An `on-` entry reports something that already happened —
it is started and forgotten, and nothing it does can change the outcome. Every
other entry runs at a moment CodeHydra is waiting on: it blocks, and what it
returns matters. The tense tells you which you are writing.

Because hooks are read from the worktree, a hook must be **committed on the
branch a workspace is created from** — in practice, it lives on `main`. This is
the trade for being able to write and test a hook inside a workspace, which is
the only place you ever have the repository open.

## What a hook is

One file per entry, the way git does it: if the file is there it runs, and if it
is not, nothing happens. No subdirectories, no `10-`/`20-` ordering, and beyond
the `on-` prefix above, nothing to learn. A repository that wants several steps
writes them in one script.

The file is the entry's name, with or without an extension — the extension never
decides anything, the shebang does:

```
.codehydra/hooks/after-worktree-created       #!/usr/bin/env python3
.codehydra/hooks/after-worktree-created.py    same thing
.codehydra/hooks/after-worktree-created.sh    #!/bin/bash
.codehydra/hooks/after-worktree-created.cmd   Windows: an extension is required,
                                              since cmd cannot run a bare file
```

Two files claiming one entry (`after-worktree-created` and
`after-worktree-created.sh` side by side) is a mistake — usually a rename that
left the old one behind. The first by name wins, and CodeHydra logs which.

On Linux and macOS the file must be **executable** (`chmod +x`). Unlike git,
which skips a non-executable hook in silence, CodeHydra reports it.

## The exchange

One JSON object on **stdin**. One JSON object, or nothing, on **stdout**.
**stderr** is never parsed — it is yours, and it goes to CodeHydra's log and to a
`CodeHydra Hooks` output channel in the workspace's editor.

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)                                    # the JSON below
echo "setting up" >&2                           # shows up in the output channel
echo '{"title": "Feature X"}'                   # the result
```

Every entry is handed the same core, plus a field or two of its own:

```json
{
  "workspaceName": "feature-x",
  "workspacePath": "/home/me/.local/share/codehydra/.../workspaces/feature-x",
  "projectPath": "/home/me/src/my-app",
  "branch": "feature-x",
  "base": "main"
}
```

`branch` and `base` are **absent** — not null — when CodeHydra does not know
them (a detached HEAD, or a worktree you adopted by hand).

The working directory is the worktree, and `ch` is on `PATH`, so a hook can call
back into CodeHydra (`ch ws set-title`, `ch ws tag`) as well as return values.

There is no timeout. A hook runs until it finishes.

## `after-worktree-created`

Runs once, on a genuinely new worktree, before the editor and the agent start.
This is where `.keepfiles` work now goes.

It **blocks** the workspace opening — it has to, since it can contribute the
environment the agent will run in. The sidebar row shows as loading throughout.

Extra input: none.

Output — every field optional:

```json
{
  "env": { "DATABASE_URL": "postgres://localhost/feature_x" },
  "title": "Feature X",
  "tags": {
    "review": { "color": "#3498db", "description": "Waiting on review" },
    "db": { "label": "🗄" },
    "wip": {}
  }
}
```

- `env` reaches the agent and the editor's terminals.
- `title` is the sidebar display name; the branch name stays the identity.
- `tags` are keyed by name; `color`, `label` and `description` are all optional.

`title` and `tags` are written to the workspace's git config, so they survive a
restart exactly as a title you set by hand would. Returning them is still better
than shelling out to `ch` during setup, which races the snapshot the
workspace-open returns and loses.

**Failure is loud but not fatal.** A non-zero exit raises a notification and is
logged; the workspace still opens. A failed `pnpm install` is something you fix
_in_ the workspace.

The output shape is strict — `{"envs": …}` is an error, not a silently dropped
key.

Replacing a `.keepfiles` that listed `.env` and `config/local.yml`:

```bash
#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
project=$(printf '%s' "$input" | jq -r .projectPath)
workspace=$(printf '%s' "$input" | jq -r .workspacePath)

for f in .env config/local.yml; do
  if [ -e "$project/$f" ]; then
    mkdir -p "$(dirname "$workspace/$f")"
    cp "$project/$f" "$workspace/$f"
  fi
done
```

## `before-worktree-deleted`

The last gate before the worktree is removed. By the time it runs the workspace
is quiesced — terminals killed, agent server stopped, editor view closed — and
it gets its own row on the deletion progress panel.

Extra input: `"keepBranch": true | false`.

To refuse, exit **0** and say so:

```json
{ "blocked": true, "reason": "Deployment lock held by CI run #4821" }
```

Printing nothing, or `{}`, allows the deletion.

A **non-zero exit** means the script broke or could not tell. That stops the
deletion too — the gate fails closed — but is reported as a hook failure rather
than a policy decision. The two are deliberately different signals.

Either way the pipeline stops before `git worktree remove`, the reason appears
on the panel's row, and the user gets Retry and Dismiss. **Dismiss force-deletes
and skips hooks entirely**, which is the escape from a hook that refuses
wrongly or hangs.

It does not run for a runtime-only teardown (closing a project leaves worktrees
on disk), and it does not run in force mode.

## `on-workspace-created`

Fired after a workspace is created and forgotten immediately — nothing waits for
it, its stdout is ignored, and a non-zero exit only reaches the log.

Extra input: `"reopened": true | false`. It is `true` when the workspace was
discovered at project open or woken from hibernation rather than newly created,
so a script that registers workspaces with something external will want to skip
those, while one that re-warms a cache will not.

## Trust

Hooks are code from a repository, so the first time one would actually run,
CodeHydra asks:

> **Run repository hooks?**
> "my-app" defines CodeHydra hooks. Running them executes scripts from the
> repository on your machine.
>
> `[ Always ] [ Once ] [ Skip ] [ Never ]`

**Always** and **Never** are remembered for that project; **Once** and **Skip**
apply to that one run. Escape means Skip. The workspace's sidebar row turns
green while the question is open, so a question raised while you are looking
somewhere else still says where to look.

The question is asked whatever triggered the hook — including `ch ws delete` and
an auto-workspace poll — because a gate that quietly disappears when called from
a script is not a gate. A repository with no hooks is never asked anything.

To turn the whole feature off, set `hooks.enabled` to `false` (config.json,
`CH_HOOKS__ENABLED=false`, or `--hooks.enabled=false`).

## Debugging

- Anything on stderr appears in the **CodeHydra Hooks** output channel in the
  workspace's editor, and in CodeHydra's log. For `after-worktree-created` it is
  buffered until the editor is up, so the new workspace opens with its setup log
  already there. `before-worktree-deleted` has no editor left to show it in, so
  its output goes to the log and the progress row.
- `CH_LOG__LEVEL=debug CH_LOG__OUTPUT=console` shows discovery and spawn details
  under the `[hooks]` logger.
- "not executable" means `chmod +x`. "the interpreter in its shebang was not
  found" means the `#!` line points at something that is not installed.
