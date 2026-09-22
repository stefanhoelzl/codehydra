# CodeHydra User Guide

Run multiple AI agents in parallel, each in its own isolated workspace.

**Contents**

1. [Why CodeHydra?](#why-codehydra)
2. [Quick start](#quick-start)
3. [Core concepts](#core-concepts)
4. [Using CodeHydra](#using-codehydra)
5. [Configuration](#configuration)
6. [Automatic workspaces](#automatic-workspaces)
7. [Repository hooks](#repository-hooks)
8. [CLI and MCP](#cli-and-mcp)

## Why CodeHydra?

Ever had an AI agent make changes to files you were actively working on? Or
waited for one task to finish before starting the next? CodeHydra solves these
problems by giving each AI agent its own isolated workspace.

![CodeHydra showing multiple workspaces with AI agents running in parallel](screenshot.png)

Imagine starting your morning by spinning up three workspaces: one for the
sprint task, one for that refactoring you've been meaning to do, and one for the
AI to investigate a flaky test. All running in parallel, none stepping on each
other's toes.

- **No more conflicts** — each agent works in its own git branch with its own files
- **No more waiting** — run multiple tasks simultaneously
- **No more context switching** — jump between workspaces instantly

## Quick start

Run CodeHydra with npx or uvx:

```sh
npx codehydra@latest
```

```sh
uvx --refresh codehydra
```

Or download it from
[GitHub Releases](https://github.com/stefanhoelzl/codehydra/releases).

On first launch, CodeHydra asks which coding agent to use — **Claude Code** or
**OpenCode** — then guides you through opening a project and creating your first
workspace. Want to run multiple agents? Just create more workspaces — each one
gets its own worktree and agent session.

## Core concepts

### Project

A git repository opened in CodeHydra. Projects are containers that hold your
workspaces. Open a local folder, or clone straight from a git URL — remote
projects are kept as a bare clone with worktrees created on demand.

### Workspace

An isolated development environment with its own branch, files, and AI agent
session. Workspaces are backed by git worktrees, so changes in one never affect
another. Each one opens in a full VSCodium editor with the agent in a terminal.

### Hibernation

Workspaces you're not using can be put to sleep to free up resources. A
hibernated workspace keeps its branch and files — wake it any time to pick up
where you left off.

### Agent status

The sidebar shows each workspace's agent status at a glance:

| Status   | Meaning           |
| -------- | ----------------- |
| **None** | No agent active   |
| **Idle** | Ready for input   |
| **Busy** | Working on a task |

You'll hear a sound when an agent finishes its task, so you can stay productive
without constantly checking the screen. The app icon also carries a badge
summarizing status across all workspaces.

## Using CodeHydra

### Managing workspaces

- **Create** — click **New workspace** or press <kbd>Enter</kbd> in shortcut mode
- **Switch** — click a workspace or use <kbd>1</kbd>-<kbd>0</kbd> in shortcut mode to jump directly
- **Delete** — hover and click the delete icon, or press <kbd>Delete</kbd> in shortcut mode
- **Hibernate / Wake** — put an idle workspace to sleep to free resources; click
  it (or wake it from the sidebar) to bring it back

Workspaces created in the background — by the MCP server, a plugin, or
automation — get a blue **new** tag in the sidebar so they're easy to spot. The
tag clears the first time you switch to that workspace.

The question mark in the sidebar header opens this guide; the gear next to it
opens the settings.

### Keyboard shortcuts

Press <kbd>Alt</kbd>+<kbd>X</kbd> to enter shortcut mode, then:

| Key                                     | Action                              |
| --------------------------------------- | ----------------------------------- |
| <kbd>↑</kbd> / <kbd>↓</kbd>             | Navigate workspaces                 |
| <kbd>←</kbd> / <kbd>→</kbd>             | Navigate idle workspaces            |
| <kbd>1</kbd>-<kbd>9</kbd>, <kbd>0</kbd> | Jump to workspace 1-10              |
| <kbd>Enter</kbd>                        | Create workspace                    |
| <kbd>Delete</kbd>                       | Remove workspace                    |
| <kbd>H</kbd>                            | Hibernate / wake workspace          |
| <kbd>T</kbd>                            | Toggle hiding hibernated workspaces |
| <kbd>S</kbd>                            | Open settings                       |
| <kbd>B</kbd>                            | Report a bug                        |
| <kbd>Escape</kbd>                       | Exit shortcut mode                  |

### Background processes: `ch bg`

When an agent leaves a process running in the background — a dev server, a
file watcher, a `tail -f` — the workspace stays **busy** so you know work is
still in flight and your machine won't sleep mid-task. That's the right default
for something you're waiting on, but a dev server you started just to test a
change shouldn't pin the workspace busy forever.

Prefix a long-lived background command with `ch bg` (or the equivalent
`ch-bg`) and that shell no longer keeps the workspace busy:

```sh
ch bg npm run dev
```

It runs the command unchanged — same output, same exit code — and only tells
CodeHydra to leave the workspace status alone. This applies to Claude Code;
OpenCode's background shells don't affect its status.

### What agents are told

You don't have to explain any of this to your agent. CodeHydra gives every
agent session a short system prompt describing the workspace it runs in — what
busy and idle mean, that the worktree's lifecycle belongs to CodeHydra, that
creating another workspace is your call, and where to find this guide
(`ch guide`). A line in your project's `CLAUDE.md` or `AGENTS.md` is still the
place to tighten or loosen any of it for your repository.

## Configuration

CodeHydra works out of the box, but most behavior is configurable. Open the
settings with the gear in the sidebar header (or <kbd>Alt</kbd>+<kbd>X</kbd>
then <kbd>S</kbd>).

The same dot-separated keys work in three places, highest precedence first:

| Source      | Example                |
| ----------- | ---------------------- |
| CLI flag    | `--log.level=debug`    |
| Env var     | `CH_LOG__LEVEL=debug`  |
| config.json | `"log.level": "debug"` |

An env var is the key with a `CH_` prefix, `.` turned into `__` and `-` into
`_`, upper-cased. `config.json` lives in the data directory:

- **Linux**: `~/.local/share/codehydra/`
- **macOS**: `~/Library/Application Support/Codehydra/`
- **Windows**: `%APPDATA%\Codehydra\`

From a shell or an agent, `ch config list`, `ch config get <key>`,
`ch config set <key> <value>` and `ch config reset <key>` read and write the
running app's settings, exactly as the settings dialog does.

Common keys:

- `agent` — which coding agent to launch (`claude` or `opencode`)
- `silent` — mute the sound played when an agent goes idle
- `notification` — when to raise an OS notification for an idle agent
  (`disabled`, `each-workspace`, `first-workspace`)
- `sidebar.width` — expanded sidebar width (also set by dragging its edge)
- `update.notification` — whether to notify when an update is available
- `hooks.enabled` — run repository hooks (see [Repository hooks](#repository-hooks))
- `log.level` — e.g. `debug`, or `debug:hooks,process` for some loggers only

Logs are written to the `logs/` folder of the data directory.

## Automatic workspaces

CodeHydra can create workspaces for you on a schedule from any command that
emits JSON — for example, a workspace per pull request that requests your
review. Configure them under `auto-workspace.sources` in the settings; the
editor there has a help panel with the full reference. The poll interval is
`auto-workspace.poll-interval` (seconds between the end of one poll and the
start of the next, default 60).

The value is a multi-document YAML stream, one `---`-separated document per
source:

| Key        | Meaning                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `name`     | Source name; must be unique                                                          |
| `type`     | The trigger: `cron` (the default and only type)                                      |
| `mode`     | `workspaces` (default) or `events` — what the command's objects mean                 |
| `cmd`      | Shell command (`sh` on POSIX, `cmd.exe` on Windows) printing a JSON array of objects |
| `template` | Rendered once per object into one workspace; every string in it is a Liquid template |

Inside `template`, the render context is the JSON object itself: `{{ title }}`,
`{{ user.login }}`, `{{ title | truncate: 60 }}`. Its keys are `name`
(required: workspace name and git branch), `key` (dedup identity, default the
name), `base`, `tracking`, `project` or `git` (where the workspace goes),
`focus`, `prompt` (sent to the new agent), `agent` and `metadata` (`title`,
`tags`, any other keys).

- **`mode: workspaces`** — the command emits the workspaces that _should_
  exist. An item not seen before creates a workspace; one already handled is
  skipped; one that disappears is forgotten, so if it comes back it is created
  again. Nothing is ever deleted automatically.
- **`mode: events`** — the command emits things that _happened_, and each
  object fires once. Nothing is tracked, so the command must not emit the same
  thing twice. If `template.name` matches an existing workspace, its metadata is
  re-applied and it is woken (or switched to with `focus: true`); it gets no
  prompt. Otherwise the workspace is created.

```yaml
name: github
cmd: |
  gh api graphql -f q='is:open is:pr review-requested:@me' \
    -f query='query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{number title url body baseRefName author{login} repository{url}}}}}' \
    --jq '[.data.search.nodes[]|{number,title,html_url:.url,body,user:{login:.author.login},base:{ref:.baseRefName},clone_url:(.repository.url+".git")}]'
template:
  name: "{{ title }}"
  key: "{{ html_url }}"
  base: "{{ base.ref }}"
  project: "{{ clone_url }}"
  metadata:
    title: "PR #{{ number }}: {{ title }}"
    tags:
      review: { color: "#4b6de8" }
  prompt: |
    Review pull request #{{ number }} "{{ title }}" opened by {{ user.login }}.

    {{ body }}
```

## Repository hooks

A repository can ship scripts that CodeHydra runs at a few points in a
workspace's life: set a new worktree up, refuse to delete one, or hear that one
was created. They live in the repository, so everyone who works on it gets them.
(They replace `.keepfiles`, which CodeHydra no longer reads.)

### Where hooks go

One directory, read from the **worktree** — so a hook must be committed on the
branch workspaces are created from (in practice, `main`):

```
.codehydra/hooks/
  after-worktree-created      # blocking; may return env, title, tags
  before-worktree-deleted     # blocking; may refuse the deletion
  on-workspace-created        # fire-and-forget; output ignored
```

An entry starting with `on-` reports something that already happened: it is
started and forgotten. Every other entry blocks the operation, and what it
prints matters.

One file per entry. If the file is there it runs; if not, nothing happens. The
file is named after the entry, with or without an extension —
`after-worktree-created`, `after-worktree-created.sh` and
`after-worktree-created.py` are all the same entry. If two files claim one entry,
the first by name wins and CodeHydra logs a warning; this is not platform-aware,
so a repository cannot ship both a bare file for POSIX and a `.cmd` for Windows.

How a hook is started:

- **Linux / macOS**: `/bin/sh -c '<path>'`, so the shebang picks the
  interpreter. The file must be executable (`chmod +x`); unlike git, CodeHydra
  reports a non-executable blocking hook instead of skipping it silently.
- **Windows**: `cmd.exe /d /s /c "<path>"`. The shebang means nothing there, so
  use `.cmd` or `.bat`.
- Symlinks and directories are ignored with a warning.

### The exchange

- **stdin**: one JSON object (below), then stdin is closed.
- **stdout**: one JSON object, or nothing (empty output is the same as `{}`).
  Anything else — invalid JSON, `null`, an array, an unknown key — is a hook
  failure. Output shapes are strict for both blocking hooks.
- **stderr**: never parsed. It is shown in the **CodeHydra Hooks** output
  channel of the workspace's editor after the hook exits (not live), and logged
  at `info` level.
- **Working directory**: the worktree.
- **Environment**: CodeHydra's own environment, with CodeHydra's bin directory
  put first on `PATH`. `ch` therefore works inside a hook and finds the
  workspace from the working directory (`ch ws title`, `ch ws tag set`, …).
  Nothing workspace-specific is added to the environment; stdin is the context.
- **Timeout**: none. A hook runs until it exits.

Every entry receives this core, plus a field or two of its own:

```json
{
  "workspaceName": "feature-x",
  "workspacePath": "/home/me/.local/share/codehydra/projects/my-app-1a2b3c4d/workspaces/feature-x",
  "projectPath": "/home/me/src/my-app",
  "branch": "feature-x",
  "base": "main"
}
```

A minimal hook:

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)                          # the JSON above
echo "setting up" >&2                 # goes to the output channel
echo '{"title": "Feature X"}'         # the result
```

### after-worktree-created

Runs once, on a newly created worktree, before the editor and the agent start.
It does not run when a workspace is reopened (app start, project open) or woken
from hibernation. It blocks the workspace opening — the sidebar row shows as
loading until it exits — because it can contribute the environment the agent
runs in.

Extra input: none. `branch` and `base` are always present.

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

- `env` reaches the agent's terminal and the editor's terminals. It is not
  persisted: after an app restart or a hibernate/wake the workspace starts
  without it. With OpenCode, the agent server process itself does not get it.
- `title` is the sidebar display name; the branch name stays the identity.
- `tags` are keyed by tag name; `color`, `label` and `description` are optional.
  A tag name must start with a letter and contain only letters, digits and
  `-` (not ending in `-`); an invalid one is dropped with a warning in the log.

`title` and `tags` are stored in the workspace's git config, so they survive a
restart like a title set by hand. Return them rather than calling `ch` during
setup, which can be overwritten by the workspace opening.

**Failure is loud but not fatal.** A non-zero exit or invalid output raises a
notification and is logged; the workspace still opens, without anything the
hook returned. A hook that never exits leaves the workspace loading.

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

### before-worktree-deleted

The last gate before the worktree is removed. By the time it runs the workspace
is shut down — terminals killed, agent server stopped, editor closed — and it
has its own row on the deletion progress panel. It also runs when closing a
project with "remove all" confirmed. It does not run when closing a project
leaves the worktrees on disk, and not for a forced deletion.

Extra input: `"keepBranch": true | false` (the user's choice in the delete
dialog). `branch` and `base` are absent when CodeHydra does not know them (a
detached HEAD, or a worktree without a recorded base).

To refuse, exit **0** and print:

```json
{ "blocked": true, "reason": "Deployment lock held by CI run #4821" }
```

Printing nothing, or `{}`, allows the deletion. `{"reason": "…"}` without
`"blocked": true` also allows it.

A **non-zero exit** or invalid output means the hook broke. That stops the
deletion too — the gate fails closed — but is reported as a hook failure, with
the last stderr line, rather than as a refusal.

Either way the deletion stops before the worktree is removed and the reason
appears on the progress row, with **Retry** and **Dismiss**. Retry runs the
hook again. Dismiss force-deletes, skipping hooks, and deletes the branch even
if you chose to keep it. These buttons appear only once the hook has exited:
a hook that hangs can only be stopped by killing its process (or quitting
CodeHydra).

### on-workspace-created

Started after a workspace is created and forgotten immediately — nothing waits
for it, its stdout is ignored, and a failure (including a non-executable file)
only reaches the log.

It also runs for every non-hibernated workspace when CodeHydra starts or a
project is opened, and when a workspace is woken. Extra input:
`"reopened": true | false` tells these apart, so a script that registers
workspaces with something external can skip reopens, while one that re-warms a
cache will not. On a reopen, `base` may be empty or absent.

### Trust

Hooks are code from a repository, so the first time one would run for a
project, CodeHydra asks:

> **Run repository hooks?** "my-app" defines CodeHydra hooks. Running them
> executes scripts from the repository on your machine.
>
> **Always** · **Once** · **Skip** · **Never**

- **Always** and **Never** are remembered for that project; **Once** and
  **Skip** apply to that one run. Escape means Skip.
- Skip or Never on a `before-worktree-deleted` lets the deletion proceed
  without the gate.
- The question is asked whatever triggered the hook — the UI, `ch ws delete`,
  an automatic workspace.
- A repository with no hooks is never asked anything.
- To change a remembered answer, remove the project's entry from `hooks.trusted`
  in `state.json` (in the data directory) while CodeHydra is not running.

To turn hooks off entirely, set `hooks.enabled` to `false` (settings,
`ch config set hooks.enabled false`, `CH_HOOKS__ENABLED=false`, or
`--hooks.enabled=false`). The change applies immediately.

### Debugging hooks

- Test a hook by hand from the worktree:
  `echo '{"workspaceName":"x","workspacePath":"'"$PWD"'","projectPath":"/path/to/project","branch":"x","base":"main"}' | .codehydra/hooks/after-worktree-created`
- stderr appears in the **CodeHydra Hooks** output channel once the hook
  exits. `before-worktree-deleted` has no editor left to show it in: only its
  reason, or its last stderr line on failure, reaches the progress row.
- stderr is logged at `info`, below the default log level. Run with
  `--log.level=info` (or `debug`) to see it in the log file; the process
  details (command line, exit code, stdout) are under the `[process]` logger at
  `debug`. At `debug` stdout is logged in full, including any `env` values.
- "not executable" means `chmod +x`. "the interpreter in its shebang was not
  found" means the `#!` line points at something that is not installed — or
  that the script itself exited with 127 (command not found).

## CLI and MCP

### The `ch` command

Every workspace terminal has `ch` on its `PATH`. It drives the running
CodeHydra from a shell: `ch --help` lists the commands, `ch <command> --help`
shows one command's arguments.

```sh
ch ws status                  # this workspace: branch, dirty flag, agent status
ch ws create feature-auth main
ch ws title "Auth rework"
ch ws tag set review --color "#3498db"
ch project list
ch config get agent
ch guide repository-hooks     # one section of this guide
```

- `ch` acts on the workspace containing the current directory; `--workspace
<path>` targets another. Workspaces and projects may be named instead of
  pathed.
- Output is human-readable at a terminal and JSON when piped; `--json` and
  `--no-json` force either. `ch guide` prints markdown unless `--json` is given.
- Exit codes: 0 ok, 1 failed, 2 usage, 3 CodeHydra not reachable, 4 not in a
  workspace, 5 conflict, 6 not found.
- `ch lock take|release|ls` and `ch lock run <name> -- <cmd…>` share a
  single-holder resource (a phone, a port) across workspaces.

### MCP

The same operations are exposed to the agents as MCP tools (`ch mcp` is the
server both agents launch). Agents can query workspace info, create
workspaces with an initial prompt, execute VS Code commands, hibernate and
wake workspaces, read and set metadata and tags, delete workspaces, and read
this guide (`guide`).

You don't need to learn any special syntax. Just describe what you want in
plain language:

- "What branch is this workspace on?"
- "Create a new workspace called 'feature-auth' from main"
- "Save all open files"
