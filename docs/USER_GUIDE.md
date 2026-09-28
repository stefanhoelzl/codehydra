# CodeHydra User Guide

Run multiple AI agents in parallel, each in its own isolated workspace.

**Contents**

1. [Why CodeHydra?](#why-codehydra)
2. [Quick start](#quick-start)
3. [Core concepts](#core-concepts)
4. [Using CodeHydra](#using-codehydra)
5. [Configuration](#configuration)
6. [Plugins](#plugins)
7. [Agents](#agents)
8. [CLI and MCP](#cli-and-mcp)
9. [Troubleshooting](#troubleshooting)

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
use — **Claude Code** or **OpenCode** — then downloads what it needs: the
embedded editor, and the agent unless it is already installed (see
[Which agent binary runs](#which-agent-binary-runs)). Then open a project
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
- **Docked**, it stays expanded beside the workspace, which shrinks to the
  rest of the window instead of being covered. Toggle it with the dock button
  in the header (or <kbd>Alt</kbd>+<kbd>X</kbd>, <kbd>P</kbd>); the choice is
  saved as `sidebar.mode` (`overlay`, the default, or `docked`). Docked, resting
  the pointer on the sidebar is not a hover: a workspace an agent opens in the
  background takes the view as it would with the sidebar collapsed.
- **Resize** it by dragging its right edge (at least 250 px, at most 75% of the
  window); the width is saved as `sidebar.width`. Docked, the workspace
  follows the drag.
- The header has, when expanded, the **dock** button, the **eye**, the
  **gear** (settings) and **?** (this guide). Hover any sidebar icon for what
  it does.
- The **eye** (or <kbd>Alt</kbd>+<kbd>X</kbd>, <kbd>T</kbd>) hides sleeping
  workspaces; it shows a closed eye while they are hidden, and a project with
  hidden rows shows how many. The choice is remembered.
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
  to **adopt**; worktrees on a detached HEAD cannot be adopted. An adopted
  workspace is named after its branch, like every other workspace. The
  adoption is stored on that branch: with another branch checked out in the
  worktree, it is not listed after the next start until the branch is back.
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
- **Hibernate** — hover a ready row and click its pause icon, or press
  <kbd>Alt</kbd>+<kbd>X</kbd>, <kbd>H</kbd> on the active workspace (or
  `ch ws hibernate`). Any workspace can hibernate, busy or not, without a
  confirmation; hibernating the active one moves you to another.
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
plugins' `before-worktree-deleted` hooks (if any plugin has one; **Cancel**
stops it while it runs), removing the worktree. If the deletion finishes while you are on it,
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
| <kbd>P</kbd>                             | Dock / undock the sidebar                                           |
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

`config.json` lives in your CodeHydra home, `~/.codehydra/`
(`%USERPROFILE%\.codehydra\` on Windows), the one folder for what you write
yourself — settings and your [plugins](#plugins) — the same place on every
platform, so it can live in your dotfiles.
A `config.json` left in the data directory by an older version is moved there
on the first start.

What the app writes lives in the data directory: `state.json` (what the app
itself remembers: which plugins are enabled (`plugins.state`), the hide-hibernated toggle, tracked
automations, a dismissed update, the workspaces folder in use) and
the `logs/` folder (plugin run logs are in `logs/plugins/`):

- **Linux**: `~/.local/share/codehydra/`
- **macOS**: `~/Library/Application Support/Codehydra/`
- **Windows**: `%LOCALAPPDATA%\Codehydra\`

Windows versions before this one kept it in `%APPDATA%\Codehydra\` (the
roaming profile). The first start of a newer version moves settings, state,
logs and binaries to `%LOCALAPPDATA%` and then migrates the workspaces without
asking, as **Migrate** below does: cloned repositories move, existing
workspaces stay in the old folder and remain listed, new ones are created in
the new one. While an older CodeHydra is still running from the old folder,
nothing moves and the next start tries again.

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

### Where workspaces live

Worktrees and cloned repositories live in the data directory by default. Set
`paths.workspaces` to an absolute folder to keep them elsewhere — for example
on a Windows Dev Drive. The settings dialog has a **Browse…** button for it.
Only source code moves there: binaries, logs and `state.json` stay in the data
directory, and settings in your CodeHydra home.

The change applies at the next start, which asks what to do with what is
already there:

- **Migrate** moves cloned repositories to the new folder. Existing workspaces
  are not moved: they stay in the old folder and remain in the sidebar as
  ordinary workspaces, with their agent conversations and editor state, whatever
  branch is later checked out in them. New workspaces are created in the new
  folder. Offered only when the new folder is empty. If a step fails, the
  migration is undone and you can retry, continue with the current folder, or
  quit.
- **Use as is** switches to the new folder without moving anything. Workspaces
  in the old folder stay on disk but are no longer listed.
- **Quit** leaves everything as it is.

A folder that cannot be used — inside a project, or not writable — offers only
**Continue with current folder** and **Quit**, and the question comes back at
the next start until the setting is changed.

Earlier versions marked the workspaces a migration left behind with an
`external` tag. The first start of this version removes that tag from them;
they stay listed, now on any branch.

## Plugins

A plugin is your own script — or a repository's — attached to CodeHydra. A
plugin can contribute:

- **hooks**: scripts run at a few points in a workspace's life — set a new
  worktree up, give a workspace its environment each time it opens, refuse to
  delete one, or hear that one was opened;
- **automations**: scripts run on a timer, whose output creates workspaces —
  for example one per pull request that requests your review — or runs other
  actions (hibernate, wake, notify, …).

### Where plugins live

| Where                                                                  | Whose            | Applies to    | Contributes           | Runs                               |
| ---------------------------------------------------------------------- | ---------------- | ------------- | --------------------- | ---------------------------------- |
| `~/.codehydra/plugins/` (Windows: `%USERPROFILE%\.codehydra\plugins\`) | yours            | every project | hooks and automations | right away (enabled)               |
| `.codehydra/plugins/` in a worktree                                    | the repository's | that worktree | hooks only            | once trusted (see [Trust](#trust)) |

In either folder a plugin is **one YAML file**, `<name>.yaml`, or **a folder**
holding `plugin.yaml` and whatever files its scripts use. The file or folder
name is the plugin's name (letters, digits, `.`, `-` and `_`); there is no name
key. Other files in the plugins folder are ignored; a folder without
`plugin.yaml`, or a name used by both a file and a folder, is reported as a
problem.

A repository's plugins are read from the **worktree**, so they must be
committed on the branch the worktree checks out. They run as they are in the
worktree at that moment, uncommitted edits included — so an agent in the
workspace can change what `before-worktree-deleted` does. A repository's plugin
cannot run automations: an `automations:` section there is ignored (a warning
is logged).

Plugins are read each time they would run, so an edit takes effect the next
time without a restart.

### The manifest

```yaml
description: Set up the database # optional
shell: bash # bash (default) | powershell | cmd
platform: [linux, macos] # default: every platform
hooks:
  after-worktree-created: |
    pnpm install >&2
    echo '{"title": "Ready"}'
  before-workspace-opened: '"$CH_PLUGIN_DIR/env.sh"'
automations:
  reviews: "$CH_PLUGIN_DIR/reviews.sh"
```

- A hook's or an automation's value **is** its script, in the document's
  `shell`.
- A manifest may hold several `---`-separated documents. **Every document whose
  `platform` includes the one you are on applies**, in file order — the usual
  split is one document per platform where the scripts differ:

  ```yaml
  hooks:
    after-worktree-created: ./setup.sh
  ---
  platform: windows
  shell: powershell
  hooks:
    before-workspace-opened: '& "$env:CH_PLUGIN_DIR\env.ps1"'
  ```

- Unknown keys are errors, not ignored: a typo — or a section a newer
  CodeHydra adds — is reported and the whole plugin is skipped, so a broken
  edit never half-runs.
- `ch plugin schema` prints the manifest's JSON Schema, with a description for
  every key (`--items`: the format an automation's script prints). Point your editor's YAML schema at it
  (`ch plugin schema > ~/.codehydra/plugin.schema.json`, then a
  `# yaml-language-server: $schema=…` comment at the top of the manifest).

### How scripts run

Every script — hook or automation — is written to a temporary file and run
the way GitHub Actions runs a `run:` step for its shell:

| `shell`      | Runs                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `bash`       | `bash --noprofile --norc -eo pipefail <file>` — a failing command or pipe stops the script                                 |
| `powershell` | `pwsh` if it is on `PATH`, else Windows PowerShell, with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <file>` |
| `cmd`        | `cmd /d /s /c <file>`, with `@echo off` first. Windows only                                                                |

- **bash on Windows** is Git Bash: `paths.bash` when set, else the `bash.exe`
  of the Git for Windows whose `git` is on `PATH`, else the usual install
  locations. WSL's `bash` is never used — it sees neither CodeHydra's paths nor
  its environment. Without a Git Bash, a bash script fails, saying so.
  Git Bash runs a file's shebang, so a bundled `./tool.py` works as on Linux.
- A shell that is not available (`cmd` off Windows, PowerShell without `pwsh`)
  fails that script with a message; mark the document's `platform` instead.
- **stdin**: one JSON object, newline-terminated (so `read` works under
  `bash -e`). **stdout**: the result (below). **stderr**: yours, for people.
- **Environment**: CodeHydra's own, with CodeHydra's bin directory first on
  `PATH` — so `ch` works in every script — plus:
  - `CH_PLUGIN_DIR`: the plugin's folder (folder plugins only), to reach the
    files it bundles;
  - `CH_WORKSPACE_DIR`: the worktree, for hooks.
- **Working directory**: the worktree for a hook; the plugin's folder (or the
  plugins folder, for a one-file plugin) for an automation. From a worktree,
  `ch` acts on that workspace without being told which (`ch ws title`, …).
- **Timeout**: none for a hook (see [Canceling a hook](#canceling-a-hook)); an
  automation's script is killed after 30 seconds.

### Run logs and errors

Every run writes its own log file:
`<data directory>/logs/plugins/<local|workspace/<project>>/<plugin>/<hooks|automations>/<entry>/<time>.<ok|failed>.log`.
It holds the plugin, entry, shell, working directory, times and exit, then the
JSON the script was handed, its stderr and its stdout. The environment is never
written. Per entry the newest ten failed runs and the latest successful one are
kept.

A script's output never reaches CodeHydra's own log, and an error never quotes
it — output can carry credentials an automation inlines. Instead:

- a failed run raises a **Plugin failed** notification naming the plugin, the
  entry, the exit and the run log (`local:github automations.reviews: exit 1 —
log: …`); a plugin that cannot run at all — an invalid manifest, a folder
  without `plugin.yaml` — raises **Plugin cannot run**. Each is raised once
  per distinct message, not every time it happens again;
- `ch plugin errors` lists the same: every plugin that cannot run, and the last
  failed run of each hook and automation (until it next succeeds, or
  CodeHydra restarts), with its log file;
- a hook's stderr and stdout are also shown in the **CodeHydra Plugins** output
  channel of the workspace's editor after it exits, each line tagged with the
  plugin and entry (up to 500 lines are held until the editor is up).

### Managing plugins

```sh
ch plugin list                      # name, origin, enabled/disabled/ask, platforms, path
ch plugin disable local:github      # stop running it: hooks and automations
ch plugin enable workspace:setup    # trust one of this repository's plugins
ch plugin errors                    # what is wrong, with run logs
ch plugin schema [--items]          # the manifest's JSON Schema, or the items'
ch plugin render <template>         # render piped items through a Liquid template
```

A plugin is named `local:<name>` (yours) or `workspace:<name>` (the
repository's). `ch plugin list` run inside a workspace also shows that
repository's plugins; `workspace:<name>` needs a workspace too (run it from
one, or pass `--workspace`). MCP has the same as `plugin_list`,
`plugin_enable`, `plugin_disable`, `plugin_errors`, `plugin_schema` and
`plugin_render`.

To stop every plugin at once — hooks and automations — set `plugins.enabled`
to `false` (settings, `ch config set plugins.enabled false`,
`CH_PLUGINS__ENABLED=false`, or `--plugins.enabled=false`); it applies
immediately, and automations resume where they left off when it is turned back
on. The old name `hooks.enabled` is still read.

### Hooks

```yaml
hooks:
  after-worktree-created: … # blocking; new worktrees only; may return title, tags
  before-workspace-opened: … # blocking; every open; may return env
  before-worktree-deleted: … # blocking; may refuse the deletion
  on-workspace-opened: … # fire-and-forget; every open; output ignored
```

An entry starting with `on-` reports something that already happened: it is
started and forgotten. Every other entry blocks the operation, and what it
prints matters: one JSON object, or nothing (the same as `{}`). Anything else —
invalid JSON, `null`, an array, an unknown key — is a failed run.

**Several plugins** may define the same entry. They run one after another —
your plugins by name, then the repository's by name, each plugin's documents
in file order — and their results combine: `env` variables and `tags` merge,
a later plugin winning for the same name; the last `title` set wins; the first
refusal of a deletion stops the rest. A failed plugin contributes nothing, and
for an open the next one still runs.

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
project was added. Neither is ever filled in with a stand-in. On Windows,
`workspacePath` is lower-case with forward slashes (`c:/users/…`). For a
project cloned from a URL, `projectPath` is CodeHydra's bare clone, which has no
working files.

#### after-worktree-created

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
  invalid tag name makes that plugin's whole output invalid: a failed run whose
  message names it, and none of its title or tags are applied.

`title` and `tags` are stored in the workspace's git config, so they survive a
restart like a title set by hand. `env` is not accepted here: environment
belongs to `before-workspace-opened`.

**Failure is loud but not fatal**: a failed or canceled run raises **Plugin
failed** and the workspace still opens, without what that plugin returned. A
script that never exits leaves the workspace loading until you cancel it.

Copying untracked files from the main checkout:

```yaml
hooks:
  after-worktree-created: |
    input=$(cat)
    project=$(printf '%s' "$input" | jq -r .projectPath)
    for f in .env config/local.yml; do
      if [ -e "$project/$f" ]; then
        mkdir -p "$(dirname "$f")"
        cp "$project/$f" "$f"
      fi
    done
```

#### before-workspace-opened

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

CodeHydra puts `GIT_OPTIONAL_LOCKS=0` in the same places, plugin or no plugin,
so `git status` there never takes `index.lock` — one killed mid-way cannot
leave a stale lock behind. (The editor's Source Control view already runs `git
status` that way. `git diff` against the working tree still takes the lock
briefly whatever the setting, and skips it when it is held.) It is a default:
an `env` that sets `GIT_OPTIONAL_LOCKS` wins, and so does a value already in
the environment CodeHydra was started with.

The environment is held in memory only: it is never written to a file, and
nothing of it survives a restart or a hibernation — which is why this hook runs
on every open, and why it suits short-lived values such as a freshly minted
token. When it changes between opens, the new values apply from that open on.

**Failure is loud but not fatal**, as for `after-worktree-created`: the
workspace opens without that plugin's environment. A script that never exits
leaves the workspace unopened (a new one keeps loading) until you cancel it.

#### before-worktree-deleted

The last gate before the worktree is removed. By the time it runs the workspace
is shut down — terminals killed, agent server stopped, editor closed — and it
has its own row on the deletion progress panel. It also runs when closing a
project with "remove all" confirmed. It does not run when closing a project
leaves the worktrees on disk, and not for a forced deletion.

Extra input: `"keepBranch": true | false` (the user's choice in the delete
dialog). `branch` and `base` are absent when CodeHydra does not know them.

To refuse, exit **0** and print:

```json
{ "blocked": true, "reason": "Deployment lock held by CI run #4821" }
```

Printing nothing, or `{}`, allows the deletion. `{"reason": "…"}` without
`"blocked": true` also allows it; `{"blocked": true}` without a reason shows
"blocked".

A **non-zero exit**, invalid output or a cancel means the script broke. That
stops the deletion too — the gate fails closed — and the progress row names
the plugin, the exit and its run log, rather than a refusal.

Either way the deletion stops before the worktree is removed and the reason
appears on the progress row, with **Retry** and **Dismiss**. Neither keeps the
workspace: Retry runs the whole deletion again (trust question included, unless
answered for good); Dismiss force-deletes, skipping hooks, and keeps the branch
if you chose to keep it. **Escape on the failed panel means Dismiss.** These
buttons appear once the script has exited; while it runs, the panel offers
**Cancel** instead, which stops it (see [Canceling a hook](#canceling-a-hook))
and leads to Retry and Dismiss.

When closing a project with "remove all", a refused deletion does not stop the
project from closing; that worktree stays on disk.

#### on-workspace-opened

Started after a workspace is open — its editor and agent already running, so
it cannot prepare anything for them; use `before-workspace-opened` for that —
and forgotten immediately. Nothing waits for it and its stdout is not read. A
failure still raises **Plugin failed**. It cannot be canceled from CodeHydra.

It runs on the same opens as `before-workspace-opened`: creation, app start,
project open (adopted worktrees included) and wake. Extra input:
`"reopened": true | false` tells these apart, so a script that registers
workspaces with something external can skip reopens, while one that re-warms a
cache will not.

#### Canceling a hook

A blocking hook has no timeout, so while one runs CodeHydra offers **Cancel**
for it, naming the entry and the plugin:

- `after-worktree-created` and `before-workspace-opened`: on the
  **Loading workspace...** screen — at startup, one Cancel per running script,
  each naming its workspace; later, on the loading panel of the workspace you
  are looking at. A script of a workspace you are not looking at (a background
  creation, a wake, a project being opened) gets a sidebar notification with
  Cancel once it has run for about a second and a half.
- `before-worktree-deleted`: on the deletion progress panel, below the
  row.

Cancel kills the script and everything it started (on Linux and macOS SIGTERM,
then SIGKILL for whatever is still running a second later; on Windows the whole
process tree at once) and counts as that run failing, with the entry's usual
consequence: an open goes on without what it would have returned, and a
deletion stops with Retry and Dismiss. Cancel is not offered while the trust
question is open.

Quitting CodeHydra cancels every hook still running, `on-` entries included,
the same way, and starts no new ones — a hook never outlives the app. A
deletion whose gate was canceled by the quit stays undone; the workspace is
still there on the next start.

### Trust

A repository's plugins are code from that repository, so the first time one
would run for a project, CodeHydra asks — one question per project, listing
every plugin of the repository not yet answered for, each with a checkbox
(checked):

> **Run this repository's plugins?** "my-app" ships CodeHydra plugins. Running
> them executes scripts from the repository on your machine.
>
> ☑ setup ☑ deploy-gate
>
> Buttons: **Remember**, **Just this time**

- **Remember** enables the checked plugins and disables the unchecked ones for
  the project, for good. **Just this time** runs the checked ones this once and
  remembers nothing, so the question comes back the next time a plugin would
  run.
- A plugin the repository adds later is asked about on its own.
- While the question is open, the operation waits and the workspace's sidebar
  row turns green — during `after-worktree-created` that is the placeholder row
  of the workspace being created. Every hook waiting on it gets the same
  answer.
- The question is asked whatever triggered the hook — the UI, `ch ws delete`,
  an automation. An unchecked or disabled `before-worktree-deleted` lets the
  deletion proceed without that gate.
- A repository with no plugins is never asked anything.
- Change an answer with `ch plugin enable|disable workspace:<name>`. Your own
  plugins are never asked about; `ch plugin disable local:<name>` stops one.
- A project's Always or Never for the repository hooks CodeHydra ran before
  plugins still stands for its plugins until they are answered for.

### Automations

An automation is a script your plugin runs every poll cycle. Like a hook, its
value is the script itself:

```yaml
automations:
  reviews: "$CH_PLUGIN_DIR/reviews.sh"
```

The script prints a JSON array of **items**. Each item names its `action` and
carries that action's input — the same fields its `ch` command and MCP tool
take — so one script can create workspaces, hibernate others and raise a
notification in the same poll:

```json
[
  { "action": "workspace.create", "project": "org/repo", "name": "pr-7", "prompt": "Review #7" },
  { "action": "workspace.hibernate", "workspace": "pr-3" },
  { "action": "notification.show", "title": "CI failed", "type": "error" }
]
```

The first poll runs at startup; after that, `automations.poll-interval` is the
number of seconds between the end of one poll and the start of the next
(default 60, minimum 1; a change applies once the current wait ends; the old
`auto-workspace.poll-interval` is still read). Every automation runs each
poll. The script gets `{}` on stdin and is killed after 30 seconds. A failed or
timed-out script, or output that is not a JSON array, skips that automation for
the poll and raises **Plugin failed**.

`ch plugin schema --items` prints the item format as a JSON Schema, one branch
per action; `ch <command> --help` (`ch ws create --help`, …) describes each
action's fields.

Items are strict: an item with no `action`, an action no automation may run, a
missing field, a value of the wrong type or a field the action does not know
(a typo) is refused, and raises **Plugin failed** naming the automation, the
item's position, the action and the field. The next item still runs; the run
log holds the whole output.

#### Creating workspaces

A `workspace.create` item takes `ch ws create`'s fields:

| Field                                           | Meaning                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `project`                                       | Required. An open project's name, a local path, or a git URL (or `org/repo`) — opened or cloned if needed |
| `name`                                          | Required. Workspace name **and git branch** — must be a valid branch name, so prefer `pr-7` to a title    |
| `base`                                          | Branch to fork from (default: the project's default branch). Only when creating                           |
| `tracking`                                      | Existing remote branch to check out with upstream set, e.g. `origin/feature-x`, instead of forking `base` |
| `prompt`                                        | Sent to the new workspace's agent — or, for an event that matches, as a message                           |
| `agent`, `model`, `permissionMode`, `agentName` | The agent: `claude` or `opencode`, `provider/model`, a Claude permission mode, a named agent              |
| `stealFocus`                                    | `true` switches to the workspace (default `false`)                                                        |

and three that only automations have:

| Field      | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `event`    | `false` (default): this workspace should exist. `true`: something happened. See below                         |
| `key`      | What a `false` item is remembered by across polls (default: `name`)                                           |
| `metadata` | `title` (sidebar title), `tags` (by name: `{ color, label, description }`) and any other keys (string values) |

Metadata keys must start with a letter and contain only letters, digits and
`-`. Every workspace an automation creates or matches also gets
`source: <plugin>/<automation>` in its metadata, and a created one gets the blue
**new** tag.

- **`event: false`** — the item says the workspace _should_ exist. The script
  prints the whole list every poll, and each poll reconciles against it:
  - an item not seen before creates a workspace — or, if a workspace with that
    name already exists in the project, **adopts** it: tracked from then on,
    otherwise untouched (no metadata, wake, focus or prompt);
  - an item already handled is skipped, so deleting its workspace by hand is
    final while the item is still listed;
  - an item that disappears from the list is forgotten once its workspace is
    gone too; if it comes back after that, it is created again.

  "The list" is this automation's `event: false` items of this poll. Nothing is
  ever deleted automatically. Removing the automation, or disabling its plugin,
  forgets everything it tracked.

- **`event: true`** — the item says something _happened_, and fires every time
  it is printed. Nothing is tracked, so the script must not print the same thing
  twice (mark it read, pop a queue, keep its own cursor). `name` is matched
  against the project's workspaces:
  - no match — the workspace is created, as for `event: false`;
  - a match — its metadata is re-applied, then it is woken if hibernated, or
    switched to if `stealFocus`. Its `prompt`, if there is one, then reaches the
    running agent as a [message](#messages-to-a-running-agent), signed
    `CodeHydra · automation <plugin>/<automation>`; an agent terminal you
    closed is reopened for it;
  - a match being deleted — skipped.

  A failed event is logged and dropped; there is no retry.

A clone that fails shows a "Clone failed" notification. A `project` that is
neither an open project's name, an absolute path nor a git URL, or one that
cannot be opened, raises **Plugin failed**. A workspace that cannot be created
(an invalid branch name, a bad `tracking`) shows an error notification too. An
`event: false` item that fails either way is retried every poll.

Example — a workspace per pull request that requests your review, with `jq`
(`gh --jq` takes the same program):

```yaml
automations:
  reviews: |
    gh pr list --repo org/repo --search review-requested:@me \
      --json number,title,url,baseRefName \
      --jq '[.[] | {
        action: "workspace.create", project: "org/repo",
        name: "pr-\(.number)", key: .url, base: .baseRefName,
        metadata: {title: "PR #\(.number): \(.title)", tags: {review: {color: "#4b6de8"}}},
        prompt: "Review pull request #\(.number) \"\(.title)\": \(.url)"
      }]'
```

#### Other actions

These operations can be an item's `action`; each item runs it once, and
nothing is tracked:

`workspace.hibernate`, `workspace.wake`, `workspace.delete`,
`workspace.switch`, `workspace.title`, `workspace.tag.set`,
`workspace.tag.remove`, `metadata.set`, `agent.message`, `agent.open`,
`agent.close`, `agent.restart`, `vscode.notify`, `vscode.status-bar`,
`notification.show`, `notification.close`, `project.open`, `project.close`,
`log`.

An operation that acts on a workspace needs `workspace` (a name, looked up in
every open project, or an absolute path) and may add `project` to say where to
look the name up. An action that waits for you (`notification.show` with
`wait: true`, say) holds up the whole poll until it is answered.

#### Templates

A script that would rather describe its items as a template than build them
in `jq` can pipe its raw output through `ch plugin render`:

```yaml
automations:
  reviews: |
    gh pr list --repo org/repo --json number,title,url \
      | ch plugin render "$CH_PLUGIN_DIR/reviews.yaml"
```

```yaml
# reviews.yaml — rendered once per input item
action: workspace.create
project: org/repo
name: "pr-{{ number }}"
key: "{{ url }}"
metadata:
  title: "PR #{{ number }}: {{ title }}"
prompt: "{{ body }}"
```

Every string in the template is a Liquid template evaluated against one item
(`{{ user.login }}`, `{{ title | truncate: 60 }}`, `{% if draft %}…{% endif %}`);
every other value — `stealFocus: true`, a number, a list — is kept as written.
A field whose string renders empty is left out, so `prompt: "{{ body }}"` for an
item without a body means no prompt. Input that is not a JSON array fails the
render, so a command that failed and printed nothing is not taken for an empty
list. MCP has the same as `plugin_render`.

The `auto-workspace.sources` setting this replaces is moved on the first start
into `~/.codehydra/plugins/auto-workspaces/`: each source becomes an automation
that pipes its `cmd` through `ch plugin render` and a template in `templates/`,
rewritten to the item fields above (`git` → `project`, `focus` → `stealFocus`,
the nested `agent` → `agent`/`agentName`/`permissionMode`/`model`, `mode:
events` → `event: true`). On Windows each `cmd` goes into a batch file of its
own in `sources/`, which the automation pipes — piping the command line itself
would make cmd.exe parse it twice and strip its `^` escapes. A batch file reads
`%` differently from the command line the setting ran, so every `%` that is not
part of a set variable (`%20` in a URL) is written as `%%`. What the sources
already created stays tracked, and the setting is cleared. A template field
with no counterpart is named in the notification.

### Repository hooks from before plugins

The `.codehydra/hooks/<entry>` files repositories used to ship no longer run.
While a worktree still has them and no plugin of its own, every time it opens
its editor shows a warning naming them, with **Migrate**: that writes
`.codehydra/plugins/hooks.yaml`, which runs each file from its entry as before
— a `.win`/`.linux`/`.mac` file only on its platform, a `.cmd`/`.bat` file
through cmd, a `.ps1` through PowerShell, anything else through bash (which
runs the file itself, so its shebang and exec bit still decide). Commit it; the
hooks run again from the next open, once the plugin is trusted. An entry
several files claimed on a platform ran nothing before and is left out,
named in the message.

## Agents

Each workspace runs one coding agent — Claude Code or OpenCode, chosen by the
`agent` setting or per workspace when you create it — in a terminal tab of its
editor.

### Which agent binary runs

Both agents follow the same rules, decided once at startup:

1. **`version.claude` / `version.opencode` set** — CodeHydra downloads that
   version (once) and runs it, even when the agent is installed on your
   system. The value is an exact version (`2.1.274`) or a channel that is
   looked up again at every start: `latest` or `stable` for Claude Code,
   `latest` for OpenCode. Any string is accepted; one that names no release
   shows up as a failed download on the setup screen.
2. **Installed on your system** — with the key unset (the default), the first
   `claude` / `opencode` on CodeHydra's `PATH` whose `--version` runs is used.
   CodeHydra sees the `PATH` it was started with, which for an app launched
   from the desktop may lack directories your shell adds; then it downloads its
   own copy instead. Installing or removing the agent takes effect at the next
   start.
3. **Otherwise** — CodeHydra downloads the latest release (Claude Code's
   `stable` channel, OpenCode's latest GitHub release) and checks again for a
   newer one at every start.

Downloads land in the data directory (`claude/<version>/`,
`opencode/<version>/`); Claude Code's is checked against the release's
SHA-256. When nothing usable is there yet, the setup screen downloads before
the app opens (with Retry / Quit if it fails). When a newer release appears
while an older download works, CodeHydra starts with the older one and
downloads the newer one in the background: workspaces opened after it lands
use it, running ones keep theirs until restarted. Offline, the newest download
already there is used. Older versions are deleted at the next start. A binary
CodeHydra downloaded has its own self-update turned off (CodeHydra updates
it); a system install is left alone.

`codehydra --download-binaries` downloads the editor and both agents (the
configured version, else the latest) whatever is installed, then exits without
opening a window — for preparing an offline machine or a CI cache.

### Claude Code

The agent terminal runs `ch claude`, which starts the `claude` chosen above
with CodeHydra's additions: its status
hooks, the CodeHydra MCP server, the system prompt below,
`--allow-dangerously-skip-permissions` (so bypass mode is available through
Shift+Tab, not switched on), and `--disallowedTools=Artifact` (see
[Pages and browsers](#pages-and-browsers)). It resumes the workspace's last conversation
(`--continue`) unless the workspace is new.

### OpenCode

CodeHydra runs one `opencode serve` per workspace, with the `opencode` chosen
above, and the agent terminal attaches to it with the same binary. The status shows **None** until the terminal has attached.

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
[automation](#automations) — is sent once, when the agent
first starts. With it you can choose `--agent claude|opencode`, `--model`
(OpenCode: `provider/model`), `--permission-mode` (Claude Code, e.g. `plan`)
and `--agent-name`; these need `--agent`.

### Messages to a running agent

A message reaches an agent that is **already running**, the way one Claude
Code session messages another. An initial prompt only reaches it at launch.
Send one with `ch ws agent message <text>` (`-` reads the text from standard
input), the `workspace_send_agent_message` MCP tool or the CodeHydra API.
[Automations](#automations) in `events` mode use it for the
prompt of a workspace that already exists.

```sh
ch ws agent message "main is green again — rebase when you are done"
git log -3 | ch ws agent message --workspace other -
ch ws agent message --wake "pick this back up"
```

- **Messages are for the agent**, while notifications, the status bar and
  `ws ask` are for you. The agent never sees a notification, and you see a
  message only in the agent's transcript.
- A busy agent reads it at its next step, and an idle one starts a turn on it.
  The command returns once the agent has taken it: sent, not read.
- The agent is told who sent it: `CodeHydra · workspace <name>` for the
  workspace your shell is in (even when `--workspace` names another),
  `CodeHydra · ch` from outside any workspace, or
  `CodeHydra · automation <plugin>/<automation>`. The sender cannot be chosen.
- A hibernated workspace, or one whose agent terminal is closed, has no agent
  to take it, and the command fails (exit 6). `--wake` wakes the workspace or
  reopens the agent terminal, then waits up to 90 seconds for the agent to
  start. It does not switch to the workspace. An agent still starting in an
  open terminal is waited for (up to 30 seconds) even without `--wake`.
- **Claude Code** in bypass-permissions mode on macOS and Linux holds a
  message from outside until you approve it in its terminal. The dialog closes
  after five minutes and drops the message. In every other mode, and in every
  mode on Windows, the message is delivered straight away.
- **OpenCode** runs a message sent while it is busy as its own turn, once the
  current one ends. The message starts with `[from <sender>]`.

### Status and permissions

Busy and idle come from the agent itself: Claude Code through its hooks,
OpenCode through its server's events. A pending permission prompt, or a
question the agent asked you, counts as idle — the agent is waiting on you.

So does a dialog in the workspace's editor — a notification, pick list or text
prompt raised by the agent, `ch` or a plugin. The workspace reads idle
until you dismiss it, even while the agent keeps working and even with no agent
running, then returns to its real status.

### Pages and browsers

Agents are told to show you pages inside the workspace rather than in your OS
browser:

- **What they open** — a dev server, docs, a PR page, a report they
  generated — goes to the editor's Simple Browser with `ch ws browser`. Login
  and OAuth pages are the exception; they need your signed-in browser. An agent
  opens a page unasked only when it made it for you to look at (a report, a dev
  server showing its change) and prints other links.
- **Claude Code cannot publish claude.ai Artifacts**: CodeHydra launches it
  with `--disallowedTools=Artifact`, so pages it builds stay on disk and open
  in Simple Browser.

This is guidance, not enforcement: a tool that opens a browser by itself
(`gh … --web`, a dev server) still uses your OS browser, and so does anything
opened on purpose with `xdg-open`, `open` or `ch ws open`.

### What agents are told

You don't have to explain CodeHydra to your agent. Every session gets a short
system prompt: what busy and idle mean (so it ends its turn only when it needs
you), that the worktree's lifecycle belongs to CodeHydra, that an `index.lock`
that survives a retry while no git process is running is stale and can be
deleted (otherwise it gives you the lock's path), that creating another
workspace is your call, that `ch` is on its `PATH`, that
`code <path>` opens a file in your editor, how to
[show you pages](#pages-and-browsers), and that `ch guide` explains
CodeHydra. Claude Code is also told about `ch bg`. The MCP server adds: pass a
prompt when creating a workspace, and file a bug report only when asked.

A line in your project's `CLAUDE.md` or `AGENTS.md` is the place to tighten or
loosen any of it. With OpenCode the prompt is added to the `instructions` list,
alongside any entries in your own `opencode.json`.

## CLI and MCP

### The `ch` command

`ch` lives in the `bin` folder of the data directory. It is on the `PATH` of
every editor terminal, the agent, and plugin scripts; to use it from any
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
| `ws title [title]`                                                 | Sidebar title; with no title, clears it and the row shows the branch again                                       |
| `ws tag ls`, `ws tag set <name>`, `ws tag rm <name>`               | Tags (`--color`, `--label`, `--description`; `set` replaces the whole tag)                                       |
| `ws metadata get`, `ws metadata set <key> <value>`                 | Raw workspace metadata                                                                                           |
| `ws agent open\|close\|restart\|session`                           | The agent terminal and server                                                                                    |
| `ws agent message <text>`                                          | [Message the running agent](#messages-to-a-running-agent) (`-` reads stdin, `--wake`)                            |
| `ws status set <idle\|busy>`                                       | Report the agent's status                                                                                        |
| `ws notify`, `ws status-bar`, `ws ask`                             | For you: a notification, status-bar text, or a question in the editor (`ask` waits for the answer)               |
| `notification show <title>`, `notification close <id>`             | For you: a card in CodeHydra's sidebar, see below                                                                |
| `ws goto`, `ws diff`, `ws preview`, `ws browser`                   | Open a file (`file:line:col`), a diff, a markdown preview, a URL in the editor                                   |
| `ws vscode-command <command>`                                      | Run a VS Code command                                                                                            |
| `ws open <path>`                                                   | Open with the OS (`--reveal` shows it in the file manager)                                                       |
| `project list`, `project open <target>`, `project close <project>` | Projects (a path, a git URL or `org/repo`; `--remove-local-repo`)                                                |
| `lock take`, `lock release`, `lock ls`, `lock run`                 | Locks, see below                                                                                                 |
| `config list\|get\|set\|reset`                                     | Settings, see [Configuration](#configuration)                                                                    |
| `plugin list\|enable\|disable\|errors\|schema\|render`             | Plugins, see [Managing plugins](#managing-plugins)                                                               |
| `guide [section]`                                                  | This guide, or one `##` section of it                                                                            |
| `log <level> <message>`                                            | Write to CodeHydra's log                                                                                         |
| `report-issue <description>`                                       | File a bug report                                                                                                |
| `bg <cmd…>`                                                        | Run a command without keeping the workspace busy                                                                 |
| `mcp`, `claude`, `opencode`                                        | The MCP server and agent launchers CodeHydra itself uses; extra arguments go to the agent                        |

```sh
ch ws status
ch ws create feature-auth main --prompt "add login with GitHub"
ch ws title "Auth rework"
ch ws title                    # clears the title again
ch ws tag set review --color "#3498db"
ch ws delete --workspace feature-auth --keep-branch
ch guide plugins
```

- `ch` acts on the workspace containing the current directory.
  `--workspace <name|path>` targets another, on every command that acts on a
  workspace. Only an absolute path counts as a path. A name is looked up in
  your own project first (the one the current directory's workspace belongs
  to, or whose checkout you are in) and wins there; otherwise it must be unique
  across the other open projects. `--project <name|path>` looks the name up in
  that project only. A name that matches no open workspace fails the command
  with exit 6; one that matches several fails it with exit 2 — add `--project`
  or pass a path. `--project` without `--workspace` is exit 2 (except on
  `ws create` and `ws switch`, whose own `--project` it is). On a command that
  acts on no workspace (`project`, `config`, `guide`, `log`, `lock ls`,
  `ws create`, …) `--workspace` is exit 2 rather than ignored.
- `project`, `config`, `guide`, `log`, `report-issue`, `lock ls`,
  `notification`, `ws switch`, `ws open` and `ws create --project …` work
  outside a workspace, and so does every workspace command given `--workspace`;
  other workspace commands exit 4 there.
- `--format auto` (the default) prints human-readable output at a terminal and
  JSON when piped — errors too, as `{"error", "exitCode"}` on stderr;
  `--format json` or `--format text` forces either. `ch guide` prints markdown
  unless `--format json` is given. An unknown flag is a usage error (exit 2).
  Progress (clones, deletions) goes to stderr when it is a terminal: the
  progress of the workspace the command acts on (`ws delete --workspace other`
  shows the other workspace's teardown), and of whatever a command with no
  target starts (`ws create`, `project open`).
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
ch lock run device,port -- npm run e2e   # several locks for one command
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
- A workspace can hold several locks. `ch lock run a,b` takes them one at a
  time in name order, and if one cannot be taken it releases the others and
  does not run the command.
- A take that would leave two workspaces waiting for each other (each
  holds a lock the other is waiting for, possibly through others in between)
  fails at once with exit 5, naming the loop, rather than waiting forever.
  Release what you hold and take the locks together with `ch lock run a,b`,
  or try again later.
- Releasing a lock the workspace does not hold exits 6.
- A waiter never takes a held lock. To break one whose holder is stuck or
  gone, release it as the holder, from any shell:
  `ch lock release device --workspace <holder>`. That ends the hold, not
  whatever the holder is still running.

### Sidebar notifications

`ch notification show` puts a card in CodeHydra's own sidebar — the same kind
CodeHydra uses for clone progress and errors, visible whichever workspace you
are looking at. (`ch ws notify` is different: a toast inside one workspace's
editor.) Both are for you, and no agent sees them. To tell an agent
something, [send it a message](#messages-to-a-running-agent).

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
  (`--workspace` to another): it names the workspace, clicking its title
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
| Agent      | `workspace_get_agent_session`, `workspace_restart_agent_server`, `workspace_open_agent`, `workspace_close_agent`, `workspace_send_agent_message`, `workspace_set_agent_status`                                                                                             |
| Editor     | `workspace_execute_command`, `ui_show_message`, `workspace_open_browser`, `workspace_open_diff`, `workspace_goto`, `workspace_preview_markdown`, `system_open_path`                                                                                                        |
| Projects   | `project_list`, `project_open`, `project_close`                                                                                                                                                                                                                            |
| Locks      | `lock_take` (does not wait unless asked), `lock_release`, `lock_list`                                                                                                                                                                                                      |
| Sidebar    | `notification_show`, `notification_close`                                                                                                                                                                                                                                  |
| Other      | `config_get`, `config_list`, `config_set`, `config_reset`, `guide`, `log`, `report_bug`                                                                                                                                                                                    |

Tools that can act on another workspace take `workspace` (a name or an
absolute path, looked up like `--workspace`: the agent's own project first) and
`project`. They are the same fields as `ch`'s `--workspace` and `--project` and
the API server's `workspace` and `project`, and mean the same thing on each.

You don't need to learn any of it. Just describe what you want in plain
language:

- "Open a workspace for the login bug and tell its agent to fix it"
- "Hibernate the workspaces I'm not using"
- "Save all open files"

## Troubleshooting

### A workspace's log

Each workspace's editor has a **CodeHydra Log** output channel (View → Output,
then pick it from the list): what CodeHydra did for that workspace — creating
its worktree, starting its agent, running its plugins' hooks, hibernating and waking
it — as it happens. Lines logged while the editor was away (while the workspace
was being created, or while it was hibernated) are shown once it connects, up
to the last 1000.

It shows Info and above by default. To see more, run **Developer: Set Log
Level…** and set the **CodeHydra Log**
channel to Debug. The level applies from then on; lines already dropped do not
come back.

Each line reads `(logger) [<trace> <intent>@<module>/<hook> <origin>] message`:
which part of CodeHydra wrote it, and on behalf of which operation — the trace
id is the same in the log file, so a line can be found there with its
surroundings.

### The log file

The full record, for every workspace and for CodeHydra itself, is in the
`logs/` folder of the data directory (see
[Where settings come from](#where-settings-come-from)); how much of it is
written is the `log.level` setting (`warn` by default; `debug` for detail).
A workspace's lines carry `<project>/<workspace>` there, so
`grep 'myproject/feature-x' <logfile>` finds them. Bug reports attach this
file.
