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
8. [Agents](#agents)
9. [CLI and MCP](#cli-and-mcp)

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

On first launch (no `config.json` yet), CodeHydra asks which coding agent to
use — **Claude Code** or **OpenCode** — then downloads what it needs (the
embedded editor and the agent), which only happens once. Then open a project
and create your first workspace. Want to run multiple agents? Just create more
workspaces — each one gets its own worktree and agent session.

## Core concepts

### Project

A git repository opened in CodeHydra. Projects are containers that hold your
workspaces. Open a local folder, or clone straight from a git URL — remote
projects are kept as a bare clone with worktrees created on demand.

### Workspace

An isolated development environment with its own branch, files, and AI agent
session. Workspaces are git worktrees, so changes in one never affect another.
Each one opens in a full VSCodium editor with the agent in a terminal.

### Hibernation

A workspace you're not using can be put to sleep to free its editor and agent
server. A hibernated workspace keeps its branch and files and shows a
screenshot of where you left it — wake it any time to pick up where you left
off.

### Agent status

Each workspace reports its agent's status:

| Status    | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| **None**  | No agent running                                                                               |
| **Idle**  | Done, or waiting on you (including a pending permission prompt or a dialog open in its editor) |
| **Busy**  | Working on a task                                                                              |
| **Mixed** | Several agent sessions, some idle and some busy                                                |

You'll hear a sound when an agent goes idle, so you can stay productive
without constantly checking the screen. On macOS and Windows the app icon
carries a badge: ● when every agent is busy, ◐ when some are done (no badge on
Linux).

## Using CodeHydra

### The sidebar

The sidebar lists your projects and their workspaces, sorted by name.

- **Collapsed**, it is a strip of status icons. It expands when you rest the
  pointer at the left edge of the window, in shortcut mode, while a dialog or
  the New workspace form is showing, and whenever there are no workspaces.
- **Resize** it by dragging its right edge (at least 250 px, at most 75% of the
  window); the width is saved as `sidebar.width`.
- The header has **?** (this guide) and the **gear** (settings), when expanded.
- **Hide hibernated / Show hibernated** at the bottom (or <kbd>Alt</kbd>+<kbd>X</kbd>,
  <kbd>T</kbd>) hides sleeping workspaces; a project with hidden rows shows how
  many. The choice is remembered.
- Notifications (clone progress, failures, updates) stack at the bottom of the
  sidebar, newest on top; repeats merge into one card with a count. The stack
  takes at most 30% of the sidebar's height and scrolls beyond that.

A workspace row shows its title (or its name if it has none); with a title, the
second line shows the branch. Tags follow, each in its color and with its label,
and its description on hover. Long labels scroll as `sidebar.label-scroll` says
(`hover` by default). A folder icon marks a local project, a source-control icon
a cloned one.

The icon on each row:

| Icon                       | Meaning                    |
| -------------------------- | -------------------------- |
| Grey dot                   | No agent                   |
| Green dot                  | Idle                       |
| Red pulsing dot            | Busy                       |
| Red dot                    | Mixed                      |
| Spinner                    | Being deleted              |
| Warning triangle           | Deletion failed            |
| Pause icon (play on hover) | Hibernated — click to wake |

Hovering the dot shows the counts, e.g. "2 idle, 1 busy". A row also turns
green while a dialog about that workspace is waiting for you — a hook trust
question, a failed deletion — including the placeholder row of a workspace
still being created.

### Opening and closing projects

Open a project from the New workspace form (**Open project folder** or
**Clone from Git**), or with `ch project open <path|url>`.

- A folder that is not a git repository asks to **initialize** one (git init
  with an initial commit).
- A repository that already has worktrees CodeHydra does not manage asks which
  to **adopt**; worktrees on a detached HEAD cannot be adopted.
- **Clone** accepts `org/repo`, `github.com/org/repo`, and https, ssh and
  `git://` URLs. Progress shows inline and as a sidebar card; **Continue in
  background** (or <kbd>Escape</kbd>) lets it finish on its own. For a GitHub
  repository that does not exist it offers **Create on GitHub** (initialize it
  with a README so it can be cloned) and **Retry Clone**.

To **close** a project, hover its header and click the trash icon. By default
its worktrees stay on disk and reappear when you open it again. The dialog
offers:

- **Remove all workspaces and their branches**;
- for a cloned project, **Keep cloned repository** (unchecked: the clone is
  deleted);
- for a local project, **Remove project directory from disk** (which implies
  removing all workspaces).

### Creating a workspace

Click **New workspace** at the top of the sidebar (or <kbd>Alt</kbd>+<kbd>X</kbd>,
<kbd>Enter</kbd>). The form has:

- **Project** — preselected with the project of the workspace you came from
  (the project you opened most recently when you have just opened one), unless
  you have already started filling in the form.
- **Name** — becomes the git branch. Type a new name, or pick an existing local
  or remote branch to check it out (which also fills in its base). Letters,
  digits and `-_./`, starting with a letter or digit, at most 100 characters,
  no `..`, and not the name of an existing workspace.
- **Base branch** — what a new branch forks from (default: the project's
  default branch). Cached branches show at once while a fetch runs.
- **Prompt** (optional) — sent to the agent as soon as the workspace is ready.
- **Agent**, **Agent name**, **Permission mode** — shown when there is a
  choice: more than one agent installed, a named agent or persona, Claude's
  permission modes.

**Create** is enabled once the form is valid; **Reset** or <kbd>Escape</kbd>
clears it (otherwise it keeps what you typed). The new row shows as loading
until the workspace is ready.

Every new workspace gets a blue **new** tag until you first switch to it, so
one you left while it was being created — or one an agent or automation made —
is easy to spot. Turn this off with `auto-tag.new`.

### Switching, hibernating and waking

- **Switch** — click a row, or in shortcut mode use the arrows or a number.
- **Hibernate** — <kbd>Alt</kbd>+<kbd>X</kbd>, <kbd>H</kbd> on the active
  workspace (or `ch ws hibernate`). Any workspace can hibernate, busy or not;
  hibernating the active one moves you to another.
- **Wake** — select it and click its screenshot, click the pause icon on its
  row, or press <kbd>Alt</kbd>+<kbd>X</kbd>, <kbd>H</kbd> again. Selecting a
  hibernated workspace never wakes it by itself.
- **A blank editor** — if a workspace's editor shuts down or navigates away on
  its own, CodeHydra reloads that workspace's editor after about 15 seconds.
  Open files and the agent terminal come back; the agent keeps running
  throughout. If the reload does not help, hibernate and wake the workspace.

### Deleting a workspace

Hover a ready row and click its trash icon (or <kbd>Alt</kbd>+<kbd>X</kbd>,
<kbd>Delete</kbd>). The dialog checks the worktree and warns about uncommitted
changes and commits not merged into its base; confirming deletes anyway. Tick
**Keep branch** to keep the git branch. (From `ch` or MCP, a workspace with
uncommitted or unmerged work is refused unless told to ignore warnings.)

Deleting the workspace you are on moves you to another one. Select the
deleting workspace to watch it: a progress panel shows the steps — terminating
processes, stopping the agent server, closing the editor, running the
repository hook (if the repository has one; **Cancel** stops it while it
runs), removing the worktree. If the deletion finishes while you are on it,
you are moved away again; if it fails, you stay, and the panel offers
**Retry**, **Kill & Retry** (with a table of the processes holding files open)
and **Dismiss**, which force-removes the workspace from CodeHydra even if files
remain on disk (a branch you chose to keep is kept). <kbd>Escape</kbd> on a
failed panel means Dismiss.

### Notifications and updates

- **Sound** — played when a workspace's idle count goes up (including an agent
  that reports idle when it first connects). Mute it with `silent`.
- **OS notifications** — "CodeHydra agent needs your attention", only while the
  CodeHydra window is not focused; clicking one brings the window forward and
  switches to that workspace. By default only the first agent to finish while
  all were busy notifies (`notification`).
- **Sidebar cards** — clone progress, failures and updates appear as cards at
  the bottom of the sidebar. The same card raised again stacks into one with a
  counter. Dismissing a card closes it; clicking a button answers it and closes
  it. A card about a workspace names it — click the title to go there — and
  goes away when the workspace is deleted. Agents, scripts and hooks can raise
  their own with `ch notification show` (see
  [Sidebar notifications](#sidebar-notifications)).
- **Updates** — checked every 4 hours and on resume. A sidebar card offers
  **Install**, shows the download, then **Restart Now**; dismissing silences
  that version (a newer one shows again). Only for DMG, NSIS and AppImage
  builds. Turn it off with `update.notification`.
- **Bug reports** — <kbd>Alt</kbd>+<kbd>X</kbd>, <kbd>B</kbd> opens **Report a
  Bug**; your config (secrets redacted) and logs are attached, and it is sent
  even with telemetry off.

### Keyboard shortcuts

Hold <kbd>Alt</kbd> and tap <kbd>X</kbd> to enter shortcut mode, and keep
holding <kbd>Alt</kbd> while you press:

| Key                                      | Action                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| <kbd>↑</kbd> / <kbd>↓</kbd>              | Previous / next workspace                                           |
| <kbd>←</kbd> / <kbd>→</kbd>              | Previous / next idle workspace (a busy one if none is idle)         |
| <kbd>1</kbd>-<kbd>9</kbd>, <kbd>0</kbd>  | Jump to the numbered workspace (numbers are shown in shortcut mode) |
| <kbd>Enter</kbd>                         | Open the New workspace form                                         |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Delete the active workspace                                         |
| <kbd>H</kbd>                             | Hibernate / wake the active workspace                               |
| <kbd>T</kbd>                             | Hide / show hibernated workspaces                                   |
| <kbd>S</kbd>                             | Open settings                                                       |
| <kbd>B</kbd>                             | Report a bug (also works while a dialog is open)                    |
| <kbd>Escape</kbd>                        | Leave shortcut mode                                                 |

Releasing <kbd>Alt</kbd> or leaving the window also ends shortcut mode.
Navigation skips hibernated and hidden workspaces.

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

It runs the command unchanged, with the same output and exit code (128 + the
signal number when a signal kills it, as a shell reports it), and only
tells CodeHydra to leave the workspace status alone. It matters only for
Claude Code: OpenCode's background shells never affect its status, so there it
simply runs the command. A background sub-agent always keeps the workspace busy.

## Configuration

CodeHydra works out of the box, but most behavior is configurable. Every
setting is a dot-separated key. Launching CodeHydra with `--help` prints them
all with their defaults and valid values, then exits.

### The settings dialog

Open it with the gear in the sidebar header (or <kbd>Alt</kbd>+<kbd>X</kbd>
then <kbd>S</kbd>). Keys are grouped by their first segment; dotless keys are
under **General**.

- Edits are buffered: **Save**, **Save & Restart** (saves, then relaunches) or
  **Cancel**. Save is disabled while a field is invalid.
- A key that only takes effect after a restart says **Restart to apply** once
  changed; the others apply at once.
- A key set by an env var or CLI flag carries an `env` / `cli` badge: saving it
  applies now, but the override wins again at the next start.
- Each changed key has a reset button, and **Reset all to defaults** resets
  everything. Resetting removes the key from `config.json`.

### Where settings come from

The same keys work in three places, highest precedence first:

| Source      | Example                |
| ----------- | ---------------------- |
| CLI flag    | `--log.level=debug`    |
| Env var     | `CH_LOG__LEVEL=debug`  |
| config.json | `"log.level": "debug"` |

- An env var is the key with a `CH_` prefix, `.` turned into `__` and `-` into
  `_`, upper-cased.
- A CLI flag also takes `--key value`, and a bare `--key` means `true`.
  Booleans accept `true`/`false`/`1`/`0`. `--key=@path` reads the value from a
  file (one trailing newline stripped; `@@` for a value that really starts with
  `@`) — the only way to give a multi-line value on the command line.
- An invalid value from any source stops CodeHydra at startup with an error and
  the `--help` text. Unknown keys are ignored (and dropped from `config.json`);
  a `config.json` that is not valid JSON is renamed to `config.json.broken` and
  defaults are used.

`config.json` lives in the data directory, next to `state.json` (what the app
itself remembers: trusted hook answers, the hide-hibernated toggle, tracked
automatic workspaces, a dismissed update) and the `logs/` folder:

- **Linux**: `~/.local/share/codehydra/`
- **macOS**: `~/Library/Application Support/Codehydra/`
- **Windows**: `%USERPROFILE%\AppData\Roaming\Codehydra\`

### From a shell or an agent

`ch config` reads and writes the **running** app's settings exactly as the
dialog does (MCP: `config_list`, `config_get`, `config_set`, `config_reset`).
`ch config list` is the reference for every setting: its current value,
default, where the value comes from, whether it applies live or after a
restart, its valid values and what it does.

```sh
ch config list                      # every setting, with its description
ch config get log.level
ch config set sidebar.width 300     # values are strings, parsed like a CLI flag
ch config set version.claude ""     # empty clears a key that accepts null
ch config reset sidebar.width       # back to the default
```

An unknown key exits with 6, an invalid value with 2, and no running app with 3.

## Automatic workspaces

CodeHydra can create workspaces for you on a schedule from any command that
emits JSON — for example, a workspace per pull request that requests your
review. Configure them under `auto-workspace.sources` in the settings; the
editor there has a help panel with the same reference. The first poll runs at
startup; after that, `auto-workspace.poll-interval` is the number of seconds
between the end of one poll and the start of the next (default 60, minimum 1;
a change applies once the current wait ends).

### Sources

The value is a multi-document YAML stream, one `---`-separated document per
source:

| Key        | Meaning                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `name`     | Source name; must be unique                                                          |
| `type`     | The trigger: `cron` (the default and only type)                                      |
| `mode`     | `workspaces` (default) or `events` — what the command's objects mean                 |
| `cmd`      | Shell command printing a top-level JSON array of objects                             |
| `template` | Rendered once per object into one workspace; every string in it is a Liquid template |

The command runs with `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows
(use cmd.exe syntax there: `"…"` quoting, `^` to continue a line). It inherits
CodeHydra's environment and working directory, and is killed after 30
seconds. A non-zero exit, a timeout or output that is not a JSON array skips
that poll. The command line is never logged, so an inlined token stays out of
the logs (the value is also left out of bug reports).

An invalid value — bad YAML, a document that fails validation — is rejected by
the settings dialog and `ch config set`; given at startup (config.json, env
var, CLI flag) it stops CodeHydra from starting. On the command line,
`--auto-workspace.sources=@./sources.yaml` reads the value from a file, the
only way to pass multi-line YAML there.

### The template

The render context is the JSON object itself: `{{ title }}`, `{{ user.login }}`,
`{{ title | truncate: 60 }}`, `{% if draft %}…{% endif %}`. A field the object
does not have renders empty.

| Key        | Meaning                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | Required. Workspace name **and git branch** — must be a valid branch name, so prefer `pr-{{ number }}` to a title                                                                        |
| `key`      | Dedup identity across polls (default: the rendered name). `workspaces` mode only                                                                                                         |
| `project`  | Absolute path of a local repository. Opened if it is not already                                                                                                                         |
| `git`      | Clone URL (or `org/repo`) — cloned once, then reused. `project` wins if both are given; with neither, the item is skipped                                                                |
| `base`     | Branch to fork from (default: the project's default branch). Only when creating                                                                                                          |
| `tracking` | Existing remote branch to check out with upstream set, e.g. `origin/feature-x`, instead of forking `base`                                                                                |
| `focus`    | `true` switches to the workspace once created (default `false`)                                                                                                                          |
| `prompt`   | Sent to the new workspace's agent. Never sent to an existing or adopted workspace                                                                                                        |
| `agent`    | `{ type, name, permission-mode, model: { provider, id } }`; `type` is `claude` or `opencode`, `permission-mode` is Claude only, `model` needs both fields. Default: the configured agent |
| `metadata` | `title` (sidebar title), `tags` (`tags.<name>: { color, label, description }`), and any other keys                                                                                       |

Metadata keys must start with a letter and contain only letters, digits and
`-`; an invalid key is dropped with a warning in the log. Every workspace a
source creates or matches also gets `source: <source name>` in its metadata,
and a created one gets the blue **new** tag.

### Modes

- **`mode: workspaces`** — the command emits the workspaces that _should_
  exist, and each poll reconciles against that list:
  - an item not seen before creates a workspace — or, if a workspace with that
    name already exists in the project, **adopts** it: tracked from then on,
    otherwise untouched (no metadata, wake, focus or prompt);
  - an item already handled is skipped, so deleting its workspace by hand is
    final while the item is still listed;
  - an item that disappears is forgotten once its workspace is gone too; if it
    comes back after that, it is created again.

  Nothing is ever deleted automatically. Removing a source, or switching it to
  `events`, forgets everything it tracked.

- **`mode: events`** — the command emits things that _happened_, and each
  object fires exactly once. Nothing is tracked, so the command must not emit
  the same thing twice (mark it read, pop a queue, keep its own cursor). Per
  event, `template.name` is matched against the project's workspaces:
  - no match — the workspace is created, as in `workspaces` mode;
  - a match — its metadata is re-applied, then it is woken if hibernated, or
    switched to if `focus: true`. It gets no prompt: a prompt only reaches an
    agent when it starts;
  - a match being deleted — skipped.

  A failed event is logged and dropped; there is no retry.

### When something goes wrong

Most problems only reach the log, at `warn`: a failing or timed-out command,
bad JSON, a template that does not render, a failed event. A clone that fails
shows a "Clone failed" notification. A bad project shows an error notification
naming the source and the fix: a `project` that is not an absolute path (a git
URL belongs under `git`, not `project`), a `project` that cannot be opened, or a
template with neither. A workspace that cannot be created (an invalid branch
name, a bad `tracking`) shows an error notification too. A `mode: workspaces`
item that fails either way is retried every poll (an event is still dropped),
and a repeat of the same error adds to its notification's count instead of
stacking a new one.

### Example

```yaml
name: github
cmd: |
  gh api graphql -f q='is:open is:pr review-requested:@me' \
    -f query='query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{number title url body baseRefName author{login} repository{url}}}}}' \
    --jq '[.data.search.nodes[]|{number,title,html_url:.url,body,user:{login:.author.login},base:{ref:.baseRefName},clone_url:(.repository.url+".git")}]'
template:
  name: "pr-{{ number }}"
  key: "{{ html_url }}"
  base: "{{ base.ref }}"
  git: "{{ clone_url }}"
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
workspace's life: set a new worktree up, give a workspace its environment each
time it opens, refuse to delete one, or hear that one was opened. They live in the repository, so everyone who works on it gets them.
(They replace `.keepfiles`, which CodeHydra no longer reads.)

### Where hooks go

One directory, read from the **worktree** — so a hook must be committed on the
branch the worktree checks out: its base (in practice, `main`), or the remote
branch it tracks. A hook runs as it is in the worktree at that moment,
uncommitted edits included — so an agent in the workspace can change what
`before-worktree-deleted` does.

```
.codehydra/hooks/
  after-worktree-created      # blocking; new worktrees only; may return title, tags
  before-workspace-opened     # blocking; every open; may return env
  before-worktree-deleted     # blocking; may refuse the deletion
  on-workspace-opened         # fire-and-forget; every open; output ignored
```

An entry starting with `on-` reports something that already happened: it is
started and forgotten. Every other entry blocks the operation, and what it
prints matters.

One file per entry. If the file is there it runs; if not, nothing happens. The
file is named after the entry, with or without an extension —
`after-worktree-created`, `after-worktree-created.sh` and
`after-worktree-created.py` are all the same entry.

A file can be pinned to one platform with a suffix right after the entry name:
`.win`, `.linux` or `.mac`, optionally followed by an extension
(`after-worktree-created.win.cmd`, `after-worktree-created.mac.sh`). On each
platform:

- a file suffixed for that platform runs, and the unsuffixed ones are ignored;
- otherwise the unsuffixed file runs;
- a file suffixed for another platform never runs.

So a repository that supports Windows too ships `after-worktree-created` (a
shebang script) and `after-worktree-created.win.cmd`. Only the whole segment
counts: `after-worktree-created.windows.cmd` is an ordinary unsuffixed file.

If more than one file is left for the platform — `after-worktree-created.sh`
beside a forgotten `after-worktree-created.bak`, or two `.win.*` files —
nothing runs: a **Repository hook failed** notification names the files, and
the entry counts as a failed hook (a `before-worktree-deleted` gate therefore
stops the deletion). Remove all but one, or pin them to their platforms.

How a hook is started:

- **Linux / macOS**: `/bin/sh -c '<path>'`, so the shebang picks the
  interpreter. The file must be executable (`chmod +x`); unlike git, CodeHydra
  reports a non-executable blocking hook instead of skipping it silently.
- **Windows**: `cmd.exe /d /s /c "<path>"`. The shebang means nothing there, so
  use `.cmd` or `.bat` — as a `.win.cmd` file, so the other platforms do not
  try to run it.
- Symlinks and directories are not run (a warning is logged), and they do not
  count when choosing the file: a real file beside them still runs.

### The exchange

- **stdin**: one JSON object (below), then stdin is closed.
- **stdout**: one JSON object, or nothing (empty output is the same as `{}`).
  Anything else — invalid JSON, `null`, an array, an unknown key — is a hook
  failure. Output shapes are strict for every blocking hook.
- **stderr**: never parsed. It is shown in the **CodeHydra Hooks** output
  channel of the workspace's editor after the hook exits (not live), and logged
  at `warn` level — whether the hook succeeds or fails — so it is in the log
  file at the default log level.
- **Working directory**: the worktree.
- **Environment**: CodeHydra's own environment, with CodeHydra's bin directory
  put first on `PATH`. `ch` therefore works inside a hook and finds the
  workspace from the working directory (`ch ws title`, `ch ws tag set`, …).
  Nothing workspace-specific is added to the environment; stdin is the context.
- **Paths**: on Windows, `workspacePath` is lower-case with forward slashes
  (`c:/users/…`). For a project cloned from a URL, `projectPath` is
  CodeHydra's bare clone, which has no working files.
- **Timeout**: none. A blocking hook runs until it exits or you cancel it (see
  [Canceling a hook](#canceling-a-hook)).

Every entry receives this core, plus a field of its own:

```json
{
  "workspaceName": "feature-x",
  "workspacePath": "/home/me/.local/share/codehydra/projects/my-app-1a2b3c4d/workspaces/feature-x",
  "projectPath": "/home/me/src/my-app",
  "branch": "feature-x",
  "base": "main"
}
```

`branch` is the checked-out branch; it is absent on a detached HEAD. `base` is
the base recorded for the workspace (the branch it was created from); it is
absent when none is recorded, for example for a worktree adopted when the
project was added. Neither is ever filled in with a stand-in such as the
workspace name or `""`, and the rule is the same for every entry, whatever
triggered it.

A minimal hook:

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)                          # the JSON above
echo "setting up" >&2                 # goes to the output channel
echo '{"title": "Feature X"}'         # the result
```

### after-worktree-created

Runs once, on a newly created worktree, before the editor and the agent start
— the place for setup work: installing dependencies, copying untracked config.
It does not run when a workspace is reopened (app start, project open), woken
from hibernation, or adopted as an existing worktree when a project is added.
It blocks the workspace opening — the sidebar row shows as loading until it
exits, including while the trust question is open.

Extra input: none. On a new worktree `branch` and `base` are always present.

Output — every field optional:

```json
{
  "title": "Feature X",
  "tags": {
    "review": { "color": "#3498db", "description": "Waiting on review" },
    "db": { "label": "🗄" },
    "wip": {}
  }
}
```

- `title` is the sidebar display name; the branch name stays the identity.
- `tags` are keyed by tag name; `color`, `label` and `description` are optional.
  Each dot-separated part of a tag name must start with a letter and contain
  only letters, digits and `-`, not ending in `-`; at most 59 characters. An
  invalid tag name makes the whole output invalid: a hook failure whose message
  names it (`tags.1st-review: not a valid tag name …`), and neither the title
  nor any tag is applied.

`title` and `tags` are stored in the workspace's git config, so they survive a
restart like a title set by hand. `env` is not accepted here (it is a hook
failure): environment belongs to `before-workspace-opened`.

**Failure is loud but not fatal.** A non-zero exit, invalid output or a cancel
shows a **Repository hook failed** notification (e.g. `after-worktree-created
failed: exit 1 — <last stderr line>`, or `after-worktree-created was canceled`)
and is logged; the workspace still opens, without anything the hook returned. A
hook that never exits leaves the workspace loading until you cancel it.

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

### before-workspace-opened

Runs every time a workspace opens, before its editor and agent start: when it
is created (right after `after-worktree-created`), for every non-hibernated
workspace when CodeHydra starts or a project is opened (adopted worktrees
included), and when a workspace is woken from hibernation. It blocks that
workspace's opening until it exits, including while the trust question is open.

Extra input: `"reopened": true | false` — `false` for a newly created
workspace, `true` for every other open.

Output — optional:

```json
{ "env": { "DATABASE_URL": "postgres://localhost/feature_x" } }
```

`env` (string values) is the workspace's environment. It reaches:

- the agent terminal CodeHydra opens, so Claude Code and the commands it runs
  see it;
- OpenCode's server, so the commands the OpenCode agent runs see it;
- terminals you open in the workspace's editor. A terminal that was already
  open when the workspace opened (for example one restored from the last
  session) does not have it until it is recreated.

A value replaces any variable of the same name in the environment CodeHydra
starts things with; there is no appending, so an `env` that sets `PATH` must
contain the whole path. Keys starting with `_CH_` are CodeHydra's own and are
dropped (a warning is logged).

The environment is held in memory only: it is never written to a file, and
nothing of it survives a restart or a hibernation — which is why this hook runs
on every open, and why it suits short-lived values such as a freshly minted
token. When it changes between opens, the new values apply from that open on.

**Failure is loud but not fatal**, as for `after-worktree-created`: a
**Repository hook failed** notification, and the workspace opens without the
environment. A hook that never exits leaves the workspace unopened (a new one
keeps loading) until you cancel it.

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
`"blocked": true` also allows it; `{"blocked": true}` without a reason shows
"blocked".

A **non-zero exit**, invalid output or a cancel means the hook broke. That stops
the deletion too — the gate fails closed — but is reported as a hook failure,
with the last stderr line (or `before-worktree-deleted was canceled`), rather
than as a refusal.

Either way the deletion stops before the worktree is removed and the reason
appears on the progress row, with **Retry** and **Dismiss**. Neither keeps the
workspace: Retry runs the whole deletion again (trust question included, unless
answered Always or Never); Dismiss force-deletes, skipping hooks, and keeps
the branch if you chose to keep it. **Escape on the failed panel means
Dismiss.** These buttons appear once the hook has exited; while it runs, the
panel offers **Cancel** instead, which stops it (see
[Canceling a hook](#canceling-a-hook)) and leads to Retry and Dismiss.

When closing a project with "remove all", a refused deletion does not stop the
project from closing; that worktree stays on disk.

### on-workspace-opened

Started after a workspace is open — its editor and agent already running, so
it cannot prepare anything for them; use `before-workspace-opened` for that —
and forgotten immediately. Nothing waits for it, its stdout is ignored, and a
failure (including a non-executable file) only logs a warning with the exit
code; its stderr is logged at `warn`. It cannot be canceled from CodeHydra. The
one failure that raises a notification is several files claiming the entry (see
[Where hooks go](#where-hooks-go)), because then nothing ran.

It runs on the same opens as `before-workspace-opened`: creation, app start,
project open (adopted worktrees included) and wake. Extra input:
`"reopened": true | false` tells these apart, so a script that registers
workspaces with something external can skip reopens, while one that re-warms a
cache will not.

(This entry was called `on-workspace-created`; a file with that name is no
longer run.)

### Canceling a hook

A blocking hook has no timeout, so while one runs CodeHydra offers **Cancel**
for it:

- `after-worktree-created` and `before-workspace-opened`: on the
  **Loading workspace...** screen — at startup, one Cancel per running hook,
  each naming its workspace; later, on the loading panel of the workspace you
  are looking at. A hook of a workspace you are not looking at (a background
  creation, a wake, a project being opened) gets a sidebar notification with
  Cancel once it has run for about a second and a half.
- `before-worktree-deleted`: on the deletion progress panel, below the
  hook's row.

Cancel kills the hook and everything it started (on Linux and macOS SIGTERM,
then SIGKILL for whatever is still running a second later; on Windows the
whole process tree at once) and
counts as the hook failing, with that entry's usual consequence: an open goes
on without what the hook would have returned, and a deletion stops with Retry
and Dismiss. Cancel is not offered while the trust question is open — answer
Skip there instead.

### Trust

Hooks are code from a repository, so the first time one would run for a
project, CodeHydra asks:

> **Run repository hooks?** "my-app" defines CodeHydra hooks. Running them
> executes scripts from the repository on your machine.
> `.codehydra/hooks/after-worktree-created`
>
> Buttons: **Always**, **Once**, **Skip**, **Never**

- **Always** and **Never** are remembered for that project; **Once** and
  **Skip** apply to that one run. Escape means Skip.
- Trust is per project, not per script: after **Always**, edited hooks run
  without asking.
- One question per project is open at a time; every hook waiting on it gets
  the same answer.
- The operation waits while the question is open, and the workspace's sidebar
  row turns green — during `after-worktree-created` that is the placeholder row
  of the workspace being created. With a `before-workspace-opened` or
  `on-workspace-opened` hook, it can appear right at app start — and until it is
  answered, the workspace being opened waits.
- **Once** and **Skip** answer a single hook run, so without **Always** or
  **Never** the question comes back for each hook that fires: creating a
  workspace can ask for `after-worktree-created`, then
  `before-workspace-opened`, then `on-workspace-opened`, and an app start asks
  per workspace.
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
  — add `"keepBranch": false` for `before-worktree-deleted`, or
  `"reopened": false` for `before-workspace-opened` and `on-workspace-opened`.
- stderr appears in the **CodeHydra Hooks** output channel once the hook
  exits, each line tagged with the hook's name (up to 500 lines are kept until
  the editor is up; the log keeps them all). `before-worktree-deleted` has no editor left to show it in: only its
  reason, or its last stderr line on failure, reaches the progress row.
- stderr is logged at `warn` under the `[hooks]` logger, so it is in the log
  file at the default log level, for hooks that succeed too. The process
  details (command line, exit code, stdout) are under the `[process]` logger at
  `debug`; run with `--log.level=debug` to see them. At `debug` stdout is
  logged in full, including any `env` values.
- `exit 126: a file could not be executed (is it chmod +x?)` is usually the
  hook file missing its exec bit — or a command the script ran that is not
  executable. `exit 127: a command was not found (the shebang interpreter, or
one the script ran)` means the `#!` line points at something that is not
  installed, or the script called a command that is not on `PATH`. The shell
  reports both cases with the same code, so check the last stderr line.
- `several files claim it on this platform (…)` lists the files CodeHydra could
  not choose between; see [Where hooks go](#where-hooks-go).

## Agents

Each workspace runs one coding agent — Claude Code or OpenCode, chosen by the
`agent` setting or per workspace when you create it — in a terminal tab of its
editor.

### Claude Code

The agent terminal runs `ch claude`, which starts the `claude` on your `PATH`
(or the version set by `version.claude`) with CodeHydra's additions: its status
hooks, the CodeHydra MCP server, the system prompt below, and
`--allow-dangerously-skip-permissions` (so bypass mode is available through
Shift+Tab, not switched on). It resumes the workspace's last conversation
(`--continue`) unless the workspace is new.

### OpenCode

CodeHydra runs one `opencode serve` per workspace and the agent terminal
attaches to it. The status shows **None** until the terminal has attached.

### Starting, closing and restarting

In the editor's command palette: **CodeHydra: Open Agent**, **Close Agent**,
**Restart Agent Server** (or `ch ws agent open|close|restart`, or the MCP
tools).

- **Open** focuses the agent terminal, starting it if it is closed.
- **Close** stops the agent; its terminal stays closed after a restart or
  wake until you open it again. The terminal also closes when the agent exits.
- **Restart** restarts OpenCode's server. For Claude Code there is no server:
  it regenerates CodeHydra's config files and resets status tracking, but does
  not restart a running `claude`.

### Initial prompts

A prompt given when a workspace is created — in the New workspace form, with
`ch ws create … --prompt`, by `workspace_create` from another agent, or by an
[automatic workspace](#automatic-workspaces) — is sent once, when the agent
first starts. With it you can choose `--agent claude|opencode`, `--model`
(OpenCode: `provider/model`), `--permission-mode` (Claude Code, e.g. `plan`)
and `--agent-name`; these need `--agent`.

### Status and permissions

Busy and idle come from the agent itself: Claude Code through its hooks,
OpenCode through its server's events. A pending permission prompt, or a
question the agent asked you, counts as idle — the agent is waiting on you.

So does a dialog in the workspace's editor — a notification, pick list or text
prompt raised by the agent, `ch` or a repository hook. The workspace reads idle
until you dismiss it, even while the agent keeps working and even with no agent
running, then returns to its real status.

### What agents are told

You don't have to explain CodeHydra to your agent. Every session gets a short
system prompt: what busy and idle mean (so it ends its turn only when it needs
you), that the worktree's lifecycle belongs to CodeHydra, that sibling
workspaces share the repository (an `index.lock` error means retry), that
creating another workspace is your call, that `ch` is on its `PATH`, that
`code <path>` opens a file in your editor, and that `ch guide` explains
CodeHydra. Claude Code is also told about `ch bg`. The MCP server adds: pass a
prompt when creating a workspace, and file a bug report only when asked.

A line in your project's `CLAUDE.md` or `AGENTS.md` is the place to tighten or
loosen any of it. With OpenCode the prompt is added to the `instructions` list,
alongside any entries in your own `opencode.json`.

## CLI and MCP

### The `ch` command

`ch` lives in the `bin` folder of the data directory. It is on the `PATH` of
every editor terminal, the agent, and repository hooks; to use it from any
other shell, add that folder to your `PATH` or symlink `ch`. It finds the
running CodeHydra by itself; if none is running, it exits 3.

`ch --help` lists the commands (it needs the running app), and
`ch <command> --help` shows one command's arguments:

| Command                                                            | Purpose                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `ws status`                                                        | Dirty flag, unmerged commits and agent status (`--refresh` fetches first)                                        |
| `ws create <name> [base]`                                          | New workspace (`--project`, `--tracking`, `--prompt`, `--agent`, `--model`, `--permission-mode`, `--agent-name`) |
| `ws delete`                                                        | Delete the workspace (`--keep-branch`, `--ignore-warnings`, `--no-wait`)                                         |
| `ws hibernate`, `ws wake`                                          | Hibernate / wake                                                                                                 |
| `ws switch <workspace>`                                            | Make a workspace the active one                                                                                  |
| `ws title <title>`                                                 | Sidebar title                                                                                                    |
| `ws tag ls`, `ws tag set <name>`, `ws tag rm <name>`               | Tags (`--color`, `--label`, `--description`; `set` replaces the whole tag)                                       |
| `ws metadata get`, `ws metadata set <key> <value>`                 | Raw workspace metadata                                                                                           |
| `ws agent open\|close\|restart\|session`                           | The agent terminal and server                                                                                    |
| `ws status set <idle\|busy>`                                       | Report the agent's status                                                                                        |
| `ws notify`, `ws status-bar`, `ws ask`                             | A notification, status-bar text, or a question in the editor (`ask` waits for the answer)                        |
| `notification show <title>`, `notification close <id>`             | A card in CodeHydra's sidebar, see below                                                                         |
| `ws goto`, `ws diff`, `ws preview`, `ws browser`                   | Open a file (`file:line:col`), a diff, a markdown preview, a URL in the editor                                   |
| `ws vscode-command <command>`                                      | Run a VS Code command                                                                                            |
| `ws open <path>`                                                   | Open with the OS (`--reveal` shows it in the file manager)                                                       |
| `project list`, `project open <target>`, `project close <project>` | Projects (a path, a git URL or `org/repo`; `--remove-local-repo`)                                                |
| `lock take`, `lock release`, `lock ls`, `lock run`                 | Locks, see below                                                                                                 |
| `config list\|get\|set\|reset`                                     | Settings, see [Configuration](#configuration)                                                                    |
| `guide [section]`                                                  | This guide, or one `##` section of it                                                                            |
| `log <level> <message>`                                            | Write to CodeHydra's log                                                                                         |
| `report-issue <description>`                                       | File a bug report                                                                                                |
| `bg <cmd…>`                                                        | Run a command without keeping the workspace busy                                                                 |
| `mcp`, `claude`, `opencode`                                        | The MCP server and agent launchers CodeHydra itself uses; extra arguments go to the agent                        |

```sh
ch ws status
ch ws create feature-auth main --prompt "add login with GitHub"
ch ws title "Auth rework"
ch ws tag set review --color "#3498db"
ch ws delete --workspace feature-auth --keep-branch
ch guide repository-hooks
```

- `ch` acts on the workspace containing the current directory.
  `--workspace <name|path>` targets another; a name must be unique across open
  projects, and only an absolute path counts as a path. A name that matches no
  open workspace fails the first command that needs a workspace with exit 6; a
  name that matches several fails it with exit 2 — pass a path instead.
  Commands that need no workspace still run.
- `project`, `config`, `guide`, `log`, `report-issue`, `lock ls`,
  `notification`, `ws switch`, `ws open` and `ws create --project …` work
  outside a workspace; other workspace commands exit 4 there.
- `--format auto` (the default) prints human-readable output at a terminal and
  JSON when piped — errors too, as `{"error", "exitCode"}` on stderr;
  `--format json` or `--format text` forces either. `ch guide` prints markdown
  unless `--format json` is given. An unknown flag is a usage error (exit 2).
  Progress (clones, deletions) goes to stderr when it is a terminal.
- Exit codes: 0 ok, 1 failed, 2 usage, 3 CodeHydra not reachable, 4 not in a
  workspace, 5 conflict, 6 not found.
- `ws browser` opens the URL in the editor's Simple Browser. `file://` URLs
  work there too, however they are opened (including typed into its address
  bar): CodeHydra serves the file from disk, so the page's relative links,
  stylesheets and scripts load. A directory shows its `index.html`, or else a
  listing. A file that is missing or unreadable shows a "site can't be reached"
  error. PDFs do not display: Simple Browser sandboxes its page, and Chromium's
  PDF viewer refuses to run in a sandboxed frame — open them with
  `ch ws open <path>` instead.

### Locks

A lock is a single-holder resource shared across workspaces — one phone, one
port, one test database. Locks are advisory: nothing stops a command that does
not ask.

```sh
ch lock take device "smoke test"    # waits its turn (FIFO), then holds it
ch lock take device --no-wait       # exit 5 at once if someone holds it
ch lock ls
ch lock release device              # or no name: everything this workspace holds
ch lock run device -- npm run e2e   # hold only while the command runs
```

- The **workspace** holds the lock, not the process: it stays held after
  `take` returns, until `release`, or the workspace hibernates, is deleted or
  its project is closed. Closing the agent terminal does not release it.
- `--scope global` (the default) is shared by every project; `--scope project`
  only by the workspaces of this project.
- The sidebar shows the holder with a `🔒 name` tag and waiters with `⏳ name`.
- Locks live in memory and are gone after a restart.
- `ch lock run` ties the lock to its own process; without a command it holds
  until killed (run that under `ch bg`, or the workspace stays busy).
- Releasing a lock the workspace does not hold exits 6.
- A waiter never takes a held lock. To break one whose holder is stuck or
  gone, release it as the holder, from any shell:
  `ch lock release device --workspace <holder>`. That ends the hold, not
  whatever the holder is still running.

### Sidebar notifications

`ch notification show` puts a card in CodeHydra's own sidebar — the same kind
CodeHydra uses for clone progress and errors, visible whichever workspace you
are looking at. (`ch ws notify` is different: a toast inside one workspace's
editor.)

```sh
ch notification show "Nightly build finished"
id=$(ch notification show "Building" --type spinner --percent 0 | jq -r .id)
ch notification show "Building" --id "$id" --type spinner --percent 50
ch notification close "$id"
ch notification show "Deploy to staging?" --actions Deploy --actions Skip --wait --attach
```

- It returns the card's `id` (`{"id": …}` when piped). Pass `--id` to change
  that card (progress, a new message) and `ch notification close <id>` to
  remove it. Changing a card that was dismissed exits 6.
- `--type info|warning|error|spinner` (default `info`), `--message` for a
  second line, `--percent 0..100` for a bar, `--no-dismissible` to hide the
  dismiss button.
- A card is app-wide. `--attach` ties it to the current workspace
  (`--workspace-path` to another): it names the workspace, clicking its title
  switches there, and it closes when the workspace is deleted.
- `--wait` blocks until you answer and returns the clicked action as `choice`,
  or `null` if you dismissed it, `--timeout <seconds>` passed or the workspace
  went away. Answering closes the card. Stopping the command (<kbd>Ctrl</kbd>+<kbd>C</kbd>)
  takes the question down, unless another caller is waiting on the same card.
- A card that says exactly what an open card says joins it (a counter) and
  gets its id; it goes away once every caller that raised it has closed it.

### MCP

The agents reach the same operations as MCP tools (`ch mcp` is the server both
agents launch):

| Area       | Tools                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces | `workspace_get_status`, `workspace_create`, `workspace_delete`, `workspace_switch`, `workspace_hibernate`, `workspace_wake`, `workspace_set_title`, `workspace_list_tags`, `workspace_set_tag`, `workspace_remove_tag`, `workspace_get_metadata`, `workspace_set_metadata` |
| Agent      | `workspace_get_agent_session`, `workspace_restart_agent_server`, `workspace_open_agent`, `workspace_close_agent`, `workspace_set_agent_status`                                                                                                                             |
| Editor     | `workspace_execute_command`, `ui_show_message`, `workspace_open_browser`, `workspace_open_diff`, `workspace_goto`, `workspace_preview_markdown`, `system_open_path`                                                                                                        |
| Projects   | `project_list`, `project_open`, `project_close`                                                                                                                                                                                                                            |
| Locks      | `lock_take` (does not wait unless asked), `lock_release`, `lock_list`                                                                                                                                                                                                      |
| Sidebar    | `notification_show`, `notification_close`                                                                                                                                                                                                                                  |
| Other      | `config_get`, `config_list`, `config_set`, `config_reset`, `guide`, `log`, `report_bug`                                                                                                                                                                                    |

You don't need to learn any of it. Just describe what you want in plain
language:

- "Open a workspace for the login bug and tell its agent to fix it"
- "Hibernate the workspaces I'm not using"
- "Save all open files"
